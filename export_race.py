"""Build app/static/data/race.json for the 2024 Dutch GP: track path, real lap times, cumulative times, stints."""
import json, numpy as np, pandas as pd
from fetch_basic import esql
from features import build_lap_features

SEASON = 2024
COLORS = {"Red Bull Racing": "#3671C6", "McLaren": "#FF8000", "Ferrari": "#E8002D", "Mercedes": "#27F4D2",
          "Aston Martin": "#229971", "Alpine": "#FF87BC", "Williams": "#64C4FF", "RB": "#6692FF",
          "Kick Sauber": "#52E252", "Haas F1 Team": "#B6BABD", "Haas": "#B6BABD"}

def track_path():
    # reference lap: Verstappen's fastest 2023 race lap on slicks (same circuit; 2023 telemetry is complete)
    laps = esql('FROM f1-laps | WHERE season==2023 AND session_name=="Race" AND driver_code=="VER" AND compound IN ("SOFT","MEDIUM","HARD") AND lap_duration_ms IS NOT NULL | SORT lap_duration_ms ASC | LIMIT 1')
    lap = int(laps.lap_number[0])
    t = esql(f'FROM f1-telemetry | WHERE season==2023 AND session_name=="Race" AND driver_code=="VER" AND lap_number=={lap} | KEEP session_time_s, x, y | SORT session_time_s | LIMIT 5000')
    t = t.dropna()
    x, y = t.x.values, -t.y.values  # flip y so the path is in screen coordinates (y down)
    s = 1000 / max(x.max() - x.min(), y.max() - y.min())
    x = (x - x.min()) * s; y = (y - y.min()) * s
    x += (1000 - x.max()) / 2; y += (1000 - y.max()) / 2
    ts = t.session_time_s.values
    frac = (ts - ts[0]) / (ts[-1] - ts[0])
    step = max(1, len(x) // 700)
    path = [[round(float(a), 1), round(float(b), 1)] for a, b in zip(x[::step], y[::step])]
    fr = [round(float(f), 4) for f in frac[::step]]
    fr[0], fr[-1] = 0.0, 1.0
    return {"path": path, "frac": fr, "ref": f"VER 2023 lap {lap}"}

def pit_loss(f):
    d = f[f.season == SEASON]
    losses = []
    for (drv), g in d.groupby("driver_code"):
        g = g.set_index("lap_number")
        clean = g[g.valid_for_training == 1].lap_time_s.median()
        for L in g.index[g.is_pit_in_lap_derived == 1]:
            if L + 1 in g.index and pd.notna(g.lap_time_s.get(L)) and pd.notna(g.lap_time_s.get(L + 1)):
                losses.append(g.lap_time_s[L] + g.lap_time_s[L + 1] - 2 * clean)
    return float(np.median(losses)), losses

def main():
    laps, w = pd.read_parquet("cache/laps.parquet"), pd.read_parquet("cache/weather.parquet")
    res = pd.read_parquet("cache/results.parquet")
    f = build_lap_features(laps, w)
    pl, losses = pit_loss(f)
    d = f[f.season == SEASON]
    total = int(d.lap_number.max())
    r = res[(res.season == SEASON) & (res.session_name == "Race")].set_index("driver_code")
    drivers = []
    for code, g in d.groupby("driver_code"):
        g = g.sort_values("lap_number").set_index("lap_number")
        lt = g.lap_time_s.reindex(range(1, total + 1))
        med = g[g.valid_for_training == 1].lap_time_s.median()
        done = int(g.index.max())
        lt.loc[lt.index > done] = 80.0   # lapped cars: same constant for missing laps keeps their real order
        lt = lt.fillna(med)              # rare null laps inside the race -> clean median pace
        stints = []
        for sn, s in g.groupby("stint_no"):
            stints.append({"compound": s.compound.iloc[0], "start_lap": int(s.index.min()), "end_lap": int(s.index.max()),
                           "start_age": int(s.tyre_life.iloc[0])})
        stints[-1]["end_lap"] = total
        row = r.loc[code]
        drivers.append({"code": code, "name": row.full_name, "team": row.team_name, "color": COLORS.get(row.team_name, "#999999"),
                        "grid": int(row.grid_position), "finish": int(row.position),
                        "laps_completed": int(g.index.max()), "status": row.status,
                        "lap_times": [round(float(v), 3) for v in lt.values],
                        "cum": [round(float(v), 3) for v in lt.cumsum().values], "stints": stints})
    # game baseline: finishing order by our cumulative times (official order differs only RIC/STR by 0.35 s)
    for x in drivers: x["official_finish"] = x["finish"]
    for i, x in enumerate(sorted(drivers, key=lambda x: x["cum"][-1])): x["finish"] = i + 1
    drivers.sort(key=lambda x: x["finish"])
    out = {"season": SEASON, "event": "Dutch Grand Prix", "laps_total": total, "pit_loss_s": round(pl, 2),
           "track": track_path(), "drivers": drivers}
    json.dump(out, open("app/static/data/race.json", "w"))
    # sanity: does real cumulative order reproduce the official classification?
    order = sorted(drivers, key=lambda x: (-x["laps_completed"], x["cum"][x["laps_completed"] - 1]))
    print("pit loss median", round(pl, 2), "from", len(losses), "stops; range", np.round(np.percentile(losses, [10, 90]), 1))
    print("official:", [x["code"] for x in drivers])
    print("by time :", [x["code"] for x in order])
    print("laps completed:", {x["code"]: x["laps_completed"] for x in drivers if x["laps_completed"] < total}, "status:", {x["code"]: x["status"] for x in drivers if x["status"] != "Finished"})
    for x in drivers[:4]: print(x["code"], x["stints"])
    print("track points", len(out["track"]["path"]), out["track"]["ref"])

if __name__ == "__main__":
    main()
