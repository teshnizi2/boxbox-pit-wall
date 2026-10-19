"""Driver style fingerprints from the 2.9M telemetry rows (one ES|QL STATS in Elastic) -> Hopsworks FG driver_style (+ embedding index)."""
import sys, numpy as np, pandas as pd
from fetch_basic import es, esql
import hw

Q = '''FROM f1-telemetry | WHERE session_name == "Race"
| EVAL full_thr = CASE(throttle >= 98, 1, 0), braking = CASE(brake, 1, 0), drs_open = CASE(drs >= 10, 1, 0), coasting = CASE(throttle < 5 AND NOT brake, 1, 0)
| STATS samples = COUNT(), avg_speed = AVG(speed), max_speed = MAX(speed), avg_rpm = AVG(rpm), avg_throttle = AVG(throttle),
        full_throttle_pct = AVG(full_thr) * 100, brake_pct = AVG(braking) * 100, coast_pct = AVG(coasting) * 100,
        drs_pct = AVG(drs_open) * 100, avg_gear = AVG(n_gear) BY season, driver_code
| LIMIT 100'''
STYLE = ["avg_speed", "max_speed", "avg_rpm", "avg_throttle", "full_throttle_pct", "brake_pct", "coast_pct", "drs_pct", "avg_gear"]

if __name__ == "__main__":
    n = es.count(index="f1-telemetry")["count"]; print("telemetry docs", n)
    if n < 2869213 and "--force" not in sys.argv: sys.exit("telemetry copy not finished")
    df = esql(Q)
    z = (df[STYLE] - df.groupby("season")[STYLE].transform("mean")) / df.groupby("season")[STYLE].transform("std")
    v = z.values / np.linalg.norm(z.values, axis=1, keepdims=True)
    df["style_vec"] = [list(map(float, r)) for r in v]
    df.to_parquet("cache/driver_style.parquet"); print(df[["season", "driver_code", "samples"] + STYLE[:5]].head())
    p = hw.project(); fs = p.get_feature_store()
    try:
        from hsfs import embedding
        ei = embedding.EmbeddingIndex(); ei.add_embedding("style_vec", len(STYLE))
        fg = fs.get_or_create_feature_group(name="driver_style", version=1, primary_key=["season", "driver_code"], online_enabled=True,
                                            embedding_index=ei, description="Per driver+race driving-style fingerprint from 2.9M telemetry samples (ES|QL STATS in Elastic), with a normalised style embedding for similarity search")
        fg.insert(df, write_options={"wait_for_job": False}); print("FG with embedding index OK")
    except Exception as e:
        print("embedding FG failed:", type(e).__name__, str(e)[:200])
        fg = fs.get_or_create_feature_group(name="driver_style", version=1, primary_key=["season", "driver_code"], online_enabled=False,
                                            description="Per driver+race driving-style fingerprint from 2.9M telemetry samples (ES|QL STATS in Elastic)")
        fg.insert(df.drop(columns=["style_vec"]), write_options={"wait_for_job": False}); print("FG without embedding OK")
