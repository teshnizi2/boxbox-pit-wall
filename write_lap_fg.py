import pandas as pd, hw
f = pd.read_parquet("cache/lap_features.parquet")
f["lap_event_time"] = pd.Timestamp("2023-09-03", tz="UTC")  # placeholder event time not needed; dropped below
f = f.drop(columns=["lap_event_time"])
p = hw.project(); fs = p.get_feature_store()
fg = fs.get_or_create_feature_group(
    name="lap_features", version=1,
    description="Per-driver race lap features for Dutch GP 2023+2024: tyre state, weather, pace deltas, derived stints/pit flags (engineered from Elastic f1-laps + f1-weather via ES|QL)",
    primary_key=["season", "driver_code", "lap_number"], online_enabled=False)
fg.insert(f, write_options={"wait_for_job": False})
print("inserted", f.shape)
