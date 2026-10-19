/* BoxBox mock data and local fallbacks: a plausible 2024 Zandvoort race, driver tables, and
   offline answers for every /api/* endpoint. Used with ?mock=1, when data files are missing,
   and whenever the server is down. */
(function () {
  'use strict';
  const E = window.BBEngine;
  const N = 72, PIT = 21.0;
  const OFF = { SOFT: -0.55, MEDIUM: 0, HARD: 0.42 };
  const DEG = { SOFT: 0.09, MEDIUM: 0.05, HARD: 0.03 };
  const CLIFF = { SOFT: 22, MEDIUM: 35, HARD: 48 };
  const COLORS = { 'Red Bull Racing': '#3671C6', McLaren: '#FF8000', Ferrari: '#E8002D', Mercedes: '#27F4D2', 'Aston Martin': '#229971', Alpine: '#FF87BC', Williams: '#64C4FF', RB: '#6692FF', 'Kick Sauber': '#52E252', Haas: '#B6BABD' };
  // code, name, team, grid, pace rank, [start compound, start age, ...[pit lap, compound]]
  const ROSTER = [
    ['NOR', 'Lando Norris', 'McLaren', 1, 0, ['MEDIUM', 1, [28, 'HARD']]],
    ['VER', 'Max Verstappen', 'Red Bull Racing', 2, 1, ['MEDIUM', 1, [27, 'HARD']]],
    ['PIA', 'Oscar Piastri', 'McLaren', 3, 3, ['MEDIUM', 1, [33, 'HARD']]],
    ['RUS', 'George Russell', 'Mercedes', 4, 6, ['MEDIUM', 1, [25, 'HARD'], [54, 'SOFT']]],
    ['PER', 'Sergio Perez', 'Red Bull Racing', 5, 5, ['MEDIUM', 1, [29, 'HARD']]],
    ['LEC', 'Charles Leclerc', 'Ferrari', 6, 2, ['MEDIUM', 1, [24, 'HARD']]],
    ['ALO', 'Fernando Alonso', 'Aston Martin', 7, 9, ['MEDIUM', 1, [31, 'HARD']]],
    ['STR', 'Lance Stroll', 'Aston Martin', 8, 12, ['MEDIUM', 1, [30, 'HARD']]],
    ['GAS', 'Pierre Gasly', 'Alpine', 9, 8, ['MEDIUM', 1, [32, 'HARD']]],
    ['SAI', 'Carlos Sainz', 'Ferrari', 10, 4, ['MEDIUM', 1, [30, 'HARD']]],
    ['TSU', 'Yuki Tsunoda', 'RB', 11, 16, ['SOFT', 1, [14, 'MEDIUM'], [32, 'HARD']]],
    ['HUL', 'Nico Hulkenberg', 'Haas', 12, 10, ['MEDIUM', 1, [14, 'HARD']]],
    ['RIC', 'Daniel Ricciardo', 'RB', 13, 11, ['MEDIUM', 1, [29, 'HARD']]],
    ['HAM', 'Lewis Hamilton', 'Mercedes', 14, 7, ['SOFT', 1, [23, 'HARD'], [48, 'SOFT']]],
    ['OCO', 'Esteban Ocon', 'Alpine', 15, 14, ['MEDIUM', 1, [30, 'HARD']]],
    ['BOT', 'Valtteri Bottas', 'Kick Sauber', 16, 18, ['SOFT', 3, [15, 'HARD'], [43, 'MEDIUM']]],
    ['ZHO', 'Zhou Guanyu', 'Kick Sauber', 17, 19, ['MEDIUM', 1, [18, 'HARD'], [51, 'SOFT']]],
    ['SAR', 'Logan Sargeant', 'Williams', 18, 15, ['MEDIUM', 1, [22, 'HARD']]],
    ['ALB', 'Alexander Albon', 'Williams', 19, 13, ['MEDIUM', 1, [12, 'HARD'], [54, 'MEDIUM']]],
    ['MAG', 'Kevin Magnussen', 'Haas', 20, 17, ['HARD', 2, [40, 'MEDIUM']]],
  ];

  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  const cliffPen = (a, cl) => { const x = a - cl; return x > 0 ? 0.22 * x + 0.035 * x * x : 0; };

  function buildPred(base, cliff, lap1, n) {
    const pred = {};
    for (const c of E.DRY) {
      const tab = [];
      for (let a = 1; a <= 60; a++) {
        const row = new Array(n);
        for (let L = 1; L <= n; L++) row[L - 1] = Math.round((base + 0.034 * (n - L) + OFF[c] + DEG[c] * a + cliffPen(a, cliff[c]) + (L === 1 ? lap1 : 0)) * 1000) / 1000;
        tab.push(row);
      }
      pred[c] = tab;
    }
    return pred;
  }

  function stintsFrom(strat, n) {
    const [c0, a0, ...pits] = strat;
    return E.stintsFromPits({ compound: c0, age: a0 }, pits.map(([lap, compound]) => ({ lap, compound })), n);
  }

  // Exhaustive one- and two-stop search on new tyres from the fixed start set.
  function optimize(dt, start, n, pitLoss) {
    const pre = {};
    for (const c of E.DRY) {
      pre[c] = [];
      for (let s = 1; s <= n + 1; s++) {
        const row = new Array(n + 2).fill(0);
        let t = 0;
        for (let e = s; e <= n; e++) { t += E.predLap(dt, c, e - s + 1, e); row[e] = t; }
        pre[c][s] = row;
      }
    }
    const first = [0];
    for (let L = 1; L <= n; L++) first.push(first[L - 1] + E.predLap(dt, start.compound, start.age + L - 1, L));
    let best = { t: Infinity, pits: [] };
    for (let p = 2; p <= n - 2; p++) for (const c2 of E.DRY) {
      if (c2 === start.compound) continue;
      const t = first[p] + pitLoss + pre[c2][p + 1][n];
      if (t < best.t) best = { t, pits: [{ lap: p, compound: c2 }] };
    }
    for (let p1 = 2; p1 <= n - 4; p1++) for (let p2 = p1 + 2; p2 <= n - 2; p2++) for (const c2 of E.DRY) for (const c3 of E.DRY) {
      if (new Set([start.compound, c2, c3]).size < 2) continue;
      const t = first[p1] + pitLoss + pre[c2][p1 + 1][p2] + pitLoss + pre[c3][p2 + 1][n];
      if (t < best.t) best = { t, pits: [{ lap: p1, compound: c2 }, { lap: p2, compound: c3 }] };
    }
    const stints = E.stintsFromPits(start, best.pits, n);
    return { stints, delta_vs_real: +(best.t - dt.real_pred_cum[n - 1]).toFixed(2) };
  }

  // Local stand-in for Jev (TypeSafe System One): a typed BOX / STAY_OUT call with probabilities.
  function jevLocal(b, ctx) {
    const g = b.gain_if_box || {};
    const mustSwitch = (b.compounds_used || []).length < 2;
    let best = null, bg = -Infinity;
    for (const c of E.DRY) {
      if (!(c in g)) continue;
      if (mustSwitch && c === b.compound) continue;
      if (g[c] > bg) { bg = g[c]; best = c; }
    }
    if (!best) { best = b.compound === 'HARD' ? 'MEDIUM' : 'HARD'; bg = 0; }
    const cliff = (ctx && ctx.cliff) || CLIFF[b.compound] || 35;
    const cliff_risk = E.clamp((b.age - (cliff - 8)) / 10, 0, 1);
    const gb = E.ok(b.gap_behind) ? b.gap_behind : 3;
    const undercut = E.clamp((2.2 - gb) / 2.2, 0, 1) * E.clamp(b.age / 14, 0, 1);
    const z = bg / 1.2 + 1.8 * (cliff_risk - 0.6) + 0.7 * undercut - 0.4;
    let p = 1 / (1 + Math.exp(-z));
    if (b.laps_left < 2) p = 0;
    if (mustSwitch && b.laps_left <= 3 && b.laps_left >= 1) p = Math.max(p, 0.95);
    return { call: p >= 0.5 ? 'BOX_' + best : 'STAY_OUT', p_box: +p.toFixed(2), cliff_risk: +cliff_risk.toFixed(2), undercut: +undercut.toFixed(2), ms: 0 };
  }

  function jevRun(dt, start, n, pitLoss) {
    let comp = start.compound, age = start.age;
    const used = new Set([comp]), pits = [], calls = [];
    for (let L = 1; L <= n; L++) {
      const gain = E.gainIfBox(dt, comp, age, L, n, pitLoss, used.size);
      const r = jevLocal({ lap: L, laps_left: n - L, compound: comp, age, gap_behind: 3, compounds_used: Array.from(used), gain_if_box: gain }, { cliff: dt.cliff[comp] });
      calls.push({ lap: L, call: r.call, p_box: r.p_box, cliff_risk: r.cliff_risk, undercut: r.undercut });
      if (r.call !== 'STAY_OUT' && L < n && pits.length < 3) {
        const c = r.call.slice(4);
        pits.push({ lap: L, compound: c }); comp = c; age = 1; used.add(c);
      } else age++;
    }
    const stints = E.stintsFromPits(start, pits, n);
    const pc = E.predCum(dt, stints, pitLoss, n);
    return { stints, delta_vs_real: +(pc[n - 1] - dt.real_pred_cum[n - 1]).toFixed(2), calls };
  }

  function finishTable(dt, rd, n, pitLoss) {
    dt.real_pred_cum = E.predCum(dt, rd.stints, pitLoss, n);
    try { dt.optimizer = optimize(dt, dt.start, n, pitLoss); } catch (e) { dt.optimizer = { stints: rd.stints, delta_vs_real: 0 }; }
    try { dt.jev = jevRun(dt, dt.start, n, pitLoss); } catch (e) { dt.jev = { stints: rd.stints, delta_vs_real: 0, calls: [] }; }
    return dt;
  }

  // Driver table for a REAL race.json driver when driver_{CODE}.json is not there yet.
  function synthTable(rd, race) {
    const n = E.nLaps(rd), pitLoss = race.pit_loss_s;
    const plan = E.lapPlan(rd.stints, n);
    const clean = [];
    for (let L = 2; L <= Math.min(n, rd.laps_completed || n); L++) {
      if (plan.pit[L] || plan.pit[L - 1]) continue;
      const v = rd.lap_times[L - 1];
      if (E.ok(v)) clean.push(v - (0.034 * (n - L) + OFF[plan.comp[L]] + DEG[plan.comp[L]] * plan.age[L] + cliffPen(plan.age[L], CLIFF[plan.comp[L]] || 35)));
    }
    clean.sort((a, b) => a - b);
    const base = clean.length ? clean[Math.floor(clean.length / 2)] : 74;
    const c0 = plan.comp[1], a0 = plan.age[1];
    const lap1 = Math.max(0, (rd.lap_times[0] || base + 5) - (base + 0.034 * (n - 1) + OFF[c0] + DEG[c0] * a0));
    const dt = { code: rd.code, start: { compound: c0, age: a0 }, cliff: Object.assign({}, CLIFF), pred: buildPred(base, CLIFF, lap1, n), deg_note: 'Soft +0.09 s/lap, Medium +0.05, Hard +0.03 (estimated)', synthetic: true };
    return finishTable(dt, rd, n, pitLoss);
  }

  // A whole mock race: 20 drivers, track, and their driver tables.
  function makeRace() {
    const r = rng(20240825);
    const track = mockTrack();
    const drivers = [], tables = {};
    for (const [code, name, team, grid, rank, strat] of ROSTER) {
      const base = 73.3 + 0.12 * rank + 0.05 * gauss(r);
      const cliff = { SOFT: CLIFF.SOFT + Math.round(gauss(r)), MEDIUM: CLIFF.MEDIUM + Math.round(gauss(r) * 1.5), HARD: CLIFF.HARD + Math.round(gauss(r) * 2) };
      const lap1 = 4.4 + 0.32 * (grid - 1);
      const stints = stintsFrom(strat, N);
      const dt = { code, start: { compound: stints[0].compound, age: stints[0].start_age }, cliff, pred: buildPred(base, cliff, lap1, N), deg_note: 'Soft +0.09 s/lap, Medium +0.05, Hard +0.03' };
      const plan = E.lapPlan(stints, N);
      const lap_times = [], cum = [];
      let t = 0;
      for (let L = 1; L <= N; L++) {
        const v = E.predLap(dt, plan.comp[L], plan.age[L], L) + (plan.pit[L] ? PIT : 0) + 0.22 * gauss(r);
        lap_times.push(Math.round(v * 1000) / 1000);
        t += lap_times[L - 1];
        cum.push(Math.round(t * 1000) / 1000);
      }
      const rd = { code, name, team, color: COLORS[team], grid, finish: 0, lap_times, cum, stints, laps_completed: N, status: 'Finished' };
      // real_pred_cum must match the cars' real model so a replay gives delta 0
      drivers.push(rd);
      tables[code] = dt;
    }
    drivers.slice().sort((a, b) => a.cum[N - 1] - b.cum[N - 1]).forEach((d, i) => (d.finish = i + 1));
    const race = { season: 2024, event: 'Dutch Grand Prix', laps_total: N, pit_loss_s: PIT, track, drivers, mock: true };
    for (const d of drivers) finishTable(tables[d.code], d, N, PIT);
    return { race, tables };
  }

  // A closed, Zandvoort-like loop in screen coordinates (x right, y down, 0..1000).
  function mockTrack() {
    const pts = [];
    const M = 400;
    for (let i = 0; i < M; i++) {
      const t = (i / M) * Math.PI * 2;
      const r = 1 + 0.22 * Math.sin(2 * t + 0.6) + 0.1 * Math.cos(3 * t + 0.3) + 0.06 * Math.sin(5 * t);
      pts.push([Math.cos(t) * r * 1.25, Math.sin(t) * r * 0.85]);
    }
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const [x, y] of pts) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    const s = 1000 / Math.max(maxx - minx, maxy - miny);
    const path = pts.map(([x, y]) => [Math.round((x - minx) * s * 10) / 10, Math.round((y - miny) * s * 10 + (1000 - (maxy - miny) * s) * 5) / 10]);
    const seg = [0];
    for (let i = 1; i < path.length; i++) seg.push(seg[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    const total = seg[seg.length - 1] + Math.hypot(path[0][0] - path[path.length - 1][0], path[0][1] - path[path.length - 1][1]);
    return { path, frac: seg.map((v) => Math.round((v / total) * 10000) / 10000) };
  }

  // ---------- local answers for /api/* ----------
  const NAME = { SOFT: 'softs', MEDIUM: 'mediums', HARD: 'hards' };
  function radioLine(b) {
    const d = b.detail || {};
    switch (b.event) {
      case 'start': return `Radio check. Lights out at Zandvoort. We start P${d.grid || '-'} on the ${NAME[d.compound] || 'tyres'}. Look after them through turn 3.`;
      case 'box': return `Box, box. Box this lap for ${NAME[d.compound] || 'new tyres'}. Pit lane is clear.`;
      case 'cliff': return `Tyres are past the cliff, ${d.age || ''} laps old. Lap times are dropping. Your call on the stop.`;
      case 'final_lap': return `Final lap. You are P${d.position || '-'}. Bring it home.`;
      default: return 'Copy.';
    }
  }
  function debriefText(b) {
    const gained = (b.real_finish || 0) - (b.finish || 0);
    const pos = b.finish ? `P${b.finish}` : 'a disqualification';
    const vs = gained > 0 ? `${gained} place${gained > 1 ? 's' : ''} better than the real team` : gained < 0 ? `${-gained} place${gained < -1 ? 's' : ''} worse than the real team` : 'the same place as the real team';
    const dl = (x) => (x > 0 ? '+' : '') + Number(x || 0).toFixed(1) + ' s';
    return `${b.player_name || 'You'} brought ${b.driver} home in ${pos}, ${vs}. Your stints (${E.stintsLabel(b.stints)}) finished ${dl(b.delta_s)} against the real strategy. The optimizer would have been ${dl(b.optimizer_delta)} and Jev ${dl(b.jev_delta)}.`;
  }
  function askAnswer(q) {
    return {
      answer: `Offline answer: in this race the medium-to-hard one-stop around lap 25 to 30 was the common call. Softs fell off after about 20 laps, hards held their pace for more than 40. Ask again when the pit wall is online for a live answer from Elastic.`,
      conversation_id: 'local',
      esql: [
        'FROM f1-laps | WHERE event == "Dutch Grand Prix" AND season == 2024 | STATS avg_lap = AVG(lap_time) BY compound',
        'FROM f1-laps | WHERE event == "Dutch Grand Prix" AND season == 2024 AND pit_in == true | STATS stops = COUNT(*) BY lap | SORT stops DESC | LIMIT 5',
      ],
      question: q,
    };
  }
  const SEED_RUNS = [
    { player_name: 'Femke', driver: 'VER', stints: [{ compound: 'MEDIUM', start_lap: 1, end_lap: 22, start_age: 1 }, { compound: 'HARD', start_lap: 23, end_lap: 72, start_age: 1 }] },
    { player_name: 'Joost', driver: 'LEC', stints: [{ compound: 'MEDIUM', start_lap: 1, end_lap: 30, start_age: 1 }, { compound: 'HARD', start_lap: 31, end_lap: 72, start_age: 1 }] },
    { player_name: 'Priya', driver: 'HAM', stints: [{ compound: 'SOFT', start_lap: 1, end_lap: 18, start_age: 1 }, { compound: 'HARD', start_lap: 19, end_lap: 72, start_age: 1 }] },
  ];

  window.BoxBoxMock = { makeRace, synthTable, optimize, jevLocal, radioLine, debriefText, askAnswer, SEED_RUNS, CLIFF };
})();
