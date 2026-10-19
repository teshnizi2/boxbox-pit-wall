"""Connectivity check for the hack night. Run after the accounts exist and repo/.env is filled in.

    .venv/bin/python check_setup.py
"""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / "repo" / ".env")


def check_elastic():
    from elasticsearch import Elasticsearch

    url = os.getenv("REMOTE_ELASTICSEARCH_URL", "")
    key = os.getenv("REMOTE_ELASTICSEARCH_API_KEY", "")
    if not url or "your-deployment" in url or not key or key.startswith("your_"):
        return "SKIP  fill REMOTE_ELASTICSEARCH_URL and REMOTE_ELASTICSEARCH_API_KEY in repo/.env"
    es = Elasticsearch(url, api_key=key)
    info = es.info()
    indices = es.cat.indices(index="f1-*", format="json")
    names = ", ".join(sorted(i["index"] for i in indices)) or "none yet (run the Dev Tools reindex)"
    return f"OK    Elastic {info['version']['number']}; f1 indices: {names}"


def check_hopsworks():
    import hopsworks

    key = os.getenv("HOPSWORKS_API_KEY", "")
    if not key:
        return "SKIP  fill HOPSWORKS_API_KEY in repo/.env"
    project = hopsworks.login(
        host=os.getenv("HOPSWORKS_HOST", "eu-west.cloud.hopsworks.ai"),
        port=443,
        project=os.getenv("HOPSWORKS_PROJECT") or None,
        api_key_value=key,
    )
    return f"OK    Hopsworks project: {project.name}"


for label, fn in (("elastic", check_elastic), ("hopsworks", check_hopsworks)):
    try:
        print(f"{label:10}", fn())
    except Exception as exc:  # noqa: BLE001 - a setup check should report, not crash
        print(f"{label:10} FAIL  {type(exc).__name__}: {exc}")
