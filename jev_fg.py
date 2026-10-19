"""Store Jev's typed pit-wall judgments (per driver, per lap) as a Hopsworks feature group: AI judgments become reusable ML features."""
import json, pandas as pd, hw
g = json.load(open("cache/jev_ghosts.json"))
rows = [{"season": 2024, "driver_code": code, **c} for code, v in g.items() if v for c in v["calls"]]
df = pd.DataFrame(rows).rename(columns={"call": "jev_call", "p_box": "jev_p_box", "cliff_risk": "jev_cliff_risk", "undercut": "jev_undercut"})
fs = hw.project().get_feature_store()
fg = fs.get_or_create_feature_group(name="jev_pitwall_calls", version=1, primary_key=["season", "driver_code", "lap"], online_enabled=False,
                                    description="TypeSafe Jev (System One) typed judgments per lap of each driver's Jev-strategy ghost: call (BOX_x/STAY_OUT), p_box, tyre-cliff risk score, undercut threat probability")
fg.insert(df, write_options={"wait_for_job": False}); print("rows", df.shape)
