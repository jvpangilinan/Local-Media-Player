/* Gallery background (Settings > Background > Gallery, pref bg_mode "art"): classical paintings from the National Gallery of Art.
   Good by day (06:00-18:00), Evil by night. app.js applyBackground() sets data-bg="colorful" and calls galleryBg.sync(); this file
   owns data-art="good|evil", the two picture layers in #bg-layer, the plaque, the sigil (#theme-btn) and the collection row in Settings.
   - The Turning: at 06:00 and 18:00 the painting crossfades (12 s) to the other side; one setTimeout to the next boundary,
     re-armed when the window becomes visible again.
   - The hold: a click on the sigil flips the side until the next Turning (localStorage lmp_art_hold, not a pref).
   - Nothing changes while a video plays (in-window or native); the painting is still: no motion under the blurred panels.
   Paintings come from /api/art/list (manifest entries on disk: the starter pack plus whatever was downloaded). */
(function () {
    'use strict';
    var HOLD = 'lmp_art_hold', ROTATE_MS = 10 * 60 * 1000, FADE = 4000, TURN_FADE = 12000, PLAQUE_MS = 6000;
    var on = false, side = null, cur = null, works = null, loading = null, layers = null, front = 0, arrived = false, seen = [];
    var turnT = 0, rotT = 0, fadeT = 0, midT = 0, plaqueT = 0, pollT = 0, rmArm = 0, lastRun = false;
    var root = document.documentElement;

    function $(id) { return document.getElementById(id); }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
    function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function pref() { try { return (typeof prefs !== 'undefined' && prefs) || {}; } catch (e) { return {}; } }
    function say(msg) { try { if (typeof toast === 'function') toast(msg); } catch (e) {} }

    // ---------------------------------------------------------------- sides
    function isNight(h) { if (h == null) h = new Date().getHours(); return h < 6 || h >= 18; }
    function nextTurn() {                                   // ms timestamp of the next 06:00 or 18:00
        var t = new Date(), h = t.getHours(); t.setMinutes(0, 0, 0);
        if (h < 6) t.setHours(6); else if (h < 18) t.setHours(18); else { t.setDate(t.getDate() + 1); t.setHours(6); }
        return t.getTime();
    }
    function untilWord() { return new Date(nextTurn()).getHours() === 18 ? 'dusk' : 'dawn'; }
    function baseSide() { var p = pref().art_side; return p === 'good' || p === 'evil' ? p : (isNight() ? 'evil' : 'good'); }
    function readHold() {
        try { var h = JSON.parse(lsGet(HOLD) || 'null'); if (h && (h.side === 'good' || h.side === 'evil') && h.until > Date.now()) return h; } catch (e) {}
        lsDel(HOLD); return null;
    }
    function wantSide() { var h = readHold(); return h ? h.side : baseSide(); }
    function busy() {                                       // a video is playing: the painting holds still
        try { if (typeof playingId !== 'undefined' && playingId) return true; } catch (e) {}
        return !!window.__nativeOpen;
    }

    // ---------------------------------------------------------------- paintings
    function load() {
        if (works) return Promise.resolve(works);
        if (!loading) loading = fetch('/api/art/list', { headers: { 'X-LMP': '1' } }).then(function (r) { return r.json(); })
            .then(function (j) { works = (j && j.works) || []; return works; })
            .catch(function () { loading = null; return []; });
        return loading;
    }
    function pick(s) {
        var all = works || [], pool = all.filter(function (w) { return w.side === s && seen.indexOf(w.id) < 0; });
        if (!pool.length) { seen = cur ? [cur.id] : []; pool = all.filter(function (w) { return w.side === s && (!cur || w.id !== cur.id); }); }
        if (!pool.length) pool = all.filter(function (w) { return w.side === s; });
        if (!pool.length) pool = all;
        return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    }
    function focusPos(f) {
        if (Array.isArray(f) && f.length === 2) return (+f[0] || 50) + '% ' + (+f[1] || 50) + '%';
        if (f && typeof f === 'object') return (+f.x || 50) + '% ' + (+f.y || 50) + '%';
        if (typeof f === 'string' && /^[\d.]+%?\s+[\d.]+%?$/.test(f.trim())) return f.trim().split(/\s+/).map(function (v) { return parseFloat(v) + '%'; }).join(' ');
        return '50% 50%';
    }
    function show(w, fade, done, tries) {
        if (!w || !layers) { if (done) done(); return; }
        var url = '/art/' + w.id + '.jpg', img = new Image();
        img.onload = function () {
            if (!on) return;
            var nu = layers[1 - front], old = layers[front];
            nu.style.setProperty('--art-fade', '0ms'); nu.classList.remove('on'); void nu.offsetWidth;      // reset a layer that was still lit
            nu.style.setProperty('--art-pic', 'url("' + url + '")');
            nu.style.setProperty('--art-pos', focusPos(w.focus));
            nu.style.setProperty('--art-fade', fade + 'ms');
            old.classList.remove('top'); nu.classList.add('top');
            void nu.offsetWidth; nu.classList.add('on');
            front = 1 - front; cur = w; seen.push(w.id);
            clearTimeout(fadeT); fadeT = setTimeout(function () { old.classList.remove('on'); }, fade + 100);
            plaque(w);
            if (window.galleryView && galleryView.follow) galleryView.follow(w);
            if (done) done();
        };
        img.onerror = function () {                         // gone from disk (collection removed): drop it, try another once or twice
            works = (works || []).filter(function (x) { return x.id !== w.id; });
            if ((tries || 0) < 3) show(pick(w.side), fade, done, (tries || 0) + 1); else if (done) done();
        };
        img.src = url;
    }
    function setSide(s, fade) {
        side = s; lsSet('lmp_art', s); sigil();
        clearTimeout(midT);
        var w = pick(s);
        if (!w) { root.setAttribute('data-art', s); greet(); return; }
        show(w, fade, function () {                        // the accents follow halfway through the crossfade
            midT = setTimeout(function () { if (on && side === s) { root.setAttribute('data-art', s); greet(); } }, fade / 2);
        });
    }

    // ---------------------------------------------------------------- the Turning, rotation
    function armTurn() {
        clearTimeout(turnT); if (!on) return;
        turnT = setTimeout(turn, Math.min(nextTurn() - Date.now() + 1000, 2147483000));
    }
    function turn() {
        if (!on) return;
        if (busy()) { clearTimeout(turnT); turnT = setTimeout(turn, 30000); return; }     // after the video
        var s = wantSide();                                  // a hold has run out by now
        if (s !== side) setSide(s, TURN_FADE);
        armTurn();
    }
    function armRotate() {
        clearInterval(rotT);
        rotT = setInterval(function () { if (on && !document.hidden && !busy()) show(pick(side), FADE); }, ROTATE_MS);
    }
    document.addEventListener('visibilitychange', function () { if (on && !document.hidden) turn(); });

    // ---------------------------------------------------------------- the sigil, the greeting, the plaque
    function sigil() {
        var b = $('theme-btn'); if (!b || !on) return;
        var evil = side === 'evil', ic = evil ? 'fa-fire' : 'fa-sun';
        if (!b.querySelector('i.' + ic)) b.innerHTML = '<i class="fas ' + ic + '"></i>';
        b.title = 'Gallery: ' + (evil ? 'Evil' : 'Good') + '. Click to ' + (evil ? 'step into the light' : 'peek at the dark') + ' until ' + untilWord() + ' (Shift+click: change background)';
    }
    function greet() { try { hcKey = ''; tickHome(); } catch (e) {} }        // app.js: repaint the Home greeting now
    function greetLine(hr) { return on && side === 'evil' && isNight(hr) ? 'The night is yours.' : ''; }
    function hidePlaque() { var p = $('art-plaque'); if (p) p.classList.remove('on'); }
    function plaque(w) {
        var p = $('art-plaque');
        if (!p) {
            p = document.createElement('button'); p.id = 'art-plaque'; p.type = 'button'; p.title = 'Open the Gallery view';
            p.onclick = function () { hidePlaque(); if (window.galleryView && galleryView.open) galleryView.open(cur); };
            p.onmouseenter = function () { clearTimeout(plaqueT); };
            p.onmouseleave = function () { clearTimeout(plaqueT); plaqueT = setTimeout(hidePlaque, 2000); };
            document.body.appendChild(p);
        }
        p.innerHTML = '<b>' + esc(w.title) + '</b>' + esc(w.artist) + (w.year ? ', ' + esc(w.year) : '') + '<small>National Gallery of Art</small>';
        var sb = $('sidebar'), r = sb && sb.getBoundingClientRect();                 // clear the rail when it is showing
        p.style.left = r && r.width && r.right > 0 && r.right < innerWidth / 2 ? Math.round(r.right + 16) + 'px' : '';
        p.classList.add('on'); clearTimeout(plaqueT); plaqueT = setTimeout(hidePlaque, PLAQUE_MS);
    }

    // ---------------------------------------------------------------- on / off (called from applyBackground on every prefs change)
    function start() {
        on = true; side = wantSide(); lsSet('lmp_art', side); root.setAttribute('data-art', side);
        var first = !arrived; arrived = true;
        if (first) root.classList.add('art-arrive');                       // The Arrival: bright first, then the scrim settles
        load().then(function () {
            if (!on) return;
            show(pick(side), first ? 700 : FADE, function () { if (first) setTimeout(function () { root.classList.remove('art-arrive'); }, 900); });
        });
        armTurn(); armRotate(); sigil(); greet();
    }
    function stop() {
        on = false; side = null; cur = null;
        [turnT, fadeT, midT, plaqueT].forEach(clearTimeout); clearInterval(rotT);
        root.removeAttribute('data-art'); root.classList.remove('art-arrive'); lsDel('lmp_art');
        (layers || []).forEach(function (l) { l.classList.remove('on', 'top'); });
        hidePlaque(); greet();
        if (window.galleryView && galleryView.close) galleryView.close();
    }
    function sync(isArt) {
        if (!isArt) { if (on) stop(); else { root.removeAttribute('data-art'); lsDel('lmp_art'); } return; }
        if (!layers) { layers = Array.prototype.slice.call(document.querySelectorAll('#bg-layer .bg-pic')); if (layers.length < 2) { layers = null; return; } }
        if (!on) { start(); return; }
        var s = wantSide();
        if (s !== side) setSide(s, FADE);                                  // the Auto / Good / Evil picker changed
        sigil();
    }
    function flip() {
        if (!on) return;
        var other = side === 'evil' ? 'good' : 'evil', w = untilWord();
        if (other === baseSide()) { lsDel(HOLD); say(other === 'evil' ? 'Back to the night.' : 'Back to the light.'); }
        else { lsSet(HOLD, JSON.stringify({ side: other, until: nextTurn() })); say(other === 'evil' ? 'The dark, until ' + w + '.' : 'The light, until ' + w + '.'); }
        setSide(other, FADE);
    }

    // ---------------------------------------------------------------- Settings: side picker and the collection row
    function getJSON(url, opt) {
        opt = opt || {}; opt.headers = { 'X-LMP': '1', 'Content-Type': 'application/json' };
        return fetch(url, opt).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Failed'); return j; }); });
    }
    function paintColl(st) {
        var msg = $('set-art-msg'), dl = $('set-art-dl'), rm = $('set-art-rm'), bar = $('set-art-bar'); if (!msg || !st) return;
        var inst = st.install || {}, run = inst.state === 'running', mb = st.bytes ? Math.round(st.bytes / 1048576) : 0, all = st.total && st.downloaded >= st.total;
        if (run) msg.textContent = inst.msg || 'Downloading...';
        else if (inst.state === 'error') msg.textContent = 'The download stopped (' + (inst.error || 'error') + '). Try again: it picks up where it left off.';
        else if (all) msg.textContent = 'All ' + st.total + ' paintings are on this computer. Works offline.';
        else if (st.downloaded) msg.textContent = st.downloaded + ' of ' + st.total + ' paintings downloaded.';
        else msg.textContent = st.available + ' paintings ship with the app. The full collection has ' + st.total + '.';
        dl.classList.toggle('hidden', !!all); dl.disabled = run;
        dl.textContent = run ? 'Downloading...' : st.downloaded ? 'Resume download' : 'Download the collection' + (mb ? ' (' + mb + ' MB)' : '');
        rm.classList.toggle('hidden', run || !st.downloaded);
        bar.classList.toggle('hidden', !run); bar.style.setProperty('--p', (inst.pct || 0) + '%');
        if (lastRun && !run) { works = null; loading = null; if (on) load(); }       // new paintings join the rotation
        lastRun = run;
        clearTimeout(pollT); if (run) pollT = setTimeout(refresh, 1000);
    }
    function refresh() { getJSON('/api/art/status').then(paintColl).catch(function () {}); }
    function install() {
        getJSON('/api/art/install', { method: 'POST', body: '{}' }).then(function (st) { lastRun = true; paintColl(st); })
            .catch(function (e) { say(e.message || 'Could not start the download.'); });
    }
    function remove() {
        var rm = $('set-art-rm');
        if (!rmArm) { rmArm = setTimeout(function () { rmArm = 0; if (rm) rm.textContent = 'Remove'; }, 3000); if (rm) rm.textContent = 'Click again to remove'; return; }
        clearTimeout(rmArm); rmArm = 0; if (rm) rm.textContent = 'Remove';
        getJSON('/api/art', { method: 'DELETE' }).then(function (st) { works = null; loading = null; if (on) load(); paintColl(st); })
            .catch(function (e) { say(e.message || 'Could not remove the collection.'); });
    }
    function paintArt() {
        var box = $('set-bg-art'); if (!box) return;
        var isArt = pref().bg_mode === 'art'; box.classList.toggle('hidden', !isArt);
        if (!isArt) { clearTimeout(pollT); return; }
        var cur = pref().art_side || 'auto';
        document.querySelectorAll('#set-art-side .set-seg').forEach(function (b) { b.classList.toggle('on', b.dataset.side === cur); });
        refresh();
    }
    var _ps = window.paintSettings;
    if (typeof _ps === 'function') window.paintSettings = function () { var r = _ps.apply(this, arguments); try { paintArt(); } catch (e) { console.error(e); } return r; };

    window.galleryBg = { sync: sync, flip: flip, greet: greetLine, install: install, remove: remove, busy: busy, pos: focusPos,
                         current: function () { return on ? { side: side, work: cur } : null; } };
    if (pref().bg_mode === 'art') sync(true);              // prefs arrived before this file did
})();

/* Gallery view (the idle screen of Gallery mode): after 3 idle minutes with no video playing, or a click on the plaque, the UI fades
   out and the painting fills the window with a slow pan/zoom and its plaque. Any key, click, wheel or real mouse move returns; that
   input is swallowed so it does not also press something underneath. It replaces the flair clock screensaver while Gallery mode is on
   (and follows its on/off switch, lmpv9_fx_idle). Paused while the window is hidden; closes if a video starts. Still image under
   prefers-reduced-motion. This is the only place in Gallery mode with motion. */
(function () {
    'use strict';
    var IDLE_MS = 3 * 60 * 1000, GRACE = 700;
    var el = null, open = false, openedAt = 0, last = Date.now(), px = -1, py = -1, work = null, eatClick = 0, fadeT = 0;
    function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function bg() { return window.galleryBg && galleryBg.current ? galleryBg.current() : null; }
    function busy() { try { return !!(window.galleryBg && galleryBg.busy && galleryBg.busy()); } catch (e) { return false; } }
    function allowed() {
        try { if (localStorage.getItem('lmpv9_fx_idle') === '0') return false; } catch (e) {}
        return !document.documentElement.classList.contains('lm-lite');
    }
    function build() {
        el = document.createElement('div'); el.id = 'art-view'; el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<div class="av-pic"></div><div class="av-pic"></div><div class="av-plaque"></div><div class="av-hint">move the mouse to return</div>';
        document.body.appendChild(el);
    }
    function paint(w, fade) {
        if (!el || !w) return;
        var pics = el.querySelectorAll('.av-pic'), nu = pics[0].classList.contains('top') ? pics[1] : pics[0], old = nu === pics[0] ? pics[1] : pics[0];
        if (work && work.id === w.id) return;
        work = w;
        nu.style.backgroundImage = 'url("/art/' + w.id + '.jpg")';
        nu.style.backgroundPosition = window.galleryBg && galleryBg.pos ? galleryBg.pos(w.focus) : '';
        nu.classList.remove('drift'); void nu.offsetWidth; nu.classList.add('drift');               // restart the pan for each painting
        nu.style.transitionDuration = fade ? '' : '0s';
        old.classList.remove('top'); nu.classList.add('top'); void nu.offsetWidth; nu.classList.add('on');
        clearTimeout(fadeT); fadeT = setTimeout(function () { old.classList.remove('on'); }, fade ? 4200 : 0);
        el.querySelector('.av-plaque').innerHTML = '<b>' + esc(w.title) + '</b>' + esc(w.artist) + (w.year ? ', ' + esc(w.year) : '') + '<small>National Gallery of Art</small>';
    }
    function show(w) {
        var b = bg(); w = w || (b && b.work); if (!b || !w || open) return;
        if (!el) build();
        open = true; openedAt = Date.now(); px = -1; work = null;
        clearTimeout(fadeT); el.querySelectorAll('.av-pic').forEach(function (p) { p.classList.remove('on', 'top'); });
        paint(w, false);
        el.classList.toggle('paused', document.hidden);
        document.documentElement.classList.add('art-viewing');
        requestAnimationFrame(function () { if (open) el.classList.add('on'); });
    }
    function close() {
        last = Date.now(); if (!open) return; open = false;
        document.documentElement.classList.remove('art-viewing');
        if (el) el.classList.remove('on');
    }
    function wake(e) {
        last = Date.now(); if (!open) return;
        if (e && e.cancelable) e.preventDefault();
        if (e) e.stopPropagation();
        if (e && e.type === 'pointerdown') eatClick = Date.now();
        if (Date.now() - openedAt > GRACE) close();          // the click that opened it (from the plaque) does not close it
    }
    ['keydown', 'pointerdown', 'wheel', 'touchstart'].forEach(function (ev) {
        addEventListener(ev, function (e) { if (open) wake(e); else last = Date.now(); }, { passive: false, capture: true });
    });
    addEventListener('click', function (e) {                // the click that ends a waking press must not land on the UI
        if (open || Date.now() - eatClick < 800) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    addEventListener('mousemove', function (e) {
        if (!open) { last = Date.now(); return; }
        if (px < 0) { px = e.clientX; py = e.clientY; return; }                                     // the first event only sets the spot
        if (Math.abs(e.clientX - px) + Math.abs(e.clientY - py) > 12 && Date.now() - openedAt > GRACE) close();
    }, { passive: true, capture: true });
    document.addEventListener('visibilitychange', function () { if (el) el.classList.toggle('paused', document.hidden); if (!document.hidden && !open) last = Date.now(); });
    setInterval(function () {
        if (open) { if (busy() || !bg()) close(); return; }
        if (!bg() || !allowed() || document.hidden || busy()) return;
        if (Date.now() - last > IDLE_MS) show();
    }, 5000);
    window.galleryView = { open: show, close: close, isOpen: function () { return open; },
                           follow: function (w) { if (open) paint(w, true); } };
})();
