"""BoxBox game server: static UI + live Jev calls + Elastic (COMPLETION radio, Agent Builder, leaderboard). Keys stay server side."""
import time, threading
from fastapi import FastAPI, Body
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
import strategy as S

app = FastAPI(title="BoxBox")
_ctx, _lock, ROOMS = {}, threading.Lock(), {}

def ctx(code):
    code = code if code in S.DRV else "VER"
    with _lock:
        if code not in _ctx: _ctx[code] = S.make_ctx(S.pred_table(code))
    return _ctx[code]

try:
    import elastic_ai as E
except Exception as e:  # server still runs the game without Elastic
    E = None; print("elastic_ai unavailable:", type(e).__name__)

@app.get("/api/health")
def health():
    return {"ok": True, "elastic": E is not None}

@app.post("/api/jev")
def jev(b: dict = Body(...)):
    try:
        lap, comp, age = int(b["lap"]), str(b["compound"]).upper(), int(b["age"])
        used = [str(c).upper() for c in (b.get("compounds_used") or [comp])]
        st = S.jev_state(ctx(b.get("driver", "VER")), lap, comp, age, used, int(b.get("stops", max(0, len(set(used)) - 1))),
                         b.get("position"), b.get("gap_ahead"), b.get("gap_behind"), int(b.get("rejoin_behind", 0)))
        out = S.ask_jev(st); out["state"] = st
        return out
    except Exception as e:
        return JSONResponse({"error": type(e).__name__, "detail": str(e)[:200]}, status_code=200)

@app.post("/api/radio")
def radio(b: dict = Body(...)):
    if not E: return {"text": "Copy. Box, box."}
    d = b.get("detail")
    if isinstance(d, dict):  # the UI sends a situation object: turn it into plain words for the LLM
        b = {**b, "detail": ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in d.items() if k not in ("player_name",) and v not in (None, "", []))}
    return {"text": E.radio_line(b)}

@app.post("/api/debrief")
def debrief(b: dict = Body(...)):
    if not E: return {"text": "Debrief unavailable."}
    return {"text": E.debrief(b)}

@app.post("/api/ask")
def ask(b: dict = Body(...)):
    if not E: return {"answer": "The pit wall is offline.", "conversation_id": None, "esql": []}
    return E.ask_pitwall(b.get("question", ""), b.get("conversation_id"), timeout=150.0)

@app.post("/api/runs")
def runs(b: dict = Body(...)):
    if not E: return {"ok": False, "rank": None}
    return E.write_run(b)

@app.get("/api/leaderboard")
def leaderboard(n: int = 10):
    if not E: return []
    return E.leaderboard(n)

_dep = {}

@app.post("/api/serve")
def serve(b: dict = Body(...)):
    """Live call to the Hopsworks deployment 'boxboxlaptime': predicted lap times for the next laps on a new set of tyres."""
    try:
        with _lock:
            if "dep" not in _dep:
                import hw
                _dep["dep"] = hw.project().get_model_serving().get_deployment("boxboxlaptime")
        lap, comp, n = int(b.get("lap", 1)), str(b.get("compound", "HARD")).upper(), int(b.get("n", 5))
        laps = [L for L in range(lap + 1, min(S.T, lap + n) + 1)]
        inputs = [{"driver_code": b.get("driver", "VER"), "compound": comp, "tyre_life": L - lap, "laps_remaining": S.T - L,
                   "track_temperature": float(S.TEMP.loc[L])} for L in laps]
        t = time.time(); r = _dep["dep"].predict(inputs=inputs)
        return {"laps": laps, "predictions": r.get("predictions", []), "ms": int((time.time() - t) * 1000), "deployment": "boxboxlaptime (Hopsworks model serving)"}
    except Exception as e:
        return JSONResponse({"error": type(e).__name__, "detail": str(e)[:200]}, status_code=200)

_pc = {}

@app.post("/api/teamcall")
def teamcall(b: dict = Body(...)):
    """Model 2 (boxbox_pitcall, trained from the joined Feature View pitcall_fv): probability a real team boxes at the end of this lap."""
    try:
        import joblib, pandas as pd
        if "m" not in _pc:
            _pc["m"] = joblib.load("model_pitcall/pitcall.pkl")
            _pc["sty"] = pd.read_parquet("cache/driver_style.parquet").set_index(["season", "driver_code"])
            lf = pd.read_parquet("cache/lap_features.parquet"); lf = lf[lf.season == 2024]
            _pc["sc"] = lf.groupby("lap_number").track_status.agg(lambda s: int(s.astype(str).str.contains("4|6|7").any()))
        m = _pc["m"]; code = b.get("driver", "VER"); lap = int(b["lap"])
        st = _pc["sty"].loc[(2024, code)] if (2024, code) in _pc["sty"].index else _pc["sty"].iloc[0]
        comp = {"SOFT": 0, "MEDIUM": 1, "HARD": 2}.get(str(b.get("compound", "MEDIUM")).upper(), 1)
        row = {"compound_ord": comp, "tyre_life": int(b.get("age", 1)), "stint_no": int(b.get("stint_no", 1)), "laps_remaining": S.T - lap,
               "position": int(b.get("position") or 10), "track_temperature": float(S.TEMP.loc[lap]), "rainfall": 0,
               "prev_lap_delta": float(b.get("prev_lap_delta", 0.0)), "sc_or_vsc": int(_pc["sc"].get(lap, 0)),
               **{k: float(st[k]) for k in ["brake_pct", "full_throttle_pct", "coast_pct", "avg_speed"]}}
        p = float(m["model"].predict_proba(pd.DataFrame([row])[m["features"]])[0, 1])
        return {"p_team_box": round(p, 3), "model": "boxbox_pitcall v2 (Hopsworks Model Registry)"}
    except Exception as e:
        return JSONResponse({"error": type(e).__name__, "detail": str(e)[:200]}, status_code=200)

@app.get("/api/similar/{code}")
def similar_drivers(code: str, k: int = 4):
    try:
        import similar
        return similar.similar(code.upper(), 2024, k)
    except Exception as e:
        return JSONResponse({"error": type(e).__name__}, status_code=200)

def _room(room):
    return ROOMS.setdefault(room[:16], {"started_at": None, "lap_seconds": 2.5, "players": {}})

@app.post("/api/room/{room}/start")
def room_start(room: str, b: dict = Body(default={})):
    """host starts the shared race clock: every phone and the big screen derive the current lap from it"""
    r = _room(room)
    r["lap_seconds"] = float(b.get("lap_seconds", 2.5)); r["started_at"] = time.time() + float(b.get("countdown", 5))
    for p in r["players"].values(): p["stints"], p["lap"] = None, 0
    return {"ok": True, "started_at": r["started_at"], "lap_seconds": r["lap_seconds"], "server_now": time.time()}

@app.post("/api/room/{room}/join")
def room_join(room: str, b: dict = Body(...)):
    r = _room(room)
    if len(r["players"]) >= 40: return {"ok": False, "error": "room full"}
    name = str(b.get("player_name") or "anon")[:24]
    r["players"][name] = {"player_name": name, "driver": b.get("driver", "VER"), "stints": None, "lap": 0, "joined": time.time()}
    return {"ok": True, "player_name": name, "server_now": time.time(), "started_at": r["started_at"], "lap_seconds": r["lap_seconds"]}

@app.post("/api/room/{room}/state")
def room_state(room: str, b: dict = Body(...)):
    r = _room(room)
    name = str(b.get("player_name", "anon"))[:24]
    p = r["players"].setdefault(name, {"player_name": name, "joined": time.time()})
    p.update({k: b.get(k) for k in ("driver", "stints", "lap") if k in b})
    return {"ok": True, "server_now": time.time()}

@app.get("/api/room/{room}")
def room_get(room: str):
    r = _room(room)
    return {"started_at": r["started_at"], "lap_seconds": r["lap_seconds"], "server_now": time.time(), "players": list(r["players"].values())}

@app.get("/api/qr")
def qr(text: str):
    """QR code as SVG (segno, generated locally)"""
    import io, segno
    from fastapi.responses import Response
    buf = io.BytesIO(); segno.make(text, error="m").save(buf, kind="svg", scale=8, dark="#000000", light="#ffffff", border=2)
    return Response(buf.getvalue(), media_type="image/svg+xml")

@app.get("/api/lanurl")
def lanurl():
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1)); ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return {"url": f"http://{ip}:8000"}

app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
