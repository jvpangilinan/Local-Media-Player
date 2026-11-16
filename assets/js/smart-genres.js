/* Smart genres and posters: Settings panel (keys, scan buttons, progress) and the "Needs review" list (your pick also brings its poster).
   The lookups themselves run in the Python app (autogenre.py); this file only talks to /api/autogenre/*. */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var last = null, timer = 0, wasRunning = false;

    function call(url, body) {
        return fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-LMP': '1', 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body) })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
    }
    function say(m) { if (typeof toast === 'function') toast(m, 4500); else alert(m); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function open() { var m = $('settings-modal'); return !!m && !m.classList.contains('hidden'); }

    function paint(d) {
        last = d;
        var s = d.state, c = d.counts, run = s.running;
        var sw = $('set-agonline'); if (sw) { sw.classList.toggle('on', !!d.online); sw.setAttribute('aria-checked', d.online ? 'true' : 'false'); }
        var t = $('sg-tmdb'), l = $('sg-lfm');
        if (t) t.placeholder = d.has_tmdb ? 'Saved on this PC (hidden). Paste a new one to replace it' : 'Paste your free TMDB key';
        if (l) l.placeholder = d.has_lfm ? 'Saved on this PC (hidden)' : 'Optional: Last.fm key for better music genres';
        var pg = $('sg-prog'), bar = $('sg-bar'), txt = $('sg-txt');
        if (pg) pg.classList.toggle('hidden', !run && !s.finished);
        if (bar) bar.style.width = (s.total ? Math.round(s.done / s.total * 100) : 0) + '%';
        if (txt) {
            var what = s.what === 'music' ? 'Songs' : 'Movies and series';
            if (run) txt.textContent = (s.paused ? 'Paused. ' : '') + what + ': ' + s.done + ' of ' + s.total + (s.current ? ' \u00b7 ' + s.current : '');
            else if (s.finished) txt.textContent = (s.error ? s.error + ' ' : 'Done. ') + s.found + ' found' + (s.review ? ', ' + s.review + ' need a look' : '') + (s.none ? ', ' + s.none + ' not found' : '') + '.' +
                (s.art ? ' ' + s.art + ' new poster' + (s.art === 1 ? '' : 's') + '.' : '');
        }
        ['sg-go-movies', 'sg-go-music'].forEach(function (id) { var b = $(id); if (b) b.disabled = run; });
        var pb = $('sg-pause'), sb = $('sg-stop');
        if (pb) { pb.classList.toggle('hidden', !run); pb.innerHTML = s.paused ? '<i class="fas fa-play"></i> Resume' : '<i class="fas fa-pause"></i> Pause'; }
        if (sb) sb.classList.toggle('hidden', !run);
        var cn = $('sg-counts'); if (cn) cn.textContent = 'Detected so far: ' + (c.video + c.series) + ' movies and series, ' + c.track + ' songs, ' + (c.posters || 0) + ' posters.';
        var rv = $('sg-review'); if (rv) { rv.classList.toggle('hidden', !c.review); rv.textContent = 'Needs review (' + c.review + ')'; }
        if (wasRunning && !run) {                                   // a scan just finished: show the new genres right away
            try { if (s.what === 'movies' && typeof loadVideos === 'function') loadVideos('public'); } catch (e) {}
            try { if (s.what === 'music' && typeof loadMusicFilters === 'function') { loadMusicFilters(); if (typeof renderHome === 'function') renderHome(); } } catch (e) {}
        }
        wasRunning = run;
        schedule(run);
    }
    function refresh() { return call('/api/autogenre/status').then(paint).catch(function () { schedule(false); }); }
    function schedule(fast) {
        clearTimeout(timer);
        if (fast || open()) timer = setTimeout(refresh, fast ? 1200 : 2500);
    }

    window.sgOpen = refresh;                                        // called when Settings opens
    window.sgSaveKeys = function () {
        var body = {}, t = $('sg-tmdb'), l = $('sg-lfm');
        if (t && t.value.trim()) body.tmdb_key = t.value.trim();
        if (l && l.value.trim()) body.lfm_key = l.value.trim();
        if (!Object.keys(body).length) { say('Paste a key first.'); return; }
        call('/api/autogenre/config', body).then(function () { if (t) t.value = ''; if (l) l.value = ''; say('Saved on this PC.'); refresh(); }).catch(function (e) { say(e.message); });
    };
    window.sgClearKeys = function () { call('/api/autogenre/config', { tmdb_key: '', lfm_key: '' }).then(function () { say('Keys removed.'); refresh(); }).catch(function (e) { say(e.message); }); };
    window.sgStart = function (what, redo) {
        call('/api/autogenre/start', { what: what, redo: !!redo }).then(function (d) {
            if (d.nothing) say('Nothing new to detect.');
            wasRunning = !d.nothing; refresh();
        }).catch(function (e) { say(e.message); });
    };
    window.sgPause = function () { call('/api/autogenre/pause', { on: !(last && last.state.paused) }).then(refresh); };
    window.sgStop = function () { call('/api/autogenre/stop', {}).then(refresh); };
    window.sgReset = function () {
        if (!confirm('Forget every automatically detected genre? Genres you picked yourself stay. You can scan again any time.')) return;
        call('/api/autogenre/reset', {}).then(function () { say('Detected genres cleared.'); try { if (typeof loadVideos === 'function') loadVideos('public'); } catch (e) {} refresh(); }).catch(function (e) { say(e.message); });
    };
    window.sgToggleOnline = function () { if (typeof setPref === 'function') setPref({ ag_online: !(last ? last.online : prefs.ag_online) }).then(function () { setTimeout(refresh, 200); }); };

    // ---------------------------------------------------------------- Needs review
    var items = [];
    function row(it, i) {
        var c = it.cands.map(function (x, j) {
            return '<button class="sg-cand" data-i="' + i + '" data-j="' + j + '"><b>' + esc(x.title) + '</b>' + (x.year ? ' <span>' + x.year + '</span>' : '') +
                '<small>' + esc((x.genres || []).join(', ') || 'no genres listed') + '</small></button>';
        }).join('');
        return '<div class="sg-row" data-i="' + i + '"><div class="sg-name">' + esc(it.name || it.key) + (it.year ? ' <span>' + it.year + '</span>' : '') + '</div>' +
            '<div class="sg-cands">' + c + '<button class="sg-cand none" data-i="' + i + '" data-j="-1">None of these</button></div></div>';
    }
    function paintReview() {
        var box = $('sg-rv-list'); if (!box) return;
        box.innerHTML = items.length ? items.map(row).join('') : '<div class="sg-empty">All done. Nothing left to check.</div>';
    }
    window.sgReview = function () {
        var ov = $('sg-rv');
        if (!ov) {
            ov = document.createElement('div'); ov.id = 'sg-rv';
            ov.innerHTML = '<div class="sg-card"><div class="sg-head"><h3>Needs review</h3><button class="sg-x" title="Close (Esc)"><i class="fas fa-xmark"></i></button></div>' +
                '<p class="sg-hint">These were not sure matches. Tap the right one. Your choice is saved and always wins over automatic ones.</p><div id="sg-rv-list"></div></div>';
            document.body.appendChild(ov);
            ov.addEventListener('click', function (e) {
                if (e.target === ov || e.target.closest('.sg-x')) { closeReview(); return; }
                var b = e.target.closest('.sg-cand'); if (!b) return;
                var it = items[+b.dataset.i], j = +b.dataset.j; if (!it) return;
                var genres = j >= 0 ? (it.cands[j].genres || []) : [];
                call('/api/autogenre/pick', { kind: it.kind, key: it.key, genres: genres, cand: j }).then(function () {
                    items.splice(+b.dataset.i, 1); paintReview(); refresh();
                }).catch(function (er) { say(er.message); });
            });
        }
        ov.classList.add('on');
        call('/api/autogenre/review').then(function (d) { items = d.items || []; paintReview(); });
    };
    function closeReview() {
        var ov = $('sg-rv'); if (ov) ov.classList.remove('on');
        try { if (typeof loadVideos === 'function') loadVideos('public'); } catch (e) {}
    }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('sg-rv') && $('sg-rv').classList.contains('on')) { e.stopPropagation(); closeReview(); } }, true);
    document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('#settings-btn')) setTimeout(refresh, 60); });
})();
