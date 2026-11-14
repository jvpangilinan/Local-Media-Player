/* ULTRON Studio: new toys for Videos, Photos, Private and Downloads.
   Pure front end, loaded last. It only hooks into what app.js already exposes. */
(function () {
    'use strict';
    var $ = function (i) { return document.getElementById(i); };
    var LS = {
        get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
        set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    };
    function mk(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
    function typing(e) {
        var t = e.target, tag = t && t.tagName;
        return (tag === 'INPUT' && t.type !== 'range') || tag === 'TEXTAREA' || tag === 'SELECT' || !!(t && t.isContentEditable);
    }
    function plain(e) { return !(e.ctrlKey || e.metaKey || e.altKey); }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function clock(s) { return typeof fmtClock === 'function' ? fmtClock(s) : Math.floor(s / 60) + ':' + ('0' + Math.floor(s % 60)).slice(-2); }
    function playerOpen() { return typeof playingId !== 'undefined' && !!playingId && !pm.classList.contains('hidden'); }
    function say(t) {
        try { if (playerOpen() && typeof hint === 'function') hint(t); else toast(t, 2400); } catch (e) {}
    }

    /* =====================================================================
       VIDEOS: the player gets ambient glow, hover previews, A-B loop,
       frame stepping, frame grabs and a sleep timer
       ===================================================================== */
    var glow = mk('canvas'); glow.id = 'sx-glow'; glow.width = 48; glow.height = 27;
    pm.insertBefore(glow, pm.firstChild);
    var gctx = glow.getContext('2d'), gOn = LS.get('lmpv9_glow', '1') === '1';
    function paintGlowFlag() { pm.classList.toggle('sx-glow-on', gOn); var b = $('sx-glow-btn'); if (b) b.classList.toggle('sx-on', gOn); }
    setInterval(function () {
        if (!gOn || !playerOpen() || player.paused || player.readyState < 2) return;
        try { gctx.drawImage(player, 0, 0, 48, 27); } catch (e) {}
    }, 140);
    function toggleGlow() { gOn = !gOn; LS.set('lmpv9_glow', gOn ? '1' : '0'); paintGlowFlag(); say(gOn ? 'Ambient glow on' : 'Ambient glow off'); }

    // controls: glow, frame grab, sleep timer (placed before the speed button)
    var snapFlash = mk('div'); snapFlash.id = 'sx-snapflash'; pm.appendChild(snapFlash);
    var spd = $('p-speed');
    if (spd && spd.parentNode) {
        var mkBtn = function (id, icon, title, fn) {
            var b = mk('button', 'p-btn', '<i class="fas ' + icon + '"></i>'); b.id = id; b.title = title; b.onclick = fn; spd.parentNode.insertBefore(b, spd); return b;
        };
        mkBtn('sx-glow-btn', 'fa-lightbulb', 'Ambient glow (G)', toggleGlow);
        mkBtn('sx-snap-btn', 'fa-camera', 'Grab this frame: copy to clipboard (S), save as PNG (Shift+S)', function () { grab(false); });
        mkBtn('sx-sleep-btn', 'fa-moon', 'Sleep timer: pauses after 15 / 30 / 45 / 60 minutes (Z)', cycleSleep);
        paintGlowFlag();
    }

    // ---- frame grab ----
    function grab(forceSave) {
        if (!playerOpen() || !(player.videoWidth > 0)) { say('Nothing to grab yet'); return; }
        var c = document.createElement('canvas'); c.width = player.videoWidth; c.height = player.videoHeight;
        try { c.getContext('2d').drawImage(player, 0, 0); } catch (e) { say('This frame cannot be captured'); return; }
        snapFlash.classList.remove('go'); void snapFlash.offsetWidth; snapFlash.classList.add('go');
        var name = 'ULTRON-' + String(titles[playingId] || 'frame').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) + '-' + clock(player.currentTime).replace(/:/g, '-') + '.png';
        c.toBlob(function (b) {
            if (!b) { say('This frame cannot be captured'); return; }
            var save = function () {
                var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click();
                setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000); say('Frame saved: ' + name);
            };
            if (!forceSave && navigator.clipboard && window.ClipboardItem) {
                navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]).then(function () { say('Frame copied. Paste it anywhere.'); }, save);
            } else save();
        }, 'image/png');
    }

    // ---- A-B loop ----
    var loopA = null, loopB = null, bar = document.querySelector('#p-seek .bar');
    var mA = mk('div', 'sx-ab'), mB = mk('div', 'sx-ab'), mR = mk('div', 'sx-abrange');
    mA.dataset.l = 'A'; mB.dataset.l = 'B'; [mR, mA, mB].forEach(function (n) { n.style.display = 'none'; if (bar) bar.appendChild(n); });
    function paintLoop() {
        var d = player.duration || 0;
        function put(el, t) { if (t == null || !(d > 0)) { el.style.display = 'none'; return; } el.style.display = ''; el.style.left = (t / d * 100) + '%'; }
        put(mA, loopA); put(mB, loopB);
        if (loopA != null && loopB != null && d > 0) { mR.style.display = ''; mR.style.left = (loopA / d * 100) + '%'; mR.style.width = ((loopB - loopA) / d * 100) + '%'; } else mR.style.display = 'none';
    }
    function loopKey(k) {
        var t = player.currentTime || 0;
        if (k === '[') { loopA = t; if (loopB != null && loopB <= loopA) loopB = null; say('Loop starts ' + clock(t) + (loopB == null ? '. Press ] for the end.' : '')); }
        else if (k === ']') {
            if (loopA == null) loopA = 0;
            if (t <= loopA + 0.5) { say('The loop end has to come after its start'); return; }
            loopB = t; say('Looping ' + clock(loopA) + ' to ' + clock(loopB) + '  (\\ clears)');
        } else { loopA = loopB = null; say('Loop cleared'); }
        paintLoop();
    }
    var loopStop = false, stopHit = false;
    player.addEventListener('timeupdate', function () {
        if (loopA == null || loopB == null) return;
        var t = player.currentTime;
        if (!loopStop) { if (t >= loopB) player.currentTime = loopA; return; }
        if (t < loopB - 0.05) stopHit = false;
        else if (!stopHit && t >= loopB) { stopHit = true; player.pause(); player.currentTime = loopB; }
    });
    window.sxLoop = {
        get: function () { return { a: loopA, b: loopB, stop: loopStop }; },
        set: function (a, b) { loopA = a; loopB = b; stopHit = false; paintLoop(); },
        stopAtB: function (v) { loopStop = !!v; stopHit = false; }
    };
    player.addEventListener('loadstart', function () { loopA = loopB = null; paintLoop(); });
    player.addEventListener('durationchange', paintLoop);

    // ---- hover preview on the seek bar (a hidden twin video does the seeking) ----
    // Gentle on big files: the twin only seeks once the mouse rests, never while the real player is still
    // filling its buffer, and it is let go (file closed) shortly after the mouse leaves the bar.
    var seek = $('p-seek'), pv = null, pvSrc = '', pvBusy = false, pvWant = null, pvT = 0, pvIdle = 0, pvRel = 0, pvLast = null;
    var box = mk('div', 'sx-pv'), cv = mk('canvas'), lab = mk('span'); cv.width = 176; cv.height = 99; box.appendChild(cv); box.appendChild(lab);
    if (seek) seek.appendChild(box);
    function pvDraw() { try { cv.getContext('2d').drawImage(pv, 0, 0, cv.width, cv.height); } catch (e) {} pvBusy = false; if (pvWant != null) { var t = pvWant; pvWant = null; pvGo(t); } }
    function pvGo(t) {
        if (!pv || pv.readyState < 1) { pvWant = t; return; }
        if (pvBusy) { pvWant = t; return; }
        pvBusy = true; clearTimeout(pvT); pvT = setTimeout(function () { pvBusy = false; }, 700);
        try { pv.currentTime = clamp(t, 0, pv.duration || t); } catch (e) { pvBusy = false; }
    }
    function pvEnsure() {
        var src = player.currentSrc; if (!src) return false;
        if (!pv) {
            pv = document.createElement('video'); pv.muted = true; pv.preload = 'metadata'; pv.playsInline = true;
            pv.addEventListener('seeked', pvDraw);
            pv.addEventListener('loadedmetadata', function () {
                if (pv.videoWidth) cv.height = Math.round(cv.width * pv.videoHeight / pv.videoWidth);
                if (pvWant != null) { var t = pvWant; pvWant = null; pvGo(t); }
            });
        }
        if (pvSrc !== src) { pvSrc = src; pv.src = src; }
        return true;
    }
    function pvRelease() {
        clearTimeout(pvIdle); clearTimeout(pvRel); clearTimeout(pvT); pvIdle = pvRel = pvT = 0; pvLast = null;
        if (pv) { pv.removeAttribute('src'); try { pv.load(); } catch (e) {} }
        pvSrc = ''; pvWant = null; pvBusy = false;
    }
    // the real player comes first: wait while it is seeking, or has under 6 s of picture buffered ahead
    function mainStarved() {
        if (player.seeking || player.readyState < 3) return true;
        try {
            var b = player.buffered, t = player.currentTime;
            for (var i = 0; i < b.length; i++) if (t >= b.start(i) && t <= b.end(i)) return !player.paused && b.end(i) - t < 6;
        } catch (e) {}
        return false;
    }
    function pvTry() {
        pvIdle = 0;
        if (pvLast == null || !box.classList.contains('on')) return;
        if (mainStarved()) { pvIdle = setTimeout(pvTry, 400); return; }
        if (!pvEnsure()) return;
        var t = pvLast; pvLast = null; pvGo(t);
    }
    player.addEventListener('emptied', pvRelease);
    if (seek) {
        seek.addEventListener('mousemove', function (e) {
            var d = player.duration || 0; if (!(d > 0) || !player.currentSrc) return;
            var r = seek.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width, 0, 1);
            box.style.left = clamp(f * r.width, 92, Math.max(92, r.width - 92)) + 'px';
            lab.textContent = clock(f * d); box.classList.add('on');
            pvLast = f * d; clearTimeout(pvIdle); clearTimeout(pvRel); pvIdle = setTimeout(pvTry, 220);
        });
        seek.addEventListener('mouseleave', function () {
            box.classList.remove('on'); clearTimeout(pvIdle); pvIdle = 0; pvLast = null;
            clearTimeout(pvRel); pvRel = setTimeout(pvRelease, 2500);
        });
    }

    // ---- sleep timer ----
    var SLEEP = [0, 15, 30, 45, 60], sleepI = 0, sleepAt = 0, sleepTick = 0;
    function paintSleep() {
        var b = $('sx-sleep-btn'); if (!b) return;
        b.classList.toggle('sx-on', sleepI > 0);
        b.innerHTML = '<i class="fas fa-moon"></i>' + (sleepI > 0 ? '<span class="sx-badge">' + Math.max(0, Math.ceil((sleepAt - Date.now()) / 60000)) + 'm</span>' : '');
    }
    function stopSleep() { sleepI = 0; sleepAt = 0; clearInterval(sleepTick); sleepTick = 0; player.style.filter = ''; paintSleep(); }
    function cycleSleep() {
        sleepI = (sleepI + 1) % SLEEP.length;
        if (!sleepI) { stopSleep(); say('Sleep timer off'); return; }
        sleepAt = Date.now() + SLEEP[sleepI] * 60000; player.style.filter = '';
        clearInterval(sleepTick);
        sleepTick = setInterval(function () {
            if (!playerOpen()) { stopSleep(); return; }
            var left = sleepAt - Date.now();
            if (left <= 30000 && !player.paused) player.style.filter = 'brightness(' + clamp(left / 30000, .15, 1).toFixed(2) + ')';   // the picture slowly dims
            if (left <= 0) { player.pause(); sleepI = 0; clearInterval(sleepTick); sleepTick = 0; paintSleep(); say('Sleep timer: paused. Sweet dreams.'); }
            else paintSleep();
        }, 1000);
        paintSleep(); say('Sleep timer: ' + SLEEP[sleepI] + ' minutes');
    }
    player.addEventListener('play', function () { if (!sleepI) player.style.filter = ''; });

    document.addEventListener('keydown', function (e) {
        if (!playerOpen() || typeof miniMode !== 'undefined' && miniMode) return;
        if (typing(e) || !plain(e)) return;
        var k = e.key, hit = true;
        if (k === 'g' || k === 'G') toggleGlow();
        else if (k === 's') grab(false);
        else if (k === 'S') grab(true);
        else if (k === 'z' || k === 'Z') cycleSleep();
        else if (k === '[' || k === ']' || k === '\\') loopKey(k);
        else if ((k === ',' || k === '.') && player.paused) { player.currentTime = clamp(player.currentTime + (k === ',' ? -1 : 1) / 30, 0, player.duration || 0); say(k === ',' ? 'Frame -1' : 'Frame +1'); }
        else hit = false;
        if (hit) { e.preventDefault(); if (typeof showUI === 'function') showUI(); }
    });

    /* =====================================================================
       PHOTOS: film looks, slideshow with Ken Burns drift, surprise me
       ===================================================================== */
    var lb = $('lightbox'), LOOKS = [
        ['Original', ''], ['Noir', 'grayscale(1) contrast(1.18) brightness(.96)'], ['Sepia', 'sepia(.85) contrast(1.05)'],
        ['Faded', 'contrast(.88) saturate(.78) brightness(1.1)'], ['Cine', 'contrast(1.14) saturate(1.18) sepia(.18) hue-rotate(-10deg)'],
        ['Pop', 'saturate(1.75) contrast(1.1)'], ['Cold', 'saturate(.9) hue-rotate(12deg) brightness(1.03) contrast(1.05)']
    ], look = 0, tagT = 0, ss = { on: false, t: 0, ms: 5000 }, peekT = 0;
    var tag = mk('div'); tag.id = 'sx-lb-tag'; lb.appendChild(tag);
    function lbTag(txt) { tag.textContent = txt; tag.classList.add('on'); clearTimeout(tagT); tagT = setTimeout(function () { tag.classList.remove('on'); }, 1500); }
    function setLook(i, silent) {
        look = (i + LOOKS.length) % LOOKS.length; $('lb-img').style.filter = LOOKS[look][1];
        var b = $('sx-lb-look'); if (b) b.classList.toggle('sx-on', look > 0);
        if (!silent) lbTag('Look: ' + LOOKS[look][0]);
    }
    var acts = lb.querySelector('.lb-acts'), fsBtn = acts && acts.querySelector('button[onclick="lbToggleFS()"]');
    if (acts) {
        var lookB = mk('button', 'lb-btn', '<i class="fas fa-wand-magic-sparkles"></i>'); lookB.id = 'sx-lb-look'; lookB.title = 'Film look (V)'; lookB.onclick = function () { setLook(look + 1); };
        var playB = mk('button', 'lb-btn', '<i class="fas fa-play"></i>'); playB.id = 'sx-lb-play'; playB.title = 'Slideshow (P)'; playB.onclick = function () { ss.on ? ssStop() : ssStart(); };
        acts.insertBefore(lookB, fsBtn || acts.firstChild); acts.insertBefore(playB, fsBtn || acts.firstChild);
    }
    function kb() {
        var im = $('lb-img'); im.classList.remove('sx-kb');
        if (!ss.on || !LB.open) return;
        void im.offsetWidth;
        im.style.setProperty('--kz', (1.06 + Math.random() * .08).toFixed(3)); im.style.setProperty('--kx', ((Math.random() * 2 - 1) * 2.4).toFixed(2));
        im.style.setProperty('--ky', ((Math.random() * 2 - 1) * 2.4).toFixed(2)); im.style.setProperty('--kd', (ss.ms + 1800) + 'ms');
        im.classList.add('sx-kb');
    }
    function ssStep() { if (!ss.on || !LB.open) return; lbGo(1); }
    function ssStart() {
        if (!LB.open) return;
        ss.on = true; lb.classList.add('sx-show'); var p = $('sx-lb-play'); if (p) { p.innerHTML = '<i class="fas fa-pause"></i>'; p.classList.add('sx-on'); }
        kb(); clearTimeout(ss.t); ss.t = setTimeout(ssStep, ss.ms); lbTag('Slideshow ' + (ss.ms / 1000) + 's  (+ / - changes speed, P stops)');
    }
    function ssStop() {
        if (!ss.on) return;
        ss.on = false; clearTimeout(ss.t); lb.classList.remove('sx-show', 'sx-peek'); $('lb-img').classList.remove('sx-kb');
        var p = $('sx-lb-play'); if (p) { p.innerHTML = '<i class="fas fa-play"></i>'; p.classList.remove('sx-on'); }
    }
    var _lbGo = window.lbGo;
    if (typeof _lbGo === 'function') window.lbGo = function () {       // every way of changing photo (keys, wheel, buttons, timer) goes through here
        var r = _lbGo.apply(this, arguments);
        if (ss.on) { clearTimeout(ss.t); ss.t = setTimeout(ssStep, ss.ms); setTimeout(kb, 240); }
        return r;
    };
    lb.addEventListener('mousemove', function () {
        if (!ss.on) return;
        lb.classList.add('sx-peek'); clearTimeout(peekT); peekT = setTimeout(function () { lb.classList.remove('sx-peek'); }, 2200);
    });
    window.addEventListener('keydown', function (e) {
        if (!LB.open || !plain(e)) return;
        var k = e.key, hit = true;
        if (k === 'v' || k === 'V') setLook(look + (e.shiftKey ? -1 : 1));
        else if (k === 'p' || k === 'P') ss.on ? ssStop() : ssStart();
        else if (k === '+' || k === '=') { ss.ms = clamp(ss.ms - 1000, 2000, 15000); lbTag('Slideshow ' + (ss.ms / 1000) + 's'); }
        else if (k === '-' || k === '_') { ss.ms = clamp(ss.ms + 1000, 2000, 15000); lbTag('Slideshow ' + (ss.ms / 1000) + 's'); }
        else hit = false;
        if (hit) e.preventDefault();
    }, true);
    new MutationObserver(function () { if (lb.classList.contains('hidden')) { ssStop(); setLook(0, true); } }).observe(lb, { attributes: true, attributeFilter: ['class'] });

    window.sxSlideshow = function () {
        if (typeof PH === 'undefined' || !PH.view || !PH.view.length) { toast('No photos to show yet.'); return; }
        openPhoto(0, null); setTimeout(ssStart, 450);
    };
    window.sxSurprisePhoto = function () {
        if (typeof PH === 'undefined' || !PH.view || !PH.view.length) { toast('No photos to show yet.'); return; }
        openPhoto(Math.floor(Math.random() * PH.view.length), null);
    };
    function injectPhotoActs(root) {
        root.querySelectorAll('.ph-acts').forEach(function (a) {
            if (a.querySelector('.sx-ss')) return;
            a.insertAdjacentHTML('afterbegin', '<button class="ph-act sx-ss" onclick="sxSlideshow()" title="Play every photo here, with a slow drift"><i class="fas fa-play"></i> Slideshow</button>' +
                '<button class="ph-act sx-ss" onclick="sxSurprisePhoto()" title="Open a random photo"><i class="fas fa-dice"></i> Surprise</button>');
        });
    }
    ['photos-view', 'private-view'].forEach(function (id) {
        var root = $(id); if (!root) return;
        new MutationObserver(function () { injectPhotoActs(root); }).observe(root, { childList: true, subtree: true });
    });

    /* =====================================================================
       PRIVATE: panic key, look-away blur, vault doors
       ===================================================================== */
    var lastTick = 0;
    function panic() {
        try { if (typeof lockNow === 'function') lockNow(); } catch (e) {}
        try { if (typeof closePhotoNow === 'function') closePhotoNow(); } catch (e) {}
        try { if (playingId) closePlayer(true); } catch (e) {}
        try { switchTab('home-view', 'tab-home'); } catch (e) {}
    }
    document.addEventListener('keydown', function (e) {
        if (e.key !== '`' || !plain(e) || typing(e)) return;
        var n = Date.now(); if (n - lastTick < 520) { lastTick = 0; e.preventDefault(); panic(); } else lastTick = n;
    }, true);

    var veil = mk('div', '', '<i class="fas fa-eye-slash"></i><span>Hidden while you look away</span>'); veil.id = 'sx-veil'; document.body.appendChild(veil);
    function sensitive() {
        if (typeof token === 'undefined' || !token) return false;
        return currentView === 'private-view' || (!!playingId && privateIds.has(playingId)) || (LB.open && PH.pub === false);
    }
    function awayOn() { return LS.get('lmpv9_lookaway', '1') === '1'; }
    function goAway() {
        if (!awayOn() || !sensitive()) return;
        document.documentElement.classList.add('sx-away');
        if (playingId && privateIds.has(playingId) && !player.paused) player.pause();      // stays paused when you come back
    }
    function comeBack() { document.documentElement.classList.remove('sx-away'); }
    window.addEventListener('blur', goAway);
    window.addEventListener('focus', comeBack);
    document.addEventListener('visibilitychange', function () { if (document.hidden) goAway(); else comeBack(); });

    var lockMenu = $('lock-menu');
    if (lockMenu) {
        var ab = mk('button', 'w-full text-left px-4 py-2 hover:bg-white/10 flex items-center justify-between'); ab.id = 'sx-away-btn';
        var paintAway = function () { ab.innerHTML = '<span><i class="fas fa-eye-slash w-5"></i>Blur when I look away</span><span class="text-xs text-gray-500">' + (awayOn() ? 'On' : 'Off') + '</span>'; };
        ab.onclick = function () { LS.set('lmpv9_lookaway', awayOn() ? '0' : '1'); paintAway(); };
        paintAway(); lockMenu.appendChild(ab);
        lockMenu.appendChild(mk('div', 'px-4 py-2 text-xs text-gray-500', 'Panic key: press <b>`</b> twice'));
    }

    var vault = mk('div', '', '<div class="d l"></div><div class="d r"></div><div class="k"><i class="fas fa-lock-open"></i></div>'); vault.id = 'sx-vault'; document.body.appendChild(vault);
    function vaultOpen() {
        vault.classList.remove('open', 'go'); void vault.offsetWidth; vault.classList.add('go');
        requestAnimationFrame(function () { requestAnimationFrame(function () { vault.classList.add('open'); }); });
        setTimeout(function () { vault.classList.remove('go', 'open'); }, 1600);
    }
    var _setToken = window.setToken;
    if (typeof _setToken === 'function') window.setToken = function (t) {
        var was = !!token, r = _setToken.apply(this, arguments);
        if (!was && t) vaultOpen();
        return r;
    };

    /* =====================================================================
       DOWNLOADS: presets, paste and drop, loading dock, finish chime
       ===================================================================== */
    var PRESETS = [['Best video', 'video', 'best'], ['1080p', 'video', '1080'], ['720p lite', 'video', '720'], ['4K', 'video', '2160'], ['MP3', 'audio', null], ['Music FLAC', 'music', null]];
    function urlsIn(text) { return (String(text || '').match(/https?:\/\/[^\s<>"']+/g) || []).filter(function (u, i, a) { return a.indexOf(u) === i; }); }
    function addLinks(list) {
        var ta = $('dl-url'); if (!ta || !list.length) return false;
        var have = ta.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
        list.forEach(function (u) { if (have.indexOf(u) < 0) have.push(u); });
        ta.value = have.join('\n'); ta.rows = clamp(have.length, 2, 6);
        if (typeof onDlUrlInput === 'function') onDlUrlInput();
        return true;
    }
    function chimeOn() { return LS.get('lmpv9_chime', '1') === '1'; }
    var actx = null;
    function ding() {
        if (!chimeOn()) return;
        var A = window.AudioContext || window.webkitAudioContext; if (!A) return;
        actx = actx || new A(); if (actx.state === 'suspended') actx.resume();
        [[880, 0], [1318.5, .13], [1760, .26]].forEach(function (n) {
            var o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + n[1];
            o.type = 'sine'; o.frequency.value = n[0]; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + .02); g.gain.exponentialRampToValueAtTime(0.0001, t + .55);
            o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + .6);
        });
    }
    function dockPaint() {
        var d = $('sx-dock'); if (!d) return;
        var jobs = typeof dlJobsById === 'object' ? Object.keys(dlJobsById).map(function (k) { return dlJobsById[k]; }) : [];
        var run = jobs.filter(function (j) { return j.status === 'running'; }).length, q = jobs.filter(function (j) { return j.status === 'queued'; }).length;
        var done = jobs.filter(function (j) { return j.status === 'done'; }).length, bad = jobs.filter(function (j) { return j.status === 'error'; }).length;
        var sig = [run, q, done, bad, chimeOn()].join();
        if (d.dataset.sig === sig) return; d.dataset.sig = sig;
        d.classList.toggle('busy', run > 0);
        d.innerHTML = '<span class="bay' + (run ? ' lit' : '') + '"><b>' + run + '</b>Unloading</span><span class="bay' + (q ? ' lit' : '') + '"><b>' + q + '</b>Waiting</span>' +
            '<span class="bay ok' + (done ? ' lit' : '') + '"><b>' + done + '</b>Delivered</span>' + (bad ? '<span class="bay"><b>' + bad + '</b>Stuck</span>' : '') +
            '<button id="sx-chime" title="A little chime when a download finishes">Chime ' + (chimeOn() ? 'on' : 'off') + '</button><div class="belt"></div>';
        var c = $('sx-chime'); if (c) c.onclick = function () { LS.set('lmpv9_chime', chimeOn() ? '0' : '1'); if (chimeOn()) ding(); d.dataset.sig = ''; dockPaint(); };
    }
    function dockInit() {
        var ta = $('dl-url'), kinds = $('dl-kinds'), list = $('dl-list');
        if (!ta || !kinds || !list || $('sx-dock')) return;
        var pre = mk('div', 'sx-presets', '<span>Presets</span>' + PRESETS.map(function (p, i) { return '<button class="sx-pre" data-i="' + i + '">' + p[0] + '</button>'; }).join(''));
        pre.id = 'sx-presets'; kinds.parentNode.insertBefore(pre, kinds);
        pre.addEventListener('click', function (e) {
            var b = e.target.closest('.sx-pre'); if (!b) return;
            var p = PRESETS[+b.dataset.i]; setDlKind(p[1]); if (p[2] && $('dl-res')) $('dl-res').value = p[2];
            toast('Preset: ' + p[0], 1600);
        });
        var row = mk('div', 'sx-pasterow', '<button class="sx-pbtn" id="sx-paste"><i class="fas fa-paste mr-1"></i> Paste links from clipboard</button><span>or drop a link anywhere in the window</span>');
        ta.parentNode.insertBefore(row, ta.nextSibling);
        $('sx-paste').onclick = function () {
            if (!navigator.clipboard || !navigator.clipboard.readText) { toast('Click the box and press Ctrl+V.'); ta.focus(); return; }
            navigator.clipboard.readText().then(function (t) {
                var u = urlsIn(t); if (!u.length) { toast('No link on the clipboard.'); return; }
                addLinks(u); toast(u.length === 1 ? 'Link pasted' : u.length + ' links pasted', 1800);
            }, function () { toast('Click the box and press Ctrl+V.'); ta.focus(); });
        };
        var dock = mk('div'); dock.id = 'sx-dock'; var head = list.previousElementSibling; list.parentNode.insertBefore(dock, head || list);
        dockPaint();
    }
    var _dlOpened = window.dlOpened;
    if (typeof _dlOpened === 'function') window.dlOpened = function () { var r = _dlOpened.apply(this, arguments); dockInit(); return r; };
    var _dlFinished = window.dlFinished;
    if (typeof _dlFinished === 'function') window.dlFinished = function () { var r = _dlFinished.apply(this, arguments); try { ding(); } catch (e) {} return r; };
    setInterval(function () { if (currentView === 'dl-view') dockPaint(); }, 1000);

    var drop = mk('div', '', '<i class="fas fa-cloud-arrow-down"></i><span>Drop the link to queue it</span>'); drop.id = 'sx-drop'; document.body.appendChild(drop);
    function textDrag(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && !Array.prototype.some.call(t, function (x) { return x === 'Files'; }) && (Array.prototype.indexOf.call(t, 'text/uri-list') >= 0 || Array.prototype.indexOf.call(t, 'text/plain') >= 0); }
    var dragN = 0;
    document.addEventListener('dragenter', function (e) { if (textDrag(e)) { dragN++; drop.classList.add('on'); } });
    document.addEventListener('dragleave', function (e) { if (textDrag(e) && --dragN <= 0) { dragN = 0; drop.classList.remove('on'); } });
    document.addEventListener('dragover', function (e) { if (textDrag(e)) e.preventDefault(); });
    document.addEventListener('drop', function (e) {
        dragN = 0; drop.classList.remove('on');
        if (!textDrag(e)) return;
        var u = urlsIn((e.dataTransfer.getData('text/uri-list') || '') + '\n' + (e.dataTransfer.getData('text/plain') || ''));
        if (!u.length) return;
        e.preventDefault();
        if (typeof dlOpened === 'function' && currentView !== 'dl-view') switchTab('dl-view', 'tab-dl');
        setTimeout(function () { dockInit(); addLinks(u); toast(u.length === 1 ? 'Link added. Press Download.' : u.length + ' links added. Press Download.', 2600); }, 60);
    });

    /* =====================================================================
       VIDEOS: movie night roulette (spin the reel, play what lands)
       ===================================================================== */
    var MOODS = [['any', 'Anything'], ['fresh', 'Never watched'], ['half', 'Unfinished'], ['fav', 'Favorites']];
    var rl = mk('div'); rl.id = 'sx-rl';
    rl.innerHTML = '<div class="box"><button class="x" aria-label="Close">&times;</button><div class="k">MOVIE NIGHT</div><h2>Roulette</h2><div class="moods"></div>' +
        '<div class="win"><div class="ptr"></div><div class="strip"></div></div><div class="out"></div><div class="acts"><button class="go" disabled>Play it</button><button class="spin">Spin</button></div></div>';
    document.body.appendChild(rl);
    var rlMood = 'any', rlScope = 'public', rlPick = null, rlBusy = false;
    var moodsEl = rl.querySelector('.moods'), strip = rl.querySelector('.strip'), out = rl.querySelector('.out'), goB = rl.querySelector('.go'), spinB = rl.querySelector('.spin');
    function paintMoods() { moodsEl.innerHTML = MOODS.map(function (m) { return '<button data-m="' + m[0] + '" class="' + (m[0] === rlMood ? 'on' : '') + '">' + m[1] + '</button>'; }).join(''); }
    function esc2(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function candidates() {
        var d = typeof vdata !== 'undefined' && vdata[rlScope]; if (!d) return [];
        var seen = {}, all = [];
        function add(c) { if (c && c.id && !seen[c.id]) { seen[c.id] = 1; all.push(c); } }
        (d.loose || []).forEach(add); (d.all_series || []).forEach(add);
        ['continue', 'recent', 'unwatched', 'most_watched'].forEach(function (k) { (d[k] || []).forEach(add); });
        (d.genres || []).forEach(function (g) { (g.items || []).forEach(add); });
        return all.filter(function (c) {
            var series = c.kind === 'series', seenIt = series ? (c.watched || 0) : (c.view_count || 0);
            if (rlMood === 'fresh') return !seenIt;
            if (rlMood === 'half') return series ? (c.progress > 0 && c.progress < 1) : c.progress > 0;
            if (rlMood === 'fav') return (c.user_rating || 0) >= 4 || (c.avg_rating || 0) >= 4 || (c.view_count || 0) >= 3;
            return true;
        });
    }
    function tile(c, win) {
        return '<div class="t' + (win ? ' win-t' : '') + '">' + (c.poster ? '<img src="' + esc2(c.poster) + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '<span>' + esc2(c.title) + '</span></div>';
    }
    function playable(c) { return c.kind === 'series' ? (c.resume || c.first || c.id) : c.id; }
    function spin() {
        if (rlBusy) return;
        var list = candidates();
        if (!list.length) { strip.style.transition = 'none'; strip.style.transform = 'none'; strip.innerHTML = ''; out.innerHTML = '<div class="n">Nothing fits that mood.</div><div class="m">Try Anything, or refresh the library.</div>'; goB.disabled = true; rlPick = null; return; }
        rlBusy = true; goB.disabled = true; spinB.disabled = true; out.innerHTML = '<div class="m">Spinning...</div>';
        var W = 32, total = 40, tiles = [], pick = list[Math.floor(Math.random() * list.length)];
        for (var i = 0; i < total; i++) tiles.push(i === W ? pick : list[Math.floor(Math.random() * list.length)]);
        strip.style.transition = 'none'; strip.style.transform = 'translateX(0)';
        strip.innerHTML = tiles.map(function (c, i) { return tile(c, false); }).join('');
        void strip.offsetWidth;
        var win = rl.querySelector('.win').clientWidth, step = 150, target = -(W * step + 69) + win / 2;
        strip.style.transition = 'transform 4.4s cubic-bezier(.1,.72,.08,1)'; strip.style.transform = 'translateX(' + target + 'px)';
        var done = false, fin = function () {
            if (done) return; done = true; rlBusy = false; spinB.disabled = false; rlPick = pick;
            var t = strip.children[W]; if (t) t.classList.add('win-t');
            var bits = [];
            if (pick.kind === 'series') bits.push('Series' + (pick.episodes ? ', ' + pick.episodes + ' episodes' : ''));
            if (pick.genre) bits.push(pick.genre);
            if (pick.view_count) bits.push(pick.view_count + ' view' + (pick.view_count === 1 ? '' : 's'));
            if (pick.progress > 0 && pick.progress < 1) bits.push(Math.round(pick.progress * 100) + '% watched');
            out.innerHTML = '<div class="n">' + esc2(pick.title) + '</div><div class="m">' + esc2(bits.join('  /  ') || 'Tonight\'s pick') + '</div>';
            goB.disabled = false; goB.textContent = pick.kind === 'series' ? 'Play from where you are' : 'Play it';
        };
        strip.addEventListener('transitionend', fin, { once: true }); setTimeout(fin, 4700);
    }
    function openRoulette(scope) {
        rlScope = scope === 'private' && typeof token !== 'undefined' && token ? 'private' : 'public';
        rl.classList.add('on'); paintMoods(); strip.innerHTML = ''; out.innerHTML = '<div class="m">Pick a mood and spin. Whatever lands, plays.</div>'; goB.disabled = true; rlPick = null;
        var n = candidates().length; if (!n) out.innerHTML = '<div class="n">No videos to spin yet.</div><div class="m">Add some and press the refresh icon.</div>';
    }
    function closeRoulette() { rl.classList.remove('on'); }
    rl.addEventListener('click', function (e) {
        if (e.target === rl || e.target.closest('.x')) { closeRoulette(); return; }
        var m = e.target.closest('.moods button'); if (m && !rlBusy) { rlMood = m.dataset.m; paintMoods(); return; }
        if (e.target.closest('.spin')) { spin(); return; }
        if (e.target.closest('.go') && rlPick) { var id = playable(rlPick); closeRoulette(); playVideo(id); }
    });
    window.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && rl.classList.contains('on')) { e.preventDefault(); e.stopPropagation(); closeRoulette(); }
    }, true);
    window.sxRoulette = openRoulette;

    var bb = $('browse-bar');
    if (bb) { var rb = mk('button', '', '<i class="fas fa-dice"></i> Roulette'); rb.id = 'sx-roulette'; rb.title = 'Movie night roulette'; rb.onclick = function () { openRoulette('public'); }; bb.insertBefore(rb, $('bb-collapse') || null); }
    var pvRoot = $('private-view');
    if (pvRoot) new MutationObserver(function () {
        var pb = $('private-bar'); if (!pb || pb.querySelector('.sx-rlbtn')) return;
        var b = mk('button', 'pv-tab sx-rlbtn', '<i class="fas fa-dice"></i> Roulette'); b.onclick = function () { openRoulette('private'); }; pb.appendChild(b);
    }).observe(pvRoot, { childList: true, subtree: true });
})();
