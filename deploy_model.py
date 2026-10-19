"""Register boxbox_laptime v2 (same model + JSON export) and deploy it on Hopsworks model serving."""
import time, hw, json
p = hw.project(); mr = p.get_model_registry(); fs = p.get_feature_store()
fv = fs.get_feature_view("laptime_fv", version=1)
meta = json.load(open("model/meta.json"))
m = mr.python.create_model(name="boxbox_laptime", metrics={"mae_s": round(meta["mae"]["ridge"], 4)}, feature_view=fv,
                           description="v2: same Ridge model as v1 plus linear.json (numpy-only serving)")
m.save("model"); print("model version", m.version)
ds = p.get_dataset_api(); path = ds.upload("serving/predictor.py", "Resources", overwrite=True); print("uploaded", path)
t = time.time()
dep = m.deploy(name="boxboxlaptime", script_file=path, description="BoxBox lap-time model (numpy predictor)")
print("deployment created", dep.name, round(time.time() - t, 1), "s")
dep.start(await_running=600); print("running", round(time.time() - t, 1), "s")
print(dep.predict(inputs=[{"driver_code": "VER", "compound": "HARD", "tyre_life": 10, "laps_remaining": 30, "track_temperature": 30.0}]))
