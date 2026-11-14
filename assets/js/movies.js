/* ULTRON Movies: collections, Netflix-style expanding cards, picture modes (black bars / smart zoom),
   and the Precision trimmer (A/B filmstrip like DaVinci Resolve).
   Front end only. It hooks into what app.js already exposes, loaded after studio.js. */
(function () {
    'use strict';
    var $ = function (i) { return document.getElementById(i); };
    function mk(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function esc2(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function playerOpen() { return typeof playingId !== 'undefined' && !!playingId && !pm.classList.contains('hidden'); }
    function inMini() { return typeof miniMode !== 'undefined' && miniMode; }
    function say(t) { try { if (playerOpen() && typeof hint === 'function') hint(t); else toast(t, 2600); } catch (e) {} }
    function typing(e) {
        var t = e.target, tag = t && t.tagName;
        return (tag === 'INPUT' && t.type !== 'range') || tag === 'TEXTAREA' || tag === 'SELECT' || !!(t && t.isContentEditable);
    }
    function isPrivate(id) { try { return scopeOf(id) === 'private'; } catch (e) { return false; } }

    /* =====================================================================
       1. MOVIES: auto-sorted collections (Spider-Man, Iron Man ...) as rows
       ===================================================================== */
    window.paintCollections = function (V) {
        var host = $('public-collections'); if (!host) return;
        var colls = (V && V.collections) || [];
        host.innerHTML = colls.map(function (c, i) {
            var tag = '<span class="mv-tag" title="Sorted automatically from the file names. Nothing was moved on disk.">AUTO &middot; ' + c.count + ' films</span>';
            return sectionHtml('public-c-' + i, c.name, tag, false, cardsHtml(c.items, 'public'));
        }).join('');
        colls.forEach(function (c, i) { try { updateArrows('public-c-' + i); } catch (e) {} });
    };

    /* =====================================================================
       2. NETFLIX-STYLE CARDS: rest as a poster, hover = it grows into a wide card and plays a muted preview
       ===================================================================== */
    var HOSTS = '#video-view, #series-view, #videos-view, #home-view';
    var pop = null, popCard = null, openT = 0, closeT = 0, popVid = null;
    var idx = null, idxFor = null;
    function index() {
        var d = (typeof vdata !== 'undefined') && vdata.public;
        if (!d) return { v: {}, s: {} };
        if (idxFor === d && idx) return idx;
        idx = { v: {}, s: {} };
        function add(c) { if (!c) return; if (c.kind === 'series') idx.s[c.id] = c; else idx.v[c.id] = c; }
        [d.featured].concat(d.loose || [], d.singles || [], d.continue || [], d.recent || [], d.most_watched || [], d.unwatched || [], d.all_series || []).forEach(add);
        (d.collections || []).forEach(function (c) { c.items.forEach(add); });
        (d.genres || []).forEach(function (g) { g.items.forEach(add); });
        idxFor = d;
        return idx;
    }
    function hashOf(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000; return h; }

    function closePop(now) {
        clearTimeout(openT); clearTimeout(closeT);
        if (popVid) { try { popVid.pause(); popVid.removeAttribute('src'); popVid.load(); } catch (e) {} popVid = null; }
        if (pop) {
            var p = pop; pop = null; popCard = null;
            if (now) p.remove(); else { p.classList.remove('on'); setTimeout(function () { p.remove(); }, 160); }
        }
        popCard = null;
    }
    function scheduleClose() { clearTimeout(closeT); closeT = setTimeout(function () { closePop(); }, 140); }

    function openPop(card) {
        if (!card.isConnected || playerOpen()) return;
        closePop(true);
        var d = index(), sid = card.dataset.sid, id = card.dataset.id;
        var item = sid ? d.s[sid] : d.v[id];
        var el = card.querySelector('[data-title-id]') || card.querySelector('.font-bold');
        var title = (item && item.title) || (el && el.textContent) || '';
        var isSeries = !!sid;
        var playId = isSeries ? (item && (item.resume || item.first)) : id;
        var art = isSeries ? (item && item.first) : id;
        var r = card.getBoundingClientRect();
        var w = clamp(Math.round(r.width * 1.9), 330, 470), mh = Math.round(w * 9 / 16), bh = 118;
        var sbEl = document.getElementById('tab-video'), sbBox = sbEl && sbEl.parentElement ? sbEl.closest('aside, nav, #sidebar') || sbEl.parentElement : null,
            minLeft = Math.max(12, sbBox ? Math.round(sbBox.getBoundingClientRect().right) + 12 : 12);
        var left = clamp(r.left + r.width / 2 - w / 2, minLeft, Math.max(minLeft, innerWidth - w - 12));
        var top = clamp(r.top + r.height / 2 - mh / 2 - 6, 60, Math.max(60, innerHeight - mh - bh - 12));
        var bits = [];
        if (isSeries) {
            bits.push(((item && item.episodes) || 0) + ' episodes');
            if (item && item.watched) bits.push(item.watched + ' watched');
        } else if (item) {
            if (item.year) bits.push(item.year);
            bits.push(item.view_count ? item.view_count + 'x viewed' : 'Not watched yet');
            if (item.avg_rating != null) bits.push('&#9733; ' + item.avg_rating);
            if (item.collection) bits.push(esc2(item.collection));
            else if (item.series) bits.push(esc2(item.series));
        }
        var prog = item && item.progress ? '<div class="nfx-prog"><i style="width:' + Math.round(item.progress * 100) + '%"></i></div>' : '';
        pop = mk('div', 'nfx-pop');
        pop.style.cssText = 'left:' + left + 'px;top:' + top + 'px;width:' + w + 'px;';
        pop.style.transformOrigin = (r.left + r.width / 2 - left) + 'px ' + (r.top + r.height / 2 - top) + 'px';
        pop.innerHTML = '<div class="nfx-media" style="height:' + mh + 'px">' +
            (art ? '<img class="nfx-bd" alt="" src="/backdrop/' + art + '" onerror="this.remove()">' : '') +
            '<video class="nfx-pv" muted playsinline></video><div class="nfx-shade"></div>' +
            '<div class="nfx-name">' + esc2(title) + '</div>' + prog + '</div>' +
            '<div class="nfx-body"><div class="nfx-btns">' +
            '<button class="nfx-play" title="' + (item && item.progress ? 'Resume' : 'Play') + '"><i class="fas fa-play"></i></button>' +
            (isSeries ? '<button class="nfx-b nfx-open" title="Open the series"><i class="fas fa-list"></i></button>'
                      : '<button class="nfx-b nfx-ren" title="Rename"><i class="fas fa-pen"></i></button>') +
            '<span class="nfx-fill"></span><span class="nfx-hint">' + (isSeries ? 'SERIES' : 'MOVIE') + '</span></div>' +
            '<div class="nfx-meta">' + bits.join('<span class="nfx-dot">&middot;</span>') + '</div></div>';
        document.body.appendChild(pop);
        void pop.offsetWidth; pop.classList.add('on');
        popCard = card;
        pop.addEventListener('mouseenter', function () { clearTimeout(closeT); });
        pop.addEventListener('mouseleave', scheduleClose);
        pop.addEventListener('click', function (e) {
            var c = card;
            if (e.target.closest('.nfx-play')) { e.stopPropagation(); closePop(true); if (playId) playVideo(playId); return; }
            if (e.target.closest('.nfx-ren')) { e.stopPropagation(); closePop(true); editTitle(e, id); return; }
            closePop(true); c.click();
        });
        // muted preview from a different spot of each film (never the very start: that is all studio logos)
        if (playId && (typeof prefs === 'undefined' || prefs.hover_preview !== false)) {
            var v = pop.querySelector('video'), a = 0, b = 0; popVid = v;
            v.src = '/media/video/' + playId;
            v.addEventListener('loadedmetadata', function () {
                var dur = v.duration || 0;
                a = dur > 240 ? dur * (0.15 + hashOf(playId) / 1000 * 0.3) : (dur > 40 ? dur * 0.2 : 0);
                b = a + 28;
                if (a) v.currentTime = a;
                v.play().catch(function () {});
            });
            v.addEventListener('timeupdate', function () { if (b && v.currentTime > b) v.currentTime = a; });
            v.addEventListener('playing', function () { v.classList.add('on'); });
        }
    }

    document.addEventListener('mouseover', function (e) {
        var card = e.target.closest && e.target.closest('.vcard[data-id], .vcard[data-sid]');
        if (!card || !card.closest(HOSTS) || card.closest('#private-view') || card.classList.contains('utile')) return;
        if (card === popCard) { clearTimeout(closeT); return; }
        if (playerOpen()) return;
        clearTimeout(openT); clearTimeout(closeT);
        openT = setTimeout(function () { openPop(card); }, popCard ? 140 : 420);
    });
    document.addEventListener('mouseout', function (e) {
        var card = e.target.closest && e.target.closest('.vcard');
        if (!card) return;
        var to = e.relatedTarget;
        if (to && (card.contains(to) || (pop && pop.contains(to)))) return;
        clearTimeout(openT);
        if (popCard === card) scheduleClose();
    });
    window.addEventListener('scroll', function () { if (pop) closePop(true); }, true);
    window.addEventListener('resize', function () { closePop(true); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(true); }, true);
    document.addEventListener('wheel', function () { if (pop) closePop(true); }, { passive: true });
    new MutationObserver(function () { if (document.documentElement.classList.contains('in-player')) closePop(true); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    /* =====================================================================
       3. PLAYER: black bars, picture modes, picture info, "make it playable"
       ===================================================================== */
    var probe = null, probeId = null;
    var MODES = ['smart', 'fit', 'fill'], MODE_NAME = { smart: 'Smart', fit: 'Fit', fill: 'Fill' };
    function curMode() { var m = (typeof prefs !== 'undefined' && prefs.play_aspect) || 'smart'; return MODES.indexOf(m) < 0 ? 'smart' : m; }
    function fmtRatio(r) {
        if (!r) return '';
        if (Math.abs(r - 16 / 9) < 0.03) return '16:9';
        if (Math.abs(r - 4 / 3) < 0.03) return '4:3';
        if (Math.abs(r - 1) < 0.03) return '1:1';
        return r.toFixed(2) + ':1';
    }
    var badge = mk('div', 'p-ui'); badge.id = 'nfx-ratio';
    var top = $('p-top'); if (top) top.appendChild(badge);

    function applyAspect() {
        if (!playerOpen()) return;
        var st = player.style, mode = curMode();
        st.objectViewBox = '';
        if (inMini()) { st.objectFit = 'contain'; return; }
        var cropped = false;
        if (mode === 'fill') { st.objectFit = 'cover'; try { fitFill = true; } catch (e) {} }
        else {
            st.objectFit = 'contain'; try { fitFill = false; } catch (e) {}
            if (mode === 'smart' && probe && probe.crop && probe.w && probe.h) {
                var c = probe.crop, f = function (n) { return Math.max(0, n).toFixed(3) + '%'; };
                st.objectViewBox = 'inset(' + f(c.y / probe.h * 100) + ' ' + f((probe.w - c.x - c.w) / probe.w * 100) + ' ' + f((probe.h - c.y - c.h) / probe.h * 100) + ' ' + f(c.x / probe.w * 100) + ')';
                cropped = true;
            }
        }
        var eff = probe ? ((cropped || (probe.crop && mode !== 'fill')) ? probe.crop.ratio : probe.ratio) : 0;
        var bits = [];
        if (probe && probe.ratio) bits.push(fmtRatio(probe.crop ? probe.crop.ratio : probe.ratio));
        if (probe && probe.w) bits.push(probe.w + '\u00d7' + probe.h);
        if (probe && probe.vcodec) bits.push(probe.vcodec.toUpperCase());
        badge.textContent = bits.join('  \u00b7  ') + (probe && probe.crop && mode !== 'fill' ? (cropped ? '  \u00b7  BARS CROPPED' : '  \u00b7  BARS IN FILE') : '');
        var b = $('nfx-asp'); if (b) b.title = 'Picture: ' + MODE_NAME[mode] + '  (A to change). Smart = removes black bars baked into the file; Fit = whole frame; Fill = crop to the window';
        void eff;
    }
    function cycleMode() {
        var m = MODES[(MODES.indexOf(curMode()) + 1) % MODES.length];
        setPref({ play_aspect: m });
        applyAspect();
        var extra = m === 'smart' ? (probe && probe.crop ? ' \u00b7 bars cropped (' + fmtRatio(probe.crop.ratio) + ')' : ' \u00b7 no bars in this file') : (m === 'fit' ? ' \u00b7 black bars' : ' \u00b7 cropped to the window');
        say('Picture: ' + MODE_NAME[m] + extra);
    }
    var spd = $('p-speed');
    if (spd && spd.parentNode) {
        var ab = mk('button', 'p-btn', '<i class="fas fa-film"></i>'); ab.id = 'nfx-asp'; ab.onclick = cycleMode;
        spd.parentNode.insertBefore(ab, spd);
        var pb = mk('button', 'p-btn', '<i class="fas fa-scissors"></i>'); pb.id = 'nfx-prec-btn'; pb.title = 'Precision trimmer: A/B filmstrip (T)'; pb.onclick = function () { togglePrec(); };
        spd.parentNode.insertBefore(pb, ab);
    }
    ['loadedmetadata', 'resize'].forEach(function (ev) { player.addEventListener(ev, applyAspect); });
    pm.addEventListener('transitionend', function () {});

    var _play = window.playVideo;
    window.playVideo = function (id) {
        var r = _play.apply(this, arguments);
        onOpen(id);
        return r;
    };
    function onOpen(id) {
                probeId = id; probe = null; badge.textContent = '';
        if (isPrivate(id)) { applyAspect(); return; }
        api('/api/videos/' + id + '/probe').then(function (r) {
            if (probeId !== id) return;
            probe = r; applyAspect(); refreshPrec(true);              // size, bars and fps for Smart picture + the trimmer (the file itself is played by libmpv as it is)
        }).catch(function () {});
    }
    var _close = window.closePlayer;
    window.closePlayer = function () {
        closePrec(); probe = null; probeId = null;
        player.style.objectViewBox = '';
        return _close.apply(this, arguments);
    };

    /* =====================================================================
       4. PRECISION TRIMMER: zoomable filmstrip with IN / OUT handles (like the DaVinci Resolve A/B trimmer)
       ===================================================================== */
    var WINS = [4, 10, 30, 60, 120, 300, 900, 3600];
    var prec = null, ps = { win: 60, ws: 0, drag: null, raf: 0, key: '', img: null, n: 0 };
    function fps() { return (probe && probe.fps > 1 && probe.fps < 241) ? probe.fps : 24; }
    function dur() { return (player.duration > 0 && isFinite(player.duration)) ? player.duration : ((probe && probe.duration) || 0); }
    function pad(n, l) { n = String(Math.floor(n)); while (n.length < (l || 2)) n = '0' + n; return n; }
    function tc(t) {
        if (t == null || !isFinite(t)) return '--:--:--:--';
        var f = fps(), whole = Math.floor(t + 1e-6), fr = Math.min(Math.round(f) - 1, Math.floor((t - whole) * f + 1e-4));
        return Math.floor(whole / 3600) + ':' + pad(whole % 3600 / 60) + ':' + pad(whole % 60) + ':' + pad(Math.max(0, fr));
    }
    function winLabel(w) { return w < 60 ? w + ' s' : (w < 3600 ? w / 60 + ' min' : '1 hour'); }
    function loopGet() { return window.sxLoop ? window.sxLoop.get() : { a: null, b: null, stop: false }; }
    function loopSet(a, b) { if (window.sxLoop) window.sxLoop.set(a, b); }

    function buildPrec() {
        prec = mk('div', 'p-ui'); prec.id = 'nfx-prec';
        prec.innerHTML =
            '<div class="np-head"><b class="np-title"><i class="fas fa-scissors"></i> PRECISION</b>' +
            '<div class="np-tcs"><span>IN</span><em id="np-in">--</em><span>OUT</span><em id="np-out">--</em><span>LEN</span><em id="np-len">--</em></div>' +
            '<div class="np-btns">' +
            '<button id="np-setin" title="Set IN at the playhead ( [ )">IN</button><button id="np-setout" title="Set OUT at the playhead ( ] )">OUT</button>' +
            '<button id="np-goin" title="Jump to IN"><i class="fas fa-backward-step"></i></button><button id="np-goout" title="Jump to OUT"><i class="fas fa-forward-step"></i></button>' +
            '<button id="np-range" title="Play the part between IN and OUT"><i class="fas fa-play"></i> A\u2013B</button>' +
            '<button id="np-loop" class="tg" title="On: loop the part. Off: stop at OUT">LOOP</button>' +
            '<button id="np-clear" title="Clear IN and OUT ( \\ )">CLEAR</button>' +
            '<button id="np-save" title="Save the part as its own file (no re-encoding) in Videos/Clips"><i class="fas fa-floppy-disk"></i> SAVE CLIP</button></div>' +
            '<div class="np-zoom"><button id="np-zout" title="Zoom out (mouse wheel on the strip)"><i class="fas fa-minus"></i></button><span id="np-win">1 min</span><button id="np-zin" title="Zoom in"><i class="fas fa-plus"></i></button></div>' +
            '<button id="np-x" title="Close (T)"><i class="fas fa-xmark"></i></button></div>' +
            '<div id="np-strip"><div id="np-img"></div><div id="np-ticks"></div><div id="np-rg"></div>' +
            '<div id="np-hin" class="np-h" data-l="IN"></div><div id="np-hout" class="np-h" data-l="OUT"></div><div id="np-ph"></div><div id="np-tip"></div></div>' +
            '<div id="np-over"><div id="np-orange"></div><div id="np-owin"></div><div id="np-oph"></div></div>' +
            '<div class="np-foot"><span id="np-tc">0:00:00:00</span>' +
            '<div class="np-step"><button data-s="-1" title="Back 1 second">&minus;1 s</button><button data-f="-10">&minus;10 f</button><button data-f="-1" title="Back one frame">&minus;1 f</button>' +
            '<button data-f="1" title="Forward one frame">+1 f</button><button data-f="10">+10 f</button><button data-s="1" title="Forward 1 second">+1 s</button></div>' +
            '<span class="np-tipline">Drag on the strip to scrub \u00b7 drag the IN / OUT handles \u00b7 wheel zooms</span></div>';
        pm.appendChild(prec);
        wirePrec();
    }
    function togglePrec() { if (prec && pm.classList.contains('nfx-prec-open')) closePrec(); else openPrec(); }
    function openPrec() {
        if (!playerOpen() || inMini()) return;
        if (isPrivate(playingId)) { say('The trimmer is not available in the private library'); return; }
        if (!prec) buildPrec();
        pm.classList.add('nfx-prec-open');
        var d = dur();
        ps.win = d && d < ps.win ? Math.max(4, Math.ceil(d)) : ps.win;
        ps.ws = Math.floor((player.currentTime || 0) / ps.win) * ps.win; ps.key = '';
        layoutPrec(); refreshPrec(true); loop();
        var b = $('nfx-prec-btn'); if (b) b.classList.add('sx-on');
    }
    function closePrec() {
        pm.classList.remove('nfx-prec-open'); pm.style.removeProperty('--nfx-lower');
        cancelAnimationFrame(ps.raf); ps.raf = 0;
        var b = $('nfx-prec-btn'); if (b) b.classList.remove('sx-on');
    }
    function layoutPrec() {
        if (!prec) return;
        var ctl = $('p-bottom'), h = (ctl ? ctl.getBoundingClientRect().height : 110) + prec.getBoundingClientRect().height + 6;
        pm.style.setProperty('--nfx-lower', Math.round(h) + 'px');
        prec.style.bottom = (ctl ? Math.round(ctl.getBoundingClientRect().height) : 110) + 'px';
    }
    window.addEventListener('resize', function () { if (pm.classList.contains('nfx-prec-open')) { layoutPrec(); ps.key = ''; refreshPrec(true); } });

    function stripW() { var s = $('np-strip'); return s ? s.clientWidth : 800; }
    function tx(t) { return (t - ps.ws) / ps.win * 100; }
    function loadStrip() {
        var d = dur(); if (!(d > 0) || !playingId) return;
        var ratio = (probe && probe.ratio) || 16 / 9, cellW = Math.max(60, 64 * ratio), n = clamp(Math.round(stripW() / cellW), 4, 30);
        var a = Math.max(0, ps.ws), b = Math.min(d, ps.ws + ps.win);
        if (!(b > a)) return;
        var key = playingId + '|' + a.toFixed(2) + '|' + b.toFixed(2) + '|' + n;
        if (key === ps.key) return;
        ps.key = key;
        var url = '/api/videos/' + playingId + '/strip?a=' + a.toFixed(2) + '&b=' + b.toFixed(2) + '&n=' + n + '&w=180';
        var img = new Image();
        img.onload = function () {
            if (ps.key !== key) return;
            var el = $('np-img'); if (!el) return;
            el.style.backgroundImage = 'url("' + url + '")'; el.classList.add('on');
            var span = (b - a) / ps.win * 100; el.style.width = span + '%';
        };
        img.onerror = function () { var el = $('np-img'); if (el && ps.key === key) el.classList.remove('on'); };
        img.src = url;
    }
    function ticks() {
        var el = $('np-ticks'); if (!el) return;
        var steps = [0.04, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800], want = ps.win / 8, st = steps.find(function (s) { return s >= want; }) || 1800, out = '';
        for (var t = Math.ceil(ps.ws / st) * st; t < ps.ws + ps.win; t += st) {
            var s = Math.round(t * 100) / 100, lab = s >= 3600 ? Math.floor(s / 3600) + ':' + pad(s % 3600 / 60) + ':' + pad(s % 60)
                : (s >= 60 ? Math.floor(s / 60) + ':' + pad(s % 60) : (st < 1 ? s.toFixed(2) : s) + 's');
            out += '<i style="left:' + tx(t).toFixed(3) + '%"><b>' + lab + '</b></i>';
        }
        el.innerHTML = out;
    }
    function refreshPrec(full) {
        if (!prec || !pm.classList.contains('nfx-prec-open')) return;
        var d = dur(), t = player.currentTime || 0, lp = loopGet();
        if (!ps.drag && !(t >= ps.ws && t <= ps.ws + ps.win) && d) { ps.ws = clamp(Math.floor(t / ps.win) * ps.win, 0, Math.max(0, d - 0.01)); full = true; }
        if (full) { ticks(); loadStrip(); $('np-win').textContent = winLabel(ps.win); }
        var ph = $('np-ph'); ph.style.left = tx(t) + '%';
        function put(id, v) { var e = $(id); if (v == null || v < ps.ws - 0.001 || v > ps.ws + ps.win + 0.001) { e.style.display = 'none'; return; } e.style.display = ''; e.style.left = tx(v) + '%'; }
        put('np-hin', lp.a); put('np-hout', lp.b);
        var rg = $('np-rg');
        if (lp.a != null && lp.b != null) {
            var l = clamp(lp.a, ps.ws, ps.ws + ps.win), r = clamp(lp.b, ps.ws, ps.ws + ps.win);
            rg.style.display = r > l ? '' : 'none'; rg.style.left = tx(l) + '%'; rg.style.width = (tx(r) - tx(l)) + '%';
        } else rg.style.display = 'none';
        $('np-in').textContent = lp.a == null ? '--' : tc(lp.a);
        $('np-out').textContent = lp.b == null ? '--' : tc(lp.b);
        $('np-len').textContent = lp.a != null && lp.b != null ? (lp.b - lp.a).toFixed(2) + ' s' : '--';
        $('np-loop').classList.toggle('on', !lp.stop);
        $('np-tc').textContent = tc(t) + '   /   ' + tc(d);
        if (d > 0) {                                        // overview of the whole film
            $('np-oph').style.left = (t / d * 100) + '%';
            var w = $('np-owin'); w.style.left = (ps.ws / d * 100) + '%'; w.style.width = Math.min(100, ps.win / d * 100) + '%';
            var o = $('np-orange');
            if (lp.a != null && lp.b != null) { o.style.display = ''; o.style.left = (lp.a / d * 100) + '%'; o.style.width = ((lp.b - lp.a) / d * 100) + '%'; } else o.style.display = 'none';
        }
    }
    function loop() { cancelAnimationFrame(ps.raf); var f = function () { if (!pm.classList.contains('nfx-prec-open')) return; refreshPrec(false); ps.raf = requestAnimationFrame(f); }; ps.raf = requestAnimationFrame(f); }
    function seekTo(t) { var d = dur(); player.currentTime = clamp(t, 0, d || t); }
    function frameStep(n) { player.pause(); var f = fps(), t = (Math.round((player.currentTime || 0) * f) + n) / f + 0.0005; seekTo(t); }
    function zoom(dir, anchorT, frac) {
        var i = WINS.indexOf(ps.win); if (i < 0) i = WINS.findIndex(function (w) { return w >= ps.win; });
        var ni = clamp(i + dir, 0, WINS.length - 1), nw = WINS[ni], d = dur();
        if (d && nw > d) nw = Math.max(4, Math.ceil(d));
        if (nw === ps.win) return;
        var at = anchorT != null ? anchorT : (player.currentTime || 0), fr = frac != null ? frac : 0.5;
        ps.win = nw; ps.ws = clamp(at - fr * nw, 0, Math.max(0, (d || nw) - nw)); ps.key = ''; refreshPrec(true);
    }
    function timeAt(e) { var r = $('np-strip').getBoundingClientRect(); return ps.ws + clamp((e.clientX - r.left) / r.width, 0, 1) * ps.win; }

    function wirePrec() {
        var strip = $('np-strip'), over = $('np-over');
        strip.addEventListener('pointerdown', function (e) {
            if (e.button !== 0) return;
            var h = e.target.closest('.np-h');
            strip.setPointerCapture(e.pointerId);
            ps.drag = h ? (h.id === 'np-hin' ? 'in' : 'out') : 'seek';
            move(e); e.preventDefault();
        });
        function move(e) {
            if (!ps.drag) return;
            var t = timeAt(e), lp = loopGet();
            if (ps.drag === 'seek') seekTo(t);
            else if (ps.drag === 'in') { loopSet(Math.min(Math.max(0, t), (lp.b != null ? lp.b - 0.04 : t)), lp.b); seekTo(t); }
            else { loopSet(lp.a != null ? lp.a : 0, Math.max(t, (lp.a != null ? lp.a + 0.04 : 0.04))); seekTo(t); }
            refreshPrec(false);
        }
        strip.addEventListener('pointermove', function (e) {
            var tip = $('np-tip'), t = timeAt(e);
            tip.style.display = ''; tip.style.left = clamp((t - ps.ws) / ps.win * 100, 2, 98) + '%'; tip.textContent = tc(t);
            move(e);
        });
        strip.addEventListener('pointerleave', function () { $('np-tip').style.display = 'none'; });
        strip.addEventListener('pointerup', function () { ps.drag = null; });
        strip.addEventListener('pointercancel', function () { ps.drag = null; });
        strip.addEventListener('wheel', function (e) {
            e.preventDefault(); e.stopPropagation();
            var r = strip.getBoundingClientRect(), fr = clamp((e.clientX - r.left) / r.width, 0, 1);
            zoom(e.deltaY < 0 ? -1 : 1, ps.ws + fr * ps.win, fr);
        }, { passive: false });
        over.addEventListener('pointerdown', function (e) {
            var d = dur(); if (!(d > 0)) return;
            var r = over.getBoundingClientRect(), t = clamp((e.clientX - r.left) / r.width, 0, 1) * d;
            ps.ws = clamp(Math.floor(t / ps.win) * ps.win, 0, Math.max(0, d - 0.01)); ps.key = ''; seekTo(t); refreshPrec(true);
        });
        var B = function (id, fn) { $(id).addEventListener('click', function (e) { e.stopPropagation(); fn(e); }); };
        B('np-x', closePrec);
        B('np-setin', function () { var lp = loopGet(), t = player.currentTime || 0; loopSet(t, lp.b != null && lp.b > t + 0.04 ? lp.b : null); });
        B('np-setout', function () { var lp = loopGet(), t = player.currentTime || 0; loopSet(lp.a != null && lp.a < t - 0.04 ? lp.a : (lp.a == null ? 0 : null), t); if (lp.a != null && lp.a >= t - 0.04) say('OUT has to come after IN'); });
        B('np-goin', function () { var lp = loopGet(); if (lp.a != null) seekTo(lp.a); });
        B('np-goout', function () { var lp = loopGet(); if (lp.b != null) seekTo(lp.b); });
        B('np-range', function () { var lp = loopGet(); if (lp.a == null || lp.b == null) { say('Set IN and OUT first'); return; } seekTo(lp.a); player.play().catch(function () {}); });
        B('np-loop', function () { var lp = loopGet(); window.sxLoop.stopAtB(!lp.stop); refreshPrec(false); say(lp.stop ? 'Loop on' : 'Stops at OUT'); });
        B('np-clear', function () { loopSet(null, null); say('IN / OUT cleared'); });
        B('np-zin', function () { zoom(-1); });
        B('np-zout', function () { zoom(1); });
        B('np-save', saveClip);
        prec.querySelectorAll('.np-step button').forEach(function (b) {
            b.addEventListener('click', function (e) {
                e.stopPropagation(); player.pause();
                if (b.dataset.f) frameStep(+b.dataset.f); else seekTo((player.currentTime || 0) + (+b.dataset.s));
            });
        });
        ['mousedown', 'click', 'dblclick'].forEach(function (ev) { prec.addEventListener(ev, function (e) { e.stopPropagation(); }); });
    }
    var saving = false;
    function saveClip() {
        var lp = loopGet();
        if (lp.a == null || lp.b == null) { say('Set IN and OUT first'); return; }
        if (saving) return;
        saving = true; var b = $('np-save'); b.disabled = true; b.classList.add('busy');
        post('/api/videos/' + playingId + '/clip', { a: lp.a, b: lp.b }).then(function (r) {
            say('Saved: Clips / ' + r.file);
        }).catch(function (e) { say(errMsg(e)); }).then(function () { saving = false; b.disabled = false; b.classList.remove('busy'); });
    }
    document.addEventListener('keydown', function (e) {
        if (!playerOpen() || inMini()) return;
        if (e.key === 'Escape' && pm.classList.contains('nfx-prec-open')) { e.preventDefault(); e.stopImmediatePropagation(); closePrec(); return; }
        if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
        var k = e.key.toLowerCase();
        if (k === 't') { e.preventDefault(); togglePrec(); }
        else if (k === 'a') { e.preventDefault(); cycleMode(); }
        else if (pm.classList.contains('nfx-prec-open') && (k === '+' || k === '=')) { e.preventDefault(); zoom(-1); }
        else if (pm.classList.contains('nfx-prec-open') && k === '-') { e.preventDefault(); zoom(1); }
    }, true);
    player.addEventListener('loadedmetadata', function () { if (pm.classList.contains('nfx-prec-open')) { ps.key = ''; refreshPrec(true); } });
    player.addEventListener('emptied', function () { ps.key = ''; });

    /* =====================================================================
       5. SETTINGS: Movies block (auto-sort, clean names, default picture)
       ===================================================================== */
    function injectSettings() {
        var anchor = null;
        document.querySelectorAll('#settings-modal section h4').forEach(function (h) { if (/LIBRARY/i.test(h.textContent)) anchor = h.parentNode; });
        if (!anchor || $('set-autosort')) return;
        var sec = mk('div', 'mt-5');
        sec.innerHTML =
            '<div class="mb-2 text-xs font-bold tracking-widest text-gray-500 uppercase">Movies</div>' +
            '<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Auto-sort movies</div><div class="text-xs text-gray-500">Files you drop in the video folder sort themselves: Spider-Man films together, S01E02 files into a series. Folders you made yourself always win. Nothing is moved on disk.</div></div>' +
            '<button id="set-autosort" class="set-switch" role="switch" title="Toggle"></button></div>' +
            '<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Clean movie names</div><div class="text-xs text-gray-500">Hide 1080p, BluRay, x264, YIFY and the other junk in file names (the files keep their names)</div></div>' +
            '<button id="set-cleantitles" class="set-switch" role="switch" title="Toggle"></button></div>' +
            '<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Auto-sort movies now</div><div id="set-autosort-note" class="text-xs text-gray-500">Looks at the video folder again with the settings above</div></div>' +
            '<button id="set-autosort-now" class="set-seg px-4"><i class="fas fa-wand-magic-sparkles mr-1"></i>Sort now</button></div>' +
            '<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Picture</div><div class="text-xs text-gray-500">Smart: black bars stay pure black and bars baked into a file are removed. Fit: the whole frame. Fill: crop to the window. Press A while playing</div></div>' +
            '<select id="set-aspect" class="set-select text-sm"><option value="smart">Smart</option><option value="fit">Fit</option><option value="fill">Fill</option></select></div>';
        anchor.appendChild(sec);
        $('set-autosort').onclick = function () { setPref({ auto_sort: !prefs.auto_sort }); setTimeout(resort, 250); };
        $('set-cleantitles').onclick = function () { setPref({ clean_titles: !prefs.clean_titles }); setTimeout(resort, 250); };
        $('set-aspect').onchange = function () { setPref({ play_aspect: this.value }); applyAspect(); };
        $('set-autosort-now').onclick = resort;
        var fit = $('set-fit'); if (fit) { var row = fit.closest('.flex'); if (row) row.style.display = 'none'; }     // replaced by Picture
    }
    function resort() {
        var note = $('set-autosort-note'), b = $('set-autosort-now');
        if (note) note.textContent = 'Sorting\u2026'; if (b) b.disabled = true;
        post('/api/autosort/run', {}).then(function (s) {
            var c = s.collections || [], se = s.series || [];
            if (note) note.textContent = c.length + ' collection' + (c.length === 1 ? '' : 's') + ' (' + c.map(function (x) { return x.name; }).slice(0, 6).join(', ') + (c.length > 6 ? ', \u2026' : '') + '), ' +
                se.length + ' series, ' + s.singles + ' single movie' + (s.singles === 1 ? '' : 's') + ', ' + s.in_folders + ' in your own folders';
            try { loadVideos('public'); refreshSeries(); } catch (e) {}
        }).catch(function (e) { if (note) note.textContent = errMsg(e); }).then(function () { if (b) b.disabled = false; });
    }
    function paintMovieSettings() {
        if (!$('set-autosort')) return;
        [['set-autosort', prefs.auto_sort !== false], ['set-cleantitles', prefs.clean_titles !== false]].forEach(function (p) {
            var el = $(p[0]); el.classList.toggle('on', p[1]); el.setAttribute('aria-checked', p[1] ? 'true' : 'false');
        });
        $('set-aspect').value = prefs.play_aspect || 'smart';
    }
    var _ps = window.paintSettings;
    window.paintSettings = function () { var r = _ps.apply(this, arguments); try { injectSettings(); paintMovieSettings(); } catch (e) { console.error(e); } return r; };
    try { injectSettings(); paintMovieSettings(); } catch (e) {}
})();
