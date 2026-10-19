"""Lap-level feature engineering from Elastic (laps + weather) -> DataFrame."""
import numpy as np, pandas as pd
COMP = {"SOFT": 0, "MEDIUM": 1, "HARD": 2, "INTERMEDIATE": 3, "WET": 4}

def build_lap_features(laps: pd.DataFrame, weather: pd.DataFrame) -> pd.DataFrame:
    d = laps[laps.session_name == "Race"].copy()
    d = d.sort_values(["season", "driver_code", "lap_number"]).reset_index(drop=True)
    g = d.groupby(["season", "driver_code"], sort=False)
    d["lap_time_s"] = d.lap_duration_ms / 1000.0
    d["compound_ord"] = d.compound.map(COMP).fillna(-1).astype(int)
    # stints: new stint when compound changes or tyre_life drops
    newstint = (g.compound.shift() != d.compound) | (g.tyre_life.diff() < 0)
    newstint.iloc[d.groupby(["season", "driver_code"], sort=False).head(1).index] = False
    d["stint_no"] = newstint.groupby([d.season, d.driver_code]).cumsum().astype(int) + 1
    nxt = d.groupby(["season", "driver_code"], sort=False).stint_no.shift(-1)
    d["is_pit_in_lap_derived"] = (nxt > d.stint_no)          # next lap starts a new stint => this is the in-lap
    d["is_pit_out_lap_derived"] = d.tyre_life.le(2) & (d.stint_no > 1) & (d.groupby(["season", "driver_code", "stint_no"]).cumcount() == 0)
    d["laps_total"] = d.groupby("season").lap_number.transform("max")
    d["laps_remaining"] = d.laps_total - d.lap_number
    d["clean_air_track"] = d.track_status.astype(str).eq("1")
    # approximate elapsed session time per lap end, to join weather
    d["t_end"] = d.groupby(["season", "driver_code"], sort=False).lap_duration_ms.transform(lambda s: s.fillna(s.median()).cumsum()) / 1000.0
    w = weather[weather.session_name == "Race"].sort_values("session_time_s")
    parts = []
    for s, part in d.groupby("season"):
        ws = w[w.season == s][["session_time_s", "track_temperature", "air_temperature", "humidity", "wind_speed", "rainfall"]]
        parts.append(pd.merge_asof(part.sort_values("t_end"), ws, left_on="t_end", right_on="session_time_s", direction="nearest"))
    d = pd.concat(parts).sort_values(["season", "driver_code", "lap_number"]).reset_index(drop=True)
    d["rainfall"] = d.rainfall.astype(int)
    ok = d.clean_air_track & ~d.is_pit_in_lap_derived & ~d.is_pit_out_lap_derived & (d.lap_number > 1) & d.lap_time_s.notna()
    d["valid_for_training"] = ok.astype(int)
    d["pace_roll3"] = d.groupby(["season", "driver_code"], sort=False).lap_time_s.transform(lambda s: s.where(ok.loc[s.index]).shift().rolling(3, min_periods=1).median())
    d["delta_vs_prev"] = d.lap_time_s - d.pace_roll3
    d["is_pit_in_lap_derived"] = d.is_pit_in_lap_derived.fillna(False).astype(int)
    d["is_pit_out_lap_derived"] = d.is_pit_out_lap_derived.astype(int)
    d["position"] = d.position.fillna(0).astype(int)
    cols = ["season", "round_number", "driver_code", "lap_number", "team_name", "compound", "compound_ord", "tyre_life", "stint_no",
            "laps_remaining", "track_temperature", "air_temperature", "humidity", "wind_speed", "rainfall", "position",
            "lap_time_s", "duration_sector_1", "duration_sector_2", "duration_sector_3", "pace_roll3", "delta_vs_prev",
            "is_pit_in_lap_derived", "is_pit_out_lap_derived", "valid_for_training", "track_status"]
    return d[cols]

if __name__ == "__main__":
    laps, w = pd.read_parquet("cache/laps.parquet"), pd.read_parquet("cache/weather.parquet")
    f = build_lap_features(laps, w); f.to_parquet("cache/lap_features.parquet")
    print(f.shape, f.valid_for_training.mean().round(2), f.is_pit_in_lap_derived.sum())
    print(f.groupby("season").is_pit_in_lap_derived.sum())
    print(f[(f.driver_code=="NOR")&(f.season==2024)].iloc[25:32].T)
    print(f.isna().sum()[lambda s: s>0])
