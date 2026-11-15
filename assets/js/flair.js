/* ULTRON Flair: front end only, loaded last. Nothing here changes app logic.
   Every effect has a switch in Settings > Flair (saved as lmpv9_fx_<name>). */
(function () {
  'use strict';
  var D = document, R = D.documentElement, BASE = 'ULTRON';
  var $ = function (i) { return D.getElementById(i); };
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  function safe(fn) { try { fn(); } catch (e) { try { console.warn('flair:', e); } catch (_) {} } }
  function mk(tag, cls, html) { var e = D.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function typing(e) { var t = e.target, g = t && t.tagName; return (g === 'INPUT' && t.type !== 'range') || g === 'TEXTAREA' || g === 'SELECT' || !!(t && t.isContentEditable); }
  function say(t, ms) { try { if (typeof toast === 'function') toast(t, ms || 2200); } catch (e) {} }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function playing() { var i = $('play-icon'); return !!i && /fa-pause/.test(i.className); }
  function vidOpen() { var m = $('player-modal'); return !!m && !m.classList.contains('hidden'); }

  /* ---------- shared state: audio levels + palette ---------- */
  var A = { an: null, data: null, peak: .2, bass: 0, level: 0, avg: 0, kick: 0, last: 0 };
  var bassEls = [];
  var PAL = [[255, 195, 113], [255, 95, 143], [139, 107, 255]];
  function readPal() {
    var cs = getComputedStyle(R);
    ['--pr1rgb', '--pr2rgb', '--pr3rgb'].forEach(function (v, i) {
      var m = cs.getPropertyValue(v).split(',').map(Number);
      if (m.length === 3 && m.every(isFinite)) PAL[i] = m;
    });
  }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  var favDirty = true;
  safe(function () {
    readPal();
    new MutationObserver(function () { readPal(); favDirty = true; }).observe(R, { attributes: true, attributeFilter: ['data-pal'] });
  });

  /* tap the audio element's source so we can read real spectrum data (must run before the first click) */
  safe(function () {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !AC.prototype.createMediaElementSource) return;
    var orig = AC.prototype.createMediaElementSource;
    AC.prototype.createMediaElementSource = function (el) {
      var node = orig.apply(this, arguments);
      try {
        if (el && el.id === 'audio' && !A.an) {
          var an = this.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = .55;
          node.connect(an); A.an = an; A.data = new Uint8Array(an.frequencyBinCount);
        }
      } catch (e) {}
      return node;
    };
  });

  /* ---------- feature switches ---------- */
  var FXS = [
    ['ripple', 'Click ripples', 'A ring pops out wherever you click'],
    ['magnet', 'Magnetic buttons', 'Play and action buttons lean toward your cursor'],
    ['trail', 'Cursor comet', 'A soft glowing trail follows the pointer'],
    ['dust', 'Floating dust', 'Tiny lights drift behind the page and speed up with the bass'],
    ['aurora', 'Aurora glow', 'Slow colour clouds in your palette behind everything (dark mode)'],
    ['reveal', 'Scroll reveal', 'Posters and cards rise in as they appear'],
    ['beat', 'Bass reactive glow', 'The music bar, logo and Now Playing pulse with the low end'],
    ['tint', 'Cover colour', 'The music bar takes the colour of the album art'],
    ['squish', 'Button squish', 'Buttons press down a little when clicked'],
    ['title', 'Song in window title', 'Shows what is playing in the window title'],
    ['stars', 'Stars (ULTRON STAR)', 'Drifting white specks behind everything. Turn off if they sit over your photos. Alt+S'],
    ['idle', 'Screensaver', 'After 3 minutes of nothing: a big clock and what is playing']
  ];
  var hooks = {};
  function on(k) { return LS.get('lmpv9_fx_' + k, '1') === '1'; }
  function setFx(k, v) { LS.set('lmpv9_fx_' + k, v ? '1' : '0'); R.classList.toggle('fl-no-' + k, !v); if (hooks[k]) hooks[k](v); }
  FXS.forEach(function (f) { R.classList.toggle('fl-no-' + f[0], !on(f[0])); });

  /* ---------- click ripple + magnetic buttons ---------- */
  safe(function () {
    D.addEventListener('pointerdown', function (e) {
      if (reduce || !on('ripple') || e.button) return;
      var r = mk('div', 'fl-ripple'); r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      D.body.appendChild(r); setTimeout(function () { r.remove(); }, 650);
    }, { passive: true });
    var sel = '#audio-bar button.bg-white, #audio-bar [onclick="togglePlay()"], #p-play, .mpill, #pl-generate';
    D.addEventListener('mousemove', function (e) {
      if (reduce || !on('magnet')) return;
      var b = e.target.closest ? e.target.closest(sel) : null; if (!b) return;
      var r = b.getBoundingClientRect();
      var x = (e.clientX - (r.left + r.width / 2)) / r.width, y = (e.clientY - (r.top + r.height / 2)) / r.height;
      b.classList.add('fl-mag'); b.style.transform = 'translate(' + (x * 7).toFixed(1) + 'px,' + (y * 7).toFixed(1) + 'px)';
    }, { passive: true });
    D.addEventListener('mouseout', function (e) {
      var b = e.target.closest ? e.target.closest(sel) : null;
      if (b && !b.contains(e.relatedTarget)) b.style.transform = '';
    }, { passive: true });
  });

  /* ---------- cursor comet ---------- */
  safe(function () {
    var c = mk('canvas'); c.id = 'fl-trail'; c.setAttribute('aria-hidden', 'true'); D.body.appendChild(c);
    var x = c.getContext('2d'), pts = [], raf = 0;
    function fit() { c.width = innerWidth; c.height = innerHeight; }
    fit(); addEventListener('resize', fit);
    function draw() {
      raf = 0; x.clearRect(0, 0, c.width, c.height); x.globalCompositeOperation = 'lighter';
      for (var i = pts.length - 1; i >= 0; i--) {
        var p = pts[i]; p.a -= .04;
        if (p.a <= 0) { pts.splice(i, 1); continue; }
        var col = PAL[i % 3], r = 2 + p.a * 8;
        x.fillStyle = rgba(col, p.a * .35); x.beginPath(); x.arc(p.x, p.y, r * 2.2, 0, 6.283); x.fill();
        x.fillStyle = rgba(col, p.a * .9); x.beginPath(); x.arc(p.x, p.y, r * .55, 0, 6.283); x.fill();
      }
      if (pts.length) raf = requestAnimationFrame(draw);
    }
    D.addEventListener('mousemove', function (e) {
      if (reduce || !on('trail') || vidOpen()) return;
      var l = pts[pts.length - 1];
      if (l && Math.abs(l.x - e.clientX) + Math.abs(l.y - e.clientY) < 6) return;
      pts.push({ x: e.clientX, y: e.clientY, a: 1 }); if (pts.length > 26) pts.shift();
      if (!raf) raf = requestAnimationFrame(draw);
    }, { passive: true });
    hooks.trail = function (v) { if (!v) { pts.length = 0; x.clearRect(0, 0, c.width, c.height); } };
  });

  /* ---------- floating dust (reacts to the bass) ---------- */
  safe(function () {
    var c = mk('canvas'); c.id = 'fl-dust'; c.setAttribute('aria-hidden', 'true');
    var bg = $('bg-layer'); if (bg && bg.parentNode) bg.parentNode.insertBefore(c, bg.nextSibling); else D.body.insertBefore(c, D.body.firstChild);
    var x = c.getContext('2d'), ps = [], raf = 0, last = 0;
    function mkp() { return { x: Math.random() * innerWidth, y: Math.random() * innerHeight, r: .7 + Math.random() * 1.7, vx: (Math.random() - .5) * .18, vy: -.06 - Math.random() * .22, t: Math.random() * 6.283, c: (Math.random() * 3) | 0 }; }
    function fit() {
      c.width = innerWidth; c.height = innerHeight;
      var n = clamp(Math.round(innerWidth * innerHeight / 30000), 22, 64);
      while (ps.length < n) ps.push(mkp()); ps.length = n;
    }
    function frame(ts) {
      raf = 0;
      if (D.hidden || !on('dust')) { x.clearRect(0, 0, c.width, c.height); return; }
      raf = requestAnimationFrame(frame);
      if (ts - last < 32) return; last = ts;
      if (vidOpen()) { x.clearRect(0, 0, c.width, c.height); return; }
      x.clearRect(0, 0, c.width, c.height);
      var sp = 1 + A.level * 6;
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i]; p.t += .02; p.x += p.vx * sp; p.y += p.vy * sp;
        if (p.y < -6) { p.y = innerHeight + 6; p.x = Math.random() * innerWidth; }
        if (p.x < -6) p.x = innerWidth + 6; else if (p.x > innerWidth + 6) p.x = -6;
        var a = .18 + .3 * (.5 + .5 * Math.sin(p.t)) + A.level * .3;
        x.fillStyle = rgba(PAL[p.c], clamp(a, 0, .85)); x.beginPath(); x.arc(p.x, p.y, p.r * (1 + A.level * .6), 0, 6.283); x.fill();
      }
    }
    function start() { if (!raf && on('dust') && !reduce) raf = requestAnimationFrame(frame); }
    fit(); addEventListener('resize', fit); D.addEventListener('visibilitychange', start);
    hooks.dust = start; start();
  });

  /* ---------- aurora ---------- */
  safe(function () {
    var a = mk('div', null, '<i></i><i></i><i></i>'); a.id = 'fl-aurora'; a.setAttribute('aria-hidden', 'true');
    var bg = $('bg-layer'); if (bg && bg.parentNode) bg.parentNode.insertBefore(a, bg.nextSibling); else D.body.insertBefore(a, D.body.firstChild);
  });

  /* ---------- scroll reveal for posters and cards ---------- */
  safe(function () {
    var main = $('main'); if (!main || !('IntersectionObserver' in window)) return;
    var SEL = '.vcard:not(.skeleton), .video-card';
    var io = new IntersectionObserver(function (es) {
      var n = 0;
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target; io.unobserve(el); el.classList.remove('fl-pre');
        if (!on('reveal') || reduce) return;
        el.style.animationDelay = Math.min(n++, 10) * 45 + 'ms'; el.classList.add('fl-rise');
        el.addEventListener('animationend', function f(ev) {
          if (ev.target !== el) return;
          el.classList.remove('fl-rise'); el.style.animationDelay = ''; el.removeEventListener('animationend', f);
        });
      });
    }, { rootMargin: '0px 0px -4% 0px', threshold: .05 });
    function mark(el) {
      if (el.dataset.fl) return; el.dataset.fl = '1';
      if (!on('reveal') || reduce) return;
      el.classList.add('fl-pre'); io.observe(el);
      setTimeout(function () { el.classList.remove('fl-pre'); }, 2500);
    }
    var queue = [], pend = false;
    function flush() {
      pend = false;
      queue.splice(0).forEach(function (n) {
        if (n.nodeType !== 1) return;
        if (n.matches && n.matches(SEL)) mark(n);
        if (n.querySelectorAll) [].forEach.call(n.querySelectorAll(SEL), mark);
      });
    }
    new MutationObserver(function (ms) {
      ms.forEach(function (m) { [].forEach.call(m.addedNodes, function (n) { queue.push(n); }); });
      if (!pend && queue.length) { pend = true; requestAnimationFrame(flush); }
    }).observe(main, { childList: true, subtree: true });
  });

  /* ---------- music bar: spectrum, bass, cover tint, song swap, title, favicon ---------- */
  safe(function () {
    var bar = $('audio-bar'), icon = $('play-icon'), title = $('np-title'), artist = $('np-artist'), cover = $('np-cover');
    ['audio-bar', 'sidebar', 'lm-mark', 'nowplaying', 'fl-aurora'].forEach(function (id) { var e = $(id); if (e) bassEls.push(e); });

    var barEls = [];
    if (bar && title) {
      var bars = mk('span', 'fl-bars', '<i></i><i></i><i></i><i></i>'); bars.setAttribute('aria-hidden', 'true');
      (artist && artist.parentNode ? artist.parentNode : title.parentNode).appendChild(bars);
      barEls = [].slice.call(bars.children);
    }

    /* real-time loop: reads the analyser while a song plays, eases back to 0 when it stops */
    var raf = 0, EDGES = [[1, 3], [3, 7], [7, 17], [17, 45]];
    function setBass(v) { var s = v.toFixed(3); for (var i = 0; i < bassEls.length; i++) bassEls[i].style.setProperty('--bass', s); }
    function loop(ts) {
      raf = 0;
      var live = !!(A.an && playing() && on('beat') && !D.hidden && !reduce);
      if (live) {
        A.an.getByteFrequencyData(A.data);
        var d = A.data, i, b = 0;
        for (i = 0; i < 3; i++) b += d[i]; b /= 765;
        A.peak = Math.max(A.peak * .9985, b, .12);
        var n = Math.min(1, b / A.peak);
        A.bass += (n - A.bass) * (n > A.bass ? .55 : .14);
        if (b > A.avg * 1.28 && b > .22 && ts - A.last > 200) { A.kick = 1; A.last = ts; }
        A.avg += (b - A.avg) * .06; A.kick *= .88;
        A.level = Math.max(Math.pow(A.bass, 1.5), A.kick * .9);
        for (i = 0; i < barEls.length; i++) {
          var e = EDGES[i], s = 0; for (var k = e[0]; k < e[1]; k++) s += d[k];
          barEls[i].style.transform = 'scaleY(' + clamp(.14 + (s / (e[1] - e[0]) / 255) * 1.9, .14, 1).toFixed(2) + ')';
        }
      } else {
        A.level *= .85; A.bass *= .85; A.kick *= .85; if (A.level < .01) A.level = 0;
      }
      setBass(A.level);
      if (bar) bar.classList.toggle('fl-live', live);
      if (live || A.level > 0) raf = requestAnimationFrame(loop);
    }
    function kick() { if (!raf) raf = requestAnimationFrame(loop); }
    hooks.beat = kick;
    D.addEventListener('visibilitychange', kick);
    setInterval(function () { if (playing() && A.an && !raf) kick(); }, 1000);   /* the analyser appears after the first click */

    /* window title */
    function syncTitle() {
      var t = title && title.textContent.trim(), a = artist && artist.textContent.trim();
      D.title = on('title') && playing() && t ? '\u25B6 ' + t + (a ? ' \u2014 ' + a : '') : BASE;
    }
    hooks.title = syncTitle;
    function sync() { if (bar) bar.classList.toggle('fl-on', playing()); syncTitle(); if (playing()) kick(); }
    if (icon) new MutationObserver(sync).observe(icon, { attributes: true, attributeFilter: ['class'] });
    sync();

    /* song change animation */
    function swap() {
      [title, artist, cover].forEach(function (el, i) {
        if (!el || reduce) return;
        var c = i === 2 ? 'fl-pop' : 'fl-swap'; el.classList.remove(c); void el.offsetWidth; el.classList.add(c);
      });
    }
    if (title) new MutationObserver(function () { syncTitle(); swap(); }).observe(title, { childList: true, characterData: true, subtree: true });

    /* cover colour */
    var cv = mk('canvas'); cv.width = cv.height = 16;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    function tint() {
      if (!bar) return;
      try {
        if (!on('tint') || !cover || !cover.complete || !cover.naturalWidth) { bar.style.removeProperty('--fl-tint'); return; }
        cx.drawImage(cover, 0, 0, 16, 16);
        var d = cx.getImageData(0, 0, 16, 16).data, best = null, score = -1;
        for (var i = 0; i < d.length; i += 4) {
          var r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          var s = (mx - mn) * (mx > 60 ? 1 : .2);
          if (s > score) { score = s; best = [r, g, b]; }
        }
        if (best && score > 40) {
          var m = Math.max.apply(null, best), k = m < 170 ? 190 / Math.max(m, 1) : 1;
          bar.style.setProperty('--fl-tint', best.map(function (v) { return Math.min(255, Math.round(v * k)); }).join(','));
        } else bar.style.removeProperty('--fl-tint');
      } catch (e) { bar.style.removeProperty('--fl-tint'); }
    }
    hooks.tint = tint;
    if (cover) { cover.addEventListener('load', tint); tint(); }

    /* favicon (visible when you run it in a browser tab) */
    var link = D.querySelector('link[rel~="icon"]');
    if (!link) { link = mk('link'); link.rel = 'icon'; D.head.appendChild(link); }
    var fc = mk('canvas'); fc.width = fc.height = 64; var fx = fc.getContext('2d');
    function rr(x, y, w, h, r) { fx.beginPath(); fx.moveTo(x + r, y); fx.arcTo(x + w, y, x + w, y + h, r); fx.arcTo(x + w, y + h, x, y + h, r); fx.arcTo(x, y + h, x, y, r); fx.arcTo(x, y, x + w, y, r); fx.closePath(); }
    function fav() {
      var g = fx.createLinearGradient(0, 0, 64, 64); g.addColorStop(0, rgba(PAL[0], 1)); g.addColorStop(.5, rgba(PAL[1], 1)); g.addColorStop(1, rgba(PAL[2], 1));
      fx.clearRect(0, 0, 64, 64); fx.fillStyle = g; rr(2, 2, 60, 60, 16); fx.fill(); fx.fillStyle = '#fff';
      if (playing()) {
        var t = Date.now() / 1000;
        for (var i = 0; i < 4; i++) { var h = 10 + 34 * (.25 + .75 * Math.abs(Math.sin(t * 3.2 + i * 1.4))) * (.6 + A.level * .8); rr(11 + i * 11.5, 50 - h, 7, h, 3); fx.fill(); }
      } else { fx.font = '800 30px Inter, Arial, sans-serif'; fx.textAlign = 'center'; fx.textBaseline = 'middle'; fx.fillText('LM', 32, 34); }
      try { link.href = fc.toDataURL('image/png'); } catch (e) {}
    }
    setInterval(function () { if (D.hidden) return; if (playing() || favDirty) { favDirty = false; fav(); } }, 300);
    fav();
  });

  /* ---------- banner + confetti ---------- */
  function banner(text, sub) {
    var old = $('fl-banner'); if (old) old.remove();
    var b = mk('div', null, text + (sub ? '<small>' + sub + '</small>' : '')); b.id = 'fl-banner'; D.body.appendChild(b);
    setTimeout(function () { b.remove(); }, 2400);
  }
  var confettiBusy = false;
  function confetti(n) {
    if (reduce || confettiBusy) return; confettiBusy = true;
    var c = mk('canvas'); c.id = 'fl-confetti'; c.width = innerWidth; c.height = innerHeight; D.body.appendChild(c);
    var x = c.getContext('2d'), cols = [PAL[0], PAL[1], PAL[2], [255, 255, 255]], ps = [], t0 = performance.now();
    for (var i = 0; i < (n || 150); i++) {
      var a = -Math.PI / 2 + (Math.random() - .5) * 1.5, sp = 9 + Math.random() * 12;
      ps.push({ x: innerWidth / 2, y: innerHeight * .8, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, w: 6 + Math.random() * 7, h: 3 + Math.random() * 5, r: Math.random() * 6, vr: (Math.random() - .5) * .4, c: cols[i % 4] });
    }
    (function step(now) {
      var life = now - t0; x.clearRect(0, 0, c.width, c.height);
      ps.forEach(function (p) {
        p.vy += .32; p.vx *= .992; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.fillStyle = rgba(p.c, clamp(1 - life / 3600, 0, 1));
        x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); x.restore();
      });
      if (life < 3600) requestAnimationFrame(step); else { c.remove(); confettiBusy = false; }
    })(t0);
  }

  /* ---------- screensaver ---------- */
  var idle = { el: null, on: false, last: Date.now(), px: -1, py: -1, tick: 0 };
  function idlePaint() {
    var t = idle.el.querySelector('.fi-time'), d = idle.el.querySelector('.fi-date'), n = idle.el.querySelector('.fi-np');
    var now = new Date();
    t.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    d.textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    var ti = $('np-title'), ar = $('np-artist');
    n.textContent = playing() && ti && ti.textContent.trim() ? '\u266A  ' + ti.textContent.trim() + (ar && ar.textContent.trim() ? '  \u00B7  ' + ar.textContent.trim() : '') : BASE;
  }
  function showIdle() {
    if (idle.on) return;
    if (!idle.el) {
      idle.el = mk('div', null, '<div class="fi-card"><div class="fi-time"></div><div class="fi-date"></div><div class="fi-np"></div></div><div class="fi-hint">move the mouse to wake</div>');
      idle.el.id = 'fl-idle'; D.body.appendChild(idle.el); bassEls.push(idle.el);
    }
    idle.on = true; idlePaint(); idle.tick = setInterval(idlePaint, 1000);
    requestAnimationFrame(function () { idle.el.classList.add('on'); });
  }
  function hideIdle() {
    if (!idle.on) return; idle.on = false; clearInterval(idle.tick); idle.el.classList.remove('on'); idle.last = Date.now();
  }
  safe(function () {
    ['keydown', 'wheel', 'touchstart', 'pointerdown'].forEach(function (ev) {
      addEventListener(ev, function () { idle.last = Date.now(); if (idle.on) hideIdle(); }, { passive: true, capture: true });
    });
    addEventListener('mousemove', function (e) {
      if (idle.on) { if (idle.px < 0 || Math.abs(e.clientX - idle.px) + Math.abs(e.clientY - idle.py) > 10) hideIdle(); idle.px = e.clientX; idle.py = e.clientY; return; }
      idle.last = Date.now(); idle.px = e.clientX; idle.py = e.clientY;
    }, { passive: true, capture: true });
    setInterval(function () {
      if (!on('idle') || idle.on || D.hidden || vidOpen()) return;
      if (window.galleryBg && galleryBg.current && galleryBg.current()) return;     // Gallery mode: its own idle screen (gallery-bg.js) takes over
      if (Date.now() - idle.last > 180000) showIdle();
    }, 5000);
    hooks.idle = function (v) { if (!v) hideIdle(); };
  });

  /* ---------- palette helper ---------- */
  var PALS = [['prism', 'Prism'], ['ember', 'Ember'], ['tide', 'Tide'], ['moss', 'Moss'], ['mono', 'Mono'], ['chrome', 'ULTRON STAR']];
  function setPal(name) {
    var b = D.querySelector('.lm-pal button[data-pal="' + name + '"]');
    if (b) b.click(); else { R.setAttribute('data-pal', name); LS.set('lmpv9_pal', name); }
  }

  /* ---------- secrets: type party, rave or lmpv9 ---------- */
  var raving = false;
  function rave() {
    if (raving) return; raving = true;
    var prev = R.getAttribute('data-pal') || 'prism', seq = ['ember', 'tide', 'moss', 'prism', 'ember', 'tide', 'moss', 'prism'], i = 0;
    R.classList.add('fl-rave'); banner('RAVE', 'ten seconds of colour'); confetti(90);
    var t = setInterval(function () {
      if (i >= seq.length) { clearInterval(t); R.setAttribute('data-pal', prev); R.classList.remove('fl-rave'); raving = false; return; }
      R.setAttribute('data-pal', seq[i++]);
    }, 1200);
  }
  safe(function () {
    var buf = '';
    D.addEventListener('keydown', function (e) {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey || !e.key || e.key.length !== 1) return;
      buf = (buf + e.key.toLowerCase()).slice(-8);
      if (/party$/.test(buf)) { buf = ''; banner('PARTY', 'let it rain'); confetti(170); }
      else if (/rave$/.test(buf)) { buf = ''; rave(); }
      else if (/(lmpv9|ultron)$/.test(buf)) { buf = ''; banner('ULTRON', 'you found it'); confetti(220); }
    });
  });

  /* ---------- back to top with a progress ring ---------- */
  safe(function () {
    var b = mk('button', null, '<i class="fas fa-arrow-up"></i>'); b.id = 'fl-top'; b.title = 'Back to top'; b.setAttribute('aria-label', 'Back to top'); D.body.appendChild(b);
    var pend = false;
    function y() { return Math.max(window.scrollY || 0, D.body.scrollTop || 0, R.scrollTop || 0); }
    function upd() {
      pend = false;
      var max = Math.max(D.body.scrollHeight - innerHeight, R.scrollHeight - innerHeight, 1), v = y();
      var music = typeof currentView !== 'undefined' && currentView === 'music-view';
      b.style.setProperty('--p', clamp(v / max, 0, 1).toFixed(3));
      b.classList.toggle('on', v > 700 && !music);
    }
    function q() { if (!pend) { pend = true; requestAnimationFrame(upd); } }
    addEventListener('scroll', q, { passive: true }); D.body.addEventListener('scroll', q, { passive: true });
    b.addEventListener('click', function () { try { D.body.scrollTo({ top: 0, behavior: 'smooth' }); window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {} });
    upd();
  });

  /* ---------- Settings > Flair ---------- */
  var flairSec = null, flairBtn = null, flairPane = null, flairNav = null;
  function showFlair() {
    if (!flairSec || !flairPane) return;
    [].forEach.call(flairPane.children, function (s) { s.classList.remove('lm-on'); });
    if (flairNav) [].forEach.call(flairNav.children, function (b) { b.classList.remove('on'); });
    flairSec.classList.add('lm-on'); if (flairBtn) flairBtn.classList.add('on'); flairPane.scrollTop = 0;
  }
  safe(function () {
    var pane = $('lm-set-pane'), nav = $('lm-set-nav'), modal = $('settings-modal');
    if (!pane) return;
    flairPane = pane; flairNav = nav;
    var sec = mk('section'); sec.id = 'fl-set'; flairSec = sec;
    var h = '<h4>Flair</h4><p class="fl-lead">New in ULTRON. Every effect has its own switch, and they all respect your system\'s reduced-motion setting.</p>';
    FXS.forEach(function (f) {
      h += '<div class="fl-row"><div><b>' + f[1] + '</b><span>' + f[2] + '</span></div><button type="button" class="fl-sw" role="switch" data-fx="' + f[0] + '" aria-checked="' + on(f[0]) + '" aria-label="' + f[1] + '"></button></div>';
    });
    h += '<div class="fl-acts"><button type="button" class="fl-btn" data-a="new">What\'s new</button><button type="button" class="fl-btn" data-a="idle">Preview screensaver</button></div>';
    h += '<div class="fl-tip"><span class="fl-kbd">Alt</span> + <span class="fl-kbd">1</span>\u2013<span class="fl-kbd">5</span> switch palette &nbsp;\u00B7&nbsp; <span class="fl-kbd">Alt</span> + <span class="fl-kbd">F</span> this page &nbsp;\u00B7&nbsp; <span class="fl-kbd">Alt</span> + <span class="fl-kbd">I</span> screensaver</div>';
    sec.innerHTML = h; pane.appendChild(sec);
    sec.addEventListener('click', function (e) {
      var sw = e.target.closest && e.target.closest('.fl-sw');
      if (sw) { var v = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(v)); setFx(sw.dataset.fx, v); return; }
      var a = e.target.closest && e.target.closest('[data-a]'); if (!a) return;
      if (a.dataset.a === 'new') { openNew(); }
      else if (a.dataset.a === 'idle') { if (typeof closeSettings === 'function') closeSettings(); setTimeout(function () { if (window.galleryBg && galleryBg.current && galleryBg.current() && window.galleryView) galleryView.open(); else showIdle(); }, 300); }
      else if (a.dataset.a === 'party') { confetti(150); }
    });
    if (nav) {
      var btn = mk('button'); btn.type = 'button'; var n = nav.children.length + 1;
      btn.innerHTML = '<i>' + (n < 10 ? '0' : '') + n + '</i><span>Flair</span>'; flairBtn = btn; nav.appendChild(btn);
      btn.addEventListener('click', showFlair);
      nav.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('button');
        if (b && b !== btn) { sec.classList.remove('lm-on'); btn.classList.remove('on'); }
      });
    }
  });
  function openFlairSettings() {
    if (typeof openSettings === 'function') { openSettings(); setTimeout(showFlair, 40); }
  }

  /* ---------- what's new (first launch of ULTRON) + welcome chip ---------- */
  function closeNew() { var n = $('fl-new'); if (n) n.remove(); LS.set('lmpv9_seen', '1'); }
  function openNew() {
    if ($('fl-new')) return;
    var n = mk('div', null,
      '<div class="fn-card"><div class="fn-tag">ULTRON \u00B7 THE BOOTH</div><h2>Things you can notice</h2><ul>' +
      '<li><i class="fas fa-wave-square"></i><span><b>Music that moves.</b> The music bar, logo and Now Playing glow with the real bass of the song, and four live bars dance next to the title.</span></li>' +
      '<li><i class="fas fa-palette"></i><span><b>Cover colour.</b> The bar takes the colour of the album art. Songs change with a little slide and pop.</span></li>' +
      '<li><i class="fas fa-wand-magic-sparkles"></i><span><b>Atmosphere.</b> Click ripples, a cursor comet, floating dust and a slow aurora in your palette. Posters rise in as you scroll.</span></li>' +
      '<li><i class="fas fa-moon"></i><span><b>Screensaver.</b> After 3 idle minutes you get a big clock and what is playing. The window title shows the song too.</span></li>' +
      '<li><i class="fas fa-keyboard"></i><span><b>Shortcuts.</b> <kbd>Alt</kbd>+<kbd>1</kbd>\u2013<kbd>5</kbd> palettes, <kbd>Alt</kbd>+<kbd>F</kbd> Flair settings, <kbd>Alt</kbd>+<kbd>I</kbd> screensaver.</span></li>' +
      '<li><i class="fas fa-gift"></i><span><b>Secrets.</b> Type <kbd>party</kbd>, <kbd>rave</kbd> or <kbd>lmpv9</kbd> anywhere.</span></li></ul>' +
      '<div class="fn-act"><button type="button" class="fl-btn" data-a="set">Flair settings</button><button type="button" class="fl-btn pri" data-a="go">Let\'s go</button></div></div>');
    n.id = 'fl-new'; D.body.appendChild(n);
    n.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-a]');
      if (a && a.dataset.a === 'set') { closeNew(); openFlairSettings(); }
      else if (a && a.dataset.a === 'go') { closeNew(); confetti(120); }
      else if (e.target === n) closeNew();
    });
  }
  safe(function () {
    addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('fl-new')) { e.stopPropagation(); closeNew(); } }, true);
    var seen = LS.get('lmpv9_seen', '') === '1';
    if (!seen) { setTimeout(openNew, 3400); return; }
    var chipSeen = false; try { chipSeen = !!sessionStorage.getItem('lmpv9_chip'); sessionStorage.setItem('lmpv9_chip', '1'); } catch (e) {}
    if (chipSeen) return;
    var hr = new Date().getHours(), msg = hr < 5 || hr >= 21 ? 'Late night session' : hr < 12 ? 'Fresh morning' : hr < 17 ? 'Afternoon reel' : 'Evening show';
    var chip = mk('div', null, msg + ' \u00B7 press Ctrl+K to search anything'); chip.id = 'fl-chip'; D.body.appendChild(chip);
    setTimeout(function () { chip.classList.add('on'); }, 3000);
    setTimeout(function () { chip.classList.remove('on'); }, 7500);
    setTimeout(function () { chip.remove(); }, 8500);
  });

  /* ---------- Alt shortcuts ---------- */
  safe(function () {
    addEventListener('keydown', function (e) {
      if (!e.altKey || e.ctrlKey || e.metaKey || typing(e)) return;
      var k = (e.key || '').toLowerCase();
      if (k >= '1' && k <= '5') { e.preventDefault(); var p = PALS[+k - 1]; setPal(p[0]); say('Palette: ' + p[1]); }
      else if (k === 'f') { e.preventDefault(); openFlairSettings(); }
      else if (k === 'i') { e.preventDefault(); showIdle(); }
    });
  });
})();
