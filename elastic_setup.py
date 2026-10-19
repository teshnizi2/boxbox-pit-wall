"""BoxBox: idempotent Elastic setup (re-runnable).

Does, in order:
  1. index `boxbox-runs` (only if missing)
  2. Agent Builder custom ES|QL tools `boxbox.*` and agent `boxbox-pitwall` (create or update)
  3. Kibana data views for f1-* and boxbox-runs (skipped if they exist)
  4. dashboard "BoxBox Live" (best effort, skipped if it exists)

Run:  .venv/bin/python elastic_setup.py [--no-dashboard]
Keys are read from repo/.env and never printed (all error text is scrubbed).
"""
import json
import os
import sys

import requests
from dotenv import dotenv_values

ROOT = os.path.dirname(os.path.abspath(__file__))
ENV = dotenv_values(os.path.join(ROOT, "repo", ".env"))
API_KEY = ENV.get("REMOTE_ELASTICSEARCH_API_KEY", "")
ES_URL = ENV.get("REMOTE_ELASTICSEARCH_URL", "").rstrip("/")
# Serverless: https://<proj>.es.<region>.gcp.elastic.cloud:443 -> https://<proj>.kb.<region>.gcp.elastic.cloud
KB_URL = (ENV.get("KIBANA_URL") or ES_URL.replace(".es.", ".kb.").replace(":443", "")).rstrip("/")
HEADERS = {"Authorization": f"ApiKey {API_KEY}", "kbn-xsrf": "true", "Content-Type": "application/json"}
CONNECTOR_ID = ".anthropic-claude-5-sonnet-chat_completion"  # Kibana connector "Anthropic Claude Sonnet 5"
INDEX_RUNS = "boxbox-runs"
AGENT_ID = "boxbox-pitwall"


def scrub(x):
    s = x if isinstance(x, str) else json.dumps(x, default=str)
    return s.replace(API_KEY, "***") if API_KEY else s


def kb(method, path, body=None, timeout=60):
    r = requests.request(method, KB_URL + path, headers=HEADERS, json=body, timeout=timeout)
    try:
        data = r.json()
    except Exception:
        data = r.text
    return r.status_code, data


def es(method, path, body=None, timeout=60):
    r = requests.request(method, ES_URL + path, headers=HEADERS, json=body, timeout=timeout)
    try:
        data = r.json()
    except Exception:
        data = r.text
    return r.status_code, data


# --------------------------------------------------------------------------------------
# 1. boxbox-runs index
# --------------------------------------------------------------------------------------
RUNS_MAPPING = {
    "mappings": {
        "properties": {
            "player_name": {"type": "keyword"},
            "driver": {"type": "keyword"},
            "team": {"type": "keyword"},
            "stints": {"type": "object", "enabled": False},  # raw list kept in _source only
            "stints_label": {"type": "keyword"},
            "pit_laps": {"type": "integer"},
            "compounds": {"type": "keyword"},
            "finish": {"type": "integer"},
            "real_finish": {"type": "integer"},
            "positions_gained": {"type": "integer"},
            "delta_s": {"type": "float"},
            "dsq": {"type": "boolean"},
            "created_at": {"type": "date"},
        }
    }
}


def ensure_index():
    c, _ = es("HEAD", f"/{INDEX_RUNS}")
    if c == 200:
        print(f"[index] {INDEX_RUNS} exists, skipped")
        return
    c, d = es("PUT", f"/{INDEX_RUNS}", RUNS_MAPPING)
    print(f"[index] create {INDEX_RUNS}: {c}", "" if c == 200 else scrub(d)[:400])


# --------------------------------------------------------------------------------------
# 2. Agent Builder tools + agent
# --------------------------------------------------------------------------------------
# "Clean lap" = green flag (track_status 1), has a time, not lap 1, not the first lap of a stint (out-lap)
# and not the last lap of a stint that is followed by a pit stop (in-lap). The last lap of the final
# stint (the flag lap) is kept.
CLEAN_PREP = """| EVAL stint_start = lap_number - tyre_life + 1
| INLINE STATS race_last = MAX(lap_number) BY driver_code
| INLINE STATS stint_first = MIN(lap_number), stint_last = MAX(lap_number) BY driver_code, stint_start
| EVAL clean = track_status == "1" AND lap_duration_ms IS NOT NULL AND lap_number > 1 AND lap_number > stint_first AND (lap_number < stint_last OR stint_last == race_last)"""

Q_STINTS = f"""FROM f1-laps
| WHERE season == ?season AND session_name == "Race" AND driver_code == ?driver
{CLEAN_PREP}
| STATS first_lap = MIN(lap_number), last_lap = MAX(lap_number), laps = COUNT(*), tyre_age_at_start = MIN(tyre_life), clean_laps = COUNT(lap_duration_ms) WHERE clean, avg_clean_ms = AVG(lap_duration_ms) WHERE clean, best_ms = MIN(lap_duration_ms) WHERE track_status == "1" BY stint_start, compound
| EVAL avg_clean_lap_s = ROUND(avg_clean_ms / 1000.0, 3), best_lap_s = ROUND(best_ms / 1000.0, 3)
| SORT first_lap
| KEEP compound, first_lap, last_lap, laps, tyre_age_at_start, clean_laps, avg_clean_lap_s, best_lap_s"""

Q_COMPOUND_PACE = f"""FROM f1-laps
| WHERE season == ?season AND session_name == "Race"
{CLEAN_PREP}
| WHERE clean
| EVAL age_bucket = CASE(tyre_life <= 5, "01-05", tyre_life <= 10, "06-10", tyre_life <= 15, "11-15", tyre_life <= 20, "16-20", tyre_life <= 25, "21-25", tyre_life <= 30, "26-30", tyre_life <= 40, "31-40", "41+")
| EVAL lap_s = lap_duration_ms / 1000.0
| STATS laps = COUNT(*), drivers = COUNT_DISTINCT(driver_code), avg_lap_s = ROUND(AVG(lap_s), 3), median_lap_s = ROUND(MEDIAN(lap_s), 3), avg_fuel_corrected_lap_s = ROUND(AVG(lap_s + 0.05 * (lap_number - 1)), 3), best_lap_s = ROUND(MIN(lap_s), 3) BY compound, age_bucket
| SORT compound, age_bucket"""

Q_GAP_AT_LAP = """FROM f1-laps
| WHERE season == ?season AND session_name == "Race" AND lap_number <= ?lap
| STATS laps_done = COUNT(*), timed_laps = COUNT(lap_duration_ms), cum_ms = SUM(lap_duration_ms), position = MAX(position) WHERE lap_number == ?lap, compound = MAX(compound) WHERE lap_number == ?lap, tyre_age = MAX(tyre_life) WHERE lap_number == ?lap BY driver_code, team_name
| WHERE laps_done == ?lap
| EVAL cum_s = CASE(timed_laps == laps_done, ROUND(cum_ms / 1000.0, 3), NULL)
| INLINE STATS leader_s = MIN(cum_s)
| EVAL gap_to_leader_s = ROUND(cum_s - leader_s, 3)
| SORT position
| KEEP position, driver_code, team_name, compound, tyre_age, cum_s, gap_to_leader_s"""

Q_LEADERBOARD = """FROM boxbox-runs
| SORT dsq ASC, positions_gained DESC, delta_s ASC, created_at ASC
| LIMIT ?n
| KEEP player_name, driver, team, positions_gained, delta_s, finish, real_finish, stints_label, pit_laps, compounds, dsq, created_at"""

Q_DUEL = """FROM f1-laps
| WHERE season == ?season AND session_name == "Race" AND driver_code IN (?driver_a, ?driver_b)
| EVAL lap_s = lap_duration_ms / 1000.0, is_a = driver_code == ?driver_a, is_b = driver_code == ?driver_b
| STATS a_pos = MAX(CASE(is_a, position, null)), b_pos = MAX(CASE(is_b, position, null)),
        a_tyre = MAX(CASE(is_a, compound, null)), b_tyre = MAX(CASE(is_b, compound, null)),
        a_age = MAX(CASE(is_a, tyre_life, null)), b_age = MAX(CASE(is_b, tyre_life, null)),
        a_lap_s = MAX(CASE(is_a, lap_s, null)), b_lap_s = MAX(CASE(is_b, lap_s, null)) BY lap_number
| EVAL lap_diff_s = ROUND(a_lap_s - b_lap_s, 3), a_lap_s = ROUND(a_lap_s, 3), b_lap_s = ROUND(b_lap_s, 3)
| SORT lap_number
| LIMIT 100"""

TOOLS = [
    {
        "id": "boxbox.stints",
        "type": "esql",
        "description": (
            "Tyre stints of ONE driver in the Dutch GP race of a season (2023 or 2024): per stint the compound, first lap, "
            "last lap, number of laps, tyre age at the start (>1 means a used set), the average CLEAN lap time in seconds "
            "(green flag only, out-lap and in-lap removed) and the best green-flag lap. A new stint = a pit stop. "
            "Use it to describe or compare a driver's strategy. 2024 = round 15, dry, Norris won from pole; "
            "2023 = round 13, wet, intermediates."
        ),
        "tags": ["boxbox"],
        "configuration": {
            "query": Q_STINTS,
            "params": {
                "season": {"type": "integer", "description": "Season year, 2023 or 2024"},
                "driver": {"type": "string", "description": "Three-letter driver code in capitals, e.g. NOR, VER, LEC, PIA, HAM, RUS, SAI, PER"},
            },
        },
    },
    {
        "id": "boxbox.compound_pace",
        "type": "esql",
        "description": (
            "Tyre degradation view for the Dutch GP race of a season (2023 or 2024): for each compound (SOFT, MEDIUM, HARD, "
            "INTERMEDIATE, WET) and tyre-age bucket (laps on the tyre: 01-05, 06-10, ... 41+) the number of clean laps, the average and median "
            "lap time in seconds, the fuel-corrected average lap time (adds 0.05 s per lap already run, an assumption for the "
            "fuel burn effect, so it shows pure tyre wear) and the best lap. Only clean laps (green flag, no out-lap, no in-lap). "
            "Raw lap times can fall as fuel burns off, so cite the fuel-corrected column for degradation and say it is an estimate."
        ),
        "tags": ["boxbox"],
        "configuration": {
            "query": Q_COMPOUND_PACE,
            "params": {"season": {"type": "integer", "description": "Season year, 2023 or 2024"}},
        },
    },
    {
        "id": "boxbox.gap_at_lap",
        "type": "esql",
        "description": (
            "Running order at the end of lap N of the Dutch GP race of a season: for every driver still running the position, team, "
            "tyre compound and tyre age on that lap, the cumulative race time in seconds (sum of lap times, empty when a lap time is "
            "missing) and the gap to the leader in seconds. Subtract two rows to get the gap between any two drivers. "
            "Use it to compare Norris and Verstappen (or any pair) at a given lap, e.g. before and after the pit stops."
        ),
        "tags": ["boxbox"],
        "configuration": {
            "query": Q_GAP_AT_LAP,
            "params": {
                "season": {"type": "integer", "description": "Season year, 2023 or 2024"},
                "lap": {"type": "integer", "description": "Race lap number, 1 to 72"},
            },
        },
    },
    {
        "id": "boxbox.duel",
        "type": "esql",
        "description": (
            "Lap-by-lap duel of TWO drivers in the Dutch GP race of a season: for every lap the position, tyre compound, tyre age "
            "and lap time of driver A and driver B, plus lap_diff_s = A minus B (negative = A faster that lap). Pit stops show as a "
            "tyre age reset to 1 and a ~20 s slower out-lap (the stop time is booked on the out-lap; the lap before is the in-lap). "
            "Use it FIRST for 'why did A beat B' or 'where did A lose to B': find the lap where positions swapped and the pit laps."
        ),
        "tags": ["boxbox"],
        "configuration": {
            "query": Q_DUEL,
            "params": {
                "season": {"type": "integer", "description": "Season year, 2023 or 2024"},
                "driver_a": {"type": "string", "description": "Three-letter code of driver A in capitals, e.g. NOR"},
                "driver_b": {"type": "string", "description": "Three-letter code of driver B in capitals, e.g. VER"},
            },
        },
    },
    {
        "id": "boxbox.leaderboard",
        "type": "esql",
        "description": (
            "The BoxBox game leaderboard: the best runs players have made in the strategy game (index boxbox-runs), ranked by "
            "positions gained versus the real finish (more is better), then by time delta in seconds (lower is better); "
            "disqualified runs (dsq = true) come last. Columns: player, driver, team, positions gained, delta_s, finish, real finish, "
            "stints label (e.g. M28-H44 = medium for 28 laps then hard for 44), pit laps, compounds."
        ),
        "tags": ["boxbox"],
        "configuration": {
            "query": Q_LEADERBOARD,
            "params": {
                "n": {"type": "integer", "description": "How many runs to return, default 5", "optional": True, "defaultValue": 5},
            },
        },
    },
]

AGENT_INSTRUCTIONS = """You are BoxBox Pit Wall, an F1 race engineer on the radio. You know one weekend only: the Dutch Grand Prix at Zandvoort, 2023 (round 13, wet, intermediates, 72 laps) and 2024 (round 15, dry, 72 laps, Norris won from pole on a Medium-Hard one stop, Verstappen second). The game BoxBox lets players rebuild the 2024 strategy and beat the real pit wall.

How you work:
- ALWAYS use tools before answering; never answer from memory. Cite concrete numbers: laps, seconds, gaps, tyre ages.
- For 'why did A beat B' or 'where did A lose to B', call boxbox.duel first (lap-by-lap positions, tyres, lap times of both), then boxbox.stints for each.
- Prefer the custom tools: boxbox.duel (two drivers lap by lap), boxbox.stints (a driver's stints and pace), boxbox.compound_pace (tyre degradation by compound and tyre age), boxbox.gap_at_lap (running order and gaps at lap N), boxbox.leaderboard (game leaderboard). Call a tool several times when comparing drivers or laps (e.g. NOR and VER at laps 20, 28 and 40).
- For anything else write the query with platform.core.generate_esql and run it with platform.core.execute_esql; use platform.core.get_index_mapping if unsure about fields. When the user asks for a chart or a plot, build it with platform.core.create_visualization.
- Answer like a race engineer: short, direct, at most 6 lines unless asked for more, plain words, no filler. Start with the verdict, then the numbers that back it, then the call you would make.
- Output is shown in a game UI as plain text: no markdown bold, no headings, no tables; short lines starting with '-' are fine. Do not mention tool names, indices or ES|QL in the answer.
- Only state what the tool results show. Never invent overtakes, incidents, safety cars, start incidents or pit-stop times. If the data does not show why, say so. Lap times in f1-laps are summed to get race time, so gaps can differ from the official classification by a fraction of a second.
- Charts: reuse the numbers you already fetched and call platform.core.create_visualization directly; do not call get_index_mapping or generate_esql first unless you need data the boxbox tools do not give. Then add one or two lines of insight.

Data facts (indices f1-laps, f1-results, f1-sessions, f1-weather, f1-telemetry):
- f1-laps has one row per driver and lap with lap_duration_ms (milliseconds, can be null), compound, tyre_life (laps on the tyre), position, track_status ("1" = green). Use session_name == "Race".
- is_pit_in_lap and is_pit_out_lap are ALWAYS false: do not use them. A stint is identified within season and driver_code by stint_start = lap_number - tyre_life + 1; a pit stop is a new stint. Pit loss (in-lap + out-lap versus clean pace) is about 24 s at Zandvoort 2024, measured over 26 stops.
- Driver codes: VER, PER, NOR, PIA, LEC, SAI, HAM, RUS, ALO, STR, GAS, OCO, ALB, SAR, TSU, RIC, LAW, HUL, MAG, BOT, ZHO, DEV. f1-results has full_name, team_name, grid_position and finishing position.
- Lap times fall by roughly 0.05 s per lap as fuel burns off, so do not read falling raw times as 'no degradation'; use the fuel-corrected figure of boxbox.compound_pace and call it an estimate.
- 2024 start: Norris started on pole (grid 1), Verstappen P2 (grid 2), Piastri P3, Leclerc P6 (f1-results grid_position). Verstappen passed Norris at the start and led after lap 1 (boxbox.gap_at_lap lap 1: Verstappen first, Norris 0.96 s behind). Never call a driver the pole-sitter unless grid_position is 1, and never mix up grid order with running order. To explain a result, find the lap where the lead changed: call boxbox.gap_at_lap for several laps (for example 1, 10, 20, 26, 27, 28, 29, 30, 40, 72) and compare the pit stop laps from boxbox.stints.
- Gaps: use boxbox.gap_at_lap; the difference of two cumulative times is the gap between those two drivers at that lap.
"""

AGENT = {
    "id": AGENT_ID,
    "name": "BoxBox Pit Wall",
    "description": "F1 race engineer for the Dutch GP 2023/2024: strategy, tyre degradation, gaps and the BoxBox leaderboard, answered with ES|QL tools.",
    "avatar_color": "#E10600",
    "avatar_symbol": "BB",
    "configuration": {
        "instructions": AGENT_INSTRUCTIONS,
        "tools": [
            {
                "tool_ids": [t["id"] for t in TOOLS]
                + [
                    "platform.core.execute_esql",
                    "platform.core.generate_esql",
                    "platform.core.get_index_mapping",
                    "platform.core.create_visualization",
                ]
            }
        ],
    },
}


def upsert_tool(t):
    c, _ = kb("GET", f"/api/agent_builder/tools/{t['id']}")
    if c == 200:
        body = {k: t[k] for k in ("description", "tags", "configuration")}
        c, d = kb("PUT", f"/api/agent_builder/tools/{t['id']}", body)
        verb = "updated"
    else:
        c, d = kb("POST", "/api/agent_builder/tools", t)
        verb = "created"
    print(f"[tool] {t['id']}: {verb if c == 200 else 'FAILED'} ({c})", "" if c == 200 else scrub(d)[:600])
    return c == 200


def upsert_agent(a):
    c, _ = kb("GET", f"/api/agent_builder/agents/{a['id']}")
    if c == 200:
        body = {k: v for k, v in a.items() if k != "id"}
        c, d = kb("PUT", f"/api/agent_builder/agents/{a['id']}", body)
        verb = "updated"
    else:
        c, d = kb("POST", "/api/agent_builder/agents", a)
        verb = "created"
    print(f"[agent] {a['id']}: {verb if c == 200 else 'FAILED'} ({c})", "" if c == 200 else scrub(d)[:800])
    return c == 200


# --------------------------------------------------------------------------------------
# 3. Kibana data views
# --------------------------------------------------------------------------------------
DATA_VIEWS = [
    ("f1-sessions", "session_date"),
    ("f1-results", None),
    ("f1-laps", None),
    ("f1-weather", None),
    ("f1-telemetry", None),
    (INDEX_RUNS, "created_at"),
]


def ensure_data_views():
    for name, time_field in DATA_VIEWS:
        c, _ = kb("GET", f"/api/data_views/data_view/{name}")
        if c == 200:
            print(f"[data view] {name} exists, skipped")
            continue
        dv = {"id": name, "title": name, "name": name}
        if time_field:
            dv["timeFieldName"] = time_field
        c, d = kb("POST", "/api/data_views/data_view", {"data_view": dv})
        print(f"[data view] {name}: {'created' if c == 200 else 'FAILED'} ({c})", "" if c == 200 else scrub(d)[:400])


# ----------------------------------------------------------------------------------------
# 4. Dashboard "BoxBox Live" via the Kibana Dashboards API (Lens-as-code panels on ES|QL, no data view needed)
# ----------------------------------------------------------------------------------------
DASH_TITLE = "BoxBox Live"


def _esql(q):
    return {"type": "esql", "query": q}


def _metric(title, q, col, x):
    return {"type": "vis", "grid": {"x": x, "y": 0, "w": 12, "h": 8},
            "config": {"type": "metric", "title": title, "data_source": _esql(q), "metrics": [{"type": "primary", "operation": "value", "column": col}]}}


def _bar(title, q, xcol, ycol, x, y, w=24, h=14):
    return {"type": "vis", "grid": {"x": x, "y": y, "w": w, "h": h},
            "config": {"type": "xy", "title": title,
                       "layers": [{"type": "bar", "data_source": _esql(q), "x": {"operation": "value", "column": xcol}, "y": [{"column": ycol}]}]}}


DASH_PANELS = [
    _metric("Runs played", "FROM boxbox-runs | STATS runs = COUNT(*)", "runs", 0),
    _metric("Best positions gained", "FROM boxbox-runs | WHERE dsq == false | STATS best = MAX(positions_gained)", "best", 12),
    _metric("Fastest vs real team (s)", "FROM boxbox-runs | WHERE dsq == false | STATS best = MIN(delta_s)", "best", 24),
    _metric("Disqualified runs", "FROM boxbox-runs | WHERE dsq == true | STATS dsq_runs = COUNT(*)", "dsq_runs", 36),
    {
        "type": "vis", "grid": {"x": 0, "y": 8, "w": 48, "h": 16},
        "config": {
            "type": "data_table", "title": "Leaderboard (positions gained, then time delta)",
            "data_source": _esql("FROM boxbox-runs | SORT dsq ASC, positions_gained DESC, delta_s ASC | LIMIT 10 | KEEP player_name, driver, positions_gained, delta_s, finish, real_finish, stints_label, dsq"),
            "metrics": [{"operation": "value", "column": c} for c in ("player_name", "driver", "positions_gained", "delta_s", "finish", "real_finish", "stints_label", "dsq")],
        },
    },
    _bar("Pit laps chosen (all runs)", "FROM boxbox-runs | MV_EXPAND pit_laps | WHERE pit_laps IS NOT NULL | STATS runs = COUNT(*) BY pit_laps | SORT pit_laps", "pit_laps", "runs", 0, 24),
    _bar("Compounds used (runs per compound)", "FROM boxbox-runs | MV_EXPAND compounds | WHERE compounds IS NOT NULL | STATS runs = COUNT(*) BY compounds | SORT runs DESC", "compounds", "runs", 24, 24),
    {"type": "vis", "grid": {"x": 0, "y": 38, "w": 24, "h": 16},
     "config": {"type": "xy", "title": "Verstappen 2024: lap time above 74 s, actual vs Hopsworks model (boxbox-predictions)",
                "layers": [{"type": "line", "data_source": _esql('FROM boxbox-predictions | WHERE driver_code == "VER" AND clean_lap | EVAL actual = ROUND(actual_s - 74, 3), model = ROUND(predicted_s - 74, 3) | KEEP lap_number, actual, model | SORT lap_number'),
                            "x": {"operation": "value", "column": "lap_number"}, "y": [{"column": "actual"}, {"column": "model"}]}]}},
    {"type": "vis", "grid": {"x": 24, "y": 38, "w": 24, "h": 16},
     "config": {"type": "data_table", "title": "Strategy backtest: real team vs optimizer vs Jev (s vs real)",
                "data_source": _esql("FROM boxbox-backtest | SORT opt_d ASC | KEEP drv, real, opt, opt_d, jev, jev_d | LIMIT 20"),
                "metrics": [{"operation": "value", "column": c} for c in ("drv", "real", "opt", "opt_d", "jev", "jev_d")]}},
]


def ensure_dashboard():
    body = {"title": DASH_TITLE, "description": "Live view of the BoxBox strategy game: leaderboard, pit laps, compounds.",
            "panels": DASH_PANELS, "time_range": {"from": "now-24h", "to": "now"}, "refresh_interval": {"pause": False, "value": 5000}}
    c, d = kb("GET", "/api/dashboards?per_page=100")
    existing = [x for x in (d.get("data", []) if isinstance(d, dict) else []) if (x.get("data", x) or {}).get("title") == DASH_TITLE]
    if existing:
        did = existing[0].get("id")
        c, d = kb("PUT", f"/api/dashboards/{did}", body)
        print(f"[dashboard] {DASH_TITLE}: {'updated' if c in (200, 201) else 'update FAILED'} ({c}) id={did}", "" if c in (200, 201) else scrub(d)[:500])
        return
    c, d = kb("POST", "/api/dashboards", body)
    if c in (200, 201):
        print(f"[dashboard] {DASH_TITLE}: created ({c}) id={d.get('id')}  open: {KB_URL}/app/dashboards#/view/{d.get('id')}")
    else:
        print(f"[dashboard] FAILED ({c})", scrub(d)[:800])


def main():
    if not API_KEY or not ES_URL:
        sys.exit("repo/.env is missing REMOTE_ELASTICSEARCH_URL / REMOTE_ELASTICSEARCH_API_KEY")
    ensure_index()
    for t in TOOLS:
        upsert_tool(t)
    upsert_agent(AGENT)
    ensure_data_views()
    if "--no-dashboard" not in sys.argv:
        ensure_dashboard()


if __name__ == "__main__":
    main()
