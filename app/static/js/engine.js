/* BoxBox game math. Pure functions, shared by the UI and the mock data. See app/CONTRACT.md. */
(function () {
  'use strict';
  const DRY = ['SOFT', 'MEDIUM', 'HARD'];
  const ok = (x) => typeof x === 'number' && isFinite(x);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  function nLaps(d) {
    const c = (d && d.cum) || [];
    let n = 0;
    while (n < c.length && ok(c[n])) n++;
    return n;
  }

  // Per-lap compound, tyre age and "pit at end of this lap" for laps 1..N (index = lap).
  function lapPlan(stints, N) {
    const comp = new Array(N + 2).fill(null), age = new Array(N + 2).fill(0), pit = new Array(N + 2).fill(false);
    const ss = (stints || []).slice().sort((a, b) => a.start_lap - b.start_lap);
    ss.forEach((s, i) => {
      const a0 = ok(s.start_age) ? s.start_age : 1;
      for (let L = Math.max(1, s.start_lap); L <= Math.min(N, s.end_lap); L++) {
        comp[L] = s.compound;
        age[L] = a0 + (L - s.start_lap);
      }
      if (i < ss.length - 1 && s.end_lap >= 1 && s.end_lap <= N) pit[s.end_lap] = true;
    });
    for (let L = 1; L <= N; L++) {
      if (!comp[L]) {
        comp[L] = comp[L - 1] || (ss[0] && ss[0].compound) || 'MEDIUM';
        age[L] = (age[L - 1] || 0) + 1;
      }
    }
    return { comp, age, pit };
  }

  function table(dt, c) {
    const p = dt.pred || {};
    return p[c] || p.MEDIUM || p[Object.keys(p)[0]];
  }

  // pred[c][age-1][lap-1]; ages beyond the table are clamped to its last row.
  function predLap(dt, c, age, L) {
    const tab = table(dt, c);
    if (!tab || !tab.length) return 0;
    const a = clamp(Math.round(age), 1, tab.length);
    for (let k = a - 1; k >= 0; k--) {
      const r = tab[k];
      if (r && ok(r[L - 1])) return r[L - 1];
    }
    return 0;
  }

  function predCum(dt, stints, pitLoss, N) {
    const p = lapPlan(stints, N);
    const out = new Array(N);
    let s = 0;
    for (let L = 1; L <= N; L++) {
      s += predLap(dt, p.comp[L], p.age[L], L) + (p.pit[L] ? pitLoss : 0);
      out[L - 1] = s;
    }
    return out;
  }

  // player_cum(L) = driver.cum[L-1] + (player_pred_cum(L) - real_pred_cum[L-1])
  function carCum(rd, dt, stints, pitLoss) {
    const N = nLaps(rd);
    const pc = predCum(dt, stints, pitLoss, N);
    const out = new Array(N);
    for (let i = 0; i < N; i++) {
      const rp = dt.real_pred_cum && dt.real_pred_cum[i];
      out[i] = rd.cum[i] + (pc[i] - (ok(rp) ? rp : pc[i]));
    }
    return out;
  }

  // Position at lap L among the other drivers' real cum[L-1].
  function posAt(race, code, myTime, L) {
    let p = 1;
    for (const d of race.drivers) {
      if (d.code === code) continue;
      const t = d.cum[L - 1];
      if (ok(t) && t < myTime) p++;
    }
    return p;
  }

  // Final classification with one driver's real car replaced by a strategy (cum array).
  function classify(race, code, myCum) {
    const N = race.laps_total || 72;
    const rows = race.drivers.map((d) => {
      const mine = d.code === code;
      const cum = mine ? myCum : d.cum;
      const n = Math.min(N, cum.length);
      return { code: d.code, d, mine, time: cum[n - 1], laps: n };
    });
    rows.sort((a, b) => b.laps - a.laps || a.time - b.time);
    rows.forEach((r, i) => (r.pos = i + 1));
    return rows;
  }

  function stintsFromPits(start, pits, N) {
    const ps = pits.slice().sort((a, b) => a.lap - b.lap);
    const out = [];
    let cur = { compound: start.compound, start_lap: 1, start_age: start.age || 1 };
    for (const p of ps) {
      cur.end_lap = p.lap;
      out.push(cur);
      cur = { compound: p.compound, start_lap: p.lap + 1, start_age: 1 };
    }
    cur.end_lap = N;
    out.push(cur);
    return out.filter((s) => s.end_lap >= s.start_lap);
  }

  function compoundsUsed(stints) {
    return Array.from(new Set((stints || []).map((s) => s.compound)));
  }

  // Time saved by boxing now (end of lap L) onto each compound, vs the best later option.
  function gainIfBox(dt, comp, age, L, N, pitLoss, usedCount) {
    const out = {};
    if (L >= N) { DRY.forEach((c) => (out[c] = -pitLoss)); return out; }
    // stay-out prefix: cost of laps L+1..p on the current set
    const stay = [0];
    for (let l = L + 1; l <= N; l++) stay.push(stay[stay.length - 1] + predLap(dt, comp, age + (l - L), l));
    for (const X of DRY) {
      // new set of X from lap s to N
      const fromLap = (s) => { let t = 0; for (let l = s; l <= N; l++) t += predLap(dt, X, l - s + 1, l); return t; };
      const nowCost = pitLoss + fromLap(L + 1);
      let best = Infinity;
      for (let p = L + 1; p <= N - 1; p += 1) {
        const c = stay[p - L] + pitLoss + fromLap(p + 1);
        if (c < best) best = c;
      }
      if (usedCount >= 2) best = Math.min(best, stay[N - L]);
      out[X] = +(best - nowCost).toFixed(2);
    }
    return out;
  }

  function stintsLabel(stints) {
    const L = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };
    return (stints || []).map((s) => (L[s.compound] || '?') + ' ' + s.start_lap + '-' + s.end_lap).join(' · ');
  }

  window.BBEngine = { DRY, ok, clamp, nLaps, lapPlan, predLap, predCum, carCum, posAt, classify, stintsFromPits, compoundsUsed, gainIfBox, stintsLabel };
})();
