"""Game tables, optimizer and the Jev pit wall (TypeSafe System One) for the 2024 Dutch GP."""
import asyncio, json, sys, time, numpy as np, pandas as pd, joblib
import train

DRY, AGES = train.DRY, 60
race = json.load(open("app/static/data/race.json"))
T, PIT = race["laps_total"], race["pit_loss_s"]
M = joblib.load("model/laptime_ridge.pkl")
lf = pd.read_parquet("cache/lap_features.parquet")
l24 = lf[lf.season == 2024]
TEMP = l24.groupby("lap_number").track_temperature.median().reindex(range(1, T + 1)).ffill().bfill()
CLIFF = {c: int(l24[l24.compound == c].tyre_life.max()) + 2 for c in DRY}
DRV = {d["code"]: d for d in race["drivers"]}

def cliff_pen(c, a):
    over = max(0, a - CLIFF[c]); return min(4.0, 0.04 * over * over + 0.3 * over)   # tyre cliff: grows fast, capped at +4 s/lap

def pred_table(code):
    g = pd.MultiIndex.from_product([DRY, range(1, AGES + 1), range(1, T + 1)], names=["compound", "tyre_life", "lap_number"]).to_frame(index=False)
    g["season"], g["driver_code"] = 2024, code
    g["laps_remaining"] = T - g.lap_number
    g["track_temperature"] = TEMP.loc[g.lap_number].values
    p = M["model"].predict(train.design(g, M["drivers"])).reshape(len(DRY), AGES, T)
    return {c: p[i] + np.array([cliff_pen(c, a) for a in range(1, AGES + 1)])[:, None] for i, c in enumerate(DRY)}

def strat_laps(tab, stints):
    out = np.zeros(T)
    for i, s in enumerate(stints):
        for L in range(s["start_lap"], s["end_lap"] + 1):
            out[L - 1] = tab[s["compound"]][min(AGES, s["start_age"] + L - s["start_lap"]) - 1, L - 1]
        if i < len(stints) - 1: out[s["end_lap"] - 1] += PIT
    return out

def stints_from(c0, a0, stops):
    """stops: list of (pit_lap, compound)"""
    st, cur, start, age = [], c0, 1, a0
    for L, c in stops:
        st.append({"compound": cur, "start_lap": start, "end_lap": L, "start_age": age}); cur, start, age = c, L + 1, 1
    st.append({"compound": cur, "start_lap": start, "end_lap": T, "start_age": age})
    return st

def label(st): return "-".join(f"{s['compound'][0]}{s['end_lap']}" for s in st)

def optimize(tab, c0, a0):
    first = np.cumsum([tab[c0][min(AGES, a0 + k) - 1, k] for k in range(T)])
    D = {c: {s: np.cumsum([tab[c][min(AGES, 1 + k) - 1, s - 1 + k] for k in range(T - s + 1)]) for s in range(2, T + 1)} for c in DRY}
    best1, best2 = (1e9, None), (1e9, None)
    for L1 in range(5, T - 3):
        t1 = first[L1 - 1] + PIT
        for c1 in DRY:
            if c1 != c0:
                tot = t1 + D[c1][L1 + 1][T - L1 - 1]
                if tot < best1[0]: best1 = (tot, [(L1, c1)])
            for L2 in range(L1 + 6, T - 3):
                t2 = t1 + D[c1][L1 + 1][L2 - L1 - 1] + PIT
                for c2 in DRY:
                    if len({c0, c1, c2}) < 2: continue
                    tot = t2 + D[c2][L2 + 1][T - L2 - 1]
                    if tot < best2[0]: best2 = (tot, [(L1, c1), (L2, c2)])
    return best1, best2

# ---------------- Jev ----------------
def _q():
    from typesafe_sdk import Choice, Noul, Score
    return {
        "call": Choice(instructions="You are the race strategist on the pit wall at Zandvoort (Dutch GP 2024). Using `state`, make this lap's call for our car: stay out, or box at the end of this lap for a new set of the given compound. The main evidence is `state.model_seconds_saved_if_box_now`: seconds our lap-time model says boxing now onto each compound saves versus the best plan that stays out (positive means boxing now is faster, negative means a later stop is better). Usually stay out while it is negative. Also weigh the tyre cliff, an undercut threat from the car behind, and that Zandvoort is very hard to overtake on, so rejoining behind several cars (`state.cars_we_would_rejoin_behind`) costs extra time the model does not count.",
                       criteria={"STAY_OUT": None, "BOX_SOFT": None, "BOX_MEDIUM": None, "BOX_HARD": None}),
        "cliff": Score(instructions="How close are our current tyres to the performance cliff, given `state.tyre_age_laps`, `state.laps_until_cliff` and `state.pace_lost_to_wear_s`?",
                       criteria=["fresh, plenty of life left", "worn but stable", "close to the cliff", "at or past the cliff, losing lots of time"]),
        "undercut": Noul(instructions="Could the car directly behind us (`state.gap_behind_s` seconds back) pass us by pitting first (an undercut) if we stay out this lap? It is a real threat when the gap is small (under about 3 seconds) and our tyres are old."),
    }

def make_ctx(tab):
    """D[c][s][n-1] = time of an n-lap stint on new compound c starting at lap s; F = best time to the flag from lap s on new c with <=1 more stop."""
    D = {c: {s: np.cumsum([tab[c][min(AGES, 1 + k) - 1, s - 1 + k] for k in range(T - s + 1)]) for s in range(1, T + 1)} for c in DRY}
    Fok, Fnot = {}, {}
    for s in range(1, T + 1):
        for c in DRY:
            best_ok, best_not = D[c][s][T - s], np.inf
            for L3 in range(s + 4, T - 3):
                part = D[c][s][L3 - s] + PIT
                for c3 in DRY:
                    v = part + D[c3][L3 + 1][T - L3 - 1]
                    best_ok = min(best_ok, v)
                    if c3 != c: best_not = min(best_not, v)
            Fok[(s, c)], Fnot[(s, c)] = best_ok, best_not
    return {"tab": tab, "D": D, "Fok": Fok, "Fnot": Fnot}

def box_values(ctx, L, cur, age, used):
    """seconds saved by boxing at the end of lap L onto each compound, vs the best plan that stays out now (>0 = box now is faster)"""
    if L >= T - 2: return {c: None for c in DRY}
    tab, Fok, Fnot = ctx["tab"], ctx["Fok"], ctx["Fnot"]
    F = lambda s, c, u: Fok[(s, c)] if len(u) >= 2 else Fnot[(s, c)]
    box = {c: PIT + F(L + 1, c, used | {c}) for c in DRY}
    run = np.cumsum([tab[cur][min(AGES, age + k) - 1, L + k - 1] for k in range(1, T - L + 1)])
    stay = run[-1] if len(used) >= 2 else np.inf
    for L2 in range(L + 1, T - 3):
        base = run[L2 - L - 1] + PIT
        for c2 in DRY:
            stay = min(stay, base + F(L2 + 1, c2, used | {c2}))
    return {c: (round(float(stay - box[c]), 1) if np.isfinite(stay - box[c]) else None) for c in DRY}

def jev_state(ctx, lap, compound, age, compounds_used, stops, position, gap_ahead, gap_behind, rejoin_behind):
    tab = ctx["tab"]; used = set(compounds_used)
    wear = float(tab[compound][min(AGES, age) - 1, lap - 1] - tab[compound][0, lap - 1])
    saved = box_values(ctx, lap, compound, age, used)
    best = max((c for c in DRY if saved[c] is not None), key=lambda c: saved[c], default=None)
    return {"track": "Zandvoort, Dutch GP 2024: narrow, banked, one of the hardest tracks to overtake on", "lap": lap, "laps_remaining": T - lap,
            "current_compound": compound, "tyre_age_laps": age, "laps_until_cliff": CLIFF[compound] - age, "pace_lost_to_wear_s": round(wear, 2),
            "pit_stop_time_loss_s": PIT, "model_seconds_saved_if_box_now": saved, "best_compound_if_box_now": best,
            "position": position, "gap_ahead_s": None if gap_ahead is None else round(gap_ahead, 1),
            "gap_behind_s": None if gap_behind is None else round(gap_behind, 1), "cars_we_would_rejoin_behind": rejoin_behind,
            "compounds_used": sorted(used), "two_compound_rule_satisfied": len(used) >= 2, "stops_made": stops}

def parse(r):
    ch = r.choices["call"]; pr = dict(ch.probabilities) if ch.probabilities else {}
    sc = r.scores["cliff"]
    return {"call": ch.choice, "p_box": round(1 - float(pr.get("STAY_OUT", 1.0 if ch.choice == "STAY_OUT" else 0.0)), 3),
            "cliff_risk": round(float(sc.score) / 3.0, 3), "undercut": round(float(r.nouls["undercut"].noul), 3)}

def ask_jev(state):
    from typesafe_sdk import TypeSafeClient
    t = time.time()
    with TypeSafeClient() as c:
        out = parse(c.system_one(state=state, questions=_q()))
    out["ms"] = int((time.time() - t) * 1000); return out

def policy(j, lap, since_stop, rule_ok):
    """code owns the rules, Jev supplies the judgment"""
    if lap >= T - 3: return None
    if j and j["call"] != "STAY_OUT" and j["p_box"] >= 0.5 and since_stop >= 5:
        c = j["call"].split("_")[1]; return c
    return None

async def jev_ghost(client, sem, code, ctx, real_pred_cum):
    tab = ctx["tab"]
    d = DRV[code]; c0, a0 = d["stints"][0]["compound"], d["stints"][0]["start_age"]
    others = np.array([o["cum"] for o in race["drivers"] if o["code"] != code])
    cur, age, used, stops, since, cum, calls = c0, a0, {c0}, [], 0, 0.0, []
    Q = _q()
    for L in range(1, T + 1):
        cum += tab[cur][min(AGES, age) - 1, L - 1]
        me = d["cum"][L - 1] + (cum - real_pred_cum[L - 1])
        o = others[:, L - 1]; ahead = o[o < me]; behind = o[o > me]
        pos = 1 + len(ahead)
        j = None
        if 6 <= L <= T - 4:
            rejoin = int(((behind > me) & (behind < me + PIT)).sum())
            st = jev_state(ctx, L, cur, age, used, len(stops), pos, me - ahead.max() if len(ahead) else None, behind.min() - me if len(behind) else None, rejoin)
            async with sem:
                for attempt in range(2):
                    try:
                        j = parse(await client.system_one(state=st, questions=Q)); break
                    except Exception as e:
                        j = None; await asyncio.sleep(0.5)
            if j: calls.append({"lap": L, **j})
        box = policy(j, L, since, len(used) >= 2)
        if L == T - 4 and len(used) < 2:
            box = "HARD" if cur != "HARD" else "MEDIUM"     # forced by the two-compound rule
        if box:
            stops.append((L, box)); cum += PIT; cur, age, since = box, 1, 0; used.add(box)
        else:
            age += 1; since += 1
    return code, stints_from(c0, a0, stops), calls

def main(with_jev=True):
    tabs, out = {}, {}
    t0 = time.time()
    for d in race["drivers"]:
        code = d["code"]; tab = tabs[code] = pred_table(code)
        rp = strat_laps(tab, d["stints"]); rpc = np.cumsum(rp)
        c0, a0 = d["stints"][0]["compound"], d["stints"][0]["start_age"]
        (t1, s1), (t2, s2) = optimize(tab, c0, a0)
        best = (t1, s1) if t1 <= t2 else (t2, s2)
        opt_st = stints_from(c0, a0, best[1])
        out[code] = {"code": code, "start": {"compound": c0, "age": a0}, "cliff": CLIFF,
                     "pred": {c: np.round(tab[c], 3).tolist() for c in DRY}, "real_pred_cum": np.round(rpc, 3).tolist(),
                     "real_label": label(d["stints"]),
                     "deg_note": "Pace lost after 20 laps: " + ", ".join(f"{c.title()} +{tab[c][20, 40] - tab[c][0, 40]:.1f} s" for c in DRY),
                     "optimizer": {"stints": opt_st, "label": label(opt_st), "delta_vs_real": round(float(best[0] - rpc[-1]), 2),
                                   "best_one_stop": {"stints": stints_from(c0, a0, s1), "label": label(stints_from(c0, a0, s1)), "delta_vs_real": round(float(t1 - rpc[-1]), 2)}},
                     "jev": None}
    print("tables+optimizer", round(time.time() - t0, 1), "s")
    if with_jev:
        from typesafe_sdk import AsyncTypeSafeClient
        async def run():
            sem = asyncio.Semaphore(20)
            async with AsyncTypeSafeClient() as client:
                return await asyncio.gather(*[jev_ghost(client, sem, d["code"], make_ctx(tabs[d["code"]]), out[d["code"]]["real_pred_cum"]) for d in race["drivers"]])
        t0 = time.time(); res = asyncio.run(run()); print("jev ghosts", round(time.time() - t0, 1), "s")
        for code, st, calls in res:
            jp = np.cumsum(strat_laps(tabs[code], st))
            out[code]["jev"] = {"stints": st, "label": label(st), "delta_vs_real": round(float(jp[-1] - out[code]["real_pred_cum"][-1]), 2), "calls": calls}
        json.dump({k: v["jev"] for k, v in out.items()}, open("cache/jev_ghosts.json", "w"))
    else:
        try:
            cached = json.load(open("cache/jev_ghosts.json"))
            for k, v in cached.items(): out[k]["jev"] = v
        except FileNotFoundError: pass
    for code, v in out.items():
        json.dump(v, open(f"app/static/data/driver_{code}.json", "w"))
    # backtest summary
    rows = []
    for d in race["drivers"]:
        v = out[d["code"]]; real_first = d["stints"][0]["end_lap"]
        rows.append({"drv": d["code"], "real": v["real_label"], "opt": v["optimizer"]["label"], "opt_d": v["optimizer"]["delta_vs_real"],
                     "opt1": v["optimizer"]["best_one_stop"]["label"], "opt1_d": v["optimizer"]["best_one_stop"]["delta_vs_real"],
                     "jev": v["jev"]["label"] if v["jev"] else None, "jev_d": v["jev"]["delta_vs_real"] if v["jev"] else None,
                     "jev_first_within3": (abs(v["jev"]["stints"][0]["end_lap"] - real_first) <= 3) if v["jev"] else None})
    bt = pd.DataFrame(rows); bt.to_csv("cache/backtest.csv", index=False); print(bt.to_string())
    print("CLIFF", CLIFF, "PIT", PIT)

if __name__ == "__main__":
    main(with_jev="--no-jev" not in sys.argv)
