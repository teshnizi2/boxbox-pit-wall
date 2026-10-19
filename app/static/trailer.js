/* BoxBox: Beat the Pit Wall. ~26 s cinematic trailer, fully self-contained (no assets, WebAudio soundtrack).
   API: window.BoxBoxTrailer.play({ startAt: seconds, onend: fn, hold: bool }) -> Promise<{skipped:boolean}>
   Skip: Esc / Space / Skip button. Mute: M. Without a user gesture the visuals play silently. */
(function () {
  'use strict';
  if (window.BoxBoxTrailer) return;

  var DUR = 26.5;
  var FALLBACK = 'M115,541L141,473L158,431L176,384L201,323L221,274L241,225L258,167L276,119L293,102L314,98L336,107L348,127L350,148L340,185L329,213L313,249L301,285L301,335L300,372L280,398L252,412L217,425L193,448L192,473L210,492L239,495L270,486L299,476L360,457L415,453L466,458L515,468L555,470L617,455L660,431L714,404L779,396L844,396L911,406L957,444L970,483L953,554L929,592L905,631L854,726L812,740L772,738L720,725L683,703L662,674L664,656L691,628L712,618L740,610L765,606L804,598L848,565L847,534L832,515L792,500L759,495L712,491L679,492L635,496L588,505L533,522L483,540L424,559L381,576L345,593L321,595L296,576L276,573L255,582L245,599L248,633L254,665L261,707L267,742L276,793L283,839L272,881L247,899L213,902L161,898L112,886L78,866L47,834L30,789L43,726L66,669L83,624L101,577Z';
  var running = null;

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function pr(t, a, b) { return clamp((t - a) / (b - a), 0, 1); }
  var ez = {
    oc: function (x) { return 1 - Math.pow(1 - x, 3); },
    ox: function (x) { return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); },
    ob: function (x) { var c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
    io: function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  };

  /* ------------------------------------------------------------------ CSS */
  var CSS = [
    '#bbx-trailer{position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:#000;overflow:hidden;color:#fff;',
    'font-family:Inter,"SF Pro Display",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;',
    '--h1:clamp(56px,min(9vw,14.5vh),150px);--bar:max(7vh,66px);--ty:clamp(96px,min(12vw,18vh),220px);',
    'user-select:none;-webkit-user-select:none;cursor:default}',
    '#bbx-trailer *{box-sizing:border-box;margin:0;padding:0}',
    '#bbx-trailer .stage{position:absolute;top:0;left:0;right:0;bottom:0;will-change:transform}',
    '#bbx-trailer .f{position:absolute;top:0;left:0;right:0;bottom:0;display:none;flex-direction:column;align-items:center;justify-content:center;',
    'padding:var(--bar) 3vw;text-align:center;overflow:hidden}',
    '#bbx-trailer .bg{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none}',
    '#bbx-trailer .t{font-weight:900;letter-spacing:-.025em;line-height:.98;white-space:nowrap;opacity:0;will-change:transform,opacity,filter;transform-origin:50% 55%;position:relative}',
    '#bbx-trailer .h{font-size:var(--h1)}',
    '#bbx-trailer .it{font-style:italic}',
    '#bbx-trailer .o{color:#ff4a1c;text-shadow:0 0 .3em rgba(255,74,28,.55)}',
    '#bbx-trailer .g{color:#ffb020;text-shadow:0 0 .3em rgba(255,176,32,.5)}',
    '#bbx-trailer .w{color:#fff;text-shadow:0 0 .35em rgba(255,255,255,.18)}',
    '#bbx-trailer .row{display:flex;align-items:baseline;justify-content:center;gap:.28em;position:relative}',
    '#bbx-trailer .trk{height:min(56vh,70vw);width:min(56vh,70vw);margin-bottom:2vh;overflow:visible;position:relative;flex:none}',
    '#bbx-trailer .ghost{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:92vh;font-weight:900;font-style:italic;color:transparent;-webkit-text-stroke:3px rgba(255,74,28,.42);line-height:1}',
    '#bbx-trailer .streak{position:absolute;left:0;top:63%;width:70vw;height:6px;border-radius:6px;background:linear-gradient(90deg,transparent,#ff4a1c 35%,#fff 80%,transparent);box-shadow:0 0 30px 6px rgba(255,74,28,.7);opacity:0;will-change:transform}',
    '#bbx-trailer .sub{font-size:clamp(40px,5.4vw,96px)}',
    '#bbx-trailer .big{font-size:clamp(56px,min(22vw,35vh),380px);font-style:italic;font-variant-numeric:tabular-nums;background:linear-gradient(180deg,#fff 5%,#ffb020 50%,#ff4a1c 100%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 .12em rgba(255,74,28,.55))}',
    '#bbx-trailer .glitch .t{text-shadow:-.045em 0 #ff4a1c,.045em 0 #fff}',
    '#bbx-trailer .bar4{height:5px;width:62vw;max-width:1100px;margin-top:3vh;background:linear-gradient(90deg,transparent,#ff4a1c,transparent);box-shadow:0 0 24px 4px rgba(255,74,28,.7);border-radius:4px}',
    '#bbx-trailer .you{font-size:calc(var(--h1)*1.22);color:#ffb020;text-shadow:0 0 .35em rgba(255,176,32,.75);font-style:italic}',
    '#bbx-trailer .you:after{content:"";display:block;height:.07em;background:#ffb020;margin-top:.02em;border-radius:.05em;box-shadow:0 0 .3em #ffb020}',
    '#bbx-trailer .tyres{display:flex;gap:calc(var(--ty)*.28);margin:3.2vh 0 3.4vh}',
    '#bbx-trailer .tyre{width:var(--ty);height:var(--ty);border-radius:50%;border:calc(var(--ty)*.1) solid var(--c);',
    'background:radial-gradient(circle at 35% 30%,#2b2b2b,#0b0b0b 72%);color:var(--c);display:flex;align-items:center;justify-content:center;',
    'font-size:calc(var(--ty)*.5);letter-spacing:0;box-shadow:0 0 calc(var(--ty)*.3) var(--c),inset 0 0 calc(var(--ty)*.12) rgba(0,0,0,.85)}',
    '#bbx-trailer .boxw{position:relative;display:flex;justify-content:center}',
    '#bbx-trailer .box{font-size:clamp(48px,min(7.5vw,12vh),120px);font-weight:900;font-style:italic;letter-spacing:.05em;color:#fff;',
    'background:linear-gradient(180deg,#ff8a30,#ff4a1c 55%,#e0300a);padding:.1em .9em .15em;border-radius:.28em;',
    'box-shadow:0 .06em 0 #8f1d05,0 0 .7em rgba(255,74,28,.75);text-shadow:0 .03em 0 rgba(0,0,0,.25)}',
    '#bbx-trailer .box.pressed{background:#fff;color:#ff4a1c;box-shadow:0 0 .9em .3em rgba(255,255,255,.95);text-shadow:none}',
    '#bbx-trailer .ring{position:absolute;top:0;left:0;right:0;bottom:0;border:6px solid #fff;border-radius:.3em;opacity:0;font-size:clamp(48px,min(7.5vw,12vh),120px);box-shadow:0 0 40px 6px rgba(255,255,255,.7)}',
    '#bbx-trailer .num{font-size:clamp(56px,min(15vw,27vh),270px);font-style:italic;font-variant-numeric:tabular-nums;font-feature-settings:"tnum";color:#fff;text-shadow:0 0 .22em rgba(255,74,28,.6);letter-spacing:-.03em}',
    '#bbx-trailer .num small{font-size:.48em;color:#ff4a1c;font-style:italic;margin-left:.12em}',
    '#bbx-trailer .lab{font-size:clamp(32px,3.7vw,66px);letter-spacing:.14em;text-transform:uppercase;color:#ffb020;font-weight:800;margin-top:1.4vh;text-shadow:0 0 .5em rgba(255,176,32,.45)}',
    '#bbx-trailer .pbar{height:6px;width:38vw;margin-top:3.4vh;background:#ff4a1c;border-radius:6px;box-shadow:0 0 22px 4px rgba(255,74,28,.7);transform-origin:0 50%}',
    '#bbx-trailer .lines{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;opacity:.5;',
    'background:repeating-linear-gradient(90deg,rgba(255,255,255,.06) 0,rgba(255,255,255,.06) 2px,transparent 2px,transparent 90px)}',
    '#bbx-trailer .stack{font-size:min(9vw,11.2vh);font-size:clamp(56px,min(9vw,13.2vh),150px)}',
    '#bbx-trailer .tech{font-size:clamp(30px,2.7vw,52px);font-weight:700;letter-spacing:.03em;white-space:pre;color:rgba(255,255,255,.85);margin-top:2.6vh}',
    '#bbx-trailer .title{font-size:min(19vw,33vh);font-style:italic;letter-spacing:-.035em;line-height:.9;padding:0 .06em;',
    'background:linear-gradient(180deg,#fff 6%,#ffd25a 46%,#ff4a1c 96%);-webkit-background-clip:text;background-clip:text;color:transparent;',
    'filter:drop-shadow(0 0 .1em rgba(255,74,28,.75)) drop-shadow(0 0 .02em rgba(255,255,255,.4))}',
    '#bbx-trailer .tag{font-size:clamp(56px,6.6vw,120px);font-style:italic;color:#fff;margin-top:2.6vh;text-shadow:0 0 .3em rgba(255,255,255,.2)}',
    '#bbx-trailer .built{font-size:clamp(36px,3.4vw,64px);letter-spacing:.24em;text-transform:uppercase;color:#ffb020;font-weight:800;margin-top:2.4vh}',
    '#bbx-trailer .flare{position:absolute;left:0;right:0;top:50%;height:3px;background:linear-gradient(90deg,transparent,#ff4a1c 20%,#fff 50%,#ff4a1c 80%,transparent);box-shadow:0 0 30px 6px rgba(255,74,28,.8);opacity:0}',
    '#bbx-trailer .vig{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;background:radial-gradient(ellipse at center,transparent 52%,rgba(0,0,0,.82) 100%)}',
    '#bbx-trailer .grain{position:absolute;top:0;left:0;width:100%;height:100%;opacity:.28;pointer-events:none;mix-blend-mode:screen}',
    '#bbx-trailer .flash{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;opacity:0;background:radial-gradient(circle at 50% 50%,#fff,#ffb020 45%,#ff4a1c 100%)}',
    '#bbx-trailer .blk{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;background:#000;opacity:0}',
    '#bbx-trailer .lb{position:absolute;left:0;right:0;background:#000;pointer-events:none}',
    '#bbx-trailer .lb.top{top:0}#bbx-trailer .lb.bot{bottom:0}',
    '#bbx-trailer .ctl{position:absolute;right:2.2vw;bottom:calc(var(--bar)/2 - 26px);display:flex;align-items:center;gap:18px;z-index:5}',
    '#bbx-trailer .hint{font-size:22px;color:rgba(255,255,255,.62);letter-spacing:.04em;font-weight:600}',
    '#bbx-trailer .skip{font:inherit;font-size:24px;font-weight:800;letter-spacing:.06em;color:#fff;background:rgba(0,0,0,.55);border:2px solid rgba(255,255,255,.6);',
    'border-radius:999px;padding:8px 24px;cursor:pointer;line-height:1.2}',
    '#bbx-trailer .skip:hover,#bbx-trailer .skip:focus-visible{background:#ff4a1c;border-color:#ff4a1c;outline:none}'
  ].join('');

  /* ------------------------------------------------------------ track path */
  function toPath(P) {
    var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, i;
    for (i = 0; i < P.length; i++) { minx = Math.min(minx, P[i][0]); maxx = Math.max(maxx, P[i][0]); miny = Math.min(miny, P[i][1]); maxy = Math.max(maxy, P[i][1]); }
    var sc = 940 / Math.max(maxx - minx, maxy - miny, 1), ox = (1000 - (maxx - minx) * sc) / 2, oy = (1000 - (maxy - miny) * sc) / 2, s = '';
    for (i = 0; i < P.length; i++) s += (i ? 'L' : 'M') + ((P[i][0] - minx) * sc + ox).toFixed(1) + ',' + ((P[i][1] - miny) * sc + oy).toFixed(1);
    return s + 'Z';
  }
  function loadPath() {
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (!done) { done = true; clearTimeout(to); resolve(v); } }
      var to = setTimeout(function () { fin(FALLBACK); }, 1200);
      try {
        fetch('data/race.json').then(function (r) { return r.json(); }).then(function (j) {
          var P = j && j.track && j.track.path;
          fin(P && P.length > 10 ? toPath(P) : FALLBACK);
        }).catch(function () { fin(FALLBACK); });
      } catch (e) { fin(FALLBACK); }
    });
  }

  /* --------------------------------------------------------------- timeline */
  // count-up definitions shared by visuals and audio: value steps at a0 + k*dt (k = 1..K)
  var CU = {
    lost: { a0: 6.75, K: 10, dt: 0.065, tgt: 22.9 },
    n1: { a0: 14.55, K: 10, dt: 0.065, tgt: 2869213 },
    n2: { a0: 15.8, K: 10, dt: 0.065, tgt: 3531 },
    n3: { a0: 17.05, K: 10, dt: 0.065, tgt: 20 },
    n4: { a0: 18.3, K: 10, dt: 0.065, tgt: 40 }
  };
  function cuStep(c, t) { return clamp(Math.floor((t - c.a0) / c.dt), 0, c.K); }
  function cuVal(c, t) { var k = cuStep(c, t); return k >= c.K ? c.tgt : c.tgt * ez.oc(k / c.K); }
  function cuLock(c) { return c.a0 + c.K * c.dt; }
  function fmtInt(v) { return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  var IMPACTS = [[3.5, .5], [5.0, .6], [5.7, .5], [6.5, .6], [7.4, .5], [8.1, .3], [11.0, .8], [11.35, 1], [12.0, .7], [12.35, .7], [12.7, .7],
    [14.1, 1.5], [14.5, .6], [15.25, .4], [16.5, .4], [17.75, .4], [19.0, .5], [19.6, .4], [20.3, .4], [21.0, .5], [21.7, .4], [23.0, 1.6], [23.9, .7], [26.0, 1.1]];

  function cam(t) {
    var dx = 0, dy = 0, rt = 0, fl = 0;
    for (var i = 0; i < IMPACTS.length; i++) {
      var dt = t - IMPACTS[i][0]; if (dt < 0 || dt > 1.3) continue;
      var m = IMPACTS[i][1], k = m * Math.exp(-dt * 7.5);
      dx += k * Math.sin(dt * 93) * 13; dy += k * Math.cos(dt * 77) * 9; rt += k * Math.sin(dt * 61) * 0.35;
      if (m >= 0.8) fl += Math.min(0.55, m * 0.3) * Math.exp(-dt * 11);
    }
    return { dx: dx, dy: dy, rt: rt, fl: Math.min(fl, 0.85) };
  }

  /* ----------------------------------------------------------------- build */
  function build(pathD, startAt) {
    var root = document.createElement('div');
    root.id = 'bbx-trailer';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'BoxBox trailer');
    var stage = document.createElement('div'); stage.className = 'stage'; root.appendChild(stage);
    var frames = [];

    function mkEl(cls, parent, html) { var e = document.createElement('div'); e.className = cls; if (html != null) e.innerHTML = html; parent.appendChild(e); return e; }
    function frame(a, b, o) {
      o = o || {};
      var el = mkEl('f', stage); if (o.bg) el.style.background = o.bg;
      var f = { el: el, a: a, b: b, items: [], push: o.push || 0, upd: null, vis: false };
      frames.push(f); return f;
    }
    function item(f, parent, html, cls, o) {
      var it = o || {}; it.el = mkEl('t ' + (cls || ''), parent || f.el, html); f.items.push(it); return it;
    }
    function row(f) { return mkEl('row', f.el); }

    /* F1: track draws itself, "Zandvoort. 2024." */
    var f1 = frame(0, 3.5, { push: 0.05 });
    var svgNS = 'http://www.w3.org/2000/svg';
    var wrap = mkEl('trk', f1.el);
    wrap.innerHTML = '<svg viewBox="0 0 1000 1000" width="100%" height="100%" style="overflow:visible"><defs><linearGradient id="bbxg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb020"/><stop offset="1" stop-color="#ff4a1c"/></linearGradient></defs>' +
      '<path id="bbx-gl" d="' + pathD + '" fill="none" stroke="#ff4a1c" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" pathLength="1" style="filter:blur(9px);opacity:.55"/>' +
      '<path id="bbx-mn" d="' + pathD + '" fill="none" stroke="url(#bbxg)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>' +
      '<path id="bbx-co" d="' + pathD + '" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>' +
      '<circle id="bbx-hd" r="15" fill="#fff" style="filter:drop-shadow(0 0 14px #ff4a1c) drop-shadow(0 0 30px #ff4a1c);opacity:0"/></svg>';
    var pGl = wrap.querySelector('#bbx-gl'), pMn = wrap.querySelector('#bbx-mn'), pCo = wrap.querySelector('#bbx-co'), hd = wrap.querySelector('#bbx-hd');
    var plen = 1; try { plen = pMn.getTotalLength() || 1; } catch (e) { plen = 1; }
    [pGl, pMn, pCo].forEach(function (p) { p.style.strokeDasharray = '1 1'; p.style.strokeDashoffset = '1'; });
    item(f1, null, 'Zandvoort. <span class="g">2024.</span>', 'h w', { k: 'blur', a: 1.2, d: 0.9, b: 3.3, od: 0.2 });
    f1.upd = function (t) {
      var p = ez.io(pr(t, 0.25, 3.2));
      var off = (1 - p).toFixed(4);
      pGl.style.strokeDashoffset = off; pMn.style.strokeDashoffset = off; pCo.style.strokeDashoffset = off;
      if (p > 0.002 && p < 0.999) {
        var pt = null; try { pt = pMn.getPointAtLength(p * plen); } catch (e) { pt = null; }
        if (pt) { hd.setAttribute('cx', pt.x); hd.setAttribute('cy', pt.y); hd.style.opacity = 1; } else hd.style.opacity = 0;
      } else hd.style.opacity = 0;
      wrap.style.opacity = (pr(t, 0, 0.3) * (1 - pr(t, 3.3, 3.5))).toFixed(3);
    };

    /* F2a: Max Verstappen. */
    var f2a = frame(3.5, 5.0, { push: 0.07 });
    mkEl('bg', f2a.el).style.background = 'radial-gradient(ellipse at 50% 60%,rgba(255,74,28,.2),transparent 62%)';
    item(f2a, null, '1', 'ghost', { k: 'fade', a: 3.5, d: 0.5, fx: function (t) { return { s: 1 + 0.12 * pr(t, 3.5, 5) }; } });
    var streak = mkEl('streak', f2a.el);
    item(f2a, null, 'Max Verstappen.', 'h w it', { k: 'slam', a: 3.5, d: 0.22, from: 1.0, b: 4.85, od: 0.15 });
    f2a.upd = function (t) {
      var p = pr(t, 3.55, 4.25);
      streak.style.opacity = p > 0 && p < 1 ? 1 : 0;
      streak.style.transform = 'translateX(' + (-80 + 190 * ez.oc(p)).toFixed(1) + 'vw)';
    };

    /* F2b: Home crowd. Home race. */
    var f2b = frame(5.0, 6.5, { push: 0.06 });
    var glowB = mkEl('bg', f2b.el);
    item(f2b, null, 'Home crowd.', 'h w it', { k: 'slam', a: 5.0, d: 0.22, b: 6.35, od: 0.15 });
    item(f2b, null, 'Home race.', 'h o it', { k: 'slam', a: 5.7, d: 0.22, b: 6.35, od: 0.15 });
    f2b.upd = function (t) {
      var pulse = 0.28 + 0.14 * Math.pow(Math.max(0, Math.sin((t - 5.0) * Math.PI / 0.6)), 2);
      glowB.style.background = 'radial-gradient(ellipse at 50% 55%,rgba(255,74,28,' + pulse.toFixed(3) + '),transparent 66%)';
    };

    /* F2c: He lost by 22.9 seconds. */
    var f2c = frame(6.5, 8.0, { push: 0.05 });
    item(f2c, null, 'He lost by', 'sub w', { k: 'rise', a: 6.5, d: 0.4, b: 7.88, od: 0.12 });
    item(f2c, null, '0.0', 'big', {
      k: 'slam', a: 6.62, d: 0.2, from: 0.5, b: 7.88, od: 0.12,
      html: function (t) { var k = cuStep(CU.lost, t); return (k >= CU.lost.K ? CU.lost.tgt : cuVal(CU.lost, t)).toFixed(1); },
      fx: function (t) { var d = t - cuLock(CU.lost); return d > 0 ? { s: 1 + 0.12 * Math.exp(-d * 12) } : null; }
    });
    item(f2c, null, 'seconds.', 'sub o', { k: 'rise', a: 7.45, d: 0.35, b: 7.88, od: 0.12 });

    /* F3: Was it the pit wall? */
    var f3 = frame(8.0, 10.5, { push: 0.1 });
    mkEl('bg', f3.el).style.background = 'radial-gradient(ellipse at 50% 70%,rgba(255,74,28,.14),transparent 60%)';
    item(f3, null, 'Was it', 'h w it', { k: 'blur', a: 8.1, d: 0.95, b: 10.33, od: 0.15 });
    item(f3, null, 'the <span class="o">pit wall?</span>', 'h w it', { k: 'blur', a: 8.6, d: 0.95, b: 10.33, od: 0.15 });
    item(f3, null, '', 'bar4', { k: 'fade', a: 8.2, d: 0.3, b: 10.33, od: 0.15, fx: function (t) { return { sx: ez.oc(pr(t, 8.2, 9.2)) }; } });
    f3.upd = function (t, f) {
      var g = (t > 9.65 && t < 9.9) || (t > 10.12 && t < 10.28);
      if (g !== f.gl) { f.gl = g; f.el.classList.toggle('glitch', g); }
    };

    /* F4: Tonight, YOU are the pit wall. + tyres + BOX */
    var f4 = frame(11.0, 14.5, { push: 0.05 });
    mkEl('bg', f4.el).style.background = 'radial-gradient(ellipse at 50% 105%,rgba(255,74,28,.32),transparent 60%)';
    var r1 = row(f4);
    item(f4, r1, 'Tonight,', 'h w it', { k: 'slam', a: 11.0, d: 0.2, b: 14.3, od: 0.2 });
    item(f4, r1, 'YOU', 'you', { k: 'slam', a: 11.35, d: 0.2, from: 1.6, b: 14.3, od: 0.2 });
    item(f4, null, 'are the <span class="o">pit wall.</span>', 'h w it', { k: 'rise', a: 11.75, d: 0.45, b: 14.3, od: 0.2 });
    var ty = mkEl('tyres', f4.el);
    var tyc = [['S', '#ff2d2d', 12.0], ['M', '#ffd12a', 12.35], ['H', '#f4f4f4', 12.7]];
    tyc.forEach(function (c) {
      var it = item(f4, ty, c[0], 'tyre', { k: 'slam', a: c[2], d: 0.2, from: 1.5, b: 14.3, od: 0.2 });
      it.el.style.setProperty('--c', c[1]);
    });
    var bw = mkEl('boxw', f4.el);
    var boxIt = item(f4, bw, 'BOX', 'box', {
      k: 'pop', a: 13.05, d: 0.45, b: 14.45, od: 0.05,
      fx: function (t) {
        var s = 1;
        if (t > 13.5 && t < 14.1) s = 1 + 0.05 * Math.sin((t - 13.5) * Math.PI * 2 / 0.6);
        else if (t >= 14.1 && t < 14.17) s = 1 - 0.16 * pr(t, 14.1, 14.17);
        else if (t >= 14.17) s = 0.84 + 0.4 * ez.oc(pr(t, 14.17, 14.5));
        return { s: s };
      }
    });
    item(f4, bw, '', 'ring', { k: 'none', a: 14.1, fx: function (t) { var p = pr(t, 14.1, 14.55); return { s: 1 + 1.7 * ez.oc(p), o: (1 - p) * 0.9 }; } });
    f4.upd = function (t) { var pressed = t >= 14.1; if (pressed !== f4.pr) { f4.pr = pressed; boxIt.el.classList.toggle('pressed', pressed); } };

    /* F5: four numbers */
    var specs = [
      { a: 14.5, c: CU.n1, lab: 'telemetry samples', bg: 'rgba(255,74,28,.30)', fmt: fmtInt, unit: '' },
      { a: 15.75, c: CU.n2, lab: 'laps', bg: 'rgba(255,176,32,.26)', fmt: fmtInt, unit: '' },
      { a: 17.0, c: CU.n3, lab: 'strategists', bg: 'rgba(255,255,255,.14)', fmt: fmtInt, unit: '' },
      { a: 18.25, c: CU.n4, lab: 'model answers', bg: 'rgba(255,74,28,.34)', fmt: fmtInt, unit: ' <small>ms</small>' }
    ];
    specs.forEach(function (s, idx) {
      var f = frame(s.a, s.a + 1.25, { push: 0.05 });
      var bgEl = mkEl('bg', f.el); bgEl.style.background = 'radial-gradient(ellipse at 50% 62%,' + s.bg + ',transparent 65%)';
      var lines = mkEl('lines', f.el);
      item(f, null, '0', 'num', {
        k: 'slam', a: s.a, d: 0.14, from: 0.5, b: s.a + 1.17, od: 0.08,
        html: function (t) { return s.fmt(cuVal(s.c, t)) + s.unit; },
        fx: function (t) { var d = t - cuLock(s.c); return d > 0 ? { s: 1 + 0.1 * Math.exp(-d * 12) } : null; }
      });
      item(f, null, s.lab, 'lab', { k: 'rise', a: s.a + 0.12, d: 0.3, b: s.a + 1.17, od: 0.08 });
      item(f, null, '', 'pbar', { k: 'fade', a: s.a + 0.05, d: 0.1, b: s.a + 1.17, od: 0.08, fx: function (t) { return { sx: Math.max(0.001, pr(t, s.a, s.a + 1.2)) }; } });
      f.upd = function (t) { lines.style.backgroundPosition = ((-(t - s.a) * 1600) % 90).toFixed(1) + 'px 0'; };
    });

    /* F6: Elastic. Hopsworks. Jev. Claude. */
    var f6 = frame(19.5, 23.0, { push: 0.04 });
    mkEl('bg', f6.el).style.background = 'radial-gradient(ellipse at 50% 55%,rgba(255,176,32,.13),transparent 62%)';
    [['Elastic.', 'g', 'left', 19.6, -5], ['Hopsworks.', 'w', 'right', 20.3, 5], ['Jev.', 'o', 'slam', 21.0, -5], ['Claude.', 'w', 'blur', 21.7, 5]].forEach(function (w) {
      item(f6, null, w[0], 'stack it ' + w[1], { k: w[2], a: w[3], d: w[2] === 'slam' ? 0.2 : 0.5, ox: w[4], b: 22.85, od: 0.12 });
    });
    item(f6, null, 'ES|QL  ·  Feature store  ·  Model serving', 'tech', { k: 'rise', a: 22.15, d: 0.5, b: 22.85, od: 0.12 });

    /* F7: title */
    var f7 = frame(23.0, 26.5, { push: 0.03 });
    mkEl('bg', f7.el).style.background = 'radial-gradient(ellipse at 50% 48%,rgba(255,74,28,.30),transparent 62%)';
    item(f7, null, '', 'flare', {
      k: 'none', a: 23.0, fx: function (t) { var p = pr(t, 23.0, 23.9); return { sx: 0.1 + 1.2 * ez.ox(p), o: (1 - ez.oc(p)) * 0.95 }; }
    });
    item(f7, null, 'BOXBOX', 'title', {
      k: 'slam', a: 23.0, d: 0.3, from: 2.6,
      fx: function (t) { var d = t - 26.0; return d > 0 && d < 0.7 ? { s: 1 + 0.06 * Math.exp(-d * 10) } : null; }
    });
    item(f7, null, 'Beat the Pit Wall.', 'tag', { k: 'slam', a: 23.9, d: 0.22, from: 0.9 });
    item(f7, null, 'Built tonight.', 'built', { k: 'fade', a: 25.0, d: 0.7 });

    /* overlays */
    var vig = mkEl('vig', root);
    var grain = document.createElement('canvas'); grain.className = 'grain'; grain.width = 192; grain.height = 108; root.appendChild(grain);
    var gctx = null, gimg = null;
    try { gctx = grain.getContext('2d'); gimg = gctx.createImageData(192, 108); } catch (e) { gctx = null; }
    var flash = mkEl('flash', root);
    var blk = mkEl('blk', root);
    var lbT = mkEl('lb top', root), lbB = mkEl('lb bot', root);
    var ctl = mkEl('ctl', root);
    var hint = mkEl('hint', ctl, 'Esc skip  ·  M mute');
    var skip = document.createElement('button'); skip.className = 'skip'; skip.type = 'button'; skip.textContent = 'Skip →'; ctl.appendChild(skip);

    var lastG = 0;
    function setItem(it, t) {
      var el = it.el, a = it.a;
      if (t < a) { if (it.vis !== false) { el.style.opacity = 0; it.vis = false; } return; }
      it.vis = true;
      var d = it.d || 0.3, p = pr(t, a, a + d), o = 1, s = 1, tx = 0, ty = 0, bl = 0, sx = 1, e;
      switch (it.k) {
        case 'slam': e = ez.ox(p); s = 1 + (1 - e) * (it.from == null ? 1.2 : it.from); o = Math.min(1, p * 5); bl = (1 - e) * 14; break;
        case 'rise': e = ez.oc(p); ty = (1 - e) * 70; o = e; bl = (1 - e) * 12; break;
        case 'blur': e = ez.oc(p); s = 1.16 - 0.16 * e; o = e; bl = (1 - e) * 22; break;
        case 'left': e = ez.oc(p); tx = -(1 - e) * 160; o = e; bl = (1 - e) * 12; break;
        case 'right': e = ez.oc(p); tx = (1 - e) * 160; o = e; bl = (1 - e) * 12; break;
        case 'pop': e = ez.ob(p); s = 0.15 + 0.85 * e; o = Math.min(1, p * 4); break;
        case 'fade': o = p; break;
        default: o = 1;
      }
      if (it.b != null && t > it.b) { var q = pr(t, it.b, it.b + (it.od || 0.18)); o *= 1 - q; s *= 1 + q * 0.08; bl += q * 16; }
      if (it.fx) { var r = it.fx(t); if (r) { if (r.s) s *= r.s; if (r.sx) sx *= r.sx; if (r.o != null) o *= r.o; if (r.ty) ty += r.ty; } }
      if (it.html) { var h = it.html(t); if (h !== it.lh) { it.lh = h; el.innerHTML = h; } }
      if (it.ox) tx += it.ox * window.innerWidth / 100;
      el.style.opacity = o < 0.003 ? 0 : o.toFixed(3);
      el.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + (s * sx).toFixed(4) + ',' + s.toFixed(4) + ')';
      el.style.filter = bl > 0.2 ? 'blur(' + bl.toFixed(1) + 'px)' : '';
    }

    function render(t) {
      var c = cam(t);
      stage.style.transform = 'translate(' + c.dx.toFixed(1) + 'px,' + c.dy.toFixed(1) + 'px) rotate(' + c.rt.toFixed(3) + 'deg)';
      flash.style.opacity = c.fl.toFixed(3);
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i], vis = t >= f.a && t < f.b;
        if (vis !== f.vis) { f.vis = vis; f.el.style.display = vis ? 'flex' : 'none'; }
        if (!vis) continue;
        if (f.push) f.el.style.transform = 'scale(' + (1 + f.push * (t - f.a) / (f.b - f.a)).toFixed(4) + ')';
        for (var j = 0; j < f.items.length; j++) setItem(f.items[j], t);
        if (f.upd) f.upd(t, f);
      }
      var bh = 'calc(max(7vh,66px) + ' + ((1 - ez.oc(pr(t, 0, 1.3))) * 22).toFixed(1) + 'vh)';
      lbT.style.height = bh; lbB.style.height = bh;
      blk.style.opacity = pr(t, 26.1, 26.5).toFixed(3);
      if (gctx && t - lastG > 0.04) {
        lastG = t; var dd = gimg.data;
        for (var k = 0; k < dd.length; k += 4) { var v = (Math.random() * 255) | 0; dd[k] = dd[k + 1] = dd[k + 2] = 255; dd[k + 3] = v > 205 ? (v - 205) * 2 : 0; }
        gctx.putImageData(gimg, 0, 0);
      }
    }
    return { root: root, skip: skip, hint: hint, render: render };
  }

  /* ------------------------------------------------------------------ audio */
  function buildAudio(ctx, startAt, T0) {
    var A = function (t) { return T0 + Math.max(0, t - startAt); };
    var live = function (t) { return t >= startAt - 0.0005; };
    var safe = function (fn) { try { fn(); } catch (e) { try { console.warn('[trailer audio]', e && e.message); } catch (_) { /* ignore */ } } };
    var master = ctx.createGain(), comp = ctx.createDynamicsCompressor(), mute = ctx.createGain();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 10; comp.attack.value = 0.003; comp.release.value = 0.25;
    master.gain.setValueAtTime(0.0001, T0); master.gain.linearRampToValueAtTime(0.5, T0 + 0.3);
    master.gain.setValueAtTime(0.5, A(26.3)); master.gain.linearRampToValueAtTime(0.0001, A(28.7));
    master.connect(comp); comp.connect(mute); mute.connect(ctx.destination);

    // reverb: generated impulse response
    var revIn = ctx.createGain(), revOut = ctx.createGain(), conv = ctx.createConvolver();
    safe(function () {
      var n = Math.floor(ctx.sampleRate * 2.8), ir = ctx.createBuffer(2, n, ctx.sampleRate);
      for (var ch = 0; ch < 2; ch++) { var d = ir.getChannelData(ch); for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6); }
      conv.buffer = ir; revOut.gain.value = 0.5;
      revIn.connect(conv); conv.connect(revOut); revOut.connect(master);
    });
    // noise
    var nbuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nbuf.getChannelData(0);
    for (var ni = 0; ni < nd.length; ni++) nd[ni] = Math.random() * 2 - 1;
    function noise(c0, dur) { var s = ctx.createBufferSource(); s.buffer = nbuf; s.loop = true; s.start(c0); s.stop(c0 + dur); return s; }
    // keypoint automation (song time -> param); exp = geometric, else linear
    function autom(param, kps, exp, mult) {
      mult = mult || 1;
      var v0 = kps[kps.length - 1][1], i;
      if (startAt <= kps[0][0]) v0 = kps[0][1];
      else for (i = 1; i < kps.length; i++) if (startAt <= kps[i][0]) {
        var a = kps[i - 1], b = kps[i], u = (startAt - a[0]) / (b[0] - a[0]);
        v0 = exp ? a[1] * Math.pow(b[1] / a[1], u) : a[1] + (b[1] - a[1]) * u; break;
      }
      param.setValueAtTime(v0 * mult, T0);
      for (i = 0; i < kps.length; i++) if (kps[i][0] > startAt) {
        if (exp) param.exponentialRampToValueAtTime(kps[i][1] * mult, A(kps[i][0])); else param.linearRampToValueAtTime(kps[i][1] * mult, A(kps[i][0]));
      }
    }
    function scaled(kps, m) { return kps.map(function (k) { return [k[0], k[1] * m]; }); }

    // drone pad (rises through the film, ducks in the 10.5-11.0 silence)
    safe(function () {
      var END = 29;
      var fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.Q.value = 3;
      var dg = ctx.createGain(); fl.connect(dg); dg.connect(master);
      autom(dg.gain, [[0, 0.0001], [1.6, 0.2], [8, 0.24], [10.4, 0.32], [10.5, 0.03], [11, 0.03], [11.2, 0.36], [14.5, 0.42], [19.5, 0.48], [22.9, 0.5], [23.05, 0.62], [26, 0.55], [26.5, 0.5], [28.6, 0.0001]], true);
      autom(fl.frequency, [[0, 90], [8, 320], [10.4, 520], [10.5, 110], [11, 110], [11.3, 800], [14.5, 1400], [19.5, 2200], [23, 3400], [26.5, 2600], [28.6, 300]], true);
      var fk = [[0, 55], [11, 55], [14.5, 65.4], [19.5, 73.4], [23, 82.4], [END, 82.4]];
      var lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.18; lg.gain.value = 120; lfo.connect(lg); lg.connect(fl.frequency);
      lfo.start(T0); lfo.stop(A(END));
      [['sawtooth', 1, 0.5, null], ['sawtooth', 1.007, 0.4, null], ['sine', 0.5, 0.8, null], ['triangle', 1.5, 0.3, [[0, 0.0001], [10.9, 0.0001], [12, 1], [END, 1]]]].forEach(function (v) {
        var o = ctx.createOscillator(), g = ctx.createGain(); o.type = v[0]; o.connect(g); g.connect(fl);
        if (v[3]) autom(g.gain, scaled(v[3], v[2]), true); else g.gain.value = v[2];
        autom(o.frequency, fk, true, v[1]); o.start(T0); o.stop(A(END));
      });
    });

    function kick(t, v) {
      if (!live(t)) return;
      safe(function () {
        var c = A(t), o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(120, c); o.frequency.exponentialRampToValueAtTime(40, c + 0.12);
        g.gain.setValueAtTime(0.0001, c); g.gain.linearRampToValueAtTime(v, c + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, c + 0.38);
        o.connect(g); g.connect(master); o.start(c); o.stop(c + 0.45);
      });
    }
    function hat(t, v) {
      if (!live(t)) return;
      safe(function () {
        var c = A(t), n = noise(c, 0.08), hp = ctx.createBiquadFilter(), g = ctx.createGain();
        hp.type = 'highpass'; hp.frequency.value = 7000;
        g.gain.setValueAtTime(0.0001, c); g.gain.linearRampToValueAtTime(v, c + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, c + 0.04);
        n.connect(hp); hp.connect(g); g.connect(master);
      });
    }
    function tick(t, v, f) {
      if (!live(t)) return;
      safe(function () {
        var c = A(t), o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f || 2000;
        g.gain.setValueAtTime(0.0001, c); g.gain.linearRampToValueAtTime(v || 0.16, c + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, c + 0.045);
        o.connect(g); g.connect(master); o.start(c); o.stop(c + 0.06);
      });
    }
    function boom(t, v, long) {
      if (!live(t)) return;
      safe(function () {
        var c = A(t), d = long ? 1.7 : 0.7, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(110, c); o.frequency.exponentialRampToValueAtTime(28, c + 0.6);
        g.gain.setValueAtTime(0.0001, c); g.gain.linearRampToValueAtTime(v * 0.95, c + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, c + d);
        o.connect(g); g.connect(master); g.connect(revIn); o.start(c); o.stop(c + d + 0.05);
        var n = noise(c, 0.6), lp = ctx.createBiquadFilter(), ng = ctx.createGain();
        lp.type = 'lowpass'; lp.frequency.setValueAtTime(5000, c); lp.frequency.exponentialRampToValueAtTime(180, c + 0.45);
        ng.gain.setValueAtTime(0.0001, c); ng.gain.linearRampToValueAtTime(v * 0.55, c + 0.004); ng.gain.exponentialRampToValueAtTime(0.0001, c + 0.5);
        n.connect(lp); lp.connect(ng); ng.connect(master); ng.connect(revIn);
      });
    }
    function whoosh(t0, t1, v, f0, f1) {
      if (t1 <= startAt) return;
      safe(function () {
        var c0 = A(Math.max(t0, startAt)), n = noise(c0, A(t1) - c0 + 0.3), bp = ctx.createBiquadFilter(), g = ctx.createGain();
        bp.type = 'bandpass'; bp.Q.value = 2.5; n.connect(bp); bp.connect(g); g.connect(master); g.connect(revIn);
        autom(bp.frequency, [[t0, f0], [t1, f1]], true);
        autom(g.gain, [[t0, 0.0001], [t1 - 0.04, v], [t1 + 0.06, 0.0001]], true);
      });
    }
    var shaper = null;
    safe(function () {
      var n = 1024, cv = new Float32Array(n);
      for (var i = 0; i < n; i++) { var x = i * 2 / n - 1; cv[i] = Math.tanh(3.2 * x); }
      shaper = cv;
    });
    function engine(t0, t1, f0, f1, v, o) {
      if (t1 <= startAt) return;
      o = o || {};
      safe(function () {
        var c0 = A(Math.max(t0 - 0.05, startAt)), c1 = A(t1) + 0.3;
        var out = ctx.createGain(), bp = ctx.createBiquadFilter(), ws = ctx.createWaveShaper(), mix = ctx.createGain();
        if (shaper) ws.curve = shaper; ws.oversample = '2x';
        bp.type = 'bandpass'; bp.Q.value = 0.9; mix.gain.value = 0.5;
        mix.connect(ws); ws.connect(bp); bp.connect(out);
        if (o.pan && ctx.createStereoPanner) { var sp = ctx.createStereoPanner(); out.connect(sp); sp.connect(master); autom(sp.pan, o.pan, false); } else out.connect(master);
        var fk = o.f || [[t0, f0], [t1, f1]];
        autom(out.gain, o.g || [[t0, 0.0001], [t0 + 0.25, v], [t1 - 0.12, v], [t1, 0.0001]], true);
        autom(bp.frequency, fk, true, 2.4);
        [[1, 1], [2.003, 0.5], [3.01, 0.3]].forEach(function (h) {
          var os = ctx.createOscillator(), g = ctx.createGain(); os.type = 'sawtooth'; g.gain.value = h[1];
          os.connect(g); g.connect(mix); autom(os.frequency, fk, true, h[0]); os.start(c0); os.stop(c1);
        });
      });
    }

    // heartbeat kick grid, anchored on each segment start so every scene cut lands on a hit
    function grid(a, b, step, vel, ghost) {
      for (var t = a; t < b - 0.01; t += step) {
        var i = Math.round((t - a) / step);
        var v = Array.isArray(vel) ? vel[i % vel.length] : vel;
        kick(t, v); if (ghost) kick(t + 0.2, v * 0.5);
      }
    }
    grid(0.6, 3.5, 1.2, 0.42, true);
    grid(3.5, 8.0, 0.6, 0.55, true);
    grid(8.0, 10.5, 0.6, 0.6, true);
    grid(11.0, 14.1, 0.3, [0.7, 0.32], false);
    grid(14.5, 16.5, 0.3, [0.62, 0.34], false);
    grid(16.5, 19.5, 0.15, [0.5, 0.2, 0.34, 0.2], false);
    grid(19.5, 22.3, 0.3, [0.62, 0.34], false);
    grid(22.3, 22.95, 0.15, [0.55, 0.25, 0.4, 0.25], false);
    for (var h = 14.65; h < 22.9; h += 0.3) hat(h, 0.05);

    // slam / cut hits
    [[3.5, 0.4], [5.0, 0.45], [5.7, 0.4], [6.5, 0.45], [8.1, 0.3], [11.0, 0.55], [11.35, 0.7], [12.0, 0.5], [12.35, 0.5], [12.7, 0.5],
      [19.6, 0.3], [20.3, 0.3], [21.0, 0.35], [21.7, 0.3], [23.9, 0.45]].forEach(function (b) { boom(b[0], b[1], false); });
    boom(14.1, 1.0, true); boom(23.0, 1.0, true); boom(26.0, 0.9, true); boom(14.5, 0.35, false);

    // riser whooshes
    whoosh(7.55, 8.0, 0.1, 300, 4000); whoosh(10.55, 11.0, 0.1, 300, 4000);
    whoosh(13.3, 14.1, 0.3, 300, 7000); whoosh(22.25, 23.0, 0.38, 250, 8000);

    // engine: rev 90 -> 900 Hz over 2.5 s into the BOX press, gear-shift bursts in scene 5, Doppler pass-by at the title
    engine(11.6, 14.13, 90, 900, 0.3, { g: [[11.6, 0.0001], [11.95, 0.3], [14.0, 0.42], [14.13, 0.0001]] });
    engine(15.0, 15.8, 200, 700, 0.2); engine(16.25, 17.05, 220, 780, 0.2); engine(17.5, 18.4, 240, 860, 0.22);
    engine(22.3, 24.3, 760, 230, 0.5, {
      f: [[22.3, 760], [22.98, 640], [23.02, 400], [24.3, 230]], pan: [[22.3, -1], [24.3, 1]],
      g: [[22.3, 0.0001], [22.98, 0.5], [24.3, 0.0001]]
    });

    // count-up ticks (soft 2 kHz click per step) + lock hit
    Object.keys(CU).forEach(function (k) {
      var c = CU[k];
      for (var s = 1; s < c.K; s++) tick(c.a0 + s * c.dt, 0.13, 1900 + s * 60);
      tick(cuLock(c), 0.24, 2800); boom(cuLock(c), 0.28, false);
    });

    var closeTimer = null;
    return {
      mute: function (m) { safe(function () { mute.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.03); }); },
      stop: function (quick) {
        safe(function () {
          if (quick) {
            var n = ctx.currentTime; master.gain.cancelScheduledValues(n); master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), n); master.gain.linearRampToValueAtTime(0.0001, n + 0.18);
          }
        });
        var wait = quick ? 450 : Math.max(500, (A(29) - ctx.currentTime) * 1000);
        closeTimer = setTimeout(function () { try { var p = ctx.close(); if (p && p.catch) p.catch(function () { /* ignore */ }); } catch (e) { /* ignore */ } }, wait);
      }
    };
  }

  /* ------------------------------------------------------------------- play */
  function play(opts) {
    opts = opts || {};
    if (running) return running;
    var startAt = clamp(+opts.startAt || 0, 0, DUR - 0.05);
    var done = false, raf = 0, audio = null, muted = false, ui = null, vis0 = 0, skipped = false, resolveFn;
    var prevOverflow = document.documentElement.style.overflow;
    var promise = new Promise(function (res) { resolveFn = res; });
    running = promise;

    // audio context must be created inside the user gesture that called play()
    var ctx = null;
    var AC = window.AudioContext || window.webkitAudioContext;
    var activated = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (AC && activated) { try { ctx = new AC(); } catch (e) { ctx = null; } }

    if (!document.getElementById('bbx-trailer-style')) {
      var st = document.createElement('style'); st.id = 'bbx-trailer-style'; st.textContent = CSS; document.head.appendChild(st);
    }

    function finish(wasSkipped) {
      if (done) return; done = true; skipped = !!wasSkipped;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      if (audio) { try { audio.stop(skipped); } catch (e) { /* ignore */ } } else if (ctx) { try { ctx.close(); } catch (e) { /* ignore */ } }
      if (ui && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
      document.documentElement.style.overflow = prevOverflow;
      running = null;
      try { if (typeof opts.onend === 'function') opts.onend({ skipped: skipped }); } catch (e) { try { console.error(e); } catch (_) { /* ignore */ } }
      resolveFn({ skipped: skipped });
    }
    function toggleMute() {
      muted = !muted; if (audio) audio.mute(muted);
      if (ui) ui.hint.textContent = muted ? 'Muted  ·  M unmute' : 'Esc skip  ·  M mute';
    }
    function onKey(e) {
      var k = e.key;
      if (k === 'Escape' || k === ' ' || e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); finish(true); }
      else if (k === 'm' || k === 'M') { e.preventDefault(); e.stopImmediatePropagation(); toggleMute(); }
    }

    loadPath().then(function (pathD) {
      if (done) return;
      try { ui = build(pathD, startAt); } catch (e) { try { console.error(e); } catch (_) { /* ignore */ } finish(false); return; }
      document.documentElement.style.overflow = 'hidden';
      document.body.appendChild(ui.root);
      ui.skip.addEventListener('click', function (e) { e.stopPropagation(); finish(true); });
      window.addEventListener('keydown', onKey, true);
      try { ui.skip.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      ui.render(startAt);

      function go() {
        if (done) return;
        var lead = 120;
        if (audio) { /* audio scheduled at ctx time T0 = now + lead */ }
        vis0 = performance.now() + lead + (ctx && ctx.outputLatency ? ctx.outputLatency * 1000 : 0);
        var loop = function () {
          if (done) return;
          var t = opts.hold ? startAt : startAt + Math.max(0, (performance.now() - vis0) / 1000);
          try { ui.render(t); } catch (e) { try { console.error(e); } catch (_) { /* ignore */ } }
          if (t >= DUR && !opts.hold) finish(false); else raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      }

      if (ctx && !opts.hold) {
        var r = null; try { r = ctx.resume && ctx.resume(); } catch (e) { r = null; }
        Promise.race([Promise.resolve(r), new Promise(function (ok) { setTimeout(ok, 300); })]).then(function () {
          if (done) return;
          if (ctx.state === 'running') { try { audio = buildAudio(ctx, startAt, ctx.currentTime + 0.12); } catch (e) { audio = null; try { console.warn('[trailer audio]', e && e.message); } catch (_) { /* ignore */ } } }
          if (!audio) { try { ctx.close(); } catch (e) { /* ignore */ } }
          go();
        }, go);
      } else {
        if (ctx) { try { ctx.close(); } catch (e) { /* ignore */ } ctx = null; }
        go();
      }
    });
    return promise;
  }

  window.BoxBoxTrailer = { play: play, duration: DUR };
})();
