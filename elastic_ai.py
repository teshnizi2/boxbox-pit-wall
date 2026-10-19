"""BoxBox <-> Elastic helpers for the FastAPI server.

Plain sync functions that NEVER raise: every one returns a sensible fallback on error.
Credentials come from repo/.env (absolute path, so the working directory does not matter) and
are scrubbed from all error text.

    radio_line(ctx)                        -> str    one team-radio line, LLM inside ES|QL (COMPLETION)
    debrief(summary)                       -> str    3-4 sentence race-engineer debrief
    ask_pitwall(question, conversation_id) -> dict   {answer, conversation_id, esql, ...} (Agent Builder agent)
    write_run(doc)                         -> dict   {ok, rank, ...} index a game run into boxbox-runs
    leaderboard(n)                         -> list   top runs, with their stints

Typical latency: radio_line / debrief 1-3 s, write_run 0.2-5 s (refresh wait), leaderboard < 0.5 s,
ask_pitwall 15-35 s (the agent runs several ES|QL tools): call it from a worker thread.
"""
from __future__ import annotations

import logging
import os
import re
import time
from datetime import datetime, timezone

import requests
from dotenv import dotenv_values

log = logging.getLogger("boxbox.elastic")

_ROOT = os.path.dirname(os.path.abspath(__file__))
_ENV = dotenv_values(os.path.join(_ROOT, "repo", ".env"))
_KEY = _ENV.get("REMOTE_ELASTICSEARCH_API_KEY") or os.environ.get("REMOTE_ELASTICSEARCH_API_KEY", "")
_ES = (_ENV.get("REMOTE_ELASTICSEARCH_URL") or os.environ.get("REMOTE_ELASTICSEARCH_URL", "")).rstrip("/")
_KB = (_ENV.get("KIBANA_URL") or _ES.replace(".es.", ".kb.").replace(":443", "")).rstrip("/")

# Claude Sonnet 5 hit the Elastic trial limit at 19:23, so Claude Sonnet 4.5 first, Elastic's general-purpose LLM as backup
INFERENCE_IDS = [".anthropic-claude-4.5-sonnet-completion", ".gp-llm-v2-completion"]  # completion endpoints, used by ES|QL COMPLETION
INFERENCE_ID = INFERENCE_IDS[0]
CONNECTOR_ID = "Anthropic-Claude-Sonnet-4-5"  # Kibana connector, used by the agent and the connector fallback
AGENT_ID = "boxbox-pitwall"
RUNS_INDEX = "boxbox-runs"

# Which LLM path served the last radio_line / debrief call: {"method": "esql_completion" | "kibana_connector" | "template", "ms": int}
LAST_LLM = {"method": None, "ms": None}

_sess = requests.Session()
_sess.headers.update({"Authorization": f"ApiKey {_KEY}", "Content-Type": "application/json"})


def _scrub(x) -> str:
    s = str(x)
    return s.replace(_KEY, "***") if _KEY else s


def _http(method, base, path, body=None, timeout=20, params=None, kbn=False):
    headers = {"kbn-xsrf": "true"} if kbn else None
    r = _sess.request(method, base + path, json=body, params=params, timeout=timeout, headers=headers)
    if r.status_code >= 400:
        raise RuntimeError(f"{method} {path} -> {r.status_code}: {_scrub(r.text)[:300]}")
    return r.json() if r.content else {}


# ----------------------------------------------------------------------------------------
# LLM text: ES|QL COMPLETION first, Kibana connector (same model) second, a template last
# ----------------------------------------------------------------------------------------
def _complete_esql(prompt: str, timeout: float) -> str:
    """The LLM call runs INSIDE ES|QL. The prompt is passed as a query parameter, never string-built."""
    t0, err = time.time(), None
    for i, ep in enumerate(INFERENCE_IDS):
        left = timeout - (time.time() - t0)
        if left < 3:
            break
        per = left * (0.6 if i < len(INFERENCE_IDS) - 1 else 1.0)
        query = 'ROW prompt = ?p | COMPLETION line = prompt WITH { "inference_id": "%s", "timeout": "%ds" } | KEEP line' % (ep, max(3, int(per) - 1))
        try:
            d = _http("POST", _ES, "/_query", {"query": query, "params": [{"p": prompt}]}, timeout=per, params={"format": "json"})
            LAST_LLM.update(model=ep)
            return d["values"][0][0]
        except Exception as e:  # noqa: BLE001 - try the next model
            err = e
    raise RuntimeError(f"all completion endpoints failed: {_scrub(err)[:200]}")


def _complete_connector(prompt: str, timeout: float) -> str:
    """Fallback: the same model through the Kibana connector (the direct _inference/completion API answers 403 with
    this API key, so it is not used)."""
    body = {"params": {"subAction": "unified_completion", "subActionParams": {"body": {"messages": [{"role": "user", "content": prompt}]}}}}
    d = _http("POST", _KB, f"/api/actions/connector/{CONNECTOR_ID}/_execute", body, timeout=timeout, kbn=True)
    if d.get("status") != "ok":
        raise RuntimeError(_scrub(d.get("message") or d.get("service_message") or d)[:200])
    return d["data"]["choices"][0]["message"]["content"]


def _llm(prompt: str, timeout: float = 20.0):
    """Returns the model text, or None if both paths fail. Stays within `timeout` seconds in total."""
    t0 = time.time()
    for name, fn, share in (("esql_completion", _complete_esql, 0.6), ("kibana_connector", _complete_connector, 1.0)):
        left = timeout - (time.time() - t0)
        if left < 3:
            break
        try:
            text = fn(prompt, left * share if share < 1 else left)
            if text and str(text).strip():
                LAST_LLM.update(method=name, ms=int((time.time() - t0) * 1000))
                return str(text)
        except Exception as e:  # noqa: BLE001 - never raise
            log.warning("llm via %s failed: %s", name, _scrub(e))
    LAST_LLM.update(method="template", ms=int((time.time() - t0) * 1000))
    return None


def _clean(text: str, max_words: int, one_line: bool = False) -> str:
    t = re.sub(r"[*_`#>]+", "", text).strip()
    t = re.sub(r"^(radio|engineer|pit wall|message)\s*:\s*", "", t, flags=re.I)
    if one_line:
        t = t.splitlines()[0].strip()
    t = re.sub(r"\s+", " ", t).strip().strip('"“”\'').strip()
    words = t.split()
    if len(words) > max_words:
        t = " ".join(words[:max_words]).rstrip(",;:-") + "."
    return t


def _s(v, default="n/a", maxlen=60) -> str:
    """Short single-line string safe to put in a prompt."""
    if v is None or v == "":
        return default
    return re.sub(r"[\x00-\x1f<>]+", " ", str(v)).strip()[:maxlen] or default


def _num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ----------------------------------------------------------------------------------------
# radio_line
# ----------------------------------------------------------------------------------------
_RADIO_PROMPT = """You are a Formula 1 race engineer on team radio during the Dutch Grand Prix at Zandvoort.
Write exactly ONE radio message to your driver, at most 20 words. Plain spoken English, calm and urgent like a real pit wall. No emojis, no hashtags, no quotation marks, no markdown, no preamble. Use only the facts below and do not invent numbers.
Lap: {lap}
Driver: {driver}
Event: {event}
Detail: {detail}
Reply with the radio message only."""


def _radio_fallback(ctx: dict) -> str:
    driver = _s(ctx.get("driver"), "Driver", 12)
    event = _s(ctx.get("event"), "", 40).lower()
    detail = _s(ctx.get("detail"), "", 90)
    if "box" in event or "pit" in event:
        return f"Box, box, {driver}. {detail}".strip().rstrip(".") + "."
    if "cliff" in event or "tyre" in event or "deg" in event:
        return f"{driver}, tyres are going off. {detail}".strip().rstrip(".") + "."
    if "safety" in event or "sc" == event or "vsc" in event:
        return f"{driver}, safety car. {detail}".strip().rstrip(".") + "."
    if "stay" in event:
        return f"Stay out, stay out, {driver}. {detail}".strip().rstrip(".") + "."
    return f"{driver}, copy. {detail}".strip().rstrip(".") + "."


def radio_line(ctx: dict, timeout: float = 20.0) -> str:
    """One F1 team-radio line (max ~20 words) from ctx {lap, driver, event, detail}. Never raises."""
    try:
        ctx = ctx if isinstance(ctx, dict) else {}
        prompt = _RADIO_PROMPT.format(
            lap=_s(ctx.get("lap")), driver=_s(ctx.get("driver"), maxlen=20), event=_s(ctx.get("event"), maxlen=60), detail=_s(ctx.get("detail"), maxlen=200)
        )
        text = _llm(prompt, timeout)
        if text:
            line = _clean(text, 28, one_line=True)
            if line:
                return line
        return _radio_fallback(ctx)
    except Exception as e:  # noqa: BLE001
        log.warning("radio_line failed: %s", _scrub(e))
        return "Copy that. Keep pushing."


# ----------------------------------------------------------------------------------------
# stints helpers (shared by debrief / write_run)
# ----------------------------------------------------------------------------------------
def _stint_parts(stints):
    """-> [(compound, start_lap, end_lap, laps)] from the list of stint dicts used by the app."""
    out = []
    for s in stints or []:
        try:
            if isinstance(s, dict):
                comp = str(s.get("compound") or s.get("tyre") or "?").upper()
                a = s.get("start_lap", s.get("from"))
                b = s.get("end_lap", s.get("to"))
                laps = s.get("laps")
                if laps is None and a is not None and b is not None:
                    laps = int(b) - int(a) + 1
                out.append((comp, None if a is None else int(a), None if b is None else int(b), None if laps is None else int(laps)))
        except (TypeError, ValueError):
            continue
    return out


def _stints_label(stints) -> str:
    """[{MEDIUM 1-28},{HARD 29-72}] -> 'M28-H44'."""
    return "-".join(f"{c[:1]}{l}" if l is not None else c[:1] for c, _a, _b, l in _stint_parts(stints))


def _stints_text(stints) -> str:
    parts = []
    for c, a, b, _l in _stint_parts(stints):
        parts.append(f"{c} laps {a}-{b}" if a is not None and b is not None else c)
    return ", ".join(parts) or "unknown"


# ----------------------------------------------------------------------------------------
# debrief
# ----------------------------------------------------------------------------------------
_DEBRIEF_PROMPT = """You are a Formula 1 race engineer giving a short debrief to a player who just played the Dutch GP 2024 strategy game BoxBox.
Write 3 or 4 sentences of plain English: no markdown, no bullet points, no emojis, no preamble. Use ONLY the numbers below and do not invent others.
Compare the player's strategy with what the real team did, with the optimizer and with the Jev AI call. Say what worked, what cost time, and one thing to try next. A negative time delta means faster than the real team.
Player: {player_name}
Driver: {driver}
Player strategy: {stints}
Player finish: P{finish} (the real team finished P{real_finish})
Player time vs real team: {delta_s}
Optimizer time vs real team: {optimizer_delta}
Jev AI time vs real team: {jev_delta}"""


def _signed(v) -> str:
    n = _num(v)
    return "n/a" if n is None else f"{n:+.1f} s"


def _debrief_fallback(sm: dict) -> str:
    name = _s(sm.get("player_name"), "Driver", 30)
    fin, real = sm.get("finish"), sm.get("real_finish")
    d = _num(sm.get("delta_s"))
    opt, jev = _num(sm.get("optimizer_delta")), _num(sm.get("jev_delta"))
    s1 = f"{name}, you finished P{fin} against the real team's P{real}" if fin is not None and real is not None else f"{name}, that was a solid run"
    if d is not None:
        s1 += f", {abs(d):.1f} s {'quicker' if d < 0 else 'slower'} than the real strategy."
    else:
        s1 += "."
    s2 = f"Your strategy was {_stints_text(sm.get('stints'))}."
    s3 = ""
    if opt is not None and jev is not None:
        s3 = f" The optimizer was {abs(opt):.1f} s {'faster' if opt < 0 else 'slower'} than the team and Jev {abs(jev):.1f} s {'faster' if jev < 0 else 'slower'}."
    return f"{s1} {s2}{s3} Try a different pit lap and tyre order and see what the gap does.".replace("  ", " ")


def debrief(summary: dict, timeout: float = 20.0) -> str:
    """3-4 sentence race-engineer debrief from {driver, player_name, stints, finish, real_finish, delta_s,
    optimizer_delta, jev_delta}. Never raises."""
    try:
        sm = summary if isinstance(summary, dict) else {}
        prompt = _DEBRIEF_PROMPT.format(
            player_name=_s(sm.get("player_name"), "the player", 30),
            driver=_s(sm.get("driver"), maxlen=20),
            stints=_stints_text(sm.get("stints")),
            finish=_s(sm.get("finish"), "?", 6),
            real_finish=_s(sm.get("real_finish"), "?", 6),
            delta_s=_signed(sm.get("delta_s")),
            optimizer_delta=_signed(sm.get("optimizer_delta")),
            jev_delta=_signed(sm.get("jev_delta")),
        )
        text = _llm(prompt, timeout)
        if text:
            t = _clean(text, 110)
            if t:
                return t
        return _debrief_fallback(sm)
    except Exception as e:  # noqa: BLE001
        log.warning("debrief failed: %s", _scrub(e))
        return "Solid effort. Compare your pit lap and tyre order with the optimizer and try again."


# ----------------------------------------------------------------------------------------
# ask_pitwall: Agent Builder agent `boxbox-pitwall`
# ----------------------------------------------------------------------------------------
def _collect_esql(steps) -> list:
    out = []
    for s in steps or []:
        if s.get("type") != "tool_call":
            continue
        for r in s.get("results") or []:
            data = r.get("data") or {}
            q = data.get("esql") if r.get("type") in ("query", "visualization") else (data.get("query") if r.get("type") == "esql_results" else None)
            if isinstance(q, str) and q.strip() and q.strip() not in out:
                out.append(q.strip())
    return out


def _collect_charts(steps) -> list:
    """Charts the agent built with create_visualization: [{chart_type, esql, attachment_id}] (Kibana Lens attachments)."""
    out = []
    for s in steps or []:
        if s.get("type") != "tool_call":
            continue
        for r in s.get("results") or []:
            if r.get("type") == "visualization":
                data = r.get("data") or {}
                out.append({"chart_type": data.get("chart_type"), "esql": data.get("esql"), "attachment_id": data.get("attachment_id")})
    return out


def ask_pitwall(question: str, conversation_id: str | None = None, timeout: float = 60.0) -> dict:
    """Ask the BoxBox Pit Wall agent. Returns {answer, conversation_id, esql: [queries], tools: [{tool_id, params}],
    charts: [{chart_type, esql, attachment_id}], ms, ok}. Takes 15-35 s (several tool calls): `timeout` defaults to 60 s, not 20 s. Never raises."""
    t0 = time.time()
    body = {"agent_id": AGENT_ID, "input": str(question)[:2000], "connector_id": CONNECTOR_ID}
    if conversation_id:
        body["conversation_id"] = conversation_id
    try:
        d = _http("POST", _KB, "/api/agent_builder/converse", body, timeout=timeout, kbn=True)
        steps = d.get("steps") or []
        return {
            "answer": re.sub(r"<render_attachment[^>]*/>\s*", "", (d.get("response") or {}).get("message") or "").strip(),
            "conversation_id": d.get("conversation_id") or conversation_id,
            "esql": _collect_esql(steps),
            "charts": _collect_charts(steps),
            "tools": [{"tool_id": s.get("tool_id"), "params": s.get("params")} for s in steps if s.get("type") == "tool_call"],
            "ms": int((time.time() - t0) * 1000),
            "ok": True,
        }
    except Exception as e:  # noqa: BLE001
        log.warning("ask_pitwall failed: %s", _scrub(e))
        return {
            "answer": "The pit wall radio is down right now. Try again in a moment.",
            "conversation_id": conversation_id,
            "esql": [],
            "charts": [],
            "tools": [],
            "ms": int((time.time() - t0) * 1000),
            "ok": False,
            "error": _scrub(e)[:300],
        }


# ----------------------------------------------------------------------------------------
# boxbox-runs: write_run / leaderboard
# ----------------------------------------------------------------------------------------
_SORT = [
    {"dsq": {"order": "asc", "missing": "_last"}},
    {"positions_gained": {"order": "desc"}},
    {"delta_s": {"order": "asc"}},
    {"created_at": {"order": "asc"}},
]


def _f32(x: float) -> float:
    """delta_s is a float32 field: compare in float32 so equal values are not 'less than' each other."""
    import struct

    return struct.unpack("f", struct.pack("f", float(x)))[0]


def _rank_of(doc_id: str, dsq: bool, pg: int, delta: float) -> int:
    """1 + number of runs that sort before this one (valid runs first, then positions gained desc, then delta_s asc)."""
    before = [
        {
            "bool": {
                "filter": [{"term": {"dsq": dsq}}],
                "should": [
                    {"range": {"positions_gained": {"gt": pg}}},
                    {"bool": {"filter": [{"term": {"positions_gained": pg}}, {"range": {"delta_s": {"lt": _f32(delta)}}}]}},
                ],
                "minimum_should_match": 1,
            }
        }
    ]
    if dsq:  # every valid run beats a disqualified one
        before.append({"term": {"dsq": False}})
    q = {"query": {"bool": {"should": before, "minimum_should_match": 1, "must_not": [{"ids": {"values": [doc_id]}}]}}}
    d = _http("POST", _ES, f"/{RUNS_INDEX}/_count", q, timeout=15)
    return int(d.get("count", 0)) + 1


def write_run(doc: dict, timeout: float = 20.0, refresh: str = "wait_for") -> dict:
    """Index a game run into boxbox-runs (refresh=wait_for; pass refresh="true" to force an immediate refresh, faster) -> {ok, rank, id}. Rank: valid runs by positions_gained
    desc, then delta_s asc; disqualified runs rank after all valid ones. Never raises (ok=False, rank=None on error)."""
    try:
        if not isinstance(doc, dict) or not doc:
            return {"ok": False, "rank": None, "error": "doc must be a non-empty dict"}
        d = dict(doc)
        name = re.sub(r"[<>\x00-\x1f]+", "", str(d.get("player_name") or "Anonymous")).strip()[:40] or "Anonymous"
        stints = d.get("stints") or []
        parts = _stint_parts(stints)
        finish = int(d["finish"]) if d.get("finish") is not None else None
        real_finish = int(d["real_finish"]) if d.get("real_finish") is not None else None
        pg = d.get("positions_gained")
        if pg is None:
            pg = (real_finish - finish) if (finish is not None and real_finish is not None) else 0
        delta = _num(d.get("delta_s"), 0.0)
        dsq = bool(d.get("dsq", False))
        compounds = list(dict.fromkeys(c for c, _a, _b, _l in parts))
        pit_laps = [b for _c, _a, b, _l in parts[:-1] if b is not None]
        out = {
            "player_name": name,
            "driver": _s(d.get("driver"), "", 8).upper(),
            "team": _s(d.get("team"), "", 40) if d.get("team") else None,
            "stints": stints,
            "stints_label": d.get("stints_label") or _stints_label(stints),
            "pit_laps": d.get("pit_laps") if d.get("pit_laps") is not None else pit_laps,
            "compounds": d.get("compounds") if d.get("compounds") is not None else compounds,
            "finish": finish,
            "real_finish": real_finish,
            "positions_gained": int(pg),
            "delta_s": round(delta, 3),
            "dsq": dsq,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        }
        out = {k: v for k, v in out.items() if v is not None}
        r = _http("POST", _ES, f"/{RUNS_INDEX}/_doc", out, timeout=timeout, params={"refresh": refresh})
        doc_id = r.get("_id")
        try:
            rank = _rank_of(doc_id, dsq, int(pg), out["delta_s"])
        except Exception as e:  # noqa: BLE001 - the run is saved, only the rank failed
            log.warning("rank failed: %s", _scrub(e))
            rank = None
        return {"ok": True, "rank": rank, "id": doc_id}
    except Exception as e:  # noqa: BLE001
        log.warning("write_run failed: %s", _scrub(e))
        return {"ok": False, "rank": None, "error": _scrub(e)[:300]}


def leaderboard(n: int = 10, timeout: float = 15.0) -> list:
    """Top n runs, best first: [{rank, player_name, driver, team, positions_gained, delta_s, finish, real_finish,
    stints_label, pit_laps, compounds, dsq, created_at, stints}]. Never raises ([] on error)."""
    try:
        n = max(1, min(int(n), 100))
        d = _http("POST", _ES, f"/{RUNS_INDEX}/_search", {"size": n, "sort": _SORT, "_source": True}, timeout=timeout)
        rows = []
        for i, h in enumerate(d.get("hits", {}).get("hits", []), start=1):
            row = dict(h.get("_source") or {})
            row["rank"] = i
            rows.append(row)
        return rows
    except Exception as e:  # noqa: BLE001
        log.warning("leaderboard failed: %s", _scrub(e))
        return []


def warmup() -> bool:
    """Optional: call once at server start to open the TLS connection and wake the LLM endpoint."""
    try:
        _http("GET", _ES, "/", timeout=10)
        _llm("Reply with the single word: ready", 15)
        return True
    except Exception:  # noqa: BLE001
        return False


# ----------------------------------------------------------------------------------------
# smoke test:  .venv/bin/python elastic_ai.py [--skip-agent]
# ----------------------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    def timed(label, fn, *a, **k):
        t = time.time()
        r = fn(*a, **k)
        print(f"[{time.time() - t:5.1f}s] {label}: {r}")
        return r

    timed("radio_line", radio_line, {"lap": 28, "driver": "NOR", "event": "BOX", "detail": "box this lap for hards, Verstappen is 1.2 s behind"})
    print("        via:", LAST_LLM)
    timed(
        "debrief",
        debrief,
        {
            "driver": "NOR",
            "player_name": "SMOKE_Reza",
            "stints": [{"compound": "SOFT", "start_lap": 1, "end_lap": 20}, {"compound": "HARD", "start_lap": 21, "end_lap": 72}],
            "finish": 1,
            "real_finish": 1,
            "delta_s": -2.4,
            "optimizer_delta": -5.1,
            "jev_delta": -3.3,
        },
    )
    print("        via:", LAST_LLM)
    # write_run / leaderboard on three throw-away runs, deleted again at the end
    ids = []
    for nm, pg, dl, dsq in (("SMOKE_a", 2, -3.5, False), ("SMOKE_b", 2, 4.0, False), ("SMOKE_c", 5, -9.0, True)):
        r = timed(
            f"write_run {nm}",
            write_run,
            {
                "player_name": nm,
                "driver": "VER",
                "stints": [{"compound": "MEDIUM", "start_lap": 1, "end_lap": 28}, {"compound": "HARD", "start_lap": 29, "end_lap": 72}],
                "finish": 1,
                "real_finish": 1 + pg,
                "positions_gained": pg,
                "delta_s": dl,
                "dsq": dsq,
            },
        )
        ids.append(r.get("id"))
    rows = timed("leaderboard(5)", leaderboard, 5)
    if "--skip-agent" not in sys.argv:
        r = timed("ask_pitwall", ask_pitwall, "Show the top 3 on the BoxBox leaderboard")
        print("        esql queries:", len(r["esql"]), "| tools:", [t["tool_id"] for t in r["tools"]])
    for i in ids:  # cleanup of the smoke-test runs
        if i:
            try:
                _http("DELETE", _ES, f"/{RUNS_INDEX}/_doc/{i}", timeout=10, params={"refresh": "true"})
            except Exception as e:  # noqa: BLE001
                print("cleanup failed:", _scrub(e))
    print("cleanup done; leaderboard now:", len(leaderboard(5)), "rows")
