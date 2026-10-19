/* BoxBox: Beat the Pit Wall. UI, race loop and API wiring. Math lives in js/engine.js. */
(function () {
  'use strict';
  const E = window.BBEngine, M = window.BoxBoxMock;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CMP = {
    SOFT: { l: 'S', name: 'Soft', color: '#ff4b55' },
    MEDIUM: { l: 'M', name: 'Medium', color: '#f5c518' },
    HARD: { l: 'H', name: 'Hard', color: '#f2f2f2' },
    INTERMEDIATE: { l: 'I', name: 'Inter', color: '#43b02a' },
    WET: { l: 'W', name: 'Wet', color: '#2f7fd8' },
  };
  const cmp = (c) => CMP[c] || { l: '?', name: c || '?', color: '#999' };
  const qs = new URLSearchParams(location.search);
  const fmtDelta = (x) => (!E.ok(x) ? '—' : Math.abs(x) < 0.005 ? '±0.00 s' : (x > 0 ? '+' : '−') + Math.abs(x).toFixed(Math.abs(x) < 1 ? 2 : 1) + ' s');
  const fmtGained = (g) => (g > 0 ? '+' + g : g < 0 ? '−' + Math.abs(g) : '±0');

  const S = {
    mock: qs.get('mock') === '1', race: null, tables: {}, mockTables: null,
    code: 'VER', name: '', ghostPick: [], board: [],
    screen: 'start', net: 'unknown',
    // race runtime
    T: 0, speed: 1, running: false, refLap: 76, N: 72,
    pits: [], stints: [], plan: null, cum: [], lapsDone: 0, boxArmed: false,
    rd: null, dt: null, realPlans: {}, ghosts: [], cliffWarned: {}, finalSent: false,
    jev: { inflight: false, lastLap: 0, data: null, src: '' },
    voice: true, audio: null, result: null, convId: null,
    room: (qs.get('room') || '').trim().slice(0, 40) || null, bigScreen: qs.get('screen') === '1',
  };

  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

  // ---------- network ----------
  function setNet(state) {
    if (S.mock) state = 'mock';
    S.net = state;
    const label = { mock: 'Mock data', online: 'Live', offline: 'Offline: local answers', unknown: 'Connecting' }[state];
    $$('.status').forEach((el) => { el.textContent = label; el.dataset.state = state; });
  }
  async function fetchJSON(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 8000);
    try {
      const res = await fetch(url, Object.assign({ signal: ctl.signal, headers: { 'Content-Type': 'application/json' } }, opts || {}));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }
  async function api(name, body, ms) {
    if (S.mock) return local(name, body);
    try {
      const out = name === 'leaderboard'
        ? await fetchJSON('/api/leaderboard', { method: 'GET' }, ms)
        : await fetchJSON('/api/' + name, { method: 'POST', body: JSON.stringify(body) }, ms);
      setNet('online');
      return out;
    } catch (e) {
      setNet('offline');
      const out = local(name, body);
      if (out && typeof out === 'object' && !Array.isArray(out)) out._local = true;
      return out;
    }
  }
  function localRuns() { try { return JSON.parse(lsGet('boxbox.runs', '[]')) || []; } catch (e) { return []; } }
  function local(name, b) {
    switch (name) {
      case 'jev': return M.jevLocal(b, b && b._ctx);
      case 'radio': return { text: M.radioLine(b) };
      case 'debrief': return { text: M.debriefText(b) };
      case 'ask': return S.mock ? M.askAnswer(b.question) : { answer: 'The pit wall is not answering right now (offline or slow). Try again in a moment.', esql: [], conversation_id: 'local' };
      case 'runs': {
        const runs = localRuns();
        runs.push(Object.assign({ stints_label: E.stintsLabel(b.stints), at: Date.now() }, b));
        lsSet('boxbox.runs', JSON.stringify(runs.slice(-50)));
        const rank = sortBoard(runs.concat(S.mock ? seedRuns() : [])).findIndex((r) => r.at === runs[runs.length - 1].at) + 1;
        return { ok: true, rank, _local: true };
      }
      case 'leaderboard': return sortBoard(localRuns().concat(S.mock ? seedRuns() : []));
    }
    return {};
  }
  function sortBoard(rows) {
    return rows.slice().sort((a, b) => (!!a.dsq - !!b.dsq) || (b.positions_gained - a.positions_gained) || (a.delta_s - b.delta_s));
  }
  let seedCache = null;
  function seedRuns() {
    if (seedCache) return seedCache;
    seedCache = M.SEED_RUNS.map((r) => {
      const ev = evaluate(r.driver, r.stints);
      return Object.assign({}, r, ev, { stints_label: E.stintsLabel(r.stints) });
    }).filter((r) => r.finish);
    return seedCache;
  }

  // ---------- data ----------
  async function loadRace() {
    if (!S.mock) {
      try { S.race = await fetchJSON('data/race.json', { method: 'GET' }, 10000); }
      catch (e) { S.mock = true; }
    }
    if (S.mock || !S.race || !S.race.drivers) {
      S.mock = true;
      const m = M.makeRace();
      S.race = m.race; S.mockTables = m.tables;
    }
    S.N = S.race.laps_total || 72;
    setNet(S.mock ? 'mock' : 'unknown');
  }
  function driver(code) { return S.race.drivers.find((d) => d.code === code); }
  const tablePending = {};
  function table(code) {
    if (S.tables[code]) return Promise.resolve(S.tables[code]);
    if (!tablePending[code]) tablePending[code] = loadTable(code).finally(() => delete tablePending[code]);
    return tablePending[code];
  }
  async function loadTable(code) {
    let dt = null;
    if (S.mockTables) dt = S.mockTables[code];
    else {
      try { dt = await fetchJSON('data/driver_' + code + '.json', { method: 'GET' }, 10000); if (!dt || !dt.pred) dt = null; } catch (e) { dt = null; }
      if (!dt) dt = M.synthTable(driver(code), S.race);
    }
    if (!dt.cliff) dt.cliff = Object.assign({}, M.CLIFF);
    if (!dt.start) { const s0 = driver(code).stints[0]; dt.start = { compound: s0.compound, age: s0.start_age || 1 }; }
    // Re-derive real_pred_cum from the (rounded) pred table with the same math, so replaying the
    // real strategy gives exactly 0. The server's copy is kept for the self-test report.
    const rd = driver(code), n = E.nLaps(rd);
    if (Array.isArray(dt.real_pred_cum)) dt.real_pred_cum_server = dt.real_pred_cum;
    dt.real_pred_cum = E.predCum(dt, rd.stints, S.race.pit_loss_s, n);
    S.tables[code] = dt;
    return dt;
  }
  function evaluate(code, stints) {
    const rd = driver(code), dt = S.tables[code] || (S.mockTables && S.mockTables[code]);
    if (!rd || !dt) return {};
    const cum = E.carCum(rd, dt, stints, S.race.pit_loss_s);
    const cls = E.classify(S.race, code, cum);
    const dsq = E.compoundsUsed(stints).filter((c) => E.DRY.includes(c)).length < 2;
    const fin = dsq ? 20 : cls.find((r) => r.mine).pos;
    return { finish: fin, real_finish: rd.finish, positions_gained: rd.finish - fin, delta_s: +(cum[cum.length - 1] - rd.cum[cum.length - 1]).toFixed(2), dsq };
  }

  // ---------- start screen ----------
  function renderStart() {
    const grid = $('#driver-grid');
    const ds = S.race.drivers.slice().sort((a, b) => a.grid - b.grid);
    grid.innerHTML = ds.map((d) => `
      <button class="dcard${d.code === S.code ? ' sel' : ''}" data-code="${esc(d.code)}" style="--team:${esc(d.color)}">
        <span class="dc-code">${esc(d.code)}</span>
        <span class="dc-name">${esc(d.name)}</span>
        <span class="dc-team">${esc(d.team)}</span>
        <span class="dc-nums num"><span>Grid <b>P${d.grid}</b></span><span>Finish <b>P${d.finish}</b></span></span>
        <span class="dc-table" data-code="${esc(d.code)}">&nbsp;</span>
      </button>`).join('');
    $$('.dcard', grid).forEach((b) => b.addEventListener('click', () => {
      S.code = b.dataset.code;
      $$('.dcard', grid).forEach((x) => x.classList.toggle('sel', x === b));
      updatePicked();
    }));
    updatePicked();
    // "pit wall left X s on the table" = -optimizer.delta_vs_real, filled as tables arrive
    S.race.drivers.forEach((d) => table(d.code).then((dt) => {
      const el = grid.querySelector(`.dc-table[data-code="${d.code}"]`);
      const x = dt && dt.optimizer && E.ok(dt.optimizer.delta_vs_real) ? -dt.optimizer.delta_vs_real : null;
      if (el && x != null) el.innerHTML = x > 0.005 ? `Pit wall left <b>${x < 1 ? x.toFixed(2) : x.toFixed(1)} s</b> on the table` : 'Pit wall got it right';
    }).catch(() => {}));
    const ev = $('#event-line');
    if (ev) ev.textContent = `${S.race.season} ${S.race.event} · Zandvoort · ${S.N} laps · pit loss ${S.race.pit_loss_s.toFixed(1)} s`;
  }
  function updatePicked() {
    const d = driver(S.code);
    $('#picked-driver').textContent = d ? `${d.name} · real result P${d.finish} from P${d.grid}` : S.code;
    loadTwin(S.code);
  }
  // Style twin: Hopsworks feature-store vector search over driving-style fingerprints.
  const twinCache = {};
  async function loadTwin(code) {
    const el = $('#twin');
    if (S.mock) { el.hidden = true; return; }
    let rows = twinCache[code];
    if (!rows) {
      try { rows = await fetchJSON('/api/similar/' + encodeURIComponent(code), { method: 'GET' }, 6000); twinCache[code] = rows; }
      catch (e) { rows = null; }
    }
    if (S.code !== code) return;
    const top = Array.isArray(rows) ? rows.find((r) => r && r.driver_code && r.driver_code !== code) : null;
    if (!top) { el.hidden = true; return; }
    const td = driver(top.driver_code);
    el.hidden = false;
    el.innerHTML = `Style twin: <b>${esc(td ? td.name : top.driver_code)}</b>${top.season ? ' (' + esc(top.season) + ')' : ''} <span class="num">· distance ${E.ok(top.distance) ? top.distance.toFixed(3) : '—'}</span><span class="meta">Hopsworks vector search over telemetry fingerprints</span>`;
  }
  async function loadBoard(target) {
    const rows = await api('leaderboard', null, 6000);
    S.board = Array.isArray(rows) ? rows : [];
    renderGhostPick();
    if (target === 'finish') renderBoard();
  }
  function runKey(r, i) { return (r.player_name || '') + '|' + r.driver + '|' + E.stintsLabel(r.stints) + '|' + i; }
  function renderGhostPick() {
    const el = $('#ghost-pick');
    const rows = S.board.filter((r) => r.stints && r.stints.length && driver(r.driver)).slice(0, 8);
    if (!rows.length) { el.innerHTML = '<p class="empty">No saved runs yet. Finish a race to set the first ghost.</p>'; return; }
    el.innerHTML = rows.map((r, i) => `
      <label class="gp-row"><input type="checkbox" data-i="${i}" ${S.ghostPick.some((g) => g._key === runKey(r, i)) ? 'checked' : ''}>
        <span class="gp-name">${esc(r.player_name || 'Anonymous')}</span>
        <span class="gp-meta num">${esc(r.driver)} · ${fmtGained(r.positions_gained || 0)} · ${esc(r.stints_label || E.stintsLabel(r.stints))}</span></label>`).join('');
    $$('input', el).forEach((cb) => cb.addEventListener('change', () => {
      const r = rows[+cb.dataset.i], key = runKey(r, +cb.dataset.i);
      if (cb.checked) {
        if (S.ghostPick.length >= 3) { cb.checked = false; return; }
        S.ghostPick.push(Object.assign({ _key: key }, r));
      } else S.ghostPick = S.ghostPick.filter((g) => g._key !== key);
    }));
  }

  // ---------- race ----------
  function show(screen) {
    S.screen = screen;
    ['start', 'race', 'finish', 'room'].forEach((s) => ($('#screen-' + s).hidden = s !== screen));
    if (screen === 'race' || screen === 'room') requestAnimationFrame(resizeMap);
  }
  async function startRace(ghosts) {
    initAudio();
    S.name = ($('#player-name').value || '').trim().slice(0, 24) || 'Strategist';
    lsSet('boxbox.player_name', S.name);
    const btn = $('#btn-start'); btn.disabled = true; btn.textContent = 'Loading driver data…';
    try {
      const codes = [S.code].concat((ghosts || []).map((g) => g.driver));
      await Promise.all(Array.from(new Set(codes)).map(table));
    } finally { btn.disabled = false; btn.textContent = 'Start race'; }
    S.rd = driver(S.code); S.dt = S.tables[S.code];
    S.N = E.nLaps(S.rd);
    S.T = 0; S.lapsDone = 0; S.pits = []; S.boxArmed = false; S.cliffWarned = {}; S.finalSent = false; S.result = null;
    S.jev = { inflight: false, lastLap: 0, data: null, src: '' };
    const lt = S.rd.lap_times.slice(1, 40).filter(E.ok).sort((a, b) => a - b);
    S.refLap = lt.length ? lt[Math.floor(lt.length / 2)] : 76;
    S.realPlans = {};
    for (const d of S.race.drivers) S.realPlans[d.code] = E.lapPlan(d.stints, E.nLaps(d));
    S.ghosts = (ghosts || []).map((g) => {
      const rd = driver(g.driver), dt = S.tables[g.driver];
      if (!rd || !dt) return null;
      const stints = g.stints.map((s) => ({ compound: s.compound, start_lap: s.start_lap, end_lap: s.end_lap, start_age: s.start_age || 1 }));
      return { name: g.player_name || 'Ghost', code: g.driver, color: rd.color, stints, plan: E.lapPlan(stints, E.nLaps(rd)), cum: E.carCum(rd, dt, stints, S.race.pit_loss_s) };
    }).filter(Boolean);
    recompute();
    $('#radio-feed').innerHTML = '';
    $('#lap-of').textContent = '/' + S.N;
    renderJev();
    show('race');
    setSpeed(1);
    S.running = true;
    updateRaceUI();
    radio('start', { grid: S.rd.grid, compound: S.dt.start.compound });
    askJev(1);
    $('#serve-line').textContent = '';
    serveState.last = '';
    roomPost();
  }
  function recompute() {
    S.stints = E.stintsFromPits(S.dt.start, S.pits, S.N);
    S.plan = E.lapPlan(S.stints, S.N);
    S.cum = E.carCum(S.rd, S.dt, S.stints, S.race.pit_loss_s);
  }
  function lapsDoneAt(T) {
    let n = 0; const c = S.cum;
    let lo = 0, hi = c.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] <= T) lo = m + 1; else hi = m; }
    n = lo;
    return n;
  }
  function curLap() { return Math.min(S.lapsDone + 1, S.N); }
  function setSpeed(v) {
    S.speed = v;
    $$('.speed button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === v));
  }

  let lastTs = 0;
  function frame(ts) {
    const dtR = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    if (S.screen === 'race') {
      if (S.running && S.speed > 0) S.T += dtR * S.speed * S.refLap;
      const done = lapsDoneAt(S.T);
      if (done > S.lapsDone) {
        const prev = S.lapsDone;
        S.lapsDone = done;
        for (let L = prev + 1; L <= done; L++) onLap(L);
      }
      drawMap();
    } else if (S.screen === 'room') drawRoom(dtR);
    requestAnimationFrame(frame);
  }

  // ---------- multiplayer room ----------
  // Player side: send our strategy on start, every BOX, every 5 laps and at the flag.
  function roomPost() {
    if (!S.room || S.mock || !S.rd) return;
    const body = { player_name: S.name, driver: S.code, stints: S.stints, lap: Math.min(S.lapsDone, S.N) };
    fetchJSON('/api/room/' + encodeURIComponent(S.room) + '/state', { method: 'POST', body: JSON.stringify(body) }, 4000).catch(() => {});
  }
  // Big screen: poll the room every second and draw every player with the ghost math.
  const room = { players: [], cars: {}, last: 0, polling: false };
  async function pollRoom() {
    if (room.polling) return;
    room.polling = true;
    try {
      const res = await fetchJSON('/api/room/' + encodeURIComponent(S.room), { method: 'GET' }, 4000);
      setNet('online');
      const ps = (res && res.players) || [];
      await Promise.all(Array.from(new Set(ps.map((p) => p.driver))).filter((c) => driver(c)).map(table));
      room.players = ps.filter((p) => driver(p.driver) && Array.isArray(p.stints) && p.stints.length);
      for (const p of room.players) {
        const key = (p.player_name || '') + '|' + p.driver;
        const sig = JSON.stringify(p.stints);
        let car = room.cars[key];
        if (!car || car.sig !== sig) {
          const rd = driver(p.driver), dt = S.tables[p.driver];
          const cum = E.carCum(rd, dt, p.stints, S.race.pit_loss_s);
          car = Object.assign(car || { T: 0 }, { sig, cum, rd, dt, name: p.player_name || 'Player', code: p.driver });
          room.cars[key] = car;
        }
        car.lap = Math.max(0, Math.min(p.lap || 0, car.cum.length));
        car.stints = p.stints;
        car.seen = Date.now();
      }
      room.last = Date.now();
      renderRoomList();
    } catch (e) { setNet('offline'); }
    finally { room.polling = false; }
  }
  function renderRoomList() {
    const cars = Object.values(room.cars).filter((c) => Date.now() - c.seen < 15000);
    const rows = cars.map((c) => {
      const L = c.lap;
      const pos = L > 0 ? E.posAt(S.race, c.code, c.cum[L - 1], L) : c.rd.grid;
      const dl = L > 0 ? c.cum[L - 1] - c.rd.cum[L - 1] : 0;
      return { c, L, pos, dl };
    }).sort((a, b) => a.pos - b.pos || a.dl - b.dl);
    $('#room-count').textContent = rows.length;
    $('#room-updated').textContent = room.last ? 'updated ' + new Date(room.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    $('#room-rows').innerHTML = rows.length ? rows.map((r) => `<div class="rrow" style="--team:${esc(r.c.rd.color)}">
        <span class="r-name">${esc(r.c.name)}<small>${esc(E.stintsLabel(r.c.stints))}</small></span>
        <span class="r-drv"><i></i>${esc(r.c.code)}</span><span class="num">${r.L}</span><span class="num">P${r.pos}</span><span class="num">${fmtDelta(r.dl)}</span></div>`).join('')
      : '<p class="empty">Waiting for players. Open this game with ?room=' + esc(S.room) + ' on any laptop and press Start.</p>';
  }
  let roomTimer = 0;
  function drawRoom(dtR) {
    roomTimer += dtR;
    if (roomTimer >= 1) { roomTimer = 0; pollRoom(); }
    const c = map.ctx; if (!c) return;
    c.clearRect(0, 0, map.w, map.h);
    const P = S.race.track.path;
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.beginPath(); P.forEach((p, i) => { const [x, y] = mx(p); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath();
    c.strokeStyle = '#2e2d33'; c.lineWidth = 22; c.stroke();
    c.strokeStyle = '#46454c'; c.lineWidth = 2; c.stroke();
    for (const car of Object.values(room.cars)) {
      if (Date.now() - car.seen > 15000) continue;
      // each player is drawn where they are in their own race, eased between polls
      const target = car.lap > 0 ? car.cum[car.lap - 1] : 0;
      car.T += (target - car.T) * Math.min(1, dtR * 2.5);
      const [x, y] = mx(carPos(car.cum, car.T));
      c.setLineDash([5, 4]); c.beginPath(); c.arc(x, y, 13, 0, Math.PI * 2); c.lineWidth = 3; c.strokeStyle = '#ffffff'; c.stroke(); c.setLineDash([]);
      c.beginPath(); c.arc(x, y, 8, 0, Math.PI * 2); c.fillStyle = car.rd.color; c.fill();
      label(c, x, y, `${car.name} · ${car.code}`, '#ffffff', true);
    }
  }
  function startRoomScreen() {
    $('#room-name').textContent = S.room;
    $('#room-join').textContent = `Players join at ${location.origin}/?room=${S.room}`;
    show('room');
    renderRoomList();
    pollRoom();
  }

  function onLap(L) {
    if (S.plan.pit[L]) feed(L, `Pit stop done: ${cmp(S.plan.comp[L + 1]).name} tyres fitted.`, 'pit');
    if (L >= S.N) { S.running = false; updateRaceUI(); roomPost(); setTimeout(finishRace, 1200); return; }
    updateRaceUI();
    if (L % 5 === 0) roomPost();
    const cur = L + 1, c = S.plan.comp[cur], a = S.plan.age[cur], cl = (S.dt.cliff || {})[c] || 35;
    const key = c + '@' + S.stints.findIndex((s) => cur >= s.start_lap && cur <= s.end_lap);
    if (a > cl && !S.cliffWarned[key]) { S.cliffWarned[key] = true; radio('cliff', { compound: c, age: a, cliff: cl }); }
    if (cur === S.N && !S.finalSent) { S.finalSent = true; radio('final_lap', { position: towerNow().you }); }
    askJev(cur);
  }

  function boxPress() {
    if (S.screen !== 'race' || S.lapsDone >= S.N) return;
    if (curLap() >= S.N) { $('#box-note').textContent = 'Final lap: too late to box.'; return; }
    S.boxArmed = !S.boxArmed;
    renderBox();
  }
  function chooseCompound(c) {
    if (S.screen !== 'race') return;
    const cur = curLap();
    if (cur >= S.N || S.lapsDone >= S.N) return;
    S.pits = S.pits.filter((p) => p.lap !== cur).concat([{ lap: cur, compound: c }]);
    S.boxArmed = false;
    recompute();
    updateRaceUI();
    radio('box', { compound: c, lap: cur });
    serve(c, true);
    roomPost();
  }
  // Hopsworks model serving: the deployed lap-time model predicts the next 5 laps on a new set.
  const serveState = { inflight: false, last: '' };
  async function serve(c, force) {
    if (S.screen !== 'race' || S.mock) return;
    const cur = curLap();
    const key = c + '@' + cur;
    if (serveState.inflight || (!force && serveState.last === key)) return;
    serveState.inflight = true; serveState.last = key;
    try {
      const res = await fetchJSON('/api/serve', { method: 'POST', body: JSON.stringify({ driver: S.code, lap: cur, compound: c, n: 5 }) }, 4000);
      const ps = (res && res.predictions) || [];
      if (ps.length) $('#serve-line').textContent = `Hopsworks serving: next ${ps.length} laps on new ${cmp(c).name}s ${ps.map((v) => (+v).toFixed(1)).join(' · ')} s (${Math.round(res.ms || 0)} ms)`;
    } catch (e) { /* serving is optional; keep the last line */ }
    finally { serveState.inflight = false; }
  }
  function cancelBox() {
    const cur = curLap();
    S.pits = S.pits.filter((p) => p.lap !== cur);
    S.boxArmed = false;
    recompute();
    updateRaceUI();
    feed(cur, 'Box cancelled. Stay out.', 'pit');
    roomPost();
  }
  function renderBox() {
    const cur = curLap(), planned = S.pits.find((p) => p.lap === cur);
    $('#compound-pick').hidden = !S.boxArmed;
    $('#btn-box').classList.toggle('armed', S.boxArmed);
    $('#btn-box').textContent = S.boxArmed ? 'Pick a tyre' : planned ? 'Boxing this lap' : 'BOX';
    $('#btn-cancel-box').hidden = !planned;
    $('#box-note').textContent = planned
      ? `Pitting at the end of lap ${cur} for ${cmp(planned.compound).name}s. Costs ${S.race.pit_loss_s.toFixed(1)} s.`
      : S.boxArmed ? 'S Soft · M Medium · H Hard. Esc cancels.' : `Press B to box at the end of lap ${cur}.`;
  }

  // Timing tower at the last lap the player completed (lap chart, as in the contract).
  function towerNow() {
    const L = S.lapsDone, rows = [];
    const tyreOf = (plan, n) => { const k = Math.max(1, Math.min(n, L + 1)); return { c: plan.comp[k], a: plan.age[k] }; };
    const stops = (plan) => { let s = 0; for (let k = 1; k <= L; k++) if (plan.pit[k]) s++; return s; };
    for (const d of S.race.drivers) {
      if (d.code === S.code) continue;
      const n = E.nLaps(d), plan = S.realPlans[d.code];
      rows.push({ kind: 'real', code: d.code, color: d.color, grid: d.grid, time: L > 0 ? d.cum[L - 1] : null, tyre: tyreOf(plan, n), stops: stops(plan) });
    }
    rows.push({ kind: 'you', code: S.code, color: S.rd.color, grid: S.rd.grid, time: L > 0 ? S.cum[L - 1] : null, tyre: tyreOf(S.plan, S.N), stops: stops(S.plan) });
    S.ghosts.forEach((g) => rows.push({ kind: 'ghost', code: g.code, name: g.name, color: g.color, grid: driver(g.code).grid + 0.5, time: L > 0 ? g.cum[L - 1] : null, tyre: tyreOf(g.plan, g.cum.length), stops: stops(g.plan) }));
    if (L === 0) rows.sort((a, b) => a.grid - b.grid);
    else rows.sort((a, b) => a.time - b.time);
    let p = 0, you = 0;
    rows.forEach((r, i) => {
      if (r.kind !== 'ghost') { p++; r.pos = p; if (r.kind === 'you') you = p; }
      r.int = i === 0 || L === 0 ? null : r.time - rows[i - 1].time;
    });
    return { rows, you, L };
  }
  function realPosAt(L) {
    if (L <= 0) return S.rd.grid;
    return E.posAt(S.race, S.code, S.rd.cum[L - 1], L);
  }

  function updateRaceUI() {
    const tw = towerNow(), L = tw.L;
    $('#lap-now').textContent = curLap();
    $('#pos-now').textContent = 'P' + tw.you;
    const rp = realPosAt(L);
    $('#pos-real').textContent = `Real team P${rp}`;
    const dl = L > 0 ? S.cum[L - 1] - S.rd.cum[L - 1] : 0;
    $('#delta-now').textContent = fmtDelta(dl);
    $('#delta-now').dataset.sign = dl < -0.05 ? 'gain' : dl > 0.05 ? 'loss' : 'even';
    // tower
    $('#tower-lap').textContent = L > 0 ? `After lap ${L}` : 'Starting grid';
    $('#tower-rows').innerHTML = tw.rows.map((r) => {
      const t = cmp(r.tyre.c);
      const gap = r.int == null ? (r.pos === 1 && L > 0 ? 'Leader' : '') : '+' + r.int.toFixed(1);
      const label = r.kind === 'you' ? `${esc(r.code)} <span class="tag-you">You</span>` : r.kind === 'ghost' ? `${esc(r.code)} <span class="tag-ghost">${esc(r.name)}</span>` : esc(r.code);
      return `<div class="trow ${r.kind}" style="--team:${esc(r.color)}">
        <span class="t-pos num">${r.kind === 'ghost' ? 'G' : r.pos}</span><span class="t-bar"></span>
        <span class="t-code">${label}</span>
        <span class="t-gap num">${gap}</span>
        <span class="t-tyre"><span class="tyre-dot" style="--c:${t.color}">${t.l}</span><span class="num">${r.tyre.a}</span></span>
        <span class="t-stops num">${r.stops}</span></div>`;
    }).join('');
    // tyre card
    const cur = curLap(), c = S.plan.comp[cur], a = S.plan.age[cur], t = cmp(c);
    const cl = (S.dt.cliff || {})[c] || 35;
    const health = E.clamp(1 - a / cl, 0, 1);
    $('#tyre-disc').style.setProperty('--c', t.color);
    $('#tyre-disc').textContent = t.l;
    $('#tyre-name').textContent = t.name;
    $('#tyre-age').textContent = a;
    $('#tyre-health-fill').style.width = (health * 100).toFixed(0) + '%';
    $('#tyre-health-fill').dataset.state = a > cl ? 'gone' : health < 0.25 ? 'low' : 'ok';
    $('#tyre-cliff').textContent = a > cl ? `Past the cliff by ${a - cl} lap${a - cl > 1 ? 's' : ''}` : `Cliff in ${cl - a + 1} lap${cl - a + 1 > 1 ? 's' : ''} (age ${cl})`;
    $('#tyre-pace').textContent = E.predLap(S.dt, c, a, cur).toFixed(1) + ' s';
    const used = E.compoundsUsed(S.stints.filter((s) => s.start_lap <= cur));
    $('#tyre-rule').textContent = used.length >= 2 ? `Compounds used: ${used.map((u) => cmp(u).l).join(', ')}. Rule met.` : `Only ${cmp(used[0]).name} so far: use a second compound or be disqualified.`;
    $('#tyre-rule').dataset.state = used.length >= 2 ? 'ok' : 'warn';
    renderBox();
    renderStints();
  }

  function stintBar(stints, n, upto) {
    return stints.map((s) => {
      const w = ((s.end_lap - s.start_lap + 1) / n) * 100, t = cmp(s.compound);
      const future = upto != null && s.start_lap > upto;
      return `<span class="seg${future ? ' future' : ''}" style="width:${w}%;--c:${t.color}" title="${t.name} laps ${s.start_lap}-${s.end_lap}">${w > 6 ? t.l + ' ' + (s.end_lap - s.start_lap + 1) : ''}</span>`;
    }).join('');
  }
  function renderStints() {
    $('#stint-you').innerHTML = stintBar(S.stints, S.N, curLap());
    $('#stint-real').innerHTML = stintBar(S.rd.stints, E.nLaps(S.rd));
    const x = (S.lapsDone / S.N) * 100;
    $$('.stint-cursor').forEach((el) => (el.style.left = x + '%'));
    $('#stint-real-label').textContent = E.stintsLabel(S.rd.stints);
    $('#stint-you-label').textContent = E.stintsLabel(S.stints);
  }

  // ---------- track map ----------
  const map = { ctx: null, w: 0, h: 0, s: 1, ox: 0, oy: 0, path: null };
  function resizeMap() {
    const cv = S.screen === 'room' ? $('#room-map') : $('#map'); if (!cv) return;
    const box = cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(10, Math.floor(box.width * dpr)); cv.height = Math.max(10, Math.floor(box.height * dpr));
    cv.style.width = box.width + 'px'; cv.style.height = box.height + 'px';
    map.ctx = cv.getContext('2d'); map.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    map.w = box.width; map.h = box.height;
    const P = S.race.track.path;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const [x, y] of P) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    const pad = 36;
    map.s = Math.min((map.w - 2 * pad) / (maxx - minx || 1), (map.h - 2 * pad) / (maxy - miny || 1));
    map.ox = (map.w - (maxx - minx) * map.s) / 2 - minx * map.s;
    map.oy = (map.h - (maxy - miny) * map.s) / 2 - miny * map.s;
  }
  const mx = (p) => [map.ox + p[0] * map.s, map.oy + p[1] * map.s];
  function trackPoint(f) {
    const tr = S.race.track, fr = tr.frac, P = tr.path, n = fr.length;
    f = ((f % 1) + 1) % 1;
    if (f >= fr[n - 1]) {
      const span = 1 - fr[n - 1], t = span > 0 ? (f - fr[n - 1]) / span : 0, a = P[n - 1], b = P[0];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (fr[m] <= f) lo = m; else hi = m; }
    const t = (f - fr[lo]) / ((fr[hi] - fr[lo]) || 1);
    return [P[lo][0] + (P[hi][0] - P[lo][0]) * t, P[lo][1] + (P[hi][1] - P[lo][1]) * t];
  }
  function carPos(cum, T) {
    const n = cum.length;
    if (T <= 0) return trackPoint(0);
    if (T >= cum[n - 1]) return trackPoint(0);
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] >= T) hi = m; else lo = m + 1; }
    const st = lo > 0 ? cum[lo - 1] : 0;
    return trackPoint((T - st) / ((cum[lo] - st) || 1));
  }
  function drawMap() {
    const c = map.ctx; if (!c) return;
    c.clearRect(0, 0, map.w, map.h);
    const P = S.race.track.path;
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.beginPath(); P.forEach((p, i) => { const [x, y] = mx(p); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath();
    c.strokeStyle = '#2e2d33'; c.lineWidth = 18; c.stroke();
    c.strokeStyle = '#46454c'; c.lineWidth = 2; c.stroke();
    // start / finish
    const [sx, sy] = mx(P[0]), [nx, ny] = mx(P[Math.min(3, P.length - 1)]);
    const ang = Math.atan2(ny - sy, nx - sx) + Math.PI / 2;
    c.strokeStyle = '#ffffff'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(sx + Math.cos(ang) * 13, sy + Math.sin(ang) * 13); c.lineTo(sx - Math.cos(ang) * 13, sy - Math.sin(ang) * 13); c.stroke();
    const T = S.T;
    // field
    for (const d of S.race.drivers) {
      if (d.code === S.code) continue;
      const [x, y] = mx(carPos(d.cum, T));
      c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2); c.fillStyle = d.color; c.fill();
      c.lineWidth = 2; c.strokeStyle = '#131217'; c.stroke();
    }
    // real team car (where your driver really was)
    {
      const [x, y] = mx(carPos(S.rd.cum, T));
      c.setLineDash([3, 3]); c.beginPath(); c.arc(x, y, 9, 0, Math.PI * 2); c.lineWidth = 2; c.strokeStyle = S.rd.color; c.stroke(); c.setLineDash([]);
      label(c, x, y, 'Real ' + S.code, '#b8b9be');
    }
    for (const g of S.ghosts) {
      const [x, y] = mx(carPos(g.cum, T));
      c.setLineDash([5, 4]); c.beginPath(); c.arc(x, y, 10, 0, Math.PI * 2); c.lineWidth = 2.5; c.strokeStyle = '#ffffff'; c.stroke(); c.setLineDash([]);
      label(c, x, y, g.name, '#ffffff');
    }
    const [x, y] = mx(carPos(S.cum, T));
    c.beginPath(); c.arc(x, y, 13, 0, Math.PI * 2); c.fillStyle = '#ff7a1a'; c.fill();
    c.beginPath(); c.arc(x, y, 8, 0, Math.PI * 2); c.fillStyle = S.rd.color; c.fill();
    label(c, x, y, 'You', '#ff7a1a', true);
  }
  function label(c, x, y, text, color, bold) {
    c.font = (bold ? '700 ' : '600 ') + '15px "Public Sans", system-ui, sans-serif';
    const w = c.measureText(text).width;
    let lx = x + 16, ly = y - 12;
    if (lx + w > map.w - 4) lx = x - 16 - w;
    c.fillStyle = 'rgba(19,18,23,.85)'; c.fillRect(lx - 4, ly - 13, w + 8, 19);
    c.fillStyle = color; c.fillText(text, lx, ly + 1);
  }

  // ---------- Jev ----------
  function jevBody() {
    const cur = curLap(), c = S.plan.comp[cur], a = S.plan.age[cur];
    const tw = towerNow();
    const reals = tw.rows.filter((r) => r.kind !== 'ghost');
    const i = reals.findIndex((r) => r.kind === 'you');
    const ga = i > 0 && reals[i].time != null ? +(reals[i].time - reals[i - 1].time).toFixed(2) : null;
    const gb = i >= 0 && i < reals.length - 1 && reals[i].time != null ? +(reals[i + 1].time - reals[i].time).toFixed(2) : null;
    const used = E.compoundsUsed(S.stints.filter((s) => s.start_lap <= cur));
    const me = i >= 0 ? reals[i].time : null;
    const rejoin = me == null ? 0 : reals.filter((r) => r.kind === 'real' && r.time > me && r.time <= me + S.race.pit_loss_s).length;
    return {
      lap: cur, laps_left: S.N - cur, compound: c, age: a, position: tw.you, gap_ahead: ga, gap_behind: gb,
      compounds_used: used, gain_if_box: E.gainIfBox(S.dt, c, a, cur, S.N, S.race.pit_loss_s, used.length),
      driver: S.code, stops: S.pits.filter((p) => p.lap < cur).length, rejoin_behind: rejoin,
    };
  }
  function localState(body) {
    const g = body.gain_if_box, cl = (S.dt.cliff || {})[body.compound] || 35;
    const best = E.DRY.slice().sort((x, y) => g[y] - g[x])[0];
    return {
      model_seconds_saved_if_box_now: g, best_compound_if_box_now: best, laps_until_cliff: cl - body.age,
      pace_lost_to_wear_s: +(E.predLap(S.dt, body.compound, body.age, body.lap) - E.predLap(S.dt, body.compound, 1, body.lap)).toFixed(2),
    };
  }
  async function askJev(lap) {
    if (S.jev.inflight || S.jev.lastLap >= lap || S.screen !== 'race') return;
    S.jev.inflight = true; S.jev.lastLap = lap;
    const body = jevBody();
    try {
      let res;
      if (S.mock) res = M.jevLocal(body, { cliff: (S.dt.cliff || {})[body.compound] });
      else {
        try {
          const t0 = performance.now();
          res = await fetchJSON('/api/jev', { method: 'POST', body: JSON.stringify(body) }, 4000);
          if (!E.ok(res.ms)) res.ms = Math.round(performance.now() - t0);
          setNet('online'); res._src = 'jev';
        } catch (e) {
          setNet('offline');
          res = M.jevLocal(body, { cliff: (S.dt.cliff || {})[body.compound] });
          res._local = true;
        }
      }
      if (!res.state || typeof res.state !== 'object') res.state = localState(body);
      S.jev.data = Object.assign({ lap: body.lap, gain: body.gain_if_box }, res);
      renderJev();
    } finally { S.jev.inflight = false; }
  }
  function renderJev() {
    const j = S.jev.data;
    if (!j) {
      $('#jev-call').textContent = 'Watching';
      $('#jev-call').dataset.call = 'none';
      ['#jev-pbox', '#jev-cliff', '#jev-under'].forEach((s) => { $(s + '-val').textContent = '—'; $(s + '-fill').style.width = '0%'; });
      $('#jev-src').textContent = 'First call after the start.';
      ['#jev-saved', '#jev-lapscliff', '#jev-wear'].forEach((s) => ($(s).textContent = '—'));
      $('#jev-saved-label').textContent = 'Box now';
      $('#btn-jev-take').hidden = true;
      return;
    }
    const boxing = j.call && j.call.startsWith('BOX');
    const c = boxing ? j.call.slice(4) : null;
    $('#jev-call').textContent = boxing ? `Box for ${cmp(c).name}` : 'Stay out';
    $('#jev-call').dataset.call = boxing ? 'box' : 'stay';
    const set = (s, v) => { $(s + '-val').textContent = E.ok(v) ? Math.round(v * 100) + '%' : '—'; $(s + '-fill').style.width = (E.ok(v) ? E.clamp(v, 0, 1) * 100 : 0) + '%'; };
    set('#jev-pbox', j.p_box); set('#jev-cliff', j.cliff_risk); set('#jev-under', j.undercut);
    const st = j.state || {};
    const saved = st.model_seconds_saved_if_box_now || j.gain || {};
    const best = st.best_compound_if_box_now || E.DRY.slice().sort((a, b) => (saved[b] ?? -1e9) - (saved[a] ?? -1e9))[0];
    const sv = saved[best];
    $('#jev-saved').textContent = E.ok(sv) ? (sv > 0 ? '+' : sv < 0 ? '−' : '') + Math.abs(sv).toFixed(1) + ' s' : '—';
    $('#jev-saved-label').textContent = `Box now for ${cmp(best).name}`;
    $('#jev-lapscliff').textContent = E.ok(st.laps_until_cliff) ? st.laps_until_cliff : '—';
    $('#jev-wear').textContent = E.ok(st.pace_lost_to_wear_s) ? st.pace_lost_to_wear_s.toFixed(2) + ' s' : '—';
    $('#jev-src').textContent = (S.mock || j._local ? 'Local estimate (Jev offline)' : `Jev · ${Math.round(j.ms || 0)} ms`) + ` · lap ${j.lap}`;
    const btn = $('#btn-jev-take');
    btn.hidden = !boxing || curLap() >= S.N;
    if (boxing) { btn.textContent = `Take Jev's call: ${cmp(c).name}`; btn.dataset.c = c; }
  }

  // ---------- radio ----------
  function initAudio() {
    if (S.audio) return;
    try { S.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { S.audio = null; }
    S.voice = lsGet('boxbox.voice', '1') === '1' && 'speechSynthesis' in window;
    renderVoice();
  }
  function click() {
    const ac = S.audio; if (!ac) return;
    try {
      const t = ac.currentTime, len = 0.06;
      const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * len), ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) * 0.5;
      const src = ac.createBufferSource(); src.buffer = buf;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
      const g = ac.createGain(); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      src.connect(bp); bp.connect(g); g.connect(ac.destination); src.start(t);
      const o = ac.createOscillator(), og = ac.createGain(); o.frequency.value = 1250; og.gain.setValueAtTime(0.08, t + 0.06); og.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      o.connect(og); og.connect(ac.destination); o.start(t + 0.06); o.stop(t + 0.15);
    } catch (e) { /* audio is optional */ }
  }
  function speak(text) {
    if (!S.voice || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.08; u.pitch = 0.95; u.lang = 'en-GB';
      u.onerror = (e) => { if (e && e.error && e.error !== 'interrupted' && e.error !== 'canceled') { S.voice = false; renderVoice(); } };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { S.voice = false; renderVoice(); }
  }
  function renderVoice() { const b = $('#btn-voice'); if (b) { b.textContent = S.voice ? 'Voice on' : 'Voice off'; b.classList.toggle('on', S.voice); } }
  function feed(lap, text, kind) {
    const ol = $('#radio-feed');
    const li = document.createElement('li');
    li.className = 'r-' + (kind || 'radio');
    li.innerHTML = `<span class="r-lap num">L${lap}</span><span class="r-text">${esc(text)}</span>`;
    ol.prepend(li);
    while (ol.children.length > 7) ol.lastChild.remove();
  }
  async function radio(event, detail) {
    const lap = curLap();
    const body = { lap, driver: S.code, event, detail: Object.assign({ driver_name: S.rd.name, player_name: S.name }, detail || {}) };
    const res = await api('radio', body, 8000);
    const text = (res && res.text) || M.radioLine(body);
    if (S.screen !== 'race' && event !== 'final_lap') return;
    click(); feed(lap, text, 'radio'); speak(text);
  }

  // ---------- finish ----------
  function finishRace() {
    if (S.screen !== 'race') return;
    const rd = S.rd, dt = S.dt, N = S.N, pl = S.race.pit_loss_s;
    const used = E.compoundsUsed(S.stints).filter((c) => E.DRY.includes(c));
    const dsq = used.length < 2;
    const cls = E.classify(S.race, S.code, S.cum);
    const mine = cls.find((r) => r.mine);
    const fin = dsq ? null : mine.pos;
    const delta = S.cum[N - 1] - rd.cum[N - 1];
    const other = (strat) => {
      if (!strat || !strat.stints) return null;
      const cum = E.carCum(rd, dt, strat.stints, pl);
      const pos = E.classify(S.race, S.code, cum).find((r) => r.mine).pos;
      return { stints: strat.stints, pos, delta: E.ok(strat.delta_vs_real) ? strat.delta_vs_real : cum[N - 1] - rd.cum[N - 1] };
    };
    S.result = { dsq, fin, delta, cls, opt: other(dt.optimizer), jev: other(dt.jev), gained: rd.finish - (fin || 20), saved: false };
    renderFinish();
    show('finish');
    const r = S.result;
    api('debrief', { driver: S.code, player_name: S.name, stints: S.stints, finish: fin || 20, real_finish: rd.finish, delta_s: +delta.toFixed(2), optimizer_delta: r.opt ? +r.opt.delta.toFixed(2) : null, jev_delta: r.jev ? +r.jev.delta.toFixed(2) : null }, 25000)
      .then((res) => { $('#debrief').textContent = (res && res.text) || '—'; });
    loadBoard('finish');
  }
  function renderFinish() {
    const r = S.result, rd = S.rd;
    $('#res-pos').textContent = r.dsq ? 'DSQ' : 'P' + r.fin;
    const best = r.opt ? ` Best possible: ${fmtDelta(r.opt.delta)} (${E.stintsLabel(r.opt.stints)}), still P${r.opt.pos}.` : '';
    $('#res-sub').textContent = r.dsq ? `Disqualified: only ${cmp(E.compoundsUsed(S.stints)[0]).name} tyres used. A dry race needs two compounds.` : (r.gained > 0 ? `Real team finished P${rd.finish}. You gained ${r.gained} place${r.gained > 1 ? 's' : ''}.` : r.gained < 0 ? `Real team finished P${rd.finish}. You lost ${-r.gained} place${r.gained < -1 ? 's' : ''}.` : `Same place as the real team.`) + best;
    $('#res-delta').textContent = fmtDelta(r.delta);
    $('#res-delta').dataset.sign = r.delta < -0.05 ? 'gain' : r.delta > 0.05 ? 'loss' : 'even';
    $('#res-driver').textContent = `${rd.name} · ${S.name}`;
    // compare
    const rows = [
      { who: 'You', stints: S.stints, pos: r.dsq ? 'DSQ' : 'P' + r.fin, delta: r.delta, you: true },
      { who: 'Real team', stints: rd.stints, pos: 'P' + rd.finish, delta: 0 },
      r.opt && { who: 'Optimizer', stints: r.opt.stints, pos: 'P' + r.opt.pos, delta: r.opt.delta },
      r.jev && { who: 'Jev', stints: r.jev.stints, pos: 'P' + r.jev.pos, delta: r.jev.delta },
    ].filter(Boolean);
    $('#compare-rows').innerHTML = rows.map((x) => `<tr class="${x.you ? 'you' : ''}"><td>${x.who}</td><td class="stint-cell"><span class="stint-bar mini">${stintBar(x.stints, S.N)}</span></td><td class="num">${x.pos}</td><td class="num">${fmtDelta(x.delta)}</td></tr>`).join('');
    // classification
    $('#classif-rows').innerHTML = r.cls.map((c) => {
      const d = c.d, isMe = c.mine;
      const pos = isMe && r.dsq ? 'DSQ' : (r.dsq && c.pos > r.cls.find((z) => z.mine).pos ? c.pos - 1 : c.pos);
      const gap = c.pos === 1 ? 'Winner' : '+' + (c.time - r.cls[0].time).toFixed(1);
      return `<div class="crow${isMe ? ' you' : ''}" style="--team:${esc(d.color)}"><span class="t-pos num">${pos}</span><span class="t-bar"></span><span class="t-code">${esc(d.code)}${isMe ? ' <span class="tag-you">You</span>' : ''}</span><span class="c-name">${esc(isMe ? S.name : d.name)}</span><span class="t-gap num">${gap}</span></div>`;
    }).join('');
    $('#debrief').textContent = 'Writing the debrief…';
    $('#save-status').textContent = '';
    $('#btn-save').disabled = false; $('#btn-save').textContent = 'Save to leaderboard';
    $('#ask-answer').hidden = true;
  }
  async function saveRun() {
    const r = S.result; if (!r || r.saved) return;
    const b = $('#btn-save'); b.disabled = true; b.textContent = 'Saving…';
    const body = { player_name: S.name, driver: S.code, stints: S.stints, finish: r.fin || 20, real_finish: S.rd.finish, positions_gained: r.gained, delta_s: +r.delta.toFixed(2), dsq: r.dsq };
    const res = await api('runs', body, 8000);
    r.saved = true;
    b.textContent = 'Saved';
    $('#save-status').textContent = res && res.ok ? `${res._local ? 'Saved on this laptop (offline). ' : ''}Rank ${res.rank || '—'} on the leaderboard.` : 'Could not save this run.';
    loadBoard('finish');
  }
  let boardSel = [];
  function renderBoard() {
    const el = $('#board-rows');
    const rows = S.board.slice(0, 10);
    boardSel = boardSel.filter((i) => i < rows.length);
    if (!rows.length) { el.innerHTML = '<p class="empty">No runs yet. Save yours to be the first ghost.</p>'; return; }
    el.innerHTML = rows.map((x, i) => `<label class="brow"><input type="checkbox" data-i="${i}" ${boardSel.includes(i) ? 'checked' : ''} ${x.stints && driver(x.driver) ? '' : 'disabled'}>
      <span class="b-rank num">${i + 1}</span><span class="b-name">${esc(x.player_name || 'Anonymous')}</span>
      <span class="b-drv">${esc(x.driver)}</span><span class="b-gain num">${x.dsq ? 'DSQ' : fmtGained(x.positions_gained || 0)}</span><span class="b-delta num">${fmtDelta(x.delta_s)}</span>
      <span class="b-stints">${esc(x.stints_label || E.stintsLabel(x.stints))}</span></label>`).join('');
    $$('input', el).forEach((cb) => cb.addEventListener('change', () => {
      const i = +cb.dataset.i;
      if (cb.checked) { if (boardSel.length >= 3) { cb.checked = false; return; } boardSel.push(i); } else boardSel = boardSel.filter((k) => k !== i);
      $('#btn-race-ghosts').disabled = !boardSel.length;
    }));
    $('#btn-race-ghosts').disabled = !boardSel.length;
    if (S.net === 'offline') el.insertAdjacentHTML('beforeend', '<p class="empty">Offline: showing runs saved on this laptop.</p>');
  }
  let asking = false;
  async function ask(preset) {
    const q = (typeof preset === 'string' ? preset : $('#ask-input').value || '').trim();
    if (!q || asking) return;
    asking = true;
    $('#ask-input').value = q;
    const btn = $('#btn-ask'); btn.disabled = true; btn.textContent = 'Asking…';
    $$('.ask-demos .chip').forEach((c) => (c.disabled = true));
    const t0 = Date.now();
    const tick = () => { $('#ask-text').innerHTML = `<span class="ask-wait">Pit wall is running ES|QL… ${Math.round((Date.now() - t0) / 1000)}s</span>`; };
    $('#ask-answer').hidden = false;
    $('#ask-esql-count').textContent = 'ES|QL queries it ran';
    $('#ask-esql').innerHTML = '';
    tick();
    const iv = setInterval(tick, 1000);
    try {
      const res = await api('ask', { question: q, conversation_id: S.convId || undefined }, 155000);
      if (res && res.conversation_id && res.conversation_id !== 'local') S.convId = res.conversation_id;
      $('#ask-text').textContent = (res && res.answer) || 'No answer.';
      const qs2 = (res && res.esql) || [];
      $('#ask-esql-count').textContent = `ES|QL queries it ran (${qs2.length}) · ${Math.round((Date.now() - t0) / 1000)} s`;
      $('#ask-esql').innerHTML = qs2.map((x) => `<pre>${esc(typeof x === 'string' ? x : x.query || x.esql || JSON.stringify(x))}</pre>`).join('');
    } finally {
      clearInterval(iv); asking = false;
      btn.disabled = false; btn.textContent = 'Ask';
      $$('.ask-demos .chip').forEach((c) => (c.disabled = false));
    }
  }

  // ---------- how it works + insights ----------
  function openHowto() {
    $('#howto').hidden = false;
    renderInsights();
  }
  function closeHowto() { $('#howto').hidden = true; }
  const nameOf = (code) => { const d = driver(code); return d ? d.name.split(' ').slice(-1)[0] : code; };
  async function renderInsights() {
    const el = $('#insights');
    const ds = S.race.drivers;
    const tabs = {};
    await Promise.all(ds.map((d) => table(d.code).then((t) => (tabs[d.code] = t)).catch(() => {})));
    const stops = ds.reduce((n, d) => n + Math.max(0, d.stints.length - 1), 0);
    const N = S.race.laps_total || 72;
    const winner = ds.slice().sort((a, b) => a.finish - b.finish)[0];
    const ver = driver('VER') || winner, vt = tabs[ver.code];
    const cards = [];
    cards.push(['Pit stop', S.race.pit_loss_s.toFixed(1) + ' s', `A stop costs ${S.race.pit_loss_s.toFixed(1)} s at Zandvoort, measured over ${stops} stops.`]);
    const deg = (vt && vt.deg_note) || 'Pace lost after 20 laps: Soft +1.1 s, Medium +0.9 s, Hard +1.0 s';
    const degFig = (deg.match(/Medium\s*([+−-]?\d+(\.\d+)?)/) || [])[1];
    cards.push(['Tyre wear', degFig ? (degFig.startsWith('+') ? degFig : '+' + degFig) + ' s' : '20 laps', deg.replace(/\.?$/, '.')]);
    if (vt && vt.optimizer && vt.optimizer.stints) {
      const os = vt.optimizer.stints, n = os.length - 1;
      const gap = ver.cum[N - 1] - winner.cum[N - 1];
      const plan = n === 1 ? `1 stop on lap ${os[0].end_lap}, ${cmp(os[0].compound).name} to ${cmp(os[1].compound).name}` : `${n} stops (${E.stintsLabel(os)})`;
      cards.push([`Best plan for ${ver.name.split(' ')[0]}`, fmtDelta(vt.optimizer.delta_vs_real), `${plan}, ${Math.abs(vt.optimizer.delta_vs_real).toFixed(2)} s faster. ${ver.code === winner.code ? '' : `No strategy beats ${nameOf(winner.code)} (${gap.toFixed(1)} s ahead).`}`]);
    }
    const left = ds.filter((d) => tabs[d.code] && tabs[d.code].optimizer && E.ok(tabs[d.code].optimizer.delta_vs_real))
      .map((d) => ({ code: d.code, x: -tabs[d.code].optimizer.delta_vs_real })).sort((a, b) => b.x - a.x).slice(0, 3);
    if (left.length) cards.push(['Time left on the table', left[0].x.toFixed(1) + ' s', 'Biggest gaps to the best strategy: ' + left.map((l) => `${nameOf(l.code)} ${l.x.toFixed(1)} s`).join(', ') + '.']);
    const jv = ds.filter((d) => tabs[d.code] && tabs[d.code].jev && tabs[d.code].jev.stints && tabs[d.code].jev.stints.length);
    if (jv.length) {
      const near = jv.filter((d) => Math.abs(tabs[d.code].jev.stints[0].end_lap - d.stints[0].end_lap) <= 3).length;
      const beats = jv.filter((d) => tabs[d.code].jev.delta_vs_real < 0).length;
      cards.push(['Jev vs the real teams', `${beats} of ${jv.length}`, `Jev's strategy beats the real one for ${beats} of ${jv.length} drivers. Its first stop lands within 3 laps of the real team for ${near} of ${jv.length}.`]);
    }
    cards.push(['Data trap', 'Pit flags', 'The source pit flags are always false, so stops are derived from tyre-age resets.']);
    cards.push(['Why not 2023', 'Wet race', '2023 was wet: on a drying track slick lap times improve with tyre age, so 2023 is left out of the model.']);
    el.innerHTML = cards.map(([l, f, t]) => `<div class="icard"><span class="i-label">${esc(l)}</span><span class="i-fig">${esc(f)}</span><span class="i-text">${esc(t)}</span></div>`).join('');
  }

  // ---------- self test ----------
  window.boxboxSelfTest = async function () {
    const out = [];
    for (const d of S.race.drivers) {
      const dt = await table(d.code);
      const n = E.nLaps(d);
      const pc = E.predCum(dt, d.stints, S.race.pit_loss_s, n);
      const delta = pc[n - 1] - dt.real_pred_cum[n - 1];
      const cum = E.carCum(d, dt, d.stints, S.race.pit_loss_s);
      const pos = E.classify(S.race, d.code, cum).find((r) => r.mine).pos;
      const srv = dt.real_pred_cum_server;
      const serverGap = Array.isArray(srv) ? +Math.max(...srv.map((v, i) => Math.abs(v - dt.real_pred_cum[i]))).toFixed(4) : null;
      out.push({ code: d.code, delta: +delta.toFixed(6), finish: pos, real_finish: d.finish, ok: Math.abs(delta) < 1e-6 && pos === d.finish, table: dt.synthetic ? 'synthetic' : S.mock ? 'mock' : 'real', server_rpc_gap_s: serverGap });
    }
    console.table(out);
    const bad = out.filter((r) => !r.ok);
    console.log(bad.length ? `boxboxSelfTest: ${bad.length} FAILED` : 'boxboxSelfTest: all ' + out.length + ' drivers replay with delta 0 and the real finish');
    return { ok: !bad.length, results: out };
  };

  // ---------- wiring ----------
  function bind() {
    $('#btn-start').addEventListener('click', () => startRace(S.ghostPick));
    $('#btn-box').addEventListener('click', boxPress);
    $$('#compound-pick button').forEach((b) => {
      b.addEventListener('click', () => chooseCompound(b.dataset.c));
      b.addEventListener('mouseenter', () => serve(b.dataset.c, false));
    });
    $('#btn-cancel-box').addEventListener('click', cancelBox);
    $('#btn-jev-take').addEventListener('click', (e) => chooseCompound(e.currentTarget.dataset.c));
    $$('.speed button').forEach((b) => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));
    $('#btn-voice').addEventListener('click', () => { S.voice = !S.voice && 'speechSynthesis' in window; lsSet('boxbox.voice', S.voice ? '1' : '0'); if (!S.voice) try { speechSynthesis.cancel(); } catch (e) { /* */ } renderVoice(); });
    $('#btn-quit').addEventListener('click', () => { S.running = false; show('start'); loadBoard(); });
    $('#btn-again').addEventListener('click', () => startRace(S.ghosts.map((g) => ({ player_name: g.name, driver: g.code, stints: g.stints }))));
    $('#btn-change').addEventListener('click', () => { show('start'); loadBoard(); });
    $('#btn-save').addEventListener('click', saveRun);
    $('#btn-race-ghosts').addEventListener('click', () => { const g = boardSel.map((i) => S.board[i]).filter(Boolean).slice(0, 3); boardSel = []; startRace(g); });
    $('#btn-ask').addEventListener('click', () => ask());
    $('#ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
    $$('.ask-demos .chip').forEach((c) => c.addEventListener('click', () => ask(c.dataset.q)));
    $$('.btn-howto').forEach((b) => b.addEventListener('click', openHowto));
    $('#btn-howto-close').addEventListener('click', closeHowto);
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || S.screen === 'race' || S.screen === 'room') return;
      const k = e.key.toLowerCase();
      if (k === 'h') { e.preventDefault(); $('#howto').hidden ? openHowto() : closeHowto(); }
      else if (k === 'escape' && !$('#howto').hidden) closeHowto();
    });
    window.addEventListener('resize', () => { if (S.screen === 'race') resizeMap(); });
    try { new ResizeObserver(() => { if (S.screen === 'race') resizeMap(); }).observe($('.map-panel')); } catch (e) { /* older browsers: window resize only */ }
    document.addEventListener('keydown', (e) => {
      if (S.screen !== 'race' || e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); boxPress(); }
      else if (S.boxArmed && (k === 's' || k === 'm' || k === 'h')) { e.preventDefault(); chooseCompound({ s: 'SOFT', m: 'MEDIUM', h: 'HARD' }[k]); }
      else if (k === 'escape') { S.boxArmed = false; renderBox(); }
      else if (k === ' ') { e.preventDefault(); setSpeed(S.speed > 0 ? 0 : 1); }
      else if (k === '1') setSpeed(0.5); else if (k === '2') setSpeed(1); else if (k === '3') setSpeed(2); else if (k === '4') setSpeed(4);
    });
  }

  async function boot() {
    bind();
    $('#player-name').value = lsGet('boxbox.player_name', '');
    await loadRace();
    if (qs.get('driver') && driver(qs.get('driver').toUpperCase())) S.code = qs.get('driver').toUpperCase();
    requestAnimationFrame(frame);
    if (S.room && S.bigScreen) { startRoomScreen(); window.BoxBox = { S, room }; return; }
    renderStart();
    show('start');
    loadBoard();
    if (qs.get('howto') === '1') openHowto();
    window.BoxBox = { S, evaluate, startRace, finishRace, setSpeed, chooseCompound };
  }
  boot();
})();
