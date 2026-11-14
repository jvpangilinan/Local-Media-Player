/* ULTRON STAR: drifting white specks on a canvas BEHIND the page (never over photos, text or buttons).
   Active only with Settings > Appearance > Accent palette > ULTRON STAR (not light mode).
   Switch: Settings > Flair > Stars, or press Alt+S. */
(function () {
  try {
    var R = document.documentElement, cv, cx, stars = [], raf = 0, prev = 0, still = false;
    try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    function wanted() { return R.getAttribute('data-pal') === 'chrome' && R.getAttribute('data-theme') !== 'light' && !R.classList.contains('fl-no-stars'); }
    function build() {
      var dpr = window.devicePixelRatio || 1, w = window.innerWidth, h = window.innerHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px';
      var n = Math.max(120, Math.round(w * h / 4800)); stars = [];
      for (var i = 0; i < n; i++) {
        var big = Math.random() < .08, mid = Math.random() < .3, near = big ? 1 : mid ? .6 : .3;
        stars.push({ x: Math.random() * cv.width, y: Math.random() * cv.height,
          r: (big ? 2.8 + Math.random() * 1.4 : mid ? 1.8 + Math.random() * .8 : 1.2 + Math.random() * .6) * dpr,
          vx: (-6 - 14 * near) * dpr * (.6 + Math.random() * .8), vy: (3 + 7 * near) * dpr * (.6 + Math.random() * .8),   // px/s: nearer stars drift faster (parallax)
          a: .6 + Math.random() * .4, s: .6 + Math.random() * 1.8, p: Math.random() * 6.28 });
      }
    }
    function frame(t) {
      raf = 0; if (!wanted() || document.hidden) { prev = 0; return; }
      var dt = prev ? Math.min(.1, (t - prev) / 1000) : 0; prev = t;
      cx.clearRect(0, 0, cv.width, cv.height);
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        if (!still) {
          s.x += s.vx * dt; s.y += s.vy * dt;
          if (s.x < -6) s.x = cv.width + 6; if (s.y > cv.height + 6) s.y = -6; if (s.x > cv.width + 6) s.x = -6;
        }
        var tw = still ? 1 : .6 + .4 * Math.sin(t / 1000 * s.s + s.p);
        cx.globalAlpha = Math.min(1, s.a * tw + .1); cx.beginPath(); cx.arc(s.x, s.y, s.r, 0, 6.2832); cx.fillStyle = '#fff'; cx.fill();
      }
      cx.globalAlpha = 1;
      if (!still) raf = requestAnimationFrame(frame);
    }
    function sync() {
      if (!cv) return;
      var on = wanted(); cv.style.display = on ? 'block' : 'none';
      if (on) { if (!stars.length) build(); if (!raf) raf = requestAnimationFrame(frame); }
    }
    function init() {
      cv = document.createElement('canvas'); cv.id = 'ch-stars';
      cv.style.cssText = 'position:fixed;left:0;top:0;z-index:-1;pointer-events:none;display:none';
      document.body.appendChild(cv); cx = cv.getContext('2d');
      new MutationObserver(sync).observe(R, { attributes: true, attributeFilter: ['data-pal', 'data-theme', 'data-bg', 'class'] });
      window.addEventListener('resize', function () { stars = []; sync(); });
      document.addEventListener('visibilitychange', sync);
      document.addEventListener('keydown', function (e) {                       // Alt+S toggles the stars (same switch as Settings > Flair)
        if (!e.altKey || e.ctrlKey || e.metaKey || (e.key || '').toLowerCase() !== 's') return;
        var off = !R.classList.contains('fl-no-stars');
        R.classList.toggle('fl-no-stars', off);
        try { localStorage.setItem('lmpv9_fx_stars', off ? '0' : '1'); } catch (x) {}
        var sw = document.querySelector('[data-fx="stars"]'); if (sw) sw.setAttribute('aria-checked', String(!off));
        e.preventDefault();
      });
      sync();
    }
    if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
  } catch (e) {}
})();
