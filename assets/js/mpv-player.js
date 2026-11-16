/* ULTRON native player (libmpv).
   The player UI was written for a <video id="player"> element. Instead of rewriting it, this file lets that element
   talk to libmpv: play, pause, seek, volume, speed, subtitles, audio tracks and the picture all go to /api/player/*.
   mpv draws the picture in a child window inside the ULTRON window that sits exactly over #p-stage; the page keeps the title bar and the controls.
   If libmpv is missing (or Settings turns it off) nothing here is active and the plain web player is used as before.
   Loaded after app.js and before studio.js / movies.js, so they see the patched element. */
(function () {
    'use strict';
    var player = document.getElementById('player'), pm = document.getElementById('player-modal');
    if (!player || !pm) return;
    var $ = function (id) { return document.getElementById(id); };
    var root = document.documentElement;
    var proto = HTMLMediaElement.prototype;
    var natPlay = proto.play, natPause = proto.pause, natLoad = proto.load, natRemove = player.removeAttribute;
    var natSrc = Object.getOwnPropertyDescriptor(proto, 'src');
    function nat(name) { return Object.getOwnPropertyDescriptor(proto, name); }

    var S = { holdSet: 0, status: null, session: false, loaded: false, id: null, tok: 0, seq: 0, timer: 0, rectTimer: 0, lastRect: '', chain: Promise.resolve(),
              wantPlay: false, pendingSeek: null, holdUntil: 0, curSid: -1, ended: false, noticeShown: false, fs: false, polls: 0, mirrored: {} };
    var L = { t: 0, dur: NaN, paused: true, vol: 1, muted: false, rate: 1, w: 0, h: 0, cw: 0, ch: 0, cache: 0, seeking: false, buffering: false };
    var API = {};

    function fire(type) { try { player.dispatchEvent(new Event(type)); } catch (e) {} }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function p(url, body) { return post(url, body); }                     // app.js helper: JSON POST with the X-LMP header
    function send(cmd, value) {                                           // commands are kept in order (seek, then play ...)
        S.chain = S.chain.then(function () { return p('/api/player/cmd', { cmd: cmd, value: value }); }).catch(function () {});
        return S.chain;
    }
    function fsOn() { try { return !!isFS || !!document.fullscreenElement; } catch (e) { return !!document.fullscreenElement; } }

    /* ---------- status: is libmpv usable? ---------- */
    function loadStatus(boot) {                                           // boot = the page has just loaded: the server hides any picture left from the last page
        return api('/api/player/status' + (boot ? '?boot=1' : '')).then(function (s) { S.status = s; root.classList.toggle('mpv-ready', s.engine === 'mpv'); paintSettings(); return s; })
            .catch(function () { S.status = { engine: 'html5' }; });
    }
    API.active = function () { return S.session; };
    API.status = function () { return S.status; };
    var statusP = loadStatus(true);

    /* ---------- the element's media API ---------- */
    function def(name, get, set) {
        var n = nat(name);
        Object.defineProperty(player, name, {
            configurable: true,
            get: function () { return S.session ? get() : n.get.call(player); },
            set: set ? function (v) { if (S.session) set(v); else n.set.call(player, v); } : undefined
        });
    }
    def('currentTime', function () { return L.t; }, function (v) {
        v = Number(v); if (!isFinite(v)) return;
        v = clamp(v, 0, isFinite(L.dur) ? L.dur : v);
        if (!S.loaded) { S.pendingSeek = v; L.t = v; return; }
        L.t = v; L.seeking = true; S.holdUntil = Date.now() + 700; S.ended = false;
        fire('seeking'); fire('timeupdate');
        send('seek', v);
    });
    def('duration', function () { return L.dur; });
    def('paused', function () { return L.paused; });
    def('ended', function () { return S.ended; });
    def('seeking', function () { return L.seeking; });
    def('readyState', function () { return S.loaded ? 4 : 0; });
    def('videoWidth', function () { return L.w; });
    def('videoHeight', function () { return L.h; });
    def('volume', function () { return L.vol; }, function (v) { S.holdSet = Date.now() + 700; L.vol = clamp(Number(v) || 0, 0, 1); send('volume', L.vol); fire('volumechange'); });
    def('muted', function () { return L.muted; }, function (v) { S.holdSet = Date.now() + 700; L.muted = !!v; send('mute', L.muted); fire('volumechange'); });
    def('playbackRate', function () { return L.rate; }, function (v) { S.holdSet = Date.now() + 700; L.rate = clamp(Number(v) || 1, 0.25, 4); send('speed', L.rate); fire('ratechange'); });
    def('buffered', function () {
        var end = L.t + L.cache;
        return { length: S.loaded ? 1 : 0, start: function () { return 0; }, end: function () { return clamp(end, 0, isFinite(L.dur) ? L.dur : end); } };
    });
    def('currentSrc', function () { return S.session ? '/media/video/' + S.id : ''; });
    def('error', function () { return null; });

    Object.defineProperty(player, 'src', {
        configurable: true,
        get: function () { return S.session ? '/media/video/' + S.id : natSrc.get.call(player); },
        set: function (v) {
            var m = /\/media\/video\/([^/?#]+)/.exec(String(v || ''));
            if (m && S.status && S.status.engine === 'mpv') beginSession(m[1]);
            else { endSession(true); natSrc.set.call(player, v); }
        }
    });
    player.play = function () {
        if (!S.session) return natPlay.call(player);
        S.wantPlay = true;
        if (S.loaded) { setPaused(false); send('play'); }
        return Promise.resolve();
    };
    player.pause = function () {
        if (!S.session) return natPause.call(player);
        S.wantPlay = false;
        if (S.loaded && !L.paused) { setPaused(true); send('pause'); }
    };
    player.load = function () { if (S.session) { endSession(false); return; } return natLoad.call(player); };
    player.removeAttribute = function (name) {
        if (String(name).toLowerCase() === 'src' && S.session) return;      // closePlayer(): load() below ends the session
        return natRemove.apply(player, arguments);
    };
    function setPaused(v) {
        if (L.paused === v) return;
        L.paused = v;
        if (v) fire('pause'); else { fire('play'); fire('playing'); }
    }

    /* ---------- session: one file in mpv ---------- */
    function beginSession(id) {
        var carryMute = S.session ? L.muted : null;                       // a session was running: its mute state (ours or yours) carries to the next file
        endSession(false, true);
        S.session = true; S.id = id; S.loaded = false; S.ended = false; S.seq = 0; S.curSid = -1; S.mirrored = {};
        S.pendingSeek = null; S.wantPlay = false;
        var v = nat('volume').get.call(player), m = carryMute !== null ? carryMute : nat('muted').get.call(player);
        L.t = 0; L.dur = NaN; L.paused = true; L.vol = v; L.muted = m; L.w = L.h = L.cw = L.ch = 0; L.cache = 0; L.seeking = false;
        L.rate = player.defaultPlaybackRate || 1;
        root.classList.add('mpv-on');
        startTimers(); pushRect(true);
        fire('loadstart');
        var tok = ++S.tok;
        p('/api/player/load', { id: id, volume: L.vol, mute: L.muted, speed: L.rate, osc: !overlayOn() && fsOn() }).then(function (r) {
            if (tok !== S.tok) return;
            onLoaded(r);
        }).catch(function (e) {
            if (tok !== S.tok) return;
            S.session = false; root.classList.remove('mpv-on'); stopTimers(); pushRect(true);
            var msg = (e && e.data && e.data.error) || (e && e.message) || 'mpv could not open this file';
            if (e && (e.status === 503 || e.status === 409)) {                // libmpv itself is unavailable: use the built-in web player for this file
                S.status = { engine: 'html5', enabled: e.status !== 409, error: msg }; root.classList.remove('mpv-ready'); S.noticeShown = false; paintSettings();
                natSrc.set.call(player, '/media/video/' + id); natPlay.call(player).catch(function () {});
                return;
            }
            showProblem(msg);
            fire('error');
        });
    }
    function endSession(quiet, keepClass) {
        if (!S.session) return;
        S.tok++; S.session = false; S.loaded = false; S.wantPlay = false;
        stopTimers();
        if (!keepClass) root.classList.remove('mpv-on', 'mpv-fs');
        p('/api/player/stop', {}).catch(function () {});
        pushRect(true);
        if (!quiet) { L.t = 0; L.dur = NaN; L.paused = true; }
    }
    function showProblem(msg) {
        var el = $('player-error');
        if (el) { el.textContent = 'mpv: ' + msg; el.classList.remove('hidden'); }
    }

    function onLoaded(r) {
        S.loaded = true;
        var el = $('player-error'); if (el) el.textContent = el.dataset.msg || el.textContent;
        absorb(r, true);
        mirrorTracks(true);
        addExternalTracks();
        fire('loadedmetadata'); fire('durationchange'); fire('loadeddata'); fire('canplay');
        if (S.pendingSeek != null) { var t = S.pendingSeek; S.pendingSeek = null; player.currentTime = t; }
        if (S.wantPlay) { setPaused(false); send('play'); }
        applyPicture();
        paintAudioBtn();
    }

    /* ---------- polling mpv ---------- */
    function startTimers() {
        stopTimers();
        S.timer = setTimeout(tick, 250);
        S.rectTimer = setInterval(function () { pushRect(false); syncFs(); }, 100);
    }
    function stopTimers() { clearTimeout(S.timer); clearInterval(S.rectTimer); S.timer = S.rectTimer = 0; }
    function tick() {
        if (!S.session) return;
        var tok = S.tok;
        api('/api/player/state?since=' + S.seq + (++S.polls % 20 === 0 ? '&diag=1' : '')).then(function (r) {
            if (tok === S.tok && S.session) absorb(r, false);
        }).catch(function () {}).then(function () {
            if (tok === S.tok && S.session) S.timer = setTimeout(tick, L.paused ? 600 : 250);
        });
    }
    function absorb(r, first) {
        var st = r.state || {};
        if (!st.loaded && !first) return;
        S.seq = Math.max(S.seq, r.seq || 0);
        if (st.dur > 0 && st.dur !== L.dur) { var had = isFinite(L.dur); L.dur = st.dur; if (had) fire('durationchange'); }
        L.w = st.w || L.w; L.h = st.h || L.h; L.cw = st.cw || L.cw; L.ch = st.ch || L.ch; L.cache = st.cache > L.t ? st.cache - L.t : 0;
        var now = Date.now();
        if (now >= S.holdUntil) {                                           // a seek just sent: ignore stale positions for a moment
            if (L.seeking && !st.seeking) { L.seeking = false; fire('seeked'); fire('canplay'); }
            if (Math.abs(st.t - L.t) > 0.01) { L.t = st.t; if (!L.paused || st.paused === false) fire('timeupdate'); }
        }
        if (S.loaded && !first) {
            if (st.paused !== L.paused && now >= S.holdUntil - 400) { setPaused(!!st.paused); S.wantPlay = !st.paused; }
            if (now >= S.holdSet) {
                if (typeof st.vol_lin === 'number' && Math.abs(st.vol_lin - L.vol) > 0.015) { L.vol = clamp(st.vol_lin, 0, 1); fire('volumechange'); }
                if (!!st.mute !== L.muted) { L.muted = !!st.mute; fire('volumechange'); }
                if (st.speed && Math.abs(st.speed - L.rate) > 0.01) { L.rate = st.speed; fire('ratechange'); }
            }
            if (st.buffering && !L.buffering) { L.buffering = true; fire('waiting'); }
            else if (!st.buffering && L.buffering) { L.buffering = false; fire('playing'); }
            if (st.eof && !S.ended && st.dur > 0 && st.t >= st.dur - 1.5) { S.ended = true; setPaused(true); fire('ended'); }
            else if (!st.eof && S.ended) S.ended = false;
            if (S.polls % 4 === 0) fire('progress');
            mirrorTracks(false, st);
            syncSubtitleChoice();
        }
        (r.events || []).forEach(handleEvent);
        if (r.diag) { S.diag = r.diag; paintDiag(); }
    }
    function handleEvent(ev) {
        if (ev.type === 'error') { showProblem(ev.msg || 'playback error'); fire('error'); return; }
        if (ev.type === 'closed') { try { closePlayer(); } catch (e) {} return; }          // the user closed mpv's window (Alt+F4)
        if (ev.type !== 'key') return;
        var k = ev.key;
        try {
            if (k === 'escape') { if (!$('p-menu').classList.contains('hidden')) closeMenu(); else if (fsOn()) setFS(false); else closePlayer(); }
            else if (k === 'fullscreen') toggleFS();
            else if (k === 'next') stepEpisode(1);
            else if (k === 'mini') enterMini();
            else if (k === 'shot') { var b = $('sx-snap-btn'); if (b) b.click(); }
            else if (k === 'move') showUI();
        } catch (e) { console.error(e); }
    }

    /* ---------- stage: where mpv's picture goes ---------- */
    var stage = document.createElement('div'); stage.id = 'p-stage';
    pm.insertBefore(stage, pm.firstChild);
    function overlayOn() { try { return !(prefs && prefs.mpv_overlay === false); } catch (e) { return true; } }
    function shown(el) {
        if (!el || el.classList.contains('hidden')) return false;
        var cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05;
    }
    function box(list, r, pad) {
        if (!r || r.width < 2 || r.height < 2) return;
        list.push({ x: r.left - pad, y: r.top - pad, w: r.width + 2 * pad, h: r.height + 2 * pad });
    }
    /* The picture is a native window, so the page cannot draw over it. Instead the window gets HOLES exactly where page
       controls are showing (title bar, control bar, menus, popups, toasts ...). The page's own UI is therefore in charge
       in every mode, fullscreen included, and the picture itself always keeps the full window. */
    var SKIP = { 'player': 1, 'p-hit': 1, 'p-stage': 1, 'p-mini': 1, 'p-top': 1, 'p-bottom': 1, 'sx-glow': 1 };
    function overlayCuts(W, H) {
        var cuts = [], cover = false, lift = 0, i;
        var top = $('p-top'), bot = $('p-bottom');
        if (shown(top)) {                                                  // only the part with buttons, not the tall gradient padding
            var tb = 0; [].forEach.call(top.children, function (c) { var r = c.getBoundingClientRect(); if (r.height > 0) tb = Math.max(tb, r.bottom); });
            if (tb > 0) cuts.push({ x: 0, y: 0, w: W, h: Math.min(H, tb + 14) });
        }
        if (shown(bot)) {
            var sk = $('p-seek'), r0 = (sk || bot).getBoundingClientRect(), y0 = Math.max(0, r0.top - 16);
            cuts.push({ x: 0, y: y0, w: W, h: H - y0 });
            lift = (H - y0) / H;                                            // subtitles are raised above this much of the window
            var tip = $('p-tip'); if (tip && shown(tip)) box(cuts, tip.getBoundingClientRect(), 2);
            /* the hover preview over the timeline (a canvas + time label, sticks up out of the bar): cut it out too, or the video covers it */
            var pv = document.querySelector('.sx-pv.on'); if (pv) box(cuts, pv.getBoundingClientRect(), 4);
        }
        var kids = pm.children;
        for (i = 0; i < kids.length; i++) {
            var el = kids[i];
            if (SKIP[el.id] || el === stage || /^(VIDEO|SCRIPT|STYLE)$/.test(el.tagName) || !shown(el)) continue;
            var r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
            if (r.width * r.height > W * H * 0.8) {                         // a full-window layer (a dialog's dim backdrop): use what is inside it
                for (var k = 0; k < el.children.length; k++) { var c = el.children[k]; if (shown(c)) box(cuts, c.getBoundingClientRect(), 0); }
            } else box(cuts, r, 0);
        }
        var bk = document.body.children;                                    // things appended to the page itself: toasts, dialogs, banners, the privacy veil
        for (i = 0; i < bk.length; i++) {
            var b = bk[i];
            if (b === pm || b.id === 'p-stage' || /^(SCRIPT|STYLE|LINK)$/.test(b.tagName)) continue;
            var cs = getComputedStyle(b);
            if ((cs.position !== 'fixed' && cs.position !== 'absolute') || cs.pointerEvents === 'none' || !shown(b)) continue;
            if ((parseInt(cs.zIndex, 10) || 0) < 100) continue;
            var rb = b.getBoundingClientRect(); if (rb.width < 2 || rb.height < 2) continue;
            if (rb.width * rb.height > W * H * 0.6) cover = true; else box(cuts, rb, 0);
        }
        return { cuts: cuts.slice(0, 24), cover: cover, lift: lift };
    }
    function computeStage() {
        var dpr = window.devicePixelRatio || 1, W = window.innerWidth, H = window.innerHeight;
        var hidden = pm.classList.contains('hidden') || pm.classList.contains('mini');
        root.classList.toggle('mpv-classic', !overlayOn());
        if (overlayOn()) {
            var o = overlayCuts(W, H);
            return { x: 0, y: 0, w: W, h: H, dpr: dpr, vw: W, vh: H, cuts: o.cuts, lift: o.lift, visible: S.session && !hidden && !o.cover && H > 40 };
        }
        /* classic layout: the picture sits between the two bars and mpv draws its own controls in fullscreen */
        var top = 0, bot = H, hide = false;
        if (!fsOn()) {
            var t = $('p-top'), b = $('p-bottom');
            if (t) top = Math.max(top, t.getBoundingClientRect().bottom);
            if (b) bot = Math.min(bot, b.getBoundingClientRect().top);
        }
        ['p-menu', 'p-next', 'nfx-prec'].forEach(function (id) {
            var el = $(id); if (!el || el.classList.contains('hidden') || getComputedStyle(el).display === 'none') return;
            if (id === 'nfx-prec' && !pm.classList.contains('nfx-prec-open')) return;
            var r = el.getBoundingClientRect(); if (r.height < 2) return;
            if (r.top > H * 0.3) bot = Math.min(bot, r.top - 6);
        });
        var asub = $('asub-modal'); if (asub && !asub.classList.contains('hidden')) hide = true;
        var h = Math.max(0, bot - top);
        return { x: 0, y: top, w: W, h: h, dpr: dpr, vw: W, vh: H, cuts: [], lift: 0, visible: S.session && !hidden && !hide && h > 40 };
    }
    function pushRect(force) {
        var r = computeStage();
        stage.style.top = r.y + 'px'; stage.style.height = r.h + 'px';
        var key = [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h), r.dpr, r.visible ? 1 : 0, Math.round((r.lift || 0) * 100),
                   r.cuts.map(function (c) { return Math.round(c.x) + ':' + Math.round(c.y) + ':' + Math.round(c.w) + ':' + Math.round(c.h); }).join('|')].join(',');
        if (!force && key === S.lastRect) return;
        S.lastRect = key;
        p('/api/player/surface', r).catch(function () {});
    }
    function syncFs() {
        var fs = fsOn();
        if (fs === S.fs) return;
        S.fs = fs; root.classList.toggle('mpv-fs', fs);
        if (!overlayOn()) send('osc', fs);                                  // classic layout only: mpv draws its own controls in fullscreen
        pushRect(true);
    }
    window.addEventListener('resize', function () { if (S.session) pushRect(false); });
    /* moving along the timeline brings up the preview box: update the cut-outs right away instead of on the next 100 ms tick */
    (function () {
        var sk = $('p-seek'), q = 0;
        if (!sk) return;
        function again() { q = 0; if (S.session) pushRect(false); }
        sk.addEventListener('mousemove', function () { if (!q) q = requestAnimationFrame(function () { setTimeout(again, 0); }); }, { passive: true });
        sk.addEventListener('mouseleave', function () { setTimeout(again, 60); }, { passive: true });
    })();

    /* ---------- picture mode (smart crop / fit / fill) ---------- */
    function applyPicture() {
        if (!S.session || !S.loaded) return;
        var st = player.style, fill = st.objectFit === 'cover', crop = null;
        var vb = String(st.objectViewBox || ''), m = /inset\(\s*([\d.]+)%\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)%\s*\)/.exec(vb);
        if (m && L.cw && L.ch) {
            var tp = +m[1] / 100, rt = +m[2] / 100, bt = +m[3] / 100, lf = +m[4] / 100;
            var x = Math.round(lf * L.cw), y = Math.round(tp * L.ch);
            crop = { x: x, y: y, w: Math.round(L.cw * (1 - lf - rt)), h: Math.round(L.ch * (1 - tp - bt)) };
        }
        send('picture', { mode: fill ? 'fill' : 'fit', crop: crop });
    }
    new MutationObserver(function () { applyPicture(); }).observe(player, { attributes: true, attributeFilter: ['style'] });

    /* ---------- subtitles: <track> files + the tracks inside the MKV share the normal textTracks list ---------- */
    function langName(code) {
        if (!code) return '';
        try { var n = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code); if (n && n.toLowerCase() !== code.toLowerCase()) return n; } catch (e) {}
        return code.toUpperCase();
    }
    function subLabel(t, i) {
        var base = t.title || langName(t.lang) || ('Subtitles ' + i);
        return t.title && t.lang ? t.title + ' (' + langName(t.lang) + ')' : base;
    }
    function mirrorTracks(first, st) {
        var tracks = (st && st.tracks) || (S.lastTracks || []);
        if (st && st.tracks) S.lastTracks = st.tracks;
        if (first && !tracks.length) return;
        var prefLang = '';
        try { prefLang = String((prefs && prefs.asub_lang) || 'en').slice(0, 2); } catch (e) {}
        var subs = tracks.filter(function (t) { return t.type === 'sub' && !t.external && !S.mirrored['s' + t.id]; });
        subs.sort(function (a, b) {                                         // wanted language first, then the file's default
            var sa = (a.lang || '').slice(0, 2) === prefLang ? 0 : 1, sb = (b.lang || '').slice(0, 2) === prefLang ? 0 : 1;
            return sa - sb || (b.default ? 1 : 0) - (a.default ? 1 : 0) || a.id - b.id;
        });
        subs.forEach(function (t, i) {
            S.mirrored['s' + t.id] = true;
            var tt = player.addTextTrack('subtitles', subLabel(t, t.id), t.lang || 'und');
            tt.__mpv = t.id; tt.mode = 'disabled';
        });
        if (st && subs.length) { var cc = $('p-cc'); if (cc) cc.classList.remove('hidden'); }
        paintAudioBtn();
    }
    function addExternalTracks() {
        [].slice.call(player.querySelectorAll('track')).forEach(addExternal);
    }
    function addExternal(node) {
        if (!S.session || node.__mpvBusy || !node.getAttribute('src')) return;
        node.__mpvBusy = true;
        var url = new URL(node.getAttribute('src'), location.href).href, tok = S.tok;
        p('/api/player/cmd', { cmd: 'sub-add', value: { url: url, title: node.label || '', lang: node.srclang || '' } }).then(function (r) {
            if (tok !== S.tok || !r || !r.id) return;
            node.__mpvSid = r.id;
            if (node.track) node.track.__mpv = r.id;
            syncSubtitleChoice(true);
        }).catch(function () { node.__mpvBusy = false; });
    }
    new MutationObserver(function (list) {
        list.forEach(function (m) {
            [].slice.call(m.addedNodes).forEach(function (n) { if (n.tagName === 'TRACK' && S.session && S.loaded) addExternal(n); });
            [].slice.call(m.removedNodes).forEach(function (n) { if (n.tagName === 'TRACK' && n.__mpvSid && S.session) { send('sub-remove', n.__mpvSid); if (S.curSid === n.__mpvSid) S.curSid = -1; } });
        });
    }).observe(player, { childList: true });
    function syncSubtitleChoice(force) {                                    // whichever textTrack is "showing" is the one mpv draws
        if (!S.session || !S.loaded) return;
        var tt = [].slice.call(player.textTracks), on = tt.filter(function (t) { return t.mode === 'showing'; })[0];
        var sid = on && on.__mpv ? on.__mpv : 0;
        if (on && !on.__mpv) return;                                        // still being added: try again on the next poll
        if (sid !== S.curSid || force) { S.curSid = sid; send('sid', sid); }
    }
    try { player.textTracks.addEventListener('change', function () { syncSubtitleChoice(false); }); } catch (e) {}

    /* ---------- audio tracks (a button next to the speed button; the web player has no such thing) ---------- */
    var audioBtn = null;
    function audioList() { return (S.lastTracks || []).filter(function (t) { return t.type === 'audio'; }); }
    function paintAudioBtn() {
        if (!audioBtn) return;
        audioBtn.classList.toggle('hidden', !(S.session && audioList().length > 1));
    }
    var spd = $('p-speed');
    if (spd && spd.parentNode) {
        audioBtn = document.createElement('button');
        audioBtn.className = 'p-btn hidden'; audioBtn.id = 'mpv-audio-btn'; audioBtn.title = 'Audio track';
        audioBtn.innerHTML = '<i class="fas fa-headphones"></i>';
        audioBtn.onclick = function (e) { e.stopPropagation(); openAudioMenu(); };
        spd.parentNode.insertBefore(audioBtn, spd);
    }
    function openAudioMenu() {
        var m = $('p-menu'); if (!m) return;
        if (!m.classList.contains('hidden') && m.dataset.kind === 'audio') { closeMenu(); return; }
        var cur = (S.lastTracks || []).filter(function (t) { return t.type === 'audio' && t.selected; })[0];
        m.innerHTML = audioList().map(function (t, i) {
            var name = (t.title || langName(t.lang) || ('Track ' + (i + 1))) + (t.lang && t.title ? ' (' + langName(t.lang) + ')' : '');
            var info = [String(t.codec || '').toUpperCase(), t.channels ? (t.channels === 2 ? 'stereo' : t.channels + ' ch') : ''].filter(Boolean).join(' ');
            var sel = cur && cur.id === t.id;
            return '<button class="menu-item ' + (sel ? 'sel' : '') + '" data-aid="' + t.id + '">' + esc(name) + (info ? ' <span style="opacity:.6;font-size:.75em">' + esc(info) + '</span>' : '') +
                (sel ? '<i class="fas fa-check text-xs"></i>' : '') + '</button>';
        }).join('');
        m.dataset.kind = 'audio'; m.classList.remove('hidden');
        [].slice.call(m.querySelectorAll('[data-aid]')).forEach(function (b) {
            b.onclick = function () {
                var id = +b.dataset.aid;
                (S.lastTracks || []).forEach(function (t) { if (t.type === 'audio') t.selected = t.id === id; });
                send('aid', id); closeMenu();
                try { hint('Audio: ' + b.textContent.trim()); } catch (e) {}
            };
        });
        try { showUI(); } catch (e) {}
    }

    /* ---------- screenshots come from mpv (the web element has no picture) ---------- */
    API.shot = function (withSubs) {
        return fetch('/api/player/screenshot' + (withSubs ? '?subs=1' : ''), { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('shot'); return r.blob();
        });
    };

    /* ---------- notices + Settings panel ---------- */
    function notice() {
        if (S.noticeShown || !S.status || S.status.engine === 'mpv' || S.status.enabled === false || !S.status.error) return;
        S.noticeShown = true;
        var el = $('player-error');
        if (el) { el.dataset.msg = el.textContent; }
        try { toast('Native player is off: ' + S.status.error + ' Using the built-in web player (MKV / HEVC / AC3 may not play). See Settings > Playback.', 8000); } catch (e) {}
    }
    var _mini = window.enterMiniInApp;
    if (typeof _mini === 'function') window.enterMiniInApp = function () {
        if (S.session) { try { toast('The pop-out player needs the ULTRON desktop window.', 3500); } catch (e) {} return; }
        return _mini.apply(this, arguments);
    };
    var _pv = window.playVideo;
    window.playVideo = function (id) { notice(); return _pv.apply(this, arguments); };

    function paintDiag() {
        var d = S.diag, el = $('mpv-diag'); if (!el || !d) return;
        var ad = d.audio_device ? String(d.audio_device).replace(/^.*\//, '') : '';
        el.textContent = 'Decoder: ' + (d.hwdec || 'software') + '  |  ' + (d.vo || '') + '  |  A/V sync: ' + (d.sync || '') +
            (typeof d.avsync === 'number' ? '  (offset ' + (d.avsync * 1000).toFixed(1) + ' ms)' : '') +
            '  |  dropped frames: ' + (d.dropped || 0) + '  |  ' + (d.codec || '');
    }
    /* Picture: the screen (refresh, bit depth) and what the picture of the playing video is doing. Read from /api/picture every
       few seconds while the Playback tab is on screen. */
    function hz(v) { v = +v || 0; return Math.abs(v - Math.round(v)) < 0.005 ? String(Math.round(v)) : v.toFixed(3).replace(/0+$/, ''); }
    function pictureText(d) {
        var s = d.screen || {}, out = [], dot = '  ·  ';
        if (s.hz) out.push('Screen: ' + s.w + '×' + s.h + ' at ' + hz(s.hz_exact || s.hz) + ' Hz' +
            (s.saved_hz && s.saved_hz !== s.hz ? ' (yours: ' + s.saved_hz + ' Hz)' : '') + (s.bits ? dot + s.bits + '-bit' : '') +
            dot + (s.hdr ? 'Windows HDR on' : 'SDR') + (s.rates && s.rates.length ? dot + 'offers ' + s.rates.join(' / ') + ' Hz' : ''));
        var r = d.now || d.last;
        if (!r) { out.push('Start a video to see its frame rate, sync and dropped frames here.'); return out.join('\n'); }
        var scr = +r.display_fps || +r.screen_hz || 0, fps = +r.fps || 0, bits = [], n = scr && fps ? Math.round(scr / fps) : 0;
        var fits = n > 0 && Math.abs(scr / n - fps) / fps <= 0.01;
        bits.push((fps ? hz(fps) + ' fps' : 'video') + (scr ? ' on ' + hz(scr) + ' Hz' : '') +
            (fits ? ', each frame shown ' + n + '×' : (r.interp ? ', frames blended (smooth motion)' : (scr && fps ? ', uneven frame times' : ''))));
        if (r.switched_from) bits.push('screen switched for this video');
        var fix = +r.speed_fix || 0;
        bits.push(/^display/.test(r.sync || '') && scr ? 'locked to the screen' + (Math.abs(fix) >= 0.01 ? ' (' + (fix > 0 ? '+' : '') + fix.toFixed(2).replace(/0$/, '') + ' % speed)' : '') : 'synced to the sound card');
        if (r.bits) bits.push(r.bits + '-bit' + (r.hdr ? ' ' + r.hdr + ' → SDR (' + (r.tone || 'auto') + ')' : ''));
        if (r.codec) bits.push(String(r.codec).toUpperCase() + (r.hwdec && r.hwdec !== 'no' ? ' on the GPU' : ' on the CPU'));
        bits.push('dropped ' + ((+r.dropped || 0) + (+r.decoder_dropped || 0)) + ', late ' + (+r.delayed || 0));
        out.push((d.now ? 'Playing: ' : 'Last video: ') + bits.join(dot));
        return out.join('\n');
    }
    function loadPicture() {
        var el = $('mpv-picture'); if (!el) return;
        api('/api/picture').then(function (d) { el.textContent = pictureText(d || {}); }).catch(function () { el.textContent = 'Screen details are not available.'; });
    }
    setInterval(function () { var el = $('mpv-picture'); if (el && el.offsetParent !== null && !document.hidden) loadPicture(); }, 3000);
    function field(label, hint2, html) {
        return '<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">' + label + '</div><div class="text-xs text-gray-500">' + hint2 + '</div></div>' + html + '</div>';
    }
    function buildSettings() {
        var anchor = $('set-asublang'); if (!anchor || $('mpv-settings')) return;
        var sec = anchor.closest('section'); if (!sec) return;
        var box = document.createElement('div'); box.id = 'mpv-settings';
        box.innerHTML =
            '<div class="mt-5 mb-2 text-xs font-bold tracking-widest text-gray-500 uppercase">Playback (libmpv)</div>' +
            '<div id="mpv-stat" class="text-xs text-gray-400 mb-3">Checking...</div>' +
            '<div class="text-sm font-semibold">Picture</div>' +
            '<div id="mpv-picture" class="text-xs text-gray-500 mb-4" style="white-space:pre-line">Reading the screen...</div>' +
            field('Native player window', 'Videos open in their own player window where the controls, subtitles and previews are drawn together with the picture (no overlay glitches). Off = the player inside this window',
                '<button id="mpv-native" class="set-switch" onclick="setPref({native_player: prefs.native_player === false})" title="Toggle"></button>') +
            field('Use libmpv', 'Plays MKV, HEVC, AV1, AC3, DTS and everything else as it is, on the GPU. Off = built-in web player',
                '<button id="mpv-on" class="set-switch" onclick="setPref({mpv_enabled: !prefs.mpv_enabled}).then(function(){ location.reload(); })" title="Toggle"></button>') +
            field('Controls over the picture', 'The player bars sit over the video in every mode, fullscreen too. Off = the old layout (picture between the bars; mpv\'s own controls in fullscreen)',
                '<button id="mpv-overlay" class="set-switch" onclick="setPref({mpv_overlay: prefs.mpv_overlay === false})" title="Toggle"></button>') +
            '<details class="mb-3"><summary class="text-xs font-bold tracking-widest text-gray-500 uppercase cursor-pointer mb-3">Advanced</summary>' +
            field('Video decoder', 'Auto = the Radeon through D3D11VA',
                '<select id="mpv-hw" class="set-select text-sm" onchange="setPref({mpv_hwdec: this.value})"><option value="auto">Auto (GPU)</option><option value="d3d11va">GPU (d3d11va)</option><option value="d3d11va-copy">GPU copy (d3d11va-copy)</option><option value="no">CPU only</option></select>') +
            field('Sync', 'Display = the monitor clock leads, audio is stretched a hair (smoothest)',
                '<select id="mpv-sync" class="set-select text-sm" onchange="setPref({mpv_sync: this.value})"><option value="display-resample">Display (smooth)</option><option value="audio">Audio clock</option></select>') +
            '</details>' +
            field('High-quality picture', 'Sharper scaling, smoother gradients (no banding) and better HDR. Applied the next time the player opens',
                '<button id="mpv-hq" class="set-switch" onclick="setPref({mpv_hq: prefs.mpv_hq === false})" title="Toggle"></button>') +
            field('Film refresh rate', 'While a film or episode plays in the player window, the screen moves to 120 Hz (24, 30 and 60 fps fit it exactly) and goes back when the player closes. Nothing changes when your screen already runs at a fitting rate',
                '<button id="mpv-refresh" class="set-switch" onclick="setPref({mpv_refresh: prefs.mpv_refresh === false})" title="Toggle"></button>') +
            field('Smooth motion', 'Blends frames when a video\'s frame rate does not fit the screen (25 / 50 fps at 120 Hz). Auto leaves fitting videos untouched',
                '<select id="mpv-motion" class="set-select text-sm" onchange="setPref({mpv_motion: this.value})"><option value="auto">Auto</option><option value="always">Always</option><option value="off">Off</option></select>') +
            field('HDR films', 'How HDR films are fitted to this SDR screen. Natural keeps highlights softer',
                '<select id="mpv-hdr" class="set-select text-sm" onchange="setPref({mpv_hdr: this.value})"><option value="balanced">Balanced</option><option value="natural">Natural</option></select>') +
            field('Audio output', 'Part of the device name. Detected devices are listed below',
                '<input id="mpv-dev" class="set-select text-sm" style="width:12rem" spellcheck="false" placeholder="e.g. M-Audio Duo" onchange="setPref({mpv_audio_device: this.value})">') +
            '<div id="mpv-devs" class="text-xs text-gray-500 mb-3"></div>' +
            field('Stereo downmix', 'Folds 5.1 / 7.1 down for headphones',
                '<button id="mpv-stereo" class="set-switch" onclick="setPref({mpv_stereo: !prefs.mpv_stereo})" title="Toggle"></button>') +
            field('Exclusive audio (WASAPI)', 'Bit-perfect to the interface. Other apps are silent while a video plays',
                '<button id="mpv-excl" class="set-switch" onclick="setPref({mpv_exclusive: !prefs.mpv_exclusive})" title="Toggle"></button>') +
            '<div class="mb-3"><div class="text-sm font-semibold">libmpv folder</div><div class="text-xs text-gray-500 mb-2">The folder with libmpv-2.dll, if it is not next to ULTRON.exe</div>' +
            '<div class="flex gap-2"><input id="mpv-dir" class="set-select text-sm" style="flex:1" spellcheck="false" placeholder="C:\\mpv"><button class="set-seg" id="mpv-dir-go">Use folder</button></div></div>' +
            '<div class="mb-3"><div class="text-sm font-semibold">Advanced mpv options</div><div class="text-xs text-gray-500 mb-2">One key=value per line, for example scale=ewa_lanczossharp. Applied the next time the player starts</div>' +
            '<textarea id="mpv-extra" rows="3" class="set-select text-sm" style="width:100%;font-family:monospace" spellcheck="false" onchange="setPref({mpv_extra: this.value})"></textarea></div>' +
            '<div id="mpv-diag" class="text-xs text-gray-500 mb-2" style="white-space:pre-line">Start a video to see what the decoder and the sync are doing.</div>';
        sec.appendChild(box);                                                 // INSIDE the Playback section: the settings window turns each <section> into a tab, so anything outside one shows on every tab
        $('mpv-dir-go').onclick = function () {
            p('/api/player/folder', { path: $('mpv-dir').value }).then(function (s) { S.status = s; paintSettings(); try { toast(s.available ? 'libmpv found. Restart ULTRON to use it.' : 'Not found', 4000); } catch (e) {} })
                .catch(function (e) { try { toast(e.message || 'Not found', 4000); } catch (x) {} });
        };
    }
    function paintSettings() {
        buildSettings();
        var st = S.status, el = $('mpv-stat'); if (!el || !st) return;
        var pf = (typeof prefs !== 'undefined' && prefs) || {};
        el.textContent = st.engine === 'mpv' ? ('libmpv ready' + (st.version ? ' (' + st.version + ')' : '')) :
            (st.enabled === false ? 'Off: using the built-in web player.' : ('Not active: ' + (st.error || 'libmpv was not found')));
        el.style.color = st.engine === 'mpv' ? '#4ade80' : '#fbbf24';
        var set = function (id, v) { var e = $(id); if (e && document.activeElement !== e) e.value = v; };
        set('mpv-hw', pf.mpv_hwdec || 'auto'); set('mpv-sync', pf.mpv_sync || 'display-resample'); set('mpv-motion', pf.mpv_motion || 'auto'); set('mpv-hdr', pf.mpv_hdr || 'balanced'); set('mpv-dev', pf.mpv_audio_device || ''); set('mpv-dir', pf.mpv_dir || ''); set('mpv-extra', pf.mpv_extra || '');
        [['mpv-native', pf.native_player !== false], ['mpv-on', pf.mpv_enabled], ['mpv-overlay', pf.mpv_overlay !== false], ['mpv-hq', pf.mpv_hq !== false], ['mpv-refresh', pf.mpv_refresh !== false], ['mpv-stereo', pf.mpv_stereo], ['mpv-excl', pf.mpv_exclusive]].forEach(function (x) { var e = $(x[0]); if (e) e.classList.toggle('on', !!x[1]); });
        var a = st.audio, dv = $('mpv-devs');
        if (dv) dv.textContent = a ? ((a.found ? 'Using: ' : 'Wanted device not found, using: ') + a.using + (a.devices && a.devices.length ? '  |  Detected: ' + a.devices.map(function (d) { return d.label; }).filter(Boolean).join(', ') : '')) : '';
    }
    var _op = window.openSettings;
    if (typeof _op === 'function') window.openSettings = function () { var r = _op.apply(this, arguments); statusP = loadStatus(); setTimeout(loadPicture, 50); return r; };
    window.addEventListener('load', function () { setTimeout(paintSettings, 600); });

    window.UltronMpv = API;
})();
