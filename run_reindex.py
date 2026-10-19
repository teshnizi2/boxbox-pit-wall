"""Run repo/docs/reindex-all.kibana.txt against our Elastic project via the python client (keys from repo/.env, never printed)."""
import os, re, json, sys
from dotenv import dotenv_values
from elasticsearch import Elasticsearch

env = dotenv_values("repo/.env")
src_url, src_key = env["SOURCE_ES_URL"], env["SOURCE_ES_READONLY_KEY"]

if "--test" in sys.argv:
    s = Elasticsearch(src_url, api_key=src_key, request_timeout=30)
    for ix in ["f1-sessions-lite","f1-results-lite","f1-laps-lite","f1-weather-lite","f1-telemetry-lite"]:
        try: print(ix, s.count(index=ix)["count"])
        except Exception as e: print(ix, "ERR", type(e).__name__, str(e)[:150])
    sys.exit()

es = Elasticsearch(env["REMOTE_ELASTICSEARCH_URL"], api_key=env["REMOTE_ELASTICSEARCH_API_KEY"], request_timeout=120)
txt = open("repo/docs/reindex-all.kibana.txt").read()
txt = txt.replace("${SOURCE_CLUSTER_URL}", src_url).replace("${ELASTICSEARCH_API_KEY}", src_key)
lines = [l for l in txt.splitlines() if not l.lstrip().startswith("#")]
blocks, cur = [], None
for l in lines:
    m = re.match(r"^(GET|PUT|POST|DELETE)\s+(\S+)\s*$", l)
    if m:
        cur = {"m": m.group(1), "p": m.group(2), "b": []}; blocks.append(cur)
    elif cur is not None and l.strip():
        cur["b"].append(l)
for b in blocks:
    body = json.loads("\n".join(b["b"])) if b["b"] else None
    path = "/" + b["p"].lstrip("/")
    r = es.perform_request(b["m"], path, body=body, headers={"accept":"application/json","content-type":"application/json"})
    out = r.body if hasattr(r, "body") else r
    task = out.get("task") if isinstance(out, dict) else None
    print(b["m"], b["p"], "-> task " + task if task else "ok")
