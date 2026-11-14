/* ULTRON Plain mode + Minimal UI: Settings > Look. Saved with the rest of your settings (see persist.js). */
(function () {
  'use strict';
  var D = document, R = D.documentElement;
  var LS = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
             set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  var FX = ['ripple', 'magnet', 'trail', 'dust', 'aurora', 'reveal', 'beat', 'tint', 'squish', 'title', 'idle'];

  function setFxAll(on) {
    FX.forEach(function (k) {
      LS.set('lmpv9_fx_' + k, on ? '1' : '0');
      R.classList.toggle('fl-no-' + k, !on);
    });
    D.querySelectorAll('#fl-set .fl-sw').forEach(function (b) { b.setAttribute('aria-checked', String(!!on)); });
  }
  function setLite(v) {
    if (v) {                                             // remember the flair switches so turning this off restores them
      if (LS.get('lmpv9_lite_prev') == null) LS.set('lmpv9_lite_prev', FX.map(function (k) { return LS.get('lmpv9_fx_' + k) === '0' ? '0' : '1'; }).join(''));
      setFxAll(false);
    } else {
      var p = LS.get('lmpv9_lite_prev');
      FX.forEach(function (k, i) { var on = !p || p.charAt(i) !== '0'; LS.set('lmpv9_fx_' + k, on ? '1' : '0'); R.classList.toggle('fl-no-' + k, !on); });
      try { localStorage.removeItem('lmpv9_lite_prev'); } catch (e) {}
      D.querySelectorAll('#fl-set .fl-sw').forEach(function (b) { b.setAttribute('aria-checked', String(LS.get('lmpv9_fx_' + b.dataset.fx) !== '0')); });
    }
    LS.set('lmpv9_lite', v ? '1' : '0'); R.classList.toggle('lm-lite', v);
  }
  function setPlain(v) {
    LS.set('lmpv9_plain', v ? '1' : '0'); R.classList.toggle('lm-plain', v);
    if (v) R.setAttribute('data-bg', 'dark'), R.setAttribute('data-theme', 'dark'), R.setAttribute('data-pal', 'mono');
    else {
      var bg = LS.get('lmp_bg') || 'dark'; if (['dark', 'colorful', 'time'].indexOf(bg) < 0) bg = 'dark';
      R.setAttribute('data-bg', bg); R.setAttribute('data-theme', 'dark');
      R.setAttribute('data-pal', LS.get('lmpv9_pal') || 'prism');
    }
  }
  if (R.classList.contains('lm-plain')) { R.setAttribute('data-bg', 'dark'); R.setAttribute('data-theme', 'dark'); R.setAttribute('data-pal', 'mono'); }
  if (R.classList.contains('lm-lite')) setFxAll(false);

  var rows = [
    ['plain', 'Plain mode', 'Removes every theme: no colour palettes, no background pictures, no glow, no gradients, no ambient lights. Just a clean dark app.', setPlain],
    ['lite', 'Minimal UI', 'Turns off almost all UI enhancements: animations, blur, click ripples, cursor comet, dust, aurora, card tilt, screensaver, intro and the back-to-top button.', setLite]
  ];
  function build() {
    var pane = D.getElementById('lm-set-pane'), nav = D.getElementById('lm-set-nav');
    if (!pane || D.getElementById('lk-set')) return;
    var sec = D.createElement('section'); sec.id = 'lk-set';
    var h = '<h4>Look</h4><p class="lk-lead">Choices here are saved automatically and are still there next time you open the app.</p>';
    rows.forEach(function (r) {
      h += '<div class="lk-row"><div><b>' + r[1] + '</b><span>' + r[2] + '</span></div><button type="button" class="lk-sw" role="switch" data-k="' + r[0] + '" aria-checked="' + (LS.get('lmpv9_' + r[0]) === '1') + '" aria-label="' + r[1] + '"></button></div>';
    });
    sec.innerHTML = h; pane.insertBefore(sec, pane.firstChild);
    var btn = null;
    if (nav) {
      btn = D.createElement('button'); btn.type = 'button';
      btn.innerHTML = '<i>00</i><span>Look</span>'; nav.insertBefore(btn, nav.firstChild);
      btn.addEventListener('click', function () {
        [].forEach.call(pane.children, function (s) { s.classList.remove('lm-on'); });
        [].forEach.call(nav.children, function (b) { b.classList.remove('on'); });
        sec.classList.add('lm-on'); btn.classList.add('on'); pane.scrollTop = 0;
      });
      nav.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('button');
        if (b && b !== btn) { sec.classList.remove('lm-on'); btn.classList.remove('on'); }
      });
    }
    if (nav) [].forEach.call(nav.children, function (b, i) { var n = b.querySelector('i'); if (n) n.textContent = (i + 1 < 10 ? '0' : '') + (i + 1); });
    sec.addEventListener('click', function (e) {
      var sw = e.target.closest && e.target.closest('.lk-sw'); if (!sw) return;
      var v = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(v));
      rows.forEach(function (r) { if (r[0] === sw.dataset.k) r[3](v); });
    });
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', function () { setTimeout(build, 0); }); else setTimeout(build, 0);
})();
