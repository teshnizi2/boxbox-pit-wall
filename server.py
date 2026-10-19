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

@app.get("/api/similar/{code}")
def similar_drivers(code: str, k: int = 4):
    try:
        import similar
        return similar.similar(code.upper(), 2024, k)
    except Exception as e:
        return JSONResponse({"error": type(e).__name__}, status_code=200)

@app.post("/api/room/{room}/state")
def room_state(room: str, b: dict = Body(...)):
    r = ROOMS.setdefault(room, {"started_at": time.time(), "players": {}})
    name = str(b.get("player_name", "anon"))[:24]
    r["players"][name] = {k: b.get(k) for k in ("player_name", "driver", "stints", "lap")}
    return {"ok": True}

@app.get("/api/room/{room}")
def room_get(room: str):
    r = ROOMS.get(room, {"started_at": None, "players": {}})
    return {"started_at": r["started_at"], "players": list(r["players"].values())}

app.mount("/", StaticFiles(directory="app/static", html=True), name="static")
