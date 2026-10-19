"""Pull laps, weather, results, sessions from Elastic into cache/*.parquet"""
import pandas as pd
from dotenv import dotenv_values
from elasticsearch import Elasticsearch
e = dotenv_values("repo/.env")
es = Elasticsearch(e["REMOTE_ELASTICSEARCH_URL"], api_key=e["REMOTE_ELASTICSEARCH_API_KEY"], request_timeout=120)
def esql(q):
    r = es.esql.query(query=q, format="json")
    return pd.DataFrame(r["values"], columns=[c["name"] for c in r["columns"]])
if __name__ == "__main__":
    for ix in ["laps", "weather", "results", "sessions"]:
        df = esql(f"FROM f1-{ix} | LIMIT 10000")
        df.to_parquet(f"cache/{ix}.parquet"); print(ix, df.shape)
