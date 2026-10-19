/* BoxBox game feel: page wipes, start lights, sound effects, cars on the hero track.
   Standalone: touches the DOM only, never app state. Every step is wrapped so it cannot break the game. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const inRoom = /[?&]room=/.test(location.search);
  const phone = () => window.matchMedia('(max-width: 700px)').matches;
  const safe = (fn) => (...a) => { try { return fn(...a); } catch (e) { /* cosmetic only */ } };

  // ---------- sound ----------
  let ac = null, master = null, noiseBuf = null, muted = false;
  try { muted = localStorage.getItem('boxbox.sfx') === '0'; } catch (e) { /* storage blocked */ }
  function ctx() {
    if (!ac) {
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        master = ac.createGain(); master.gain.value = 0.55;
        const comp = ac.createDynamicsCompressor(); master.connect(comp); comp.connect(ac.destination);
      } catch (e) { ac = null; }
    }
    if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
    return ac;
  }
  const tone = safe(function (f, d, o) {
    o = o || {}; const c = ctx(); if (!c || muted) return;
    const t = c.currentTime + (o.at || 0), osc = c.createOscillator(), g = c.createGain();
    osc.type = o.type || 'square'; osc.frequency.setValueAtTime(f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(o.vol || 0.2, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc.connect(g); g.connect(master); osc.start(t); osc.stop(t + d + 0.05);
  });
  const noise = safe(function (d, o) {
    o = o || {}; const c = ctx(); if (!c || muted) return;
    if (!noiseBuf) { noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate); const ch = noiseBuf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1; }
    const t = c.currentTime + (o.at || 0), src = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
    src.buffer = noiseBuf; bp.type = 'bandpass'; bp.Q.value = o.q || 0.9;
    bp.frequency.setValueAtTime(o.f1 || 1500, t); if (o.f2) bp.frequency.exponentialRampToValueAtTime(o.f2, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(o.vol || 0.25, t + Math.min(0.05, d / 3)); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    src.connect(bp); bp.connect(g); g.connect(master); src.start(t, Math.random()); src.stop(t + d + 0.05);
  });
  const sfx = {
    beep() { tone(540, 0.17, { type: 'square', vol: 0.13 }); },
    go() { tone(1080, 0.55, { type: 'sawtooth', vol: 0.14 }); tone(110, 0.6, { type: 'sine', to: 40, vol: 0.5 }); noise(0.5, { f1: 600, f2: 4000, vol: 0.2 }); },
    whoosh() { noise(0.75, { f1: 250, f2: 4200, vol: 0.28, q: 0.7 }); },
    box() { tone(150, 0.55, { type: 'sine', to: 32, vol: 0.7 }); noise(0.3, { f1: 3200, f2: 200, vol: 0.35 }); tone(660, 0.12, { type: 'square', vol: 0.1 }); },
    rattle() { for (let k = 0; k < 6; k++) noise(0.06, { at: k * 0.075, f1: 3600, vol: 0.32, q: 2.5 }); tone(220, 0.25, { type: 'sawtooth', to: 90, vol: 0.12, at: 0.45 }); },
    flag() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, { type: 'triangle', vol: 0.22, at: i * 0.11 })); noise(0.9, { f1: 400, f2: 5000, vol: 0.2 }); },
  };
  window.BoxBoxSfx = sfx;

  // ---------- page wipe between screens ----------
  function wipe() {
    const el = $('#wipe'); if (!el) return;
    el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
    sfx.whoosh();
    setTimeout(() => el.classList.remove('go'), 1000);
  }

  // ---------- start lights ----------
  let lightsBusy = false, lightsPass = false;
  function lightsThen(done) {
    const el = $('#lights'); if (!el) { done(); return; }
    lightsBusy = true;
    const lamps = $$('.lamp', el), txt = $('.lt-text', el);
    lamps.forEach((l) => l.classList.remove('on')); txt.textContent = 'Get ready'; txt.classList.remove('go');
    el.classList.add('on');
    let i = 0;
    const step = () => {
      if (i < lamps.length) { lamps[i++].classList.add('on'); sfx.beep(); setTimeout(step, 290); return; }
      setTimeout(() => {
        lamps.forEach((l) => l.classList.remove('on')); txt.textContent = 'Lights out!'; txt.classList.add('go'); sfx.go();
        setTimeout(() => { el.classList.remove('on'); lightsBusy = false; done(); }, 420);
      }, 480);
    };
    setTimeout(step, 120);
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#btn-start, #btn-again');
    if (b) {
      if (lightsPass || inRoom || phone() || b.disabled) return;
      if (lightsBusy) { e.stopImmediatePropagation(); e.preventDefault(); return; }
      e.stopImmediatePropagation(); e.preventDefault();
      lightsThen(() => { lightsPass = true; try { b.click(); } finally { lightsPass = false; } });
      return;
    }
    const t = e.target.closest && e.target.closest('button');
    if (!t) return;
    if (t.id === 'btn-box') sfx.box();
    else if (t.closest('.compound-pick, .phone-box') || t.id === 'btn-jev-take') sfx.rattle();
  }, true);

  // ---------- cars on the hero track ----------
  const CAR = '<symbol id="fx-car" viewBox="0 0 200 100" overflow="visible">' +
    '<g fill="currentColor"><rect x="4" y="27" width="12" height="46" rx="2"/><path d="M22 41L118 38 168 45 186 47V53L168 55 118 62 22 59Z"/>' +
    '<path d="M58 27L114 31 124 40H58Z" opacity=".85"/><path d="M58 73L114 69 124 60H58Z" opacity=".85"/><rect x="176" y="20" width="12" height="60" rx="2"/></g>' +
    '<g fill="#0c0c10" stroke="#666" stroke-width="2"><rect x="24" y="10" width="32" height="18" rx="5"/><rect x="24" y="72" width="32" height="18" rx="5"/><rect x="130" y="13" width="26" height="14" rx="4"/><rect x="130" y="73" width="26" height="14" rx="4"/></g>' +
    '<ellipse cx="92" cy="50" rx="11" ry="6" fill="#08080a"/><rect x="34" y="47" width="52" height="6" fill="#fff" opacity=".3"/></symbol>';
  const buildCars = safe(function () {
    const svg = $('#hero-track'); if (!svg || $('.fx-cars', svg)) return;
    const path = $('path', svg); if (!path) return;
    const d = path.getAttribute('d'); if (!d) return;
    const B = window.BoxBox, drivers = (B && B.S && B.S.race && B.S.race.drivers) || [];
    const cols = drivers.map((x) => x.color).filter(Boolean);
    const colors = cols.length ? cols : ['#ff2a2a', '#ffc233', '#3de1ff', '#2eff9a', '#ff5ad1', '#ffffff', '#7a5cff', '#ff8a1c'];
    const n = 9; let g = '<defs>' + CAR + '</defs><g class="fx-cars">';
    for (let i = 0; i < n; i++) {
      const dur = 15 + (i % 4) * 0.8, begin = -(i * dur / n);
      g += '<g><animateMotion dur="' + dur + 's" begin="' + begin.toFixed(2) + 's" repeatCount="indefinite" rotate="auto" path="' + d + '"/>' +
        '<use href="#fx-car" x="-38" y="-19" width="76" height="38" style="color:' + colors[(i * 2) % colors.length] + ';filter:drop-shadow(0 0 5px ' + colors[(i * 2) % colors.length] + ')"/></g>';
    }
    svg.insertAdjacentHTML('beforeend', g + '</g>');
  });

  // ---------- setup ----------
  function init() {
    setTimeout(() => document.body.classList.add('fx-go'), 900);
    // overlays
    const w = document.createElement('div'); w.id = 'wipe'; w.setAttribute('aria-hidden', 'true'); w.innerHTML = '<div class="w-band"><span>BoxBox</span></div>';
    const l = document.createElement('div'); l.id = 'lights'; l.setAttribute('aria-hidden', 'true');
    l.innerHTML = '<div class="lt-row"><i class="lamp"></i><i class="lamp"></i><i class="lamp"></i><i class="lamp"></i><i class="lamp"></i></div><div class="lt-text">Get ready</div>';
    document.body.append(w, l);

    // screen changes: wipe + finish fanfare
    const mo = new MutationObserver((muts) => muts.forEach((m) => {
      if (m.attributeName !== 'hidden' || m.target.hidden) return;
      wipe();
      if (m.target.id === 'screen-finish') setTimeout(sfx.flag, 450);
    }));
    $$('.screen').forEach((s) => mo.observe(s, { attributes: true, attributeFilter: ['hidden'] }));

    // sound toggle in every top bar
    $$('.topbar').forEach((tb) => {
      const st = $('.status', tb); const b = document.createElement('button');
      b.className = 'btn-quiet sfx-btn'; b.type = 'button';
      const paint = () => { b.textContent = muted ? 'Sound off' : 'Sound on'; };
      paint();
      b.addEventListener('click', () => { muted = !muted; try { localStorage.setItem('boxbox.sfx', muted ? '0' : '1'); } catch (e) { /* ignore */ } $$('.sfx-btn').forEach((x) => { x.textContent = muted ? 'Sound off' : 'Sound on'; }); if (!muted) sfx.beep(); });
      tb.insertBefore(b, st || null);
    });

    // hero CTAs
    const cta = $('#cta-start'), real = $('#btn-start');
    if (cta && real) {
      cta.addEventListener('click', () => { ctx(); real.click(); });
      const sync = () => { const s = cta.querySelector('span'); if (s) s.textContent = real.disabled ? 'Loading' : (/again/i.test(real.textContent) ? 'Race again' : 'Start the race'); cta.disabled = real.disabled; };
      new MutationObserver(sync).observe(real, { attributes: true, childList: true, characterData: true, subtree: true });
      sync();
    }
    const tr = $('#cta-trailer');
    if (tr) {
      tr.addEventListener('click', () => { ctx(); if (window.BoxBoxTrailer) window.BoxBoxTrailer.play(); });
      const reveal = () => { if (window.BoxBoxTrailer) tr.hidden = false; };
      reveal(); window.addEventListener('load', reveal);
    }

    // cars on the track (the track is drawn by app.js after the data loads)
    const hero = $('#hero-track');
    if (hero) { new MutationObserver(buildCars).observe(hero, { childList: true }); buildCars(); }
    // first gesture unlocks audio
    window.addEventListener('pointerdown', ctx, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
