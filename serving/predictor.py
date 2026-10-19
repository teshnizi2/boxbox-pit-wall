"""Hopsworks model-serving predictor for boxbox_laptime (numpy only, reads linear.json from the model files)."""
import json, os

class Predict(object):
    def __init__(self):
        base = os.environ.get("MODEL_FILES_PATH") or os.environ.get("ARTIFACT_FILES_PATH", ".")
        m = json.load(open(os.path.join(base, "linear.json")))
        self.b, self.w = m["intercept"], m["coef"]

    def _one(self, x):
        c, a = x["compound"].upper(), float(x["tyre_life"])
        y = self.b + self.w.get(f"is_{c}", 0) + self.w.get(f"age_{c}", 0) * a + self.w.get(f"age2_{c}", 0) * a * a / 10.0
        y += self.w["fuel_laps"] * float(x["laps_remaining"]) + self.w["track_temp"] * float(x.get("track_temperature", 30.0))
        y += self.w.get(f"drv_{x.get('season', 2024)}_{x['driver_code']}", 0)
        return round(y, 3)

    def predict(self, inputs):
        rows = inputs if isinstance(inputs, list) else [inputs]
        return {"predictions": [self._one(r) for r in rows]}
