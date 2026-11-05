// ============ ULTRON ============
(function () {
    var $ = function (i) { return document.getElementById(i); };

    // ---- Browse: Discover / Series / All videos in one tab ----
    var BROWSE = [['video-view', 'Movies'], ['series-view', 'Series'], ['videos-view', 'All videos']];
    var bar = document.createElement('div'); bar.id = 'browse-bar';
    bar.innerHTML = BROWSE.map(function (b) { return '<button data-v="' + b[0] + '">' + b[1] + '</button>'; }).join('') +
        '<button id="bb-collapse" title="Hide / show the Cinema bar (B)" aria-label="Collapse browse bar"><i class="fas fa-chevron-up"></i></button>';
    document.body.appendChild(bar);
    var LS = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
    var collapsed = LS.get('lmp_browse_collapsed') === '1', autoHidden = false, forceShow = false, idleT = 0;
    function mode() { return (typeof prefs !== 'undefined' && prefs.browse_bar) || 'auto'; }
    function inVideoOrNP() { return document.documentElement.classList.contains('in-player') || document.body.classList.contains('np-open'); }
    function paintBar() {
        var onView = BROWSE.some(function (b) { return b[0] === currentView; });
        var m = mode(), visible = onView && !inVideoOrNP() && (m !== 'hidden' || forceShow);
        bar.classList.toggle('show', visible);
        bar.classList.toggle('collapsed', collapsed);
        bar.classList.toggle('autohide', visible && m === 'auto' && currentView === 'video-view' && autoHidden && !collapsed);
        bar.querySelectorAll('button[data-v]').forEach(function (x) { x.classList.toggle('on', x.dataset.v === currentView); });
        var ic = bar.querySelector('#bb-collapse i'); if (ic) ic.className = 'fas fa-chevron-' + (collapsed ? 'down' : 'up');
    }
    window.paintBar = paintBar;
    function armIdle() {
        clearTimeout(idleT);
        if (mode() !== 'auto' || currentView !== 'video-view' || collapsed) { autoHidden = false; paintBar(); return; }
        idleT = setTimeout(function () { autoHidden = true; paintBar(); }, 2500);
    }
    function toggleBar() {
        if (mode() === 'hidden') forceShow = !forceShow; else { collapsed = !collapsed; LS.set('lmp_browse_collapsed', collapsed ? '1' : '0'); }
        autoHidden = false; paintBar(); armIdle();
    }
    bar.addEventListener('click', function (e) {
        var c = e.target.closest('#bb-collapse'); if (c) { toggleBar(); return; }
        var b = e.target.closest('button[data-v]'); if (b) switchTab(b.dataset.v, 'tab-video');
    });
    document.addEventListener('mousemove', function (e) {
        if (e.clientY <= 48 && autoHidden) { autoHidden = false; paintBar(); }
        if (!autoHidden) armIdle();
    }, { passive: true });
    $('browse-edge').addEventListener('mouseenter', function () { if (autoHidden) { autoHidden = false; paintBar(); armIdle(); } });
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'b' && e.key !== 'B') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        var t = e.target, tag = t && t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
        if (inVideoOrNP()) return;
        if (!BROWSE.some(function (b) { return b[0] === currentView; })) return;
        e.preventDefault(); toggleBar();
    });
    var _sw = window.switchTab;
    window.switchTab = function () { var r = _sw.apply(this, arguments); autoHidden = false; forceShow = false; paintBar(); armIdle(); return r; };
    new MutationObserver(paintBar).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(paintBar).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    paintBar(); armIdle();

    // ---- one volume for the music hub and public videos ----
    function same(a, b) { return Math.abs(a - b) < 0.001; }
    function isPriv() { try { return !!playingId && scopeOf(playingId) === 'private'; } catch (e) { return false; } }
    player.addEventListener('volumechange', function () {
        if (!playingId || isPriv()) return;
        if (!same(audio.volume, player.volume)) audio.volume = player.volume;
        if (audio.muted !== player.muted) audio.muted = player.muted;
        try { paintAudioVol(); } catch (e) {}
    });
    audio.addEventListener('volumechange', function () {
        if (isPriv()) return;
        if (!same(player.volume, audio.volume)) player.volume = audio.volume;
        if (player.muted !== audio.muted) player.muted = audio.muted;
    });
    // never two things playing: if the video is running, the music bar cannot talk over it
    audio.addEventListener('play', function () { if (playingId && !player.paused && !miniMode) audio.pause(); });

    // the music bar, Now Playing and the video player always show the same volume / mute state
    function paintVols() {
        var v = audio.muted ? 0 : audio.volume, n = $('npg-vol');
        $('vol').value = Math.round(v * 100); try { paintRange($('vol')); } catch (e) {}
        if (n) { n.value = Math.round(v * 100); try { paintRange(n); } catch (e) {} }
        try { paintAudioVol(); } catch (e) {}
    }
    audio.addEventListener('volumechange', paintVols);
    player.addEventListener('volumechange', function () { if (playingId && !isPriv()) paintVols(); });
    // the shared volume must also reach a video that is just opening, and come back to the music bar when it closes
    player.addEventListener('loadstart', function () { if (playingId && !isPriv()) { if (!same(player.volume, audio.volume)) player.volume = audio.volume; player.muted = audio.muted; } });
    paintVols();

    // new genre folder / new files dropped in by hand: the page refreshes itself when the backend re-indexed
    var libVer = null;
    setInterval(function () {
        if (document.hidden || playingId) return;
        api('/api/videos/version').then(function (d) {
            if (libVer !== null && d.v !== libVer && !d.scanning) { loadVideos('public'); if (token) loadVideos('private'); }
            if (!d.scanning) libVer = d.v;
        }).catch(function () {});
    }, 8000);

    // ---- private videos ALWAYS start silent (and never touch the shared volume) ----
    var armed = false;
    var _pv = window.playVideo;
    window.playVideo = function (id) {
        try {
            if (scopeOf(id) === 'private') { armed = true; player.volume = 0; player.muted = true; }
            else { armed = false; if (!same(player.volume, audio.volume)) player.volume = audio.volume; player.muted = audio.muted; }
        } catch (e) {}
        return _pv.apply(this, arguments);
    };
    ['loadstart', 'loadedmetadata', 'play'].forEach(function (ev) {
        player.addEventListener(ev, function () {
            if (armed && isPriv()) { if (player.volume !== 0) player.volume = 0; if (!player.muted) player.muted = true; }
        });
    });
    player.addEventListener('playing', function () { armed = false; });

    // ---- music: a proper Playlists page ----
    window.showPlaylists = function () {
        view = { kind: 'playlists' }; $('m-search').value = '';
        setMainView('playlists'); renderLibrary(); $('m-main').scrollTop = 0;
    };
    window.renderPlaylistsPage = function () {
        var host = $('mv-playlists'); if (!host) return;
        REGS.home.clear();
        var liked = playlists.find(function (p) { return p.liked; });
        var likedSrc = liked ? plSrc(liked) : { type: 'playlist', id: -1, key: 'pl:-1', label: 'Playlist', title: 'Liked Songs', liked: true };
        var mine = playlists.filter(function (p) { return !p.liked; });
        var songs = playlists.reduce(function (a, p) { return a + (p.count || 0); }, 0);
        var cards = [shelfCard(likedBox('w-full aspect-square'), 'Liked Songs', 'Pinned &middot; ' + ((liked && liked.count) || 0) + ' songs', reg(likedSrc), false, 'w-full')];
        mine.forEach(function (p) { cards.push(shelfCard(plCover(p, 'w-full aspect-square'), p.name, 'Playlist &middot; ' + p.count + ' song' + (p.count === 1 ? '' : 's'), reg(plSrc(p)), false, 'w-full')); });
        cards.push('<div class="p-3 rounded-lg hover:bg-white/10 transition-colors cursor-pointer" onclick="openNameModal(\'create\')"><div class="w-full aspect-square rounded-md border-2 border-dashed border-white/15 flex items-center justify-center text-gray-500 hover:text-white hover:border-white/40 transition-colors mb-3"><i class="fas fa-plus text-3xl"></i></div><div class="font-semibold">New playlist</div><div class="text-sm text-gray-400">Start from scratch</div></div>');
        host.innerHTML = '<div class="flex items-end justify-between gap-4 mt-4 mb-6"><div><div class="text-xs font-bold tracking-[.25em] uppercase text-gray-400 mb-1">Your library</div><h1 class="text-4xl font-black">Playlists</h1><div class="text-sm text-gray-400 mt-1">' + mine.length + ' playlist' + (mine.length === 1 ? '' : 's') + ' &middot; ' + songs + ' songs</div></div>'
            + '<button onclick="openNameModal(\'create\')" class="bg-white text-black font-bold rounded-full px-5 py-2.5 text-sm hover:scale-105 transition-transform"><i class="fas fa-plus mr-2"></i>New playlist</button></div>'
            + '<div class="grid gap-2" style="grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))">' + cards.join('') + '</div>';
    };
    var _rl = window.renderLibrary;
    window.renderLibrary = function () { var r = _rl.apply(this, arguments); if (view && view.kind === 'playlists') window.renderPlaylistsPage(); return r; };
})();
