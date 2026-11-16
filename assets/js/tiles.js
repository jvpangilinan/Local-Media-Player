/* ULTRON tiles: your own thumbnail for any movie, series or collection.
   Hover a tile and press the picture button: choose an image, or go back to the automatic thumbnail.
   Front end only; the pictures are stored by the server (data/custom_tiles) and never change your video files.
   Also the card look from Settings > Appearance > Movie cards: shape (square / poster / wide), fill or whole picture, size. */
(function () {
    'use strict';
    var C = { video: {}, series: {}, collection: {} };   // kind -> key -> when the custom picture was set
    var STAMP = {};                                      // 'kind|key' -> number that refreshes the tile's picture after a change
    var asked = {};                                      // collection names the server was already asked about
    var timer = 0, menu = null, picker = null;

    function say(msg) { try { if (typeof toast === 'function') return toast(msg); } catch (e) {} try { alert(msg); } catch (e2) {} }
    function sk(kind, key) { return kind + '|' + key; }
    function withParam(url, n) { return url + (url.indexOf('?') < 0 ? '?' : '&') + 'c=' + n; }
    function info(card) {
        if (card.dataset.id) return { kind: 'video', key: card.dataset.id };
        if (card.dataset.sid) return { kind: 'series', key: card.dataset.sid };
        if (card.dataset.coll != null) return { kind: 'collection', key: card.dataset.coll };
        return null;
    }
    function isCustom(kind, key) { return C[kind] && C[kind][key] != null; }

    // ---------------------------------------------------------------- card shape, picture and size (Settings > Appearance > Movie cards)
    var SHAPES = { square: 1, poster: 1, wide: 1 };
    // card width (rem) for sizes 1 small .. 4 extra large: in a sideways row, and the narrowest column of a grid.
    // Poster cards are narrower and wide cards wider, so a card covers about the same area in every shape.
    var WIDTH = {
        square: { row: [12, 15.6, 19, 23], grid: [8.4, 11.5, 14, 17] },
        poster: { row: [10, 12.5, 15.5, 18.5], grid: [7.4, 9.6, 11.8, 14.2] },
        wide:   { row: [15.5, 20, 24.5, 29.5], grid: [12, 15.5, 19, 23] }
    };
    function pref() { try { return (typeof prefs !== 'undefined' && prefs) || {}; } catch (e) { return {}; } }
    function look() {
        var p = pref();
        return { shape: SHAPES[p.tile_shape] ? p.tile_shape : 'square', fit: p.tile_fit === 'whole' ? 'whole' : 'fill',
                 size: Math.max(1, Math.min(4, parseInt(p.tile_size, 10) || 2)) };
    }
    // a card picture's address for the current shape: /tile/<id>?v=..&shape=poster (square needs no shape)
    function shaped(url) {
        url = String(url || '').replace(/([?&])shape=[a-z]+&?/, '$1').replace(/[?&]$/, '');
        var s = look().shape;
        if (s === 'square' || !/^\/(tile|seriestile)\//.test(url)) return url;
        return url + (url.indexOf('?') < 0 ? '?' : '&') + 'shape=' + s;
    }
    window.utShaped = shaped;
    var shownShape = null;
    function utLook() {
        var L = look(), de = document.documentElement, w = WIDTH[L.shape];
        de.setAttribute('data-ut-shape', L.shape);
        de.setAttribute('data-ut-fit', L.fit);
        de.style.setProperty('--ut-w', w.row[L.size - 1] + 'rem');
        de.style.setProperty('--ut-gw', w.grid[L.size - 1] + 'rem');
        var vv = document.getElementById('video-view'); if (vv) vv.style.setProperty('--ubh-w', w.grid[L.size - 1] + 'rem');
        var sl = document.querySelector('#ubh-filters input[data-k="size"]'); if (sl && document.activeElement !== sl) sl.value = L.size;
        document.querySelectorAll('#set-ushape .set-seg').forEach(function (b) { b.classList.toggle('on', b.dataset.v === L.shape); });
        var f = document.getElementById('set-ufit'); if (f) f.value = L.fit;
        var z = document.getElementById('set-usize'); if (z) z.value = String(L.size);
        if (shownShape !== null && shownShape !== L.shape) scan();      // every card asks for the picture of its new shape
        shownShape = L.shape;
    }
    window.utLook = utLook;

    // ---------------------------------------------------------------- show the right picture on every tile
    function setPic(cover, img, src) {
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
        var bg = 'url("' + src + '")';                                  // "Whole picture" lays a blur of the same picture behind it
        if (cover.style.getPropertyValue('--ut-bg') !== bg) cover.style.setProperty('--ut-bg', bg);
    }
    function applyCard(card) {
        var t = info(card); if (!t) return;
        var custom = isCustom(t.kind, t.key), stamp = custom ? (STAMP[sk(t.kind, t.key)] || C[t.kind][t.key]) : STAMP[sk(t.kind, t.key)];
        card.classList.toggle('ut-custom', !!custom);
        var btn = card.querySelector('.ut-img'); if (btn) btn.title = custom ? 'Thumbnail (custom)' : 'Thumbnail';
        var cover = card.querySelector('.ut-cover'); if (!cover) return;
        if (t.kind === 'collection') {
            var mine = cover.querySelector(':scope > img.ut-mine');
            if (custom) {
                var src = withParam('/colltile/' + encodeURIComponent(t.key), stamp);
                if (!mine) {
                    card._auto = [];
                    Array.prototype.slice.call(cover.children).forEach(function (n) {
                        if (n.matches('.ut-mos, .ut-ph') || (n.tagName === 'IMG')) { card._auto.push(n); cover.removeChild(n); }
                    });
                    mine = document.createElement('img'); mine.className = 'ut-mine'; mine.alt = '';
                    cover.insertBefore(mine, cover.firstChild);
                }
                setPic(cover, mine, src);
            } else {
                if (mine) {
                    mine.remove();
                    (card._auto || []).slice().reverse().forEach(function (n) { cover.insertBefore(n, cover.firstChild); });
                    card._auto = null;
                }
                // the films' own pictures (one, or the 2x2 mosaic) follow the card shape
                cover.querySelectorAll(':scope > img, :scope > .ut-mos > img').forEach(function (im) {
                    var s = shaped(im.getAttribute('src'));
                    if (im.parentNode === cover) setPic(cover, im, s); else if (im.getAttribute('src') !== s) im.setAttribute('src', s);
                });
            }
            return;
        }
        var img = cover.querySelector(':scope > img'); if (!img) return;
        if (!img.dataset.auto) img.dataset.auto = img.getAttribute('src') || '';
        var base = shaped(img.dataset.auto);
        setPic(cover, img, (custom || stamp != null) ? withParam(base, stamp) : base);
    }
    // ---------------------------------------------------------------- favorites (a heart on every tile)
    var F = { video: {}, series: {}, collection: {} }, favReady = false;
    function isFav(kind, key) { return !!(F[kind] && F[kind][key]); }
    window.utFav = {
        has: isFav,
        ready: function () { return favReady; },
        count: function () { return Object.keys(F.video).length + Object.keys(F.series).length + Object.keys(F.collection).length; }
    };
    function paintFav(card) {
        var t = info(card); if (!t) return;
        var cover = card.querySelector('.ut-cover'); if (!cover) return;
        var b = cover.querySelector(':scope > .ut-fav');
        if (!b) {
            b = document.createElement('button'); b.className = 'ut-fav'; b.type = 'button'; b.dataset.fk = t.kind; b.dataset.fkey = t.key;
            b.innerHTML = '<i class="fas fa-heart"></i>'; cover.appendChild(b);
        }
        var on = isFav(t.kind, t.key);
        b.classList.toggle('on', on); card.classList.toggle('ut-faved', on);
        b.title = on ? 'Remove from Favorites' : 'Add to Favorites'; b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    function loadFavs() {
        fetch('/api/cinema/favs').then(function (r) { return r.json(); }).then(function (d) {
            F = { video: {}, series: {}, collection: {} };
            ['video', 'series', 'collection'].forEach(function (k) { (d[k] || []).forEach(function (key) { F[k][key] = 1; }); });
            favReady = true; later(); if (window.ubhFavChanged) window.ubhFavChanged();
        }).catch(function () {});
    }
    function toggleFav(kind, key) {
        var on = !isFav(kind, key);
        if (on) F[kind][key] = 1; else delete F[kind][key];
        scan(); if (window.ubhFavChanged) window.ubhFavChanged();
        fetch('/api/cinema/fav', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LMP': '1' }, body: JSON.stringify({ kind: kind, key: key, on: on }) })
            .then(function (r) { if (!r.ok) throw 0; }).catch(function () {
                if (on) delete F[kind][key]; else F[kind][key] = 1;       // the server said no: put the heart back as it was
                scan(); if (window.ubhFavChanged) window.ubhFavChanged(); say('Could not change Favorites.');
            });
    }

    function scan() {
        timer = 0;
        var cards = document.querySelectorAll('.utile'), fresh = [];
        for (var i = 0; i < cards.length; i++) {
            var c = cards[i];
            paintFav(c);
            if (c.dataset.coll != null && !asked[c.dataset.coll]) fresh.push(c.dataset.coll);
            applyCard(c);
        }
        if (fresh.length) fetchCustom(fresh);
    }
    function later() { if (!timer) timer = setTimeout(scan, 60); }

    function fetchCustom(names) {
        names.forEach(function (n) { asked[n] = 1; });
        fetch('/api/tile/custom', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LMP': '1' }, body: JSON.stringify({ names: names }) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                ['video', 'series', 'collection'].forEach(function (k) {
                    var got = d[k] || {};
                    if (k !== 'collection') C[k] = {};            // the lists for movies and series are always complete
                    Object.keys(got).forEach(function (key) { C[k][key] = got[key]; });
                });
                later();
            }).catch(function () {});
    }

    // ---------------------------------------------------------------- the little menu
    function closeMenu() { if (menu) { menu.remove(); menu = null; } }
    function openMenu(btn) {
        closeMenu();
        var kind = btn.dataset.tk, key = btn.dataset.tkey, custom = isCustom(kind, key);
        menu = document.createElement('div'); menu.className = 'ut-menu';
        menu.innerHTML = '<button data-m="pick"><i class="far fa-image"></i> Choose picture&hellip;</button>' +
            '<button data-m="reset"' + (custom ? '' : ' disabled') + '><i class="fas fa-rotate-left"></i> Back to automatic</button>';
        document.body.appendChild(menu);
        var r = btn.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
        menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
        menu.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
        menu.addEventListener('click', function (e) {
            var b = e.target.closest('button[data-m]'); if (!b || b.disabled) return;
            e.stopPropagation(); closeMenu();
            if (b.dataset.m === 'pick') choose(kind, key); else reset(kind, key);
        });
    }
    function choose(kind, key) {
        if (picker) picker.remove();
        picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/jpeg,image/png,image/webp'; picker.style.display = 'none';
        document.body.appendChild(picker);
        picker.addEventListener('change', function () {
            var f = picker.files && picker.files[0]; picker.remove(); picker = null;
            if (!f) return;
            var fd = new FormData(); fd.append('kind', kind); fd.append('key', key); fd.append('file', f);
            fetch('/api/tile/set', { method: 'POST', headers: { 'X-LMP': '1' }, body: fd })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (x) {
                    if (!x.ok) return say(x.d.error || 'Could not set the thumbnail.');
                    C[kind][key] = x.d.stamp || Date.now(); STAMP[sk(kind, key)] = Date.now();
                    scan(); say('Thumbnail changed.');
                }).catch(function () { say('Could not set the thumbnail.'); });
        });
        picker.click();
    }
    function reset(kind, key) {
        fetch('/api/tile/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LMP': '1' }, body: JSON.stringify({ kind: kind, key: key }) })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (x) {
                if (!x.ok) return say(x.d.error || 'Could not reset the thumbnail.');
                delete C[kind][key]; STAMP[sk(kind, key)] = Date.now();
                scan(); say('Back to the automatic thumbnail.');
            }).catch(function () { say('Could not reset the thumbnail.'); });
    }

    // runs before the tile's own click (open / play), like the select mode does
    document.addEventListener('click', function (e) {
        var t = e.target;
        if (menu && !(t.closest && t.closest('.ut-menu'))) closeMenu();
        var fb = t.closest && t.closest('.ut-fav');
        if (fb) { e.preventDefault(); e.stopPropagation(); toggleFav(fb.dataset.fk, fb.dataset.fkey); return; }
        var btn = t.closest && t.closest('.ut-img'); if (!btn) return;
        e.preventDefault(); e.stopPropagation(); openMenu(btn);
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu) { closeMenu(); e.stopPropagation(); } }, true);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);

    // new tiles appear all the time (tabs, search, "show more"): give each the right picture
    new MutationObserver(function (list) {
        for (var i = 0; i < list.length; i++) if (list[i].addedNodes.length) return later();
    }).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', function () { utLook(); fetchCustom([]); loadFavs(); later(); });
    if (document.readyState !== 'loading') { utLook(); fetchCustom([]); loadFavs(); later(); }
})();
