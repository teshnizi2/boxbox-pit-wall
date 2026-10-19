"""'Who drives like X?': nearest neighbours in the Hopsworks driver_style embedding index (vector search in the feature store)."""
import pandas as pd, hw
_fg, _ds = None, None

def _load():
    global _fg, _ds
    if _fg is None:
        _fg = hw.project().get_feature_store().get_feature_group("driver_style", version=1)
        _ds = pd.read_parquet("cache/driver_style.parquet")
    return _fg, _ds

def similar(code, season=2024, k=4):
    fg, ds = _load()
    me = ds[(ds.season == season) & (ds.driver_code == code)]
    if me.empty: return []
    names = [f.name for f in fg.features]
    out = []
    for dist, row in fg.find_neighbors(me.style_vec.iloc[0], k=k + 1):
        r = dict(zip([n for n in names if n != "style_vec"][: len(row)], row)) if len(row) < len(names) else dict(zip(names, row))
        hit = ds[ds.samples == r.get("samples")] if "samples" in r else ds.iloc[0:0]
        if not hit.empty:
            h = hit.iloc[0]
            if not (h.driver_code == code and h.season == season):
                out.append({"driver_code": h.driver_code, "season": int(h.season), "distance": round(float(dist), 3)})
    return out[:k]

if __name__ == "__main__":
    fg, _ = _load(); print([f.name for f in fg.features])
    for c in ["VER", "NOR", "HAM"]: print(c, similar(c))
