import hopsworks
from dotenv import dotenv_values
def project():
    e = dotenv_values("repo/.env")
    return hopsworks.login(host=e["HOPSWORKS_HOST"], project=e["HOPSWORKS_PROJECT"], api_key_value=e["HOPSWORKS_API_KEY"])
