"""Validate our derived pit stops against the organisers' shared Hopsworks feature group hopsworks_default::f1_pit_stops (cross-project feature sharing)."""
import json, pandas as pd, hw
fs = hw.project().get_feature_store("hopsworks_default_featurestore")
ps = fs.get_feature_group("f1_pit_stops", 1)
d = ps.filter((ps.season == 2024) & (ps.round == 15)).read()
race = json.load(open("app/static/data/race.json"))
name2code = {x["name"].split()[-1].lower(): x["code"] for x in race["drivers"]}
name2code.update({"max_verstappen": "VER", "kevin_magnussen": "MAG"})
ours = {(x["code"], s["end_lap"]) for x in race["drivers"] for s in x["stints"][:-1]}
theirs = {(name2code.get(r.driver_id.split("_")[-1], r.driver_id), int(r.lap)) for r in d.itertuples()}
out = {"derived_stops": len(ours), "official_stops": len(theirs), "exact_matches": len(ours & theirs),
       "official_pit_lane_median_s": round(float(d.duration_ms.median()) / 1000, 2), "our_total_pit_loss_s": race["pit_loss_s"]}
json.dump(out, open("app/static/data/validation.json", "w")); print(out)
