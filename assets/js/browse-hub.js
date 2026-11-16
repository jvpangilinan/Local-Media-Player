/* ULTRON Browse hub.
   One page for every kind of video: movies, trilogies and franchises, series, your own folders, loose clips.
   Front end only: it reads the same data the old Browse tab used (vdata.public) and reuses the same cards,
   so ratings, rename, resume, hover previews and the player all behave exactly as before.
   The private library is not touched by this file.

   Tabs:   Home (opens here) | Movies | Collections | Series | Clips | Folders
   Pages:  a collection (watch order) or a folder opens inside the page; Esc / Back returns.
   Search: one box finds collections, series, folders and videos at once ( / focuses it ). */
(function () {
    'use strict';
    var $ = function (i) { return document.getElementById(i); };
    var LS = {
        get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    };
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function jq(x) { return JSON.stringify(x).replace(/"/g, '&quot;'); }
    function nat(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }); }
    function getY() { return document.body.scrollTop || 0; }
    function setY(y, smooth) { try { document.body.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'instant' }); } catch (e) { document.body.scrollTop = y; } }
    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

    var TABS = [['home', 'Home'], ['movies', 'Movies'], ['collections', 'Collections'], ['series', 'Series'], ['clips', 'Clips'], ['folders', 'Folders']];
    var OLD_TABS = { overview: 'home', all: 'movies' };     // names other code (and old saved state) still uses
    var SORTS = [['title', 'Title A-Z'], ['title_d', 'Title Z-A'], ['added', 'Recently added'], ['year_d', 'Year, newest'], ['year_a', 'Year, oldest'],
                 ['views', 'Most watched'], ['rating', 'Top rated'], ['shuffle', 'Shuffle']];
    var UNSORTED = '__ubh_unsorted__';   // plain text on purpose: a NUL character gets rewritten by the HTML parser and never matches
    var CHUNK = 96, ROW_MAX = 24;

    var S = {
        tab: 'home', open: null, q: '', tile: null, selmode: false, sel: {},   // Cinema always opens on Home
        sort: LS.get('ubh_sort') || 'title', type: 'all', seen: 'all', folder: '', ag: '', chip: '',
        size: parseInt(LS.get('ubh_size'), 10) || 2, shown: CHUNK, list: [], seed: 1, back: 0
    };
    if (!SORTS.some(function (t) { return t[0] === S.sort; })) S.sort = 'title';

    // ---------------------------------------------------------------- data
    var M = null;
    function raw() { return (typeof vdata !== 'undefined' && vdata.public) || null; }
    // the server says what each video is (movie / clip / extra); older servers did not, so fall back to the old guess
    function vtype(v) { return v.type || ((v.year || v.collection) ? 'movie' : 'clip'); }
    function isMovie(v) { return v.kind !== 'series' && vtype(v) === 'movie'; }
    function model() {
        var d = raw(); if (!d) return null;
        if (M && M.src === d) return M;
        var loose = d.loose || [], series = (d.all_series || []).filter(function (s) { return !s.extras; }), colls = d.collections || [];
        var names = (d.genres || []).map(function (g) { return g.name; }), by = {}, unsorted = [];
        function slot(n) { return by[n] || (by[n] = { name: n, videos: [], series: [] }); }
        names.forEach(slot);
        loose.forEach(function (v) { if (v.genre) slot(v.genre).videos.push(v); else if (!v.collection) unsorted.push(v); });
        (d.all_series || []).forEach(function (s) { if (s.genre) slot(s.genre).series.push(s); });    // folders keep their extras; only the Series tab leaves them out
        var folders = Object.keys(by).sort(nat).map(function (n) {
            var f = by[n]; f.items = f.series.concat(f.videos); f.items.sort(function (a, b) { return nat(a.title, b.title); });
            f.count = f.items.length; return f;
        });
        var eps = series.reduce(function (a, s) { return a + (s.episodes || 0); }, 0);
        var byId = {}; loose.forEach(function (v) { byId[v.id] = v; });
        // a folder is a movie shelf when most of what is in it is movies (Action, Drama ...), otherwise a clip shelf (Animation, Memes ...)
        function share(f, t) { var n = f.videos.filter(function (v) { return vtype(v) === t; }).length; return f.videos.length && n * 2 >= f.videos.length; }
        var movieShelves = folders.filter(function (f) { return share(f, 'movie'); }), clipShelves = folders.filter(function (f) { return share(f, 'clip'); });
        // "Fuelled - Animated Short Film 2021" has a year but lives with the clips: it is a clip
        var clipFolder = {}; clipShelves.forEach(function (f) { clipFolder[f.name] = 1; });
        loose.forEach(function (v) { if (v.type === 'movie' && clipFolder[v.genre] && !v.collection && !v.place) v.type = 'clip'; });
        movieShelves = genreShelves(movieShelves, loose);
        var movies = loose.filter(isMovie), clips = loose.filter(function (v) { return vtype(v) === 'clip'; });
        M = { src: d, loose: loose, series: series, colls: colls, folders: folders, by: by, unsorted: unsorted, all: loose.concat(series), eps: eps,
              singles: movies.filter(function (v) { return !v.collection; }), byId: byId, movies: movies, clips: clips,
              movieShelves: movieShelves, clipShelves: clipShelves };
        return M;
    }
    // Smart genres: a movie lying in a pile ("Movies") sits on the shelf of the genre found online (v.place, set by the server).
    // Only the shelves move it: the Folders tab still shows the folder the file is really in.
    function genreShelves(shelves, loose) {
        var by = {}, out = [];
        function get(n) { if (!by[n]) { by[n] = { name: n, videos: [] }; out.push(by[n]); } return by[n]; }
        shelves.forEach(function (f) { get(f.name).videos = f.videos.filter(function (v) { return !v.place; }); });
        loose.forEach(function (v) { if (v.place && isMovie(v)) get(v.place).videos.push(v); });
        return out.filter(function (f) { return f.videos.length; }).sort(function (a, b) { return nat(a.name, b.name); });
    }
    function folderIndex(name) { var g = (raw() && raw().genres) || []; for (var i = 0; i < g.length; i++) if (g[i].name === name) return i; return -1; }

    // ---------------------------------------------------------------- filtering / sorting
    function seenOk(v) {
        if (S.seen === 'all') return true;
        if (S.seen === 'fav') return v.kind === 'collection' ? favHas('collection', v.coll.name) : favHas(v.kind === 'series' ? 'series' : 'video', v.id);
        if (v.kind === 'collection') {
            if (S.seen === 'new') return !v.started && !v.progress;
            if (S.seen === 'going') return (v.started && !v.done) || !!v.progress;
            return v.done;
        }
        var done = v.kind === 'series' ? (v.watched >= v.episodes && v.episodes > 0) : v.view_count > 0;
        var going = v.kind === 'series' ? (v.watched > 0 && v.watched < v.episodes) : (v.progress > 0);
        if (S.seen === 'new') return !done && !going;
        if (S.seen === 'going') return going;
        return done;
    }
    // Smart genres: genres found online (kept in the database, never in your files)
    function agOk(v) {
        if (!S.ag) return true;
        if (v.kind === 'collection') return v.coll.items.some(function (x) { return (x.agenres || []).indexOf(S.ag) >= 0; });
        return (v.agenres || []).indexOf(S.ag) >= 0;
    }
    function agList(m) {
        var n = {};
        m.loose.concat(m.series).forEach(function (v) { (v.agenres || []).forEach(function (g) { n[g] = (n[g] || 0) + 1; }); });
        return Object.keys(n).sort(function (a, b) { return n[b] - n[a] || nat(a, b); }).map(function (g) { return [g, g + ' (' + n[g] + ')']; });
    }
    function typeOk(v) {
        if (S.type === 'all') return true;
        if (S.type === 'series') return v.kind === 'series';
        if (S.type === 'movies') return isMovie(v);
        return v.kind !== 'series' && !isMovie(v);
    }
    function rng(seed) { var s = seed || 1; return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
    function sorted(list) {
        var a = list.slice(), k = S.sort;
        if (k === 'shuffle') { var r = rng(S.seed); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
        var cmp = {
            title: function (x, y) { return nat(x.title, y.title); },
            title_d: function (x, y) { return nat(y.title, x.title); },
            added: function (x, y) { return (y.added || 0) - (x.added || 0) || nat(x.title, y.title); },
            year_d: function (x, y) { return (y.year || 0) - (x.year || 0) || nat(x.title, y.title); },
            year_a: function (x, y) { return (x.year || 9999) - (y.year || 9999) || nat(x.title, y.title); },
            views: function (x, y) { return (y.view_count || y.watched || 0) - (x.view_count || x.watched || 0) || nat(x.title, y.title); },
            rating: function (x, y) { return (y.avg_rating || 0) - (x.avg_rating || 0) || nat(x.title, y.title); }
        }[k] || function (x, y) { return nat(x.title, y.title); };
        return a.sort(cmp);
    }
    function applyFilters(list, o) {
        o = o || {};
        return sorted(list.filter(function (v) {
            if (!o.noType && !typeOk(v)) return false;
            if (!seenOk(v)) return false;
            if (!agOk(v)) return false;
            if (!o.noFolder && S.folder) { if (S.folder === UNSORTED ? (v.genre || v.collection || v.kind === 'series') : v.genre !== S.folder) return false; }
            if (o.chip && S.chip && (v.place || v.genre) !== S.chip) return false;
            return true;
        }));
    }
    function letterOf(t) { var c = String(t || '').trim().charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; }

    // ---------------------------------------------------------------- small html pieces
    function cards(items) { return cardsHtml(items, 'public'); }
    function yearSpan(items) {
        var ys = items.map(function (v) { return v.year; }).filter(Boolean).sort();
        if (!ys.length) return '';
        return ys[0] === ys[ys.length - 1] ? String(ys[0]) : ys[0] + '\u2013' + ys[ys.length - 1];
    }
    var LOGY = { 1: 'Single', 2: 'Duology', 3: 'Trilogy', 4: 'Quadrilogy', 5: 'Pentalogy', 6: 'Hexalogy', 7: 'Heptalogy', 8: 'Octalogy', 9: 'Nonalogy', 10: 'Decalogy' };
    function collKind(n) { return LOGY[n] || 'Collection'; }
    function tileSrc(v) { return String(v.poster || '').replace('/seriesart/', '/seriestile/').replace('/poster/', '/tile/'); }
    function collStats(c) { var w = c.items.filter(function (v) { return v.view_count > 0; }).length; return { watched: w, total: c.items.length }; }
    function collNext(c) {
        var going = c.items.filter(function (v) { return v.progress > 0; });
        if (going.length) return { v: going[0], label: 'Resume' };
        var fresh = c.items.filter(function (v) { return !v.view_count; });
        var st = collStats(c);
        if (fresh.length && st.watched) return { v: fresh[0], label: 'Play next' };
        if (fresh.length) return { v: fresh[0], label: 'Play first' };
        return { v: c.items[0], label: 'Watch again' };
    }
    function collCard(c) {
        // square cover like Music albums: one picture for 1-3 films, a 2x2 mosaic from 4 films up
        var st = collStats(c), its = c.items, cover;
        if (its.length >= 4) cover = '<div class="ut-mos">' + its.slice(0, 4).map(function (v) { return '<img src="' + esc(tileSrc(v)) + '" alt="" loading="lazy">'; }).join('') + '</div>';
        else cover = its.length ? '<img src="' + esc(tileSrc(its[0])) + '" alt="" loading="lazy">' : '<span class="ut-ph"><i class="fas fa-film"></i></span>';
        var ys = yearSpan(its);
        return '<div class="ubh-coll utile ut-coll group" data-coll="' + esc(c.name) + '" tabindex="0" role="button" title="Open ' + esc(c.name) + (st.watched ? ' (' + st.watched + ' of ' + st.total + ' watched)' : '') + '">' +
            '<div class="ut-cover">' + cover +
            (st.watched ? '<div class="ut-prog"><i style="width:' + Math.round(st.watched / st.total * 100) + '%"></i></div>' : '') +
            '<button class="ut-img" data-tk="collection" data-tkey="' + esc(c.name) + '" title="Thumbnail"><i class="far fa-image"></i></button>' +
            '</div>' +
            '<div class="ut-title">' + esc(c.name) + '</div>' +
            // "Trilogy · 2002–2007": the kind already says how many films, so only big sets spell the number out
            '<div class="ut-sub">' + (LOGY[c.count] ? esc(collKind(c.count)) : plural(c.count, 'film')) + (ys ? ' &middot; ' + ys : '') + (st.watched === st.total ? ' &middot; Seen' : '') + '</div>' +
            '</div>';
    }
    function folderCard(f, unsorted) {
        // 4+ items: a 2x2 mosaic; fewer: one picture over the whole tile (no grey placeholder cells)
        var items = f.items, cells = '';
        if (items.length >= 4) for (var i = 0; i < 4; i++) cells += '<img src="' + esc(tileSrc(items[i])) + '" alt="" loading="lazy">';
        else if (items.length) cells = '<img class="solo" src="' + esc(tileSrc(items[0])) + '" alt="" loading="lazy">';
        var bits = [], vids = unsorted ? f.items.length : f.videos.length, ser = unsorted ? 0 : f.series.length;
        if (vids) bits.push(plural(vids, 'video'));
        if (ser) bits.push(plural(ser, 'series', 'series'));
        return '<div class="ubh-folder' + (unsorted ? ' un' : '') + '" data-folder="' + esc(unsorted ? UNSORTED : f.name) + '" tabindex="0" role="button" title="Open ' + esc(unsorted ? 'Unsorted' : f.name) + '">' +
            '<div class="ubh-mos' + (items.length ? '' : ' empty') + '">' + (items.length ? cells : '<span class="solo"><i class="far fa-folder-open"></i></span>') + '</div>' +
            '<div class="ubh-ct">' + (unsorted ? 'Unsorted' : esc(f.name)) + '</div>' +
            '<div class="ubh-cm">' + (bits.join(' &middot; ') || 'Empty') + (unsorted ? ' &middot; no folder yet' : '') + '</div></div>';
    }
    function link(act, label, extra) { return '<button class="ubh-link" data-act="' + act + '" ' + (extra || '') + '>' + label + '</button>'; }
    function empty(icon, title, text, btns) {
        return '<div class="ubh-empty"><i class="' + icon + '"></i><div class="t">' + title + '</div><div class="x">' + text + '</div>' + (btns ? '<div class="b">' + btns + '</div>' : '') + '</div>';
    }
    function row(id, title, extra, items, body) {
        return sectionHtml(id, title, extra, false, body || cards(items));
    }
    function seeAllTile(attr, n) { return '<div class="ubh-seeall" ' + attr + ' tabindex="0" role="button"><i class="fas fa-arrow-right"></i><span>See all ' + n + '</span></div>'; }

    // ---------------------------------------------------------------- hero (overview)
    function heroHtml(f, label) {
        var meta = [];
        if (f.year) meta.push(f.year);
        if (f.genre) meta.push(esc(f.genre));
        if (f.collection) meta.push(esc(f.collection)); else if (f.series) meta.push(esc(f.series));
        meta.push(f.progress ? Math.round(f.progress * 100) + '% watched' : f.view_count ? 'Watched' : 'Not watched yet');
        if (f.avg_rating != null) meta.push('&#9733; ' + f.avg_rating);
        return '<section class="hero-sec ubh-hero" onmouseenter="heroEnter(this, \'' + f.id + '\', \'public\')" onmouseleave="heroStop()">' +
            '<div class="ubh-hbg" style="background-image:url(\'' + esc(f.poster) + '\')"></div>' +
            '<img class="ubh-himg" src="' + esc(f.backdrop) + '" alt="" onerror="this.remove()">' +
            '<div class="hero-shade ubh-shade"></div>' +
            '<div class="ubh-hbody"><div class="ubh-htxt">' +
            '<div class="text-accent ubh-hlab"><span></span>' + esc(label) + '</div>' +
            '<h2 class="ubh-htitle" data-title-id="' + f.id + '">' + esc(f.title) + '</h2>' +
            '<div class="ubh-hmeta">' + meta.join('<i>&middot;</i>') + '</div>' +
            '<div class="ubh-hbtns"><button onclick="playVideo(\'' + f.id + '\')"><i class="fas fa-play"></i> ' + (f.progress ? 'Resume' : 'Play') + '</button>' +
            '<button data-act="roulette"><i class="fas fa-dice"></i> Roulette</button>' +
            '<button onclick="editTitle(event, \'' + f.id + '\')" title="Rename"><i class="fas fa-pen"></i></button></div></div></div></section>';
    }
    function pickHero(m) {
        var d = m.src, c = (d.continue || [])[0];
        if (c) return { f: c, label: c.series ? 'Continue watching \u2022 ' + c.series : 'Continue watching' };
        var f = d.featured || m.loose[0];
        if (!f) return null;
        return { f: f, label: f.view_count ? 'Watch again' : 'New for you' };
    }

    // ---------------------------------------------------------------- the five tabs
    // Home: one banner, then shelves. Movies first (continue, new, collections, one shelf per genre), then series, then clips.
    function shuffled(list, seed) { var a = list.slice(), r = rng(seed); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    function viewHome(m) {
        if (!m.all.length && !m.folders.length) return noLibrary();
        var out = '', h = pickHero(m), d = m.src;
        if (h) out += heroHtml(h.f, h.label);
        out += '<div class="ubh-pad ubh-shelves">';
        var ids = [];
        function add(id, title, extra, body) { ids.push(id); out += row(id, title, extra, null, body); }
        function more(tab, chip, n) { return link('see', 'See all' + (n ? ' ' + n : ''), 'data-tab="' + tab + '" data-chip="' + esc(chip || '') + '"'); }
        if ((d.continue || []).length) add('ubh-r-cont', 'Continue Watching', '', cards(d.continue));
        var recent = (d.recent || []).filter(function (v) { return v.kind === 'series' ? !v.extras : vtype(v) !== 'extra'; });
        if (recent.length) add('ubh-r-recent', 'Recently Added', '', cards(recent));
        if (m.colls.length) add('ubh-r-coll', 'Collections', more('collections', '', m.colls.length), m.colls.slice(0, ROW_MAX).map(collCard).join(''));
        m.movieShelves.forEach(function (f, i) {
            var mv = f.videos.filter(isMovie);
            if (!mv.length) return;
            add('ubh-r-g' + i, f.name, more('movies', f.name, mv.length), mTiles(shuffled(mv, i + 7).slice(0, ROW_MAX)));
        });
        if (m.series.length) add('ubh-r-ser', 'Series', more('series', '', m.series.length), cards(sorted(m.series).slice(0, ROW_MAX)));
        var movieRow = {}; m.movieShelves.forEach(function (f) { movieRow[f.name] = 1; });
        m.clipShelves.forEach(function (f, i) {
            var cl = f.videos.filter(function (v) { return vtype(v) === 'clip'; });
            if (!cl.length) return;
            // movies found online can join a clip folder's name (Animation): then this row says it holds the clips
            add('ubh-r-c' + i, movieRow[f.name] ? f.name + ' clips' : f.name, more('clips', f.name, cl.length), clipTiles(cl.slice(0, ROW_MAX)));
        });
        out += '</div>';
        S._ids = ids;
        return out;
    }
    function collKindLine(m) {
        var t = m.colls.filter(function (c) { return c.count === 3; }).length;
        return plural(m.colls.length, 'collection') + (t ? ' &middot; ' + plural(t, 'trilogy', 'trilogies') : '');
    }
    function noLibrary() {
        return '<div class="ubh-pad">' + empty('fas fa-clapperboard', 'Nothing here yet',
            'Put movies and videos in <b>media/videos</b> and press the refresh icon in the menu. Files that share the start of their name become a collection (a trilogy, a franchise); folders you make become shelves.',
            '<button class="ubh-btn pri" data-act="newfolder"><i class="fas fa-folder-plus"></i> New folder</button><button class="ubh-btn" data-act="openfolder"><i class="fas fa-folder-open"></i> Open videos folder</button>') + '</div>';
    }

    function tilesFor(items) { return S.tile ? S.tile(items) : cards(items); }
    function gridBody(list, emptyMsg) {
        S.list = list; S.shown = Math.min(S.shown, list.length) || CHUNK;
        if (!list.length) return emptyMsg;
        return '<div class="vgrid ubh-grid" id="ubh-grid">' + tilesFor(list.slice(0, S.shown)) + '</div><div id="ubh-more" class="ubh-more"></div>';
    }
    function moreBtn() {
        var el = $('ubh-more'); if (!el) return;
        var left = S.list.length - S.shown;
        el.innerHTML = left > 0 ? '<button class="ubh-btn" data-act="more">Show ' + Math.min(CHUNK, left) + ' more <span>' + left + ' left</span></button>' : '';
    }
    function appendMore(n) {
        var g = $('ubh-grid'); if (!g || S.shown >= S.list.length) return;
        var to = Math.min(S.list.length, n || S.shown + CHUNK);
        g.insertAdjacentHTML('beforeend', tilesFor(S.list.slice(S.shown, to)));
        S.shown = to; moreBtn(); markSel();
    }
    var NOMATCH = function () { return empty('far fa-folder-open', 'Nothing matches', 'Try another filter, or clear them.', '<button class="ubh-btn" data-act="reset"><i class="fas fa-rotate-left"></i> Clear filters</button>'); };
    function viewMovies(m) {
        var list = applyFilters(m.movies, { noType: true, noFolder: true, chip: true });
        S.tile = mTiles; S.shown = CHUNK;
        return '<div class="ubh-pad">' + gridBody(list, m.movies.length ? NOMATCH()
            : empty('fas fa-film', 'No movies yet', 'A video counts as a movie when its file name has a year, like <b>Dune (2021).mkv</b>.')) + '</div>';
    }
    function viewClips(m) {
        var list = applyFilters(m.clips, { noType: true, noFolder: true, chip: true });
        S.tile = clipTiles; S.shown = CHUNK;
        return '<div class="ubh-pad">' + gridBody(list, m.clips.length ? NOMATCH()
            : empty('fas fa-photo-film', 'No clips', 'Shorts, memes and other videos without a year in their name show up here.')) + '</div>';
    }
    function viewSeries(m) {
        var list = applyFilters(m.series, { noType: true });
        S.shown = CHUNK;
        var html = gridBody(list, m.series.length
            ? empty('far fa-folder-open', 'No series match', 'Try another filter.', '<button class="ubh-btn" data-act="reset"><i class="fas fa-rotate-left"></i> Clear filters</button>')
            : empty('fas fa-layer-group', 'No series yet', 'A series is a group of episodes shown as one card. Name files like <b>Show.S01E02.mkv</b>, put episodes in a sub-folder of a folder, or press New series.',
                '<button class="ubh-btn pri" data-act="newseries"><i class="fas fa-plus"></i> New series</button>'));
        return '<div class="ubh-pad">' + html + '</div>';
    }
    // ---- Collections: the main page. Same layout as Music > Albums: heading, three chips (Collections / Singles / All), a grid with the name and a small grey line under each
    function collItem(c) {
        var it = c.items, w = it.filter(function (v) { return v.view_count > 0; }).length, rated = it.filter(function (v) { return v.avg_rating != null; });
        var ys = it.map(function (v) { return v.year; }).filter(Boolean);
        return { kind: 'collection', id: 'c:' + c.name, title: c.name, coll: c, count: c.count, started: w > 0, done: w === it.length && it.length > 0,
                 progress: it.some(function (v) { return v.progress > 0; }) ? 1 : 0, year: ys.length ? Math.min.apply(null, ys) : 0,
                 added: Math.max.apply(null, it.map(function (v) { return v.added || 0; }).concat([0])),
                 view_count: it.reduce(function (a, v) { return a + (v.view_count || 0); }, 0),
                 avg_rating: rated.length ? rated.reduce(function (a, v) { return a + v.avg_rating; }, 0) / rated.length : null };
    }
    // the tile already carries its own title and small line; only swap the small line, never add a second title
    function subTile(v, bits) {
        var tile = cards([v]).replace(/<div class="ut-sub">[\s\S]*?<\/div>/, '<div class="ut-sub">' + bits.filter(Boolean).map(esc).join(' &middot; ') + '</div>');
        return '<div class="ubh-st">' + tile + '</div>';
    }
    function singleTile(v) {       // "2019 · Action · Watched"
        return subTile(v, [v.year || '', v.place || v.genre || v.collection || '', v.view_count ? 'Seen' : '']);
    }
    function clipTiles(items) { return items.map(function (v) { return subTile(v, [v.genre || 'Clip', v.view_count ? 'Watched' : '']); }).join(''); }
    function mTiles(items) { return items.map(function (x) { return x.kind === 'collection' ? collCard(x.coll) : x.kind === 'series' ? cards([x]) : singleTile(x); }).join(''); }
    function favHas(kind, key) { return !!(window.utFav && window.utFav.has(kind, key)); }
    function favItems(m) {                        // hearted collections, movies and series, in one list
        return m.colls.filter(function (c) { return favHas('collection', c.name); }).map(collItem)
            .concat(m.loose.filter(function (v) { return favHas('video', v.id); }))
            .concat(m.series.filter(function (s) { return favHas('series', s.id); }));
    }
    function viewCollections(m) {
        if (!m.all.length && !m.folders.length) return noLibrary();
        var list = applyFilters(m.colls.map(collItem), { noType: true, noFolder: true });
        S.tile = mTiles; S.shown = CHUNK;
        var msg = m.colls.length ? NOMATCH()
            : empty('fas fa-layer-group', 'No collections yet', 'Movies whose names start the same become a collection on their own (Spider-Man, Spider-Man 2 ...). Or press <b>Add movies</b> and build one yourself.', '<button class="ubh-btn pri" data-act="addmovies"><i class="fas fa-plus"></i> Add movies</button>');
        return '<div class="ubh-pad">' + gridBody(list, msg) + '</div>';
    }
    function viewFolders(m) {
        var tiles = '';
        if (m.unsorted.length) tiles += folderCard({ items: sorted(m.unsorted), videos: m.unsorted, series: [] }, true);
        m.folders.forEach(function (f) { tiles += folderCard(f); });
        tiles += '<div class="ubh-folder add" data-act="newfolder" tabindex="0" role="button"><div class="ubh-mos plus"><span class="solo"><i class="fas fa-plus"></i></span></div><div class="ubh-ct">New folder</div><div class="ubh-cm">Independent, Anime, Family ...</div></div>';
        return '<div class="ubh-pad"><div class="ubh-gridf">' + tiles + '</div></div>';
    }

    // ---------------------------------------------------------------- pages inside the page
    function pageHead(o) {
        var bd = o.art ? '<img class="ubh-himg" src="' + esc(o.art) + '" alt="" onerror="this.remove()">' : '';
        return '<section class="hero-sec ubh-ph"><div class="ubh-hbg" style="background-image:url(\'' + esc(o.poster || '') + '\')"></div>' + bd + '<div class="ubh-shade"></div>' +
            '<div class="ubh-phb"><button class="ubh-back" data-act="back"><i class="fas fa-arrow-left"></i> ' + esc(o.back) + '</button>' +
            '<div class="ubh-hlab text-accent"><span></span>' + esc(o.eyebrow) + '</div>' +
            '<h2 class="ubh-htitle">' + esc(o.title) + '</h2><div class="ubh-hmeta">' + o.meta + '</div>' +
            '<div class="ubh-hbtns">' + o.btns + '</div></div></section>';
    }
    function viewCollection(m) {
        var c = m.colls.filter(function (x) { return x.name === S.open.k; })[0];
        if (!c) { S.open = null; return viewCollections(m); }
        var st = collStats(c), nx = collNext(c), ys = yearSpan(c.items);
        var meta = [esc(collKind(c.count)), plural(c.count, 'film')]; if (ys) meta.push(ys); meta.push(st.watched + ' of ' + st.total + ' watched');
        var body = c.items.map(function (v, i) { return '<div class="ubh-ord"><span class="ubh-n">' + (i < 9 ? '0' : '') + (i + 1) + '</span>' + cards([v]) + '</div>'; }).join('');
        return pageHead({ back: 'Collections', eyebrow: 'Collection', title: c.name, meta: meta.join('<i>&middot;</i>'),
            art: nx.v.backdrop, poster: nx.v.poster,
            btns: '<button onclick="playVideo(\'' + nx.v.id + '\')"><i class="fas fa-play"></i> ' + nx.label + (nx.label === 'Play next' || nx.label === 'Resume' ? ': ' + esc(nx.v.title) : '') + '</button>' +
                  '<button data-act="addmovies" data-k="' + esc(c.name) + '"><i class="fas fa-plus"></i> Add movies</button>' +
                  '<button data-act="renamecoll" data-k="' + esc(c.name) + '" title="Rename this collection"><i class="fas fa-pen"></i></button>' +
                  '<button data-act="selmode" title="Pick movies to take out of this collection"><i class="fas fa-check-double"></i> Select</button>' }) +
            '<div class="ubh-pad"><div class="vgrid ubh-grid ubh-ordered">' + body + '</div><p class="ubh-note">Nothing was moved on disk. The order follows the year in each file name. Use Select to take movies out.</p></div>';
    }
    function viewFolder(m) {
        var un = S.open.k === UNSORTED, f = un ? { name: 'Unsorted', items: m.unsorted, videos: m.unsorted, series: [], count: m.unsorted.length } : m.by[S.open.k] && m.folders.filter(function (x) { return x.name === S.open.k; })[0];
        if (!f) { S.open = null; return viewFolders(m); }
        var list = applyFilters(f.items, { noFolder: true });
        S.shown = CHUNK;
        var i = un ? -1 : folderIndex(f.name), first = f.items[0] || {};
        var meta = [plural(f.videos.length, 'video')]; if (f.series.length) meta.push(plural(f.series.length, 'series', 'series'));
        var btns = un
            ? '<button data-act="organize"><i class="fas fa-folder-tree"></i> Sort these into folders</button>'
            : '<button data-act="addvideos" data-i="' + i + '"><i class="fas fa-plus"></i> Add videos</button>' +
              '<button data-act="organize" data-genre="' + esc(f.name) + '" title="Move videos you already have into this folder"><i class="fas fa-folder-tree"></i> From library</button>' +
              '<button data-act="openfolderi" data-i="' + i + '" title="Open this folder on disk"><i class="fas fa-folder-open"></i></button>' +
              '<button data-act="delfolder" data-i="' + i + '" title="Delete this folder (only when it is empty)"><i class="fas fa-trash"></i></button>';
        var html = gridBody(list, f.count
            ? empty('far fa-folder-open', 'Nothing matches', 'Try another filter.', '<button class="ubh-btn" data-act="reset"><i class="fas fa-rotate-left"></i> Clear filters</button>')
            : empty('far fa-folder-open', 'This folder is empty', 'Press Add videos, or drop files into the folder. Put episodes inside a sub-folder to make a series.'));
        return pageHead({ back: 'Folders', eyebrow: un ? 'Videos with no folder and no collection' : 'Folder', title: f.name, meta: meta.join('<i>&middot;</i>'), art: first.backdrop, poster: first.poster, btns: btns }) +
            '<div class="ubh-pad">' + html + '</div>';
    }

    // ---------------------------------------------------------------- search
    function tokens(q) { return q.toLowerCase().split(/\s+/).filter(Boolean); }
    function hit(text, tk) { text = text.toLowerCase(); return tk.every(function (t) { return text.indexOf(t) >= 0; }); }
    function viewSearch(m) {
        var tk = tokens(S.q), lq = S.q.toLowerCase();
        function rank(a, b) { var A = a.title.toLowerCase().indexOf(lq) === 0 ? 0 : 1, B = b.title.toLowerCase().indexOf(lq) === 0 ? 0 : 1; return A - B || nat(a.title, b.title); }
        var cs = m.colls.filter(function (c) { return hit(c.name + ' ' + c.items.map(function (v) { return v.title; }).join(' '), tk); });
        var fs = m.folders.filter(function (f) { return hit(f.name, tk); });
        var ss = m.series.filter(function (s) { return hit(s.title + ' ' + (s.genre || ''), tk); }).sort(rank);
        var vs = m.loose.filter(function (v) { return hit(v.title + ' ' + (v.collection || '') + ' ' + (v.genre || '') + ' ' + (v.place || ''), tk); }).sort(rank);
        var n = cs.length + fs.length + ss.length + vs.length, out = '<div class="ubh-pad"><div class="ubh-rcount">' + plural(n, 'result') + ' for <b>' + esc(S.q) + '</b></div>';
        if (!n) return out + empty('fas fa-magnifying-glass', 'No results', 'Nothing matches &ldquo;' + esc(S.q) + '&rdquo;. Try fewer letters.', '<button class="ubh-btn" data-act="clearq">Clear search</button>') + '</div>';
        if (cs.length) out += '<h3 class="ubh-gh">Collections</h3><div class="ubh-gridc">' + cs.map(collCard).join('') + '</div>';
        if (fs.length) out += '<h3 class="ubh-gh">Folders</h3><div class="ubh-gridf">' + fs.map(function (f) { return folderCard(f); }).join('') + '</div>';
        if (ss.length) out += '<h3 class="ubh-gh">Series</h3><div class="vgrid ubh-grid">' + cards(ss.slice(0, 48)) + '</div>';
        if (vs.length) { S.shown = CHUNK; S.list = vs; out += '<h3 class="ubh-gh">Videos <span>' + vs.length + '</span></h3><div class="vgrid ubh-grid" id="ubh-grid">' + cards(vs.slice(0, S.shown)) + '</div><div id="ubh-more" class="ubh-more"></div>'; }
        return out + '</div>';
    }

    // ---------------------------------------------------------------- header + filters
    function build() {
        var host = $('video-view'); if (!host) return;
        host.innerHTML =
            '<div class="ubh" id="ubh">' +
            '<header class="ubh-head" id="ubh-head">' +
            // one row: title, tabs, then search and icon tools on the right
            '<div class="ubh-top"><div class="ubh-ttl"><h1>Cinema</h1></div><nav class="ubh-tabs" id="ubh-tabs" role="tablist"></nav>' +
            '<div class="ubh-tools"><div class="ubh-search"><i class="fas fa-magnifying-glass"></i><input id="ubh-q" autocomplete="off" spellcheck="false" placeholder="Search movies, series, clips" aria-label="Search the library"><kbd>/</kbd><button class="ubh-x" data-act="clearq" aria-label="Clear search"><i class="fas fa-xmark"></i></button></div>' +
            '<button class="ubh-ib" data-act="surprise" title="Surprise me: play something at random" aria-label="Surprise me"><i class="fas fa-shuffle"></i></button>' +
            '<button class="ubh-ib" data-act="roulette" title="Movie night roulette" aria-label="Roulette"><i class="fas fa-dice"></i></button>' +
            '<button class="ubh-ib" data-act="selmode" id="ubh-selbtn" title="Select movies: add them to a collection or take them out" aria-label="Select"><i class="fas fa-check-double"></i></button>' +
            '<button class="ubh-ib" data-act="manage" title="Manage: new folder, organize, new series" aria-label="Manage"><i class="fas fa-ellipsis"></i></button></div></div>' +
            '<div class="ubh-filters" id="ubh-filters"></div></header>' +
            '<div id="ubh-body" class="ubh-skel"><div class="ubh-pad"><div class="vgrid ubh-grid">' + skeleton() + '</div></div></div></div>';
        $('ubh-q').addEventListener('input', function () { S.q = this.value.trim(); S.shown = CHUNK; paint(false); });
        $('ubh-q').addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.stopPropagation(); if (this.value) { clearQ(); } else this.blur(); }
        });
        var old = $('ubh-az'); if (old) old.remove();
        var az = document.createElement('div'); az.id = 'ubh-az'; az.setAttribute('aria-label', 'Jump to letter'); document.body.appendChild(az);
        var oldSb = $('ubh-selbar'); if (oldSb) oldSb.remove();
        var sbar = document.createElement('div'); sbar.id = 'ubh-selbar'; document.body.appendChild(sbar);
        sizeVar(); flagOn();
    }
    function flagOn() { document.body.classList.toggle('ubh-on', typeof currentView !== 'undefined' && currentView === 'video-view'); }
    function sel(k, label, opts, cur) {
        return '<label class="ubh-sel"><span>' + label + '</span><select data-k="' + k + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(cur) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
    }
    function seg(k, opts, cur) {
        return '<div class="ubh-seg" data-k="' + k + '">' + opts.map(function (o) { return '<button data-v="' + o[0] + '" class="' + (cur === o[0] ? 'on' : '') + '">' + o[1] + '</button>'; }).join('') + '</div>';
    }
    function gridView() { return !S.q && !S.open ? ['movies', 'clips', 'series', 'collections'].indexOf(S.tab) >= 0 : (!S.q && S.open && S.open.t === 'folder'); }
    // the genre / folder chips above the Movies and Clips grids
    function chipRow(shelves, test, total) {
        var rows = shelves.map(function (f) { return [f.name, f.name, f.videos.filter(test).length]; }).filter(function (x) { return x[2]; });
        if (S.chip && !rows.some(function (x) { return x[0] === S.chip; })) S.chip = '';
        if (rows.length < 2) return '';
        return '<div class="ubh-chiprow" role="tablist">' + [['', 'All', total]].concat(rows).map(function (x) {
            return '<button class="ubh-chip' + (S.chip === x[0] ? ' on' : '') + '" data-chipv="' + esc(x[0]) + '">' + esc(x[1]) + '<b>' + x[2] + '</b></button>';
        }).join('') + '</div>';
    }
    function paintHead(m) {
        var d = m || model();
        var counts = { home: '', movies: d ? d.movies.length : '', collections: d ? d.colls.length : '', series: d ? d.series.length : '',
                       clips: d ? d.clips.length : '', folders: d ? d.folders.length + (d.unsorted.length ? 1 : 0) : '' };
        var active = S.q ? '' : (S.open ? (S.open.t === 'collection' ? 'collections' : 'folders') : S.tab);
        $('ubh-tabs').innerHTML = TABS.map(function (t) {
            if (counts[t[0]] === 0 && t[0] !== 'home' && t[0] !== 'folders') return '';          // no clips at all: no Clips tab
            return '<button role="tab" data-tab="' + t[0] + '" class="' + (active === t[0] ? 'on' : '') + '">' + t[1] + (counts[t[0]] !== '' ? '<b>' + counts[t[0]] + '</b>' : '') + '</button>';
        }).join('');
        var f = $('ubh-filters'), show = d && gridView();
        f.classList.toggle('off', !show);
        if (!show) { f.innerHTML = ''; return; }
        var inFolder = S.open && S.open.t === 'folder', parts = [], chips = '';
        if (!inFolder && S.tab === 'movies') chips = chipRow(d.movieShelves, isMovie, d.movies.length);
        if (!inFolder && S.tab === 'clips') chips = chipRow(d.clipShelves, function (v) { return vtype(v) === 'clip'; }, d.clips.length);
        if (inFolder) parts.push(seg('type', [['all', 'All'], ['movies', 'Movies'], ['series', 'Series'], ['videos', 'Clips']], S.type));
        if (S.tab !== 'clips' || inFolder) parts.push(sel('seen', 'Show', [['all', 'Everything'], ['new', 'Not watched'], ['going', 'In progress'], ['done', 'Watched'], ['fav', 'Favorites']], S.seen));
        parts.push(sel('sort', 'Sort', SORTS, S.sort));
        if (S.sort === 'shuffle') parts.push('<button class="ubh-ib sm" data-act="reshuffle" title="Shuffle again" aria-label="Shuffle again"><i class="fas fa-shuffle"></i></button>');
        if (S.tab === 'collections' && !inFolder) {
            parts.push('<button class="ubh-btn sm" data-act="addmovies" title="Put movies into a collection (new or existing)"><i class="fas fa-plus"></i><span>Add movies</span></button>');
            if (d.src.overrides) parts.push('<button class="ubh-link" data-act="resetcoll" title="Forget every collection change you made by hand">Automatic sorting</button>');
        }
        parts.push('<span class="ubh-cnt" id="ubh-cnt"></span>');
        parts.push('<label class="ubh-size" title="Tile size"><i class="fas fa-border-all"></i><input type="range" min="1" max="4" step="1" value="' + S.size + '" data-k="size" aria-label="Tile size"><i class="fas fa-square"></i></label>');
        f.innerHTML = chips + '<div class="ubh-frow">' + parts.join('') + '</div>';
    }
    function paintCount() {
        var c = $('ubh-cnt'); if (c) c.textContent = plural(S.list.length, 'title');
        var az = $('ubh-az'); if (!az) return;
        var on = gridView() && (S.sort === 'title' || S.sort === 'title_d') && S.list.length >= 40;
        az.classList.toggle('has', on);
        if (!on) { az.innerHTML = ''; return; }
        var seen = {}, order = [];
        S.list.forEach(function (v) { var l = letterOf(v.title); if (!seen[l]) { seen[l] = 1; order.push(l); } });
        az.innerHTML = order.map(function (l) { return '<button data-az="' + l + '">' + l + '</button>'; }).join('');
    }
    function skeleton() { var s = ''; for (var i = 0; i < 12; i++) s += '<div class="skeleton vcard aspect-square rounded-md"></div>'; return s; }
    function sizeVar() {
        var w = { 1: '8.4rem', 2: '11.5rem', 3: '14rem', 4: '17rem' }[S.size] || '11.5rem';
        var v = $('video-view'); if (v) v.style.setProperty('--ubh-w', w);
    }

    // ---------------------------------------------------------------- paint
    var io = null;
    function paint(keepScroll) {
        var body = $('ubh-body'); if (!body) return;
        var m = model();
        if (!m) return;
        var y = getY();
        var html;
        S.tile = null;
        if (S.q) html = viewSearch(m);
        else if (S.open) html = S.open.t === 'collection' ? viewCollection(m) : viewFolder(m);
        else html = ({ home: viewHome, movies: viewMovies, clips: viewClips, collections: viewCollections, series: viewSeries, folders: viewFolders }[S.tab] || viewHome)(m);
        body.classList.remove('ubh-skel');
        body.innerHTML = html;
        paintHead(m);
        paintCount(); moreBtn(); markSel(); selBar();
        var sb = document.querySelector('.ubh-search'); if (sb) sb.classList.toggle('has', !!S.q);
        (S._ids || []).forEach(function (id) { try { updateArrows(id); } catch (e) {} });
        if (S.tab !== 'home' || S.q || S.open) S._ids = [];
        watchMore();
        if (keepScroll) setY(y);
    }
    function watchMore() {
        if (io) { io.disconnect(); io = null; }
        var more = $('ubh-more'); if (!more || !('IntersectionObserver' in window)) return;
        io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) appendMore(); }, { rootMargin: '900px 0px' });
        io.observe(more);
    }
    function go(tab, open, chip) {
        if (S.q) { S.q = ''; var q = $('ubh-q'); if (q) q.value = ''; }
        tab = OLD_TABS[tab] || tab;
        if (tab !== S.tab || chip != null) S.chip = chip || '';
        S.tab = tab; S.open = open || null; S.back = 0;
        LS.set('ubh_tab', tab);
        S.shown = CHUNK;
        paint(false);
        setY(0);
    }
    function goBack() {
        if (S.q) { clearQ(); return; }
        if (!S.open) return;
        var t = S.open.t === 'collection' ? 'collections' : 'folders', y = S.back;
        S.open = null; S.tab = t; S.shown = CHUNK; paint(false);
        setY(y || 0); S.back = 0;
    }
    function clearQ() { S.q = ''; var q = $('ubh-q'); if (q) { q.value = ''; } paint(false); }
    function openColl(name) { S.back = getY(); S.open = { t: 'collection', k: name }; S.tab = 'collections'; paint(false); setY(0); }
    function openFolderPage(name) {
        if (S.q) { S.q = ''; var q = $('ubh-q'); if (q) q.value = ''; }
        S.back = getY(); S.open = { t: 'folder', k: name }; S.tab = 'folders'; S.folder = ''; S.type = 'all'; S.seen = 'all'; paint(false); setY(0);
    }

    // ---------------------------------------------------------------- events
    function onClick(e) {
        var t = e.target;
        var az = t.closest('[data-az]');
        if (az) { jumpLetter(az.dataset.az); return; }
        var ch = t.closest('[data-chipv]');
        if (ch) { S.chip = ch.dataset.chipv; S.shown = CHUNK; paint(false); return; }
        var tabB = t.closest('#ubh-tabs [data-tab]');
        if (tabB) { go(tabB.dataset.tab, null); return; }
        var sg = t.closest('.ubh-seg button');
        if (sg) { var k = sg.parentNode.dataset.k; S[k] = sg.dataset.v; LS.set('ubh_' + k, S[k]); S.shown = CHUNK; paint(false); return; }
        var a = t.closest('[data-act]');
        if (a) { act(a, e); return; }
        var c = t.closest('[data-coll]');
        if (c) { openColl(c.dataset.coll); return; }
        var f = t.closest('[data-folder]');
        if (f) { openFolderPage(f.dataset.folder); return; }
    }
    function jumpLetter(L) {
        var idx = -1;
        for (var i = 0; i < S.list.length; i++) if (letterOf(S.list[i].title) === L) { idx = i; break; }
        if (idx < 0) return;
        if (idx >= S.shown) appendMore(idx + CHUNK);
        var g = $('ubh-grid'), el = g && g.children[idx];
        if (el) { var off = ($('ubh-head') ? $('ubh-head').offsetHeight : 0) + 12; setY(el.getBoundingClientRect().top + getY() - off, true); }
    }
    function act(b, e) {
        var a = b.dataset.act, i = parseInt(b.dataset.i, 10);
        if (a === 'back') goBack();
        else if (a === 'tab') go(b.dataset.tab, null);
        else if (a === 'see') go(b.dataset.tab, null, b.dataset.chip || '');
        else if (a === 'folder') openFolderPage(b.dataset.folder);
        else if (a === 'clearq') { clearQ(); var q = $('ubh-q'); if (q) q.focus(); }
        else if (a === 'more') appendMore();
        else if (a === 'reset') { S.type = 'all'; S.seen = 'all'; S.folder = ''; S.chip = ''; paint(false); }
        else if (a === 'reshuffle') { S.seed = (S.seed * 7919 + 13) % 100003; S.shown = CHUNK; paint(true); }
        else if (a === 'roulette') { if (window.sxRoulette) window.sxRoulette('public'); }
        else if (a === 'surprise') surprise('public');
        else if (a === 'manage') openManage({ stopPropagation: function () {}, currentTarget: b }, 'public');
        else if (a === 'newfolder') openGenreModal('public');
        else if (a === 'newseries') openOrganize('public', { title: 'New series', focus: 'series' });
        else if (a === 'openfolder') openFolderOnDisk();
        else if (a === 'organize') openOrganize('public', b.dataset.genre ? { genre: b.dataset.genre, title: 'Add videos to ' + b.dataset.genre } : {});
        else if (a === 'addvideos') openAddGenre('public', i);
        else if (a === 'openfolderi') openFolderDisk(i);
        else if (a === 'delfolder') deleteGenre('public', i);
        else if (a === 'selmode') setSelMode(!S.selmode);
        else if (a === 'selclear') { S.sel = {}; markSel(); selBar(); }
        else if (a === 'selcoll') { if (selIds().length) { var ids = {}; selIds().forEach(function (x) { ids[x] = 1; }); dlgOpen({ mode: 'name', ids: ids }); } }
        else if (a === 'seltake') { var gone = selIds().filter(function (x) { var v = model().byId[x]; return v && v.collection; }); if (gone.length) collCall('/api/collections/remove', { ids: gone }, plural(gone.length, 'movie') + ' taken out of collections'); }
        else if (a === 'addmovies') dlgOpen({ mode: 'pick', target: b.dataset.k || '' });
        else if (a === 'renamecoll') {
            var cc = findColl(b.dataset.k), ids2 = {}; if (!cc) return;
            cc.items.forEach(function (v) { ids2[v.id] = 1; });
            dlgOpen({ mode: 'rename', ids: ids2, target: cc.name, old: cc.name });
        }
        else if (a === 'resetcoll') { if (confirm('Forget every collection change you made by hand and let the auto-sorter decide again?')) collCall('/api/collections/auto', {}, 'Back to automatic sorting'); }
    }
    function openFolderOnDisk() { try { post('/api/folders/open', { genre: '', series: '', private: false }); } catch (e) {} }
    function openFolderDisk(i) {
        var g = (raw().genres || [])[i]; if (!g) return;
        post('/api/folders/open', { genre: g.name, series: '', private: false }).catch(function (e) { toast(errMsg(e)); });
    }

    function onChange(e) {
        var el = e.target.closest('[data-k]'); if (!el || !el.closest('#ubh-filters')) return;
        var k = el.dataset.k;
        if (k === 'size') { S.size = parseInt(el.value, 10) || 2; LS.set('ubh_size', S.size); sizeVar(); return; }
        S[k] = el.value; if (k === 'sort' || k === 'type') LS.set('ubh_' + k, S[k]);
        S.shown = CHUNK; paint(false);
    }
    function onInput(e) {
        var el = e.target; if (el.dataset && el.dataset.k === 'size' && el.closest('#ubh-filters')) { S.size = parseInt(el.value, 10) || 2; LS.set('ubh_size', S.size); sizeVar(); }
    }
    function overlayOpen() {
        if (document.documentElement.classList.contains('in-player') || document.body.classList.contains('np-open')) return true;
        return !!document.querySelector('[id$="-modal"]:not(.hidden):not(#player-modal), #palette:not(.hidden), #sx-rl.on, #manage-menu, #ubh-dlg');
    }
    function onKey(e) {
        if (typeof currentView === 'undefined' || currentView !== 'video-view') return;
        var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
        if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (overlayOpen()) return;
            e.preventDefault(); var q = $('ubh-q'); if (q) { q.focus(); q.select(); } return;
        }
        if (e.key === 'Escape' && !typing) {
            if (overlayOpen()) return;
            if (S.selmode) { e.preventDefault(); setSelMode(false); return; }
            if (S.q || S.open) { e.preventDefault(); goBack(); }
        }
        if ((e.key === 'Enter' || e.key === ' ') && t && t.matches && t.matches('.ubh-coll, .ubh-folder, .ubh-seeall')) { e.preventDefault(); t.click(); }
    }


    // ---------------------------------------------------------------- picking movies + putting them in collections by hand
    // The auto-sorter keeps doing its job; what you place here wins over it and is remembered (nothing moves on disk).
    function selIds() { return Object.keys(S.sel); }
    function markSel() {
        var host = $('ubh-body'); if (!host) return;
        document.body.classList.toggle('ubh-selecting', S.selmode);
        var cs = host.querySelectorAll('.vcard[data-id]');
        for (var i = 0; i < cs.length; i++) cs[i].classList.toggle('ubh-picked', !!(S.selmode && S.sel[cs[i].dataset.id]));
    }
    function selBar() {
        var b = $('ubh-selbar'), btn = $('ubh-selbtn'); if (btn) btn.classList.toggle('on', S.selmode);
        if (!b) return;
        var n = selIds().length, m = model(), inColl = 0;
        selIds().forEach(function (id) { if (m && m.byId[id] && m.byId[id].collection) inColl++; });
        b.classList.toggle('on', S.selmode);
        if (!S.selmode) { b.innerHTML = ''; return; }
        b.innerHTML = '<span class="ubh-sn"><b>' + n + '</b> selected</span>' +
            '<button class="ubh-btn pri" data-act="selcoll"' + (n ? '' : ' disabled') + '><i class="fas fa-layer-group"></i> Add to collection</button>' +
            '<button class="ubh-btn" data-act="seltake"' + (inColl ? '' : ' disabled') + ' title="Keep these movies out of every collection"><i class="fas fa-arrow-right-from-bracket"></i> Take out of collection' + (inColl ? ' (' + inColl + ')' : '') + '</button>' +
            '<button class="ubh-btn" data-act="selclear"' + (n ? '' : ' disabled') + '>Clear</button>' +
            '<button class="ubh-btn" data-act="selmode">Done</button>';
    }
    function setSelMode(on) {
        S.selmode = on; if (!on) S.sel = {};
        markSel(); selBar();
        if (on) toast('Select mode: click movies to pick them. Esc or Done to leave.');
    }
    function togglePick(card) {
        var id = card.dataset.id; if (!id) return;
        if (S.sel[id]) delete S.sel[id]; else S.sel[id] = 1;
        card.classList.toggle('ubh-picked', !!S.sel[id]); selBar();
    }
    // while picking, a click on a poster picks it instead of playing it (runs before the card's own click handler)
    document.addEventListener('click', function (e) {
        if (!S.selmode || !e.target.closest) return;
        var card = e.target.closest('#ubh-body .vcard[data-id]');
        if (!card) return;
        e.preventDefault(); e.stopPropagation(); togglePick(card);
    }, true);

    var D = null;   // the open dialog: { mode: 'pick' | 'name' | 'rename', ids: {id: 1}, target, old, q }
    function collNames() { var m = model(); return m ? m.colls.map(function (c) { return c.name; }) : []; }
    function findColl(name) {
        var m = model(), k = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (!m || !k) return null;
        for (var i = 0; i < m.colls.length; i++) if (m.colls[i].name.toLowerCase() === k) return m.colls[i];
        return null;
    }
    function dlgClose() { var el = $('ubh-dlg'); if (el) el.remove(); D = null; }
    function dlgOpen(o) {
        dlgClose();
        D = { mode: o.mode, ids: o.ids || {}, target: o.target || '', old: o.old || '', q: '' };
        var title = D.mode === 'rename' ? 'Rename collection' : (D.mode === 'name' ? 'Add to collection' : 'Add movies'), el = document.createElement('div');
        el.id = 'ubh-dlg'; el.className = 'ubh-dlg';
        el.innerHTML = '<div class="ubh-dbox" role="dialog" aria-modal="true" aria-label="' + title + '">' +
            '<div class="ubh-dh"><div class="ubh-dt">' + title + '</div><button class="ubh-dx" data-d="close" aria-label="Close"><i class="fas fa-xmark"></i></button></div>' +
            '<label class="ubh-fl"><span>Collection name</span><input id="ubh-dn" list="ubh-dl" autocomplete="off" spellcheck="false" placeholder="Pick one you have, or type a new name" value="' + esc(D.target) + '"></label>' +
            '<datalist id="ubh-dl">' + collNames().map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist>' +
            '<div class="ubh-dhint" id="ubh-dhint"></div>' +
            (D.mode === 'pick' ? '<div class="ubh-fl"><span>Movies</span><input id="ubh-ds" autocomplete="off" spellcheck="false" placeholder="Search your movies"></div><div class="ubh-dlist" id="ubh-dlist"></div>' : '') +
            '<div class="ubh-derr" id="ubh-derr"></div>' +
            '<div class="ubh-df"><button class="ubh-btn" data-d="close">Cancel</button><button class="ubh-btn pri" data-d="ok" id="ubh-dok"></button></div></div>';
        document.body.appendChild(el);
        dlgRefresh(true);
        var n = $('ubh-dn'); if (n) { n.focus(); n.select(); }
    }
    function dlgRows() {
        var m = model(), tk = tokens(D.q), tgt = findColl($('ubh-dn') ? $('ubh-dn').value : D.target), out = [], shown = 0, total = 0;
        (m ? m.loose : []).forEach(function (v) {
            if (tgt && v.collection === tgt.name) return;                                   // already in that collection
            if (tk.length && !hit(v.title + ' ' + (v.collection || ''), tk)) return;
            total++; if (shown >= 300) return; shown++;
            out.push('<label class="ubh-dr' + (D.ids[v.id] ? ' on' : '') + '"><input type="checkbox" data-pick="' + v.id + '"' + (D.ids[v.id] ? ' checked' : '') + '>' +
                '<img src="' + esc(v.poster) + '" alt="" loading="lazy"><span class="n">' + esc(v.title) + '</span><span class="y">' + (v.year || '') + '</span>' +
                (v.collection ? '<span class="c">in ' + esc(v.collection) + '</span>' : '') + '</label>');
        });
        return out.join('') + (total > shown ? '<div class="ubh-dmore">' + (total - shown) + ' more: type in the search box to narrow it down</div>' : '') +
            (!total ? '<div class="ubh-dmore">No movies match.</div>' : '');
    }
    function dlgRefresh(rows) {
        if (!D) return;
        var name = ($('ubh-dn') || {}).value || '', tgt = findColl(name), n = Object.keys(D.ids).length, h = $('ubh-dhint'), ok = $('ubh-dok');
        if (h) h.innerHTML = !name.trim() ? 'Name the collection, then pick the movies.'
            : tgt ? 'Joins the collection <b>' + esc(tgt.name) + '</b> (' + plural(tgt.count, 'film') + ' now).' : 'Makes a new collection called <b>' + esc(name.trim()) + '</b>.';
        if (D.mode === 'pick' && rows) { var l = $('ubh-dlist'); if (l) l.innerHTML = dlgRows(); }
        if (ok) {
            ok.textContent = D.mode === 'rename' ? 'Rename' : (n ? 'Add ' + plural(n, 'movie') : 'Add');
            ok.disabled = D.mode !== 'rename' && !n;
        }
    }
    async function refreshLib() {
        try { if (typeof loadVideos === 'function') await loadVideos('public'); else window.ubhPaint(raw()); } catch (e) { console.error(e); }
    }
    async function dlgOk() {
        if (!D) return;
        var name = ($('ubh-dn') || {}).value.trim(), ids = Object.keys(D.ids), err = $('ubh-derr');
        if (!name) { err.textContent = 'Give the collection a name.'; return; }
        if (!ids.length) { err.textContent = 'Pick at least one movie.'; return; }
        var mode = D.mode, old = D.old, open = S.open; $('ubh-dok').disabled = true;
        try {
            var r = await post('/api/collections/assign', { ids: ids, name: name });
            dlgClose();
            if (mode === 'rename') toast('Renamed to "' + r.name + '"'); else toast('Added ' + plural(r.count, 'movie') + ' to "' + r.name + '"');
            S.sel = {}; S.selmode = false; markSel(); selBar();
            if (open && open.t === 'collection') S.open = { t: 'collection', k: r.name };
            await refreshLib();
        } catch (e) { if (err) err.textContent = (typeof errMsg === 'function' ? errMsg(e) : 'Could not save.'); var ok = $('ubh-dok'); if (ok) ok.disabled = false; }
    }
    async function collCall(url, body, msg) {
        try { await post(url, body || {}); if (msg) toast(msg); S.sel = {}; S.selmode = false; markSel(); selBar(); await refreshLib(); }
        catch (e) { toast(typeof errMsg === 'function' ? errMsg(e) : 'Could not save.'); }
    }
    document.addEventListener('input', function (e) {
        if (!D || !e.target.closest || !e.target.closest('#ubh-dlg')) return;
        if (e.target.id === 'ubh-ds') { D.q = e.target.value.trim(); dlgRefresh(true); }
        else if (e.target.id === 'ubh-dn') dlgRefresh(D.mode === 'pick');
    });
    document.addEventListener('change', function (e) {
        var c = e.target; if (!D || !c.dataset || !c.dataset.pick || !c.closest('#ubh-dlg')) return;
        if (c.checked) D.ids[c.dataset.pick] = 1; else delete D.ids[c.dataset.pick];
        c.closest('.ubh-dr').classList.toggle('on', c.checked); dlgRefresh(false);
    });
    document.addEventListener('click', function (e) {
        if (!D || !e.target.closest) return;
        var b = e.target.closest('[data-d]');
        if (b && b.closest('#ubh-dlg')) { if (b.dataset.d === 'close') dlgClose(); else dlgOk(); return; }
        if (e.target.id === 'ubh-dlg') dlgClose();                                     // click on the dark backdrop
    });
    document.addEventListener('keydown', function (e) {
        if (!D) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dlgClose(); }
        else if (e.key === 'Enter' && e.target && e.target.id === 'ubh-dn') { e.preventDefault(); if (D.mode !== 'pick') dlgOk(); else { var s2 = $('ubh-ds'); if (s2) s2.focus(); } }
    }, true);

    // ---------------------------------------------------------------- hooks into the app
    window.ubhBuild = build;
    window.ubhPaint = function (d) {
        if (!$('ubh-body')) build();
        try { genreData.public = (d && d.genres) || []; } catch (e) {}
        M = null; paint(true);
    };
    window.ubhGo = function (tab) { if (typeof switchTab === 'function') switchTab('video-view', 'tab-video'); go(tab, null); };
    window.ubhOpenFolder = function (name) { if (typeof switchTab === 'function') switchTab('video-view', 'tab-video'); openFolderPage(name); };
    window.ubhCollFirst = function (name) {       // the film a collection tile previews on hover
        var m = model(); if (!m) return null;
        for (var i = 0; i < m.colls.length; i++) if (m.colls[i].name === name) { var it = m.colls[i].items || []; return it.length ? it[0].id : null; }
        return null;
    };
    window.ubhFavChanged = function () {          // a heart was pressed (or the list arrived): repaint when the page is showing Favorites only
        if ($('ubh-body') && S.seen === 'fav' && !S.q) paint(true);
    };
    window.ubhState = S;

    var _sw = window.switchTab;
    window.switchTab = function (viewId, tabId) {
        var want = null;
        if (viewId === 'series-view') want = 'series'; else if (viewId === 'videos-view') want = 'movies';
        if (want) { viewId = 'video-view'; tabId = 'tab-video'; }
        var r = _sw.call(this, viewId, tabId);
        flagOn();
        if (want) { S.q = ''; var q = $('ubh-q'); if (q) q.value = ''; S.open = null; S.tab = want; LS.set('ubh_tab', want); paint(false); setY(0); }
        return r;
    };
    var _jg = window.jumpGenre;
    window.jumpGenre = function (scope, i) {
        if (scope !== 'public') return _jg && _jg.apply(this, arguments);
        var g = ((raw() || {}).genres || [])[i]; if (!g) return;
        openFolderPage(g.name);
    };

    document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('#video-view')) onClick(e); });
    // the floating selection bar lives on <body>, outside #video-view
    document.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('#ubh-selbar [data-act]');
        if (b && !b.disabled) act(b, e);
    });
    document.addEventListener('change', function (e) { if (e.target.closest && e.target.closest('#video-view')) onChange(e); });
    document.addEventListener('input', function (e) { if (e.target.closest && e.target.closest('#video-view')) onInput(e); });
    document.addEventListener('keydown', onKey);
    if (typeof vdata !== 'undefined' && vdata.public) window.ubhPaint(vdata.public);
})();
