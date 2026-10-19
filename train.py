"""Feature View -> lap-time model (tyre degradation + fuel) -> Hopsworks Model Registry -> per-driver game tables."""
import json, os, sys, joblib, numpy as np, pandas as pd
from sklearn.linear_model import Ridge
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import GroupKFold
from sklearn.metrics import mean_absolute_error
import hw

DRY = ["SOFT", "MEDIUM", "HARD"]
FEATS = ["season", "driver_code", "lap_number", "stint_no", "compound", "tyre_life", "laps_remaining", "track_temperature", "rainfall"]

def design(df, drivers):
    X = pd.DataFrame(index=df.index)
    for c in DRY:
        on = (df.compound == c).astype(float)
        X[f"is_{c}"] = on
        X[f"age_{c}"] = on * df.tyre_life
        X[f"age2_{c}"] = on * df.tyre_life ** 2 / 10.0
    X["fuel_laps"] = df.laps_remaining
    X["track_temp"] = df.track_temperature
    for d in drivers:
        X[f"drv_{d}"] = (df.season.astype(str) + "_" + df.driver_code == d).astype(float)
    return X

def get_training(seasons=(2024,)):
    p = hw.project(); fs = p.get_feature_store()
    fg = fs.get_feature_group("lap_features", version=1)
    q = fg.select(FEATS + ["lap_time_s", "valid_for_training"])
    fv = fs.get_or_create_feature_view(name="laptime_fv", version=1, query=q, labels=["lap_time_s"],
                                       description="Clean dry race laps (no SC/VSC, no in/out laps): lap time vs tyre compound, tyre age, fuel load, track temperature")
    X, y = fv.training_data(description="all dry clean race laps")
    df = X.copy(); df["lap_time_s"] = y["lap_time_s"].values
    df = df[(df.valid_for_training == 1) & df.compound.isin(DRY) & df.season.isin(seasons) & (df.rainfall == 0)].dropna(subset=["lap_time_s", "track_temperature"])
    # drop outliers (traffic, mistakes): > 3 s off the driver's stint median
    med = df.groupby(["season", "driver_code", "stint_no"]).lap_time_s.transform("median")
    df = df[(df.lap_time_s - med).abs() < 3.0]
    return p, fv, df

def fit_eval(df):
    drivers = sorted((df.season.astype(str) + "_" + df.driver_code).unique())
    X, y = design(df, drivers), df.lap_time_s.values
    groups = df.season.astype(str) + df.driver_code + df.stint_no.astype(str)
    res = {"ridge": [], "gbm": []}
    for tr, te in GroupKFold(n_splits=5).split(X, y, groups):
        r = Ridge(alpha=1.0).fit(X.iloc[tr], y[tr]); res["ridge"].append(mean_absolute_error(y[te], r.predict(X.iloc[te])))
        g = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05).fit(X.iloc[tr], y[tr]); res["gbm"].append(mean_absolute_error(y[te], g.predict(X.iloc[te])))
    model = Ridge(alpha=1.0).fit(X, y)
    coef = dict(zip(X.columns, model.coef_))
    return model, drivers, coef, {k: float(np.mean(v)) for k, v in res.items()}

if __name__ == "__main__":
    seasons = tuple(int(s) for s in (sys.argv[1].split(",") if len(sys.argv) > 1 else ["2024"]))
    p, fv, df = get_training(seasons)
    model, drivers, coef, mae = fit_eval(df)
    print("rows", len(df), "MAE (5-fold by stint):", {k: round(v, 3) for k, v in mae.items()})
    for c in DRY:
        print(c, "offset", round(coef[f"is_{c}"], 3), "deg/lap", round(coef[f"age_{c}"], 4), "deg2", round(coef[f"age2_{c}"] / 10, 5),
              "laps", int((df.compound == c).sum()), "max age", int(df[df.compound == c].tyre_life.max()) if (df.compound == c).any() else None)
    print("fuel s/lap-remaining", round(coef["fuel_laps"], 4), "track temp", round(coef["track_temp"], 4))
    os.makedirs("model", exist_ok=True)
    joblib.dump({"model": model, "drivers": drivers, "seasons": seasons}, "model/laptime_ridge.pkl")
    json.dump({"coef": coef, "mae": mae, "rows": len(df), "seasons": seasons}, open("model/meta.json", "w"), indent=1)
    if "--register" in sys.argv:
        mr = p.get_model_registry()
        m = mr.python.create_model(name="boxbox_laptime", metrics={"mae_s": round(mae["ridge"], 4), "mae_gbm_s": round(mae["gbm"], 4)},
                                   feature_view=fv, description="Lap time = driver pace + compound offset + per-compound tyre degradation (age, age^2) + fuel + track temp. Ridge, 5-fold GroupKFold by stint.")
        m.save("model"); print("registered", m.name, m.version)
