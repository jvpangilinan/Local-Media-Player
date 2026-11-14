/* Private search: a search bar that lives ONLY inside the Private library (videos, series and photos).
   - It reads the already-unlocked private data (vdata.private) and the private photo list; nothing is sent anywhere.
   - The main Ctrl+K search never looks at the private library, and this bar never looks at the public one.
   - Everything it holds is dropped the moment the library locks. Loaded after app.js and photos-lock.js. */
(function () {
  'use strict';
  var Q = '', photoCache = null, photoBusy = false, seq = 0, timer = 0;

  var css = document.createElement('style');
  css.id = 'private-search-css';
  css.textContent = [
    'html body #private-bar{align-items:center}',
    'html body #private-bar .ps-box{position:relative;z-index:40;display:flex;align-items:center;margin-left:1rem}',
    'html body #private-bar .ps-box i{position:absolute;left:.7rem;font-size:.7rem;opacity:.55;pointer-events:none}',
    'html body #private-bar .ps-box input{width:14rem;max-width:36vw;background:rgba(255,255,255,.08);color:inherit;border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:.38rem 1.9rem .38rem 2rem;font-size:.82rem;outline:none;transition:width .2s,background .2s,border-color .2s}',
    'html body #private-bar .ps-box input:focus{background:rgba(255,255,255,.13);border-color:var(--accent,rgba(255,255,255,.4))}',
    'html body #private-bar .ps-box input::placeholder{color:inherit;opacity:.45}',
    'html body #private-bar .ps-box button{position:absolute;right:.5rem;background:none;border:0;color:inherit;opacity:.55;cursor:pointer;padding:.15rem .3rem;display:none}',
    'html body #private-bar .ps-box.has button{display:block}',
    '#private-view #private-search-results{display:none;padding:5.5rem clamp(1.5rem,6vw,5rem) 4rem}',
    '#private-view.ps-on #private-search-results{display:block}',
    '#private-view.ps-on #private-videos, #private-view.ps-on #private-photos{display:none !important}',
    '#private-search-results .ps-h{font-size:.7rem;font-weight:800;letter-spacing:.2em;text-transform:uppercase;opacity:.55;margin:1.6rem 0 .7rem;display:flex;gap:.6rem;align-items:baseline}',
    '#private-search-results .ps-h b{opacity:.7;font-weight:600;letter-spacing:.05em}',
    '#private-search-results .ps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.9rem}',
    '#private-search-results .ps-tile{position:relative;display:block;text-align:left;background:none;border:0;padding:0;color:inherit;cursor:pointer}',
    '#private-search-results .ps-tile .ps-img{display:block;aspect-ratio:2/3;border-radius:6px;overflow:hidden;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1)}',
    '#private-search-results .ps-tile.sq .ps-img{aspect-ratio:1/1}',
    '#private-search-results .ps-tile img{width:100%;height:100%;object-fit:cover;display:block}',
    '#private-search-results .ps-tile .ps-t{display:block;margin-top:.4rem;font-size:.82rem;font-weight:600;line-height:1.2;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '#private-search-results .ps-tile .ps-s{display:block;font-size:.68rem;opacity:.5;margin-top:.1rem}',
    '#private-search-results .ps-tile:hover .ps-img,#private-search-results .ps-tile:focus-visible .ps-img{border-color:var(--accent,#fff)}',
    '#private-search-results .ps-empty{padding:4rem 0;text-align:center;opacity:.55;font-size:.9rem}'
  ].join('\n');
  document.head.appendChild(css);

  var $id = function (i) { return document.getElementById(i); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var norm = function (s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); };
  var unlocked = function () { try { return !!token; } catch (e) { return false; } };

  function reset() {                                   // lock, or the page was rebuilt: forget everything
    Q = ''; photoCache = null; photoBusy = false; seq++;
    var v = $id('private-view'); if (v) v.classList.remove('ps-on');
    var r = $id('private-search-results'); if (r) r.innerHTML = '';
  }

  function ensureUI() {
    var bar = $id('private-bar'), view = $id('private-view');
    if (!bar || !view) return;
    if (!unlocked()) { if (Q || photoCache) reset(); return; }
    if (!bar.querySelector('.ps-box')) {
      var box = document.createElement('div');
      box.className = 'ps-box';
      box.innerHTML = '<i class="fas fa-magnifying-glass"></i><input id="ps-q" type="text" autocomplete="off" spellcheck="false" placeholder="Search private" aria-label="Search the private library"><button type="button" title="Clear" aria-label="Clear search"><i class="fas fa-xmark" style="position:static;opacity:1"></i></button>';
      bar.appendChild(box);
      var inp = box.querySelector('input'), clr = box.querySelector('button');
      inp.addEventListener('input', function () { Q = inp.value; box.classList.toggle('has', !!Q); clearTimeout(timer); timer = setTimeout(run, 120); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (Q) { inp.value = ''; Q = ''; box.classList.remove('has'); run(); } else inp.blur(); return; }
        if (!(e.ctrlKey || e.metaKey)) e.stopPropagation();          // typing must never trigger player / menu shortcuts
      });
      clr.addEventListener('click', function () { inp.value = ''; Q = ''; box.classList.remove('has'); run(); inp.focus(); });
    }
    if (!$id('private-search-results')) {
      var res = document.createElement('div'); res.id = 'private-search-results';
      res.addEventListener('click', onClick);
      view.appendChild(res);
    }
  }

  function videoCards(d) {
    var seen = {}, out = [];
    var push = function (c) { if (c && c.kind !== 'series' && c.id && !seen[c.id]) { seen[c.id] = 1; out.push(c); } };
    (d.loose || []).forEach(push); (d.recent || []).forEach(push); (d.continue || []).forEach(push);
    (d.most_watched || []).forEach(push); (d.unwatched || []).forEach(push);
    (d.genres || []).forEach(function (g) { (g.items || []).forEach(push); });
    return out;
  }

  function loadPhotos() {
    if (photoCache || photoBusy || !unlocked()) return;
    photoBusy = true; var my = seq;
    api('/api/photos').then(function (d) {
      if (my !== seq || !unlocked()) return;
      photoCache = d.photos || []; photoBusy = false; run();
    }).catch(function () { photoBusy = false; if (my === seq) photoCache = []; });
  }

  var shownPhotos = [];
  function run() {
    ensureUI();
    var view = $id('private-view'), res = $id('private-search-results');
    if (!view || !res) return;
    var q = norm(Q).trim();
    if (!q || !unlocked()) { view.classList.remove('ps-on'); res.innerHTML = ''; return; }
    view.classList.add('ps-on');
    try { heroStop(); } catch (e) {}
    var words = q.split(/\s+/);
    var hit = function () { var hay = norm(Array.prototype.slice.call(arguments).join(' ')); return words.every(function (w) { return hay.indexOf(w) >= 0; }); };
    var d = (typeof vdata !== 'undefined' && vdata.private) || {};
    var vids = videoCards(d).filter(function (v) { return hit(v.title, v.series, v.genre, v.year, v.collection); }).slice(0, 60);
    var sers = (d.all_series || []).filter(function (s) { return hit(s.title, s.genre, s.folder); }).slice(0, 40);
    if (!photoCache) loadPhotos();
    shownPhotos = (photoCache || []).filter(function (p) { return hit(p.name, p.album, p.folder); }).slice(0, 120);

    var html = '';
    if (vids.length) html += '<div class="ps-h">Videos <b>' + vids.length + '</b></div><div class="ps-grid">' + vids.map(function (v) {
      return '<button class="ps-tile" data-act="play" data-id="' + esc(v.id) + '"><span class="ps-img"><img src="' + esc(v.poster) + '" alt="" loading="lazy" decoding="async"></span><span class="ps-t">' + esc(v.title) + '</span>' + (v.year || v.series ? '<span class="ps-s">' + esc([v.series, v.year].filter(Boolean).join(' \u00b7 ')) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    if (sers.length) html += '<div class="ps-h">Series <b>' + sers.length + '</b></div><div class="ps-grid">' + sers.map(function (s) {
      return '<button class="ps-tile" data-act="series" data-id="' + esc(s.id) + '"><span class="ps-img"><img src="' + esc(s.poster) + '" alt="" loading="lazy" decoding="async"></span><span class="ps-t">' + esc(s.title) + '</span><span class="ps-s">' + s.episodes + ' episode' + (s.episodes === 1 ? '' : 's') + '</span></button>';
    }).join('') + '</div>';
    if (shownPhotos.length) html += '<div class="ps-h">Photos <b>' + shownPhotos.length + '</b></div><div class="ps-grid">' + shownPhotos.map(function (p, i) {
      return '<button class="ps-tile sq" data-act="photo" data-i="' + i + '"><span class="ps-img"><img src="' + esc(phThumb(p)) + '" alt="" loading="lazy" decoding="async"></span><span class="ps-t">' + esc(p.name) + '</span>' + (p.album ? '<span class="ps-s">' + esc(p.album) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    if (!html) html = '<div class="ps-empty">' + (photoBusy ? 'Searching\u2026' : 'Nothing in the private library matches \u201c' + esc(Q.trim()) + '\u201d.') + '</div>';
    res.innerHTML = html;
  }

  function onClick(e) {
    var t = e.target.closest('.ps-tile'); if (!t) return;
    var act = t.dataset.act;
    if (act === 'play') playVideo(t.dataset.id);
    else if (act === 'series') openSeries(t.dataset.id, 'private');
    else if (act === 'photo') {
      var i = +t.dataset.i; if (!shownPhotos[i]) return;
      PH.pub = false; if (!PH.bak) PH.bak = PH.view;       // same hand-off the Home photo shelf uses
      PH.view = shownPhotos; openPhoto(i, t.querySelector('.ps-img'));
    }
  }

  // "/" jumps to the private search while you are in the Private library (and not typing somewhere else)
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = (document.activeElement || {}).tagName || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    if (typeof currentView === 'undefined' || currentView !== 'private-view' || !unlocked()) return;
    var i = $id('ps-q'); if (i) { e.preventDefault(); i.focus(); i.select(); }
  });

  // the Private page is rebuilt on every unlock and emptied on every lock: keep the bar in step with it
  var mo = new MutationObserver(function () { ensureUI(); });
  function watch() { var v = $id('private-view'); if (v) { mo.observe(v, { childList: true }); ensureUI(); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
  setInterval(function () { if (!unlocked() && (Q || photoCache)) reset(); }, 2000);
  window.privateSearchReset = reset;
})();
