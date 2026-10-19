"""Push the Hopsworks-registered model's per-lap predictions back to Elastic (index boxbox-predictions): model vs actual for every driver and lap."""
import json, numpy as np, pandas as pd
from elasticsearch import helpers
from fetch_basic import es
IX = "boxbox-predictions"
race = json.load(open("app/static/data/race.json"))
lf = pd.read_parquet("cache/lap_features.parquet"); lf = lf[lf.season == 2024].set_index(["driver_code", "lap_number"])
if not es.indices.exists(index=IX):
    es.indices.create(index=IX, mappings={"properties": {"driver_code": {"type": "keyword"}, "team": {"type": "keyword"}, "lap_number": {"type": "integer"},
        "compound": {"type": "keyword"}, "tyre_age": {"type": "integer"}, "actual_s": {"type": "float"}, "predicted_s": {"type": "float"},
        "residual_s": {"type": "float"}, "clean_lap": {"type": "boolean"}, "pit_lap": {"type": "boolean"}, "model": {"type": "keyword"}}})
docs = []
for d in race["drivers"]:
    v = json.load(open(f"app/static/data/driver_{d['code']}.json"))
    rpc = np.array(v["real_pred_cum"]); pl = np.diff(np.concatenate([[0.0], rpc]))
    for s_i, s in enumerate(d["stints"]):
        for L in range(s["start_lap"], min(s["end_lap"], d["laps_completed"]) + 1):
            key = (d["code"], L); clean = bool(lf.valid_for_training.get(key, 0) == 1)
            pit = s_i < len(d["stints"]) - 1 and L == s["end_lap"]
            act = d["lap_times"][L - 1]
            docs.append({"_index": IX, "_id": f"{d['code']}-{L}", "_source": {"driver_code": d["code"], "team": d["team"], "lap_number": L,
                "compound": s["compound"], "tyre_age": s["start_age"] + L - s["start_lap"], "actual_s": round(act, 3), "predicted_s": round(float(pl[L - 1]), 3),
                "residual_s": round(act - float(pl[L - 1]), 3), "clean_lap": clean, "pit_lap": pit, "model": "boxbox_laptime v1"}})
print(helpers.bulk(es, docs, refresh="wait_for"))
from fetch_basic import esql
print(esql('FROM boxbox-predictions | WHERE clean_lap | STATS mae = AVG(ABS(residual_s)), n = COUNT() | LIMIT 1'))
