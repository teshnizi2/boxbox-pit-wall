"""Second model: 'would a real team box this lap?' (pit-stop prediction), trained from a Feature View that JOINS lap_features with driver_style."""
import json, sys, numpy as np, pandas as pd, joblib, os
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.metrics import roc_auc_score, average_precision_score
import hw

LAP = ["season", "driver_code", "lap_number", "compound_ord", "tyre_life", "stint_no", "laps_remaining", "position", "track_temperature", "rainfall", "delta_vs_prev", "is_pit_in_lap_derived", "track_status"]
STY = ["brake_pct", "full_throttle_pct", "coast_pct", "avg_speed"]
FEAT = ["compound_ord", "tyre_life", "stint_no", "laps_remaining", "position", "track_temperature", "rainfall", "prev_lap_delta", "sc_or_vsc"] + STY

p = hw.project(); fs = p.get_feature_store()
lap = fs.get_feature_group("lap_features", version=1); sty = fs.get_feature_group("driver_style", version=1)
q = lap.select(LAP).join(sty.select(STY), on=["season", "driver_code"])
fv = fs.get_or_create_feature_view(name="pitcall_fv", version=1, query=q, labels=["is_pit_in_lap_derived"],
                                   description="Race laps joined with each driver's telemetry style fingerprint: does the team box at the end of this lap?")
X, y = fv.training_data(description="all race laps, both seasons")
df = X.copy(); df["y"] = y.values.ravel().astype(int)
df["sc_or_vsc"] = df.track_status.astype(str).str.contains("4|6|7").astype(int)
# no leakage: the in-lap itself is slow, so only the PREVIOUS lap's pace delta is known when the call is made
df = df.sort_values(["season", "driver_code", "lap_number"])
df["prev_lap_delta"] = df.groupby(["season", "driver_code"]).delta_vs_prev.shift(1)
df = df[df.lap_number > 1].dropna(subset=["tyre_life"])
Xf = df[FEAT].fillna(0.0); yy = df.y.values; groups = df.season.astype(str) + df.driver_code
aucs, aps, aucl = [], [], []
for tr, te in GroupKFold(5).split(Xf, yy, groups):
    m = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=3).fit(Xf.iloc[tr], yy[tr])
    pr = m.predict_proba(Xf.iloc[te])[:, 1]; aucs.append(roc_auc_score(yy[te], pr)); aps.append(average_precision_score(yy[te], pr))
    l = LogisticRegression(max_iter=2000).fit(Xf.iloc[tr], yy[tr]); aucl.append(roc_auc_score(yy[te], l.predict_proba(Xf.iloc[te])[:, 1]))
print("laps", len(df), "pit laps", int(yy.sum()), "GBM AUC", round(np.mean(aucs), 3), "AP", round(np.mean(aps), 3), "(base rate", round(yy.mean(), 3), ") logistic AUC", round(np.mean(aucl), 3))
m = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=3).fit(Xf, yy)
os.makedirs("model_pitcall", exist_ok=True); joblib.dump({"model": m, "features": FEAT}, "model_pitcall/pitcall.pkl")
json.dump({"auc": float(np.mean(aucs)), "ap": float(np.mean(aps)), "base_rate": float(yy.mean()), "features": FEAT}, open("model_pitcall/meta.json", "w"))
if "--register" in sys.argv:
    mr = p.get_model_registry()
    rm = mr.python.create_model(name="boxbox_pitcall", metrics={"auc": round(float(np.mean(aucs)), 4), "avg_precision": round(float(np.mean(aps)), 4)}, feature_view=fv,
                                description="v2 (no leakage: uses the previous lap pace delta, not the in-lap). Gradient-boosted classifier: probability a real team boxes at the end of this lap (tyre state, race state, weather, driver style). 5-fold GroupKFold by driver-season.")
    rm.save("model_pitcall"); print("registered", rm.name, rm.version)
