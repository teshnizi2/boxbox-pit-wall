"""Index the strategy backtest (real team vs optimizer vs Jev, per driver) into Elastic for Kibana."""
import json, pandas as pd
from elasticsearch import helpers
from fetch_basic import es
IX = "boxbox-backtest"
b = pd.read_csv("cache/backtest.csv")
if not es.indices.exists(index=IX):
    es.indices.create(index=IX, mappings={"properties": {"drv": {"type": "keyword"}, "real": {"type": "keyword"}, "opt": {"type": "keyword"}, "jev": {"type": "keyword"},
                                                        "opt_d": {"type": "float"}, "opt1_d": {"type": "float"}, "jev_d": {"type": "float"}, "jev_first_within3": {"type": "boolean"}}})
docs = [{"_index": IX, "_id": r["drv"], "_source": {k: (None if pd.isna(v) else v) for k, v in r.items() if k != "opt1"}} for r in b.to_dict("records")]
print(helpers.bulk(es, docs, refresh="wait_for"))
