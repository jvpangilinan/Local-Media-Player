/* The Diner: a quiet room to sit in (a nod to Hopper's Nighthawks, moved to a rainy neon city). The scene is painted here in code, once,
   onto canvases (no borrowed art): a blurred night street behind wet glass, a lit wall with one framed painting, a jukebox, a table.
   Only cheap layers move (rain, steam, the equaliser), all by transform / opacity.
   Paintings come from /api/art/list (the Gallery set), drift slowly and at random. The jukebox drives the app's own music player.
   Keys while it is open: Space / Right = next, Left = back, N = nothing (empty frame), M = hide the music card, Esc = leave.
   Things in the room answer a click (HOT below): lamp, fairy lights, neon sign, weather, coffee, sugar, picture light, jukebox, leaves, lean in, the cat.
   Dragging on the window draws in the fog. Each thing found is counted (12 in all); finding them all unlocks fireworks.
   The guest book (B) on the table holds the lore: diner-lore.js keeps the pages and the book, diner-talk.js plays Juno's story from diner-story.js.
   They are driven through lore(ev, data) below; every hook is a no-op when those scripts are missing. */
(function () {
    'use strict';
    var DRIFT_MS = 3 * 60 * 1000, FADE = 3000, MOUSE_MS = 2800;
    var W = 1600, H = 900, WIN = { x: 50, y: 66, w: 630, h: 540 }, ART = { x: 782, y: 152, w: 452, h: 318 }, RDX = 70;
    var SHK = { x: 1176, y: 656, w: 48, h: 88 }, LEAF = { x: 1240, y: 560, w: 360, h: 340 }, DIM = { x: 630, y: 40, w: 756, h: 600 }, COF = { x: 618, y: 723, w: 84, h: 16 };
    // what you can click: [action, x, y, w, h, label, where the label sits]
    var HOT = [['x-wx', 50, 66, 630, 540, 'Window: click for weather, drag to draw on the glass', 'in'], ['x-fairy', 44, 62, 642, 64, 'Fairy lights', 'under'], ['x-sign', 514, 212, 118, 116, 'Neon sign', ''],
        ['x-lamp', 258, 556, 154, 208, 'Lamp', ''], ['x-sip', 572, 716, 180, 96, 'Coffee: take a sip', ''], ['x-sugar', 1172, 652, 56, 94, 'Sugar', ''],
        ['x-pic', 886, 62, 244, 40, 'Picture light', 'under'], ['x-zoom', 908, 524, 200, 52, 'Lean in / lean back', 'under'],
        ['play', 1384, 244, 142, 198, 'Jukebox: play / pause', ''], ['next', 1376, 482, 158, 30, 'Next song', ''], ['x-leaves', 1440, 770, 160, 130, 'Leaves', ''],
        ['x-fw', 360, 192, 150, 110, '???', ''], ['x-cat', 548, 503, 104, 122, 'Cat', ''], ['x-shuffle', 1429, 578, 52, 52, 'Shuffle everything', ''],
        ['x-book', 872, 734, 190, 72, 'Guest book (B)', ''], ['x-juno', 1050, 714, 124, 86, "Someone's here", '']];
    var BOOK = { x: 884, y: 744, w: 166, h: 52 }, CAT = { x: 540, y: 498, w: 120, h: 128 }, TAIL = { x: 612, y: 608, w: 60, h: 74 }, CUP2 = { x: 1040, y: 716, w: 200, h: 96 }, FOG_MS = 50000;
    var fogC = null, fog0 = null, fwC = null, segs = [], fogT = 0, fwT = 0;
    var paintOff = null;
    var el = null, open = false, works = null, loading = null, imgs = null, front = 0, cur = null, hist = [], seen = [], empty = false;
    var driftT = 0, mouseT = 0, fadeT = 0, syncT = 0;

    function $(id) { return document.getElementById(id); }
    function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function pct(v, of) { return (v / of * 100).toFixed(3) + '%'; }
    function box(b) { return 'left:' + pct(b.x, W) + ';top:' + pct(b.y, H) + ';width:' + pct(b.w, W) + ';height:' + pct(b.h, H); }

    /* ---------- painting helpers ---------- */
    function rng(s) { return function () { s = s + 0x6D2B79F5 | 0; var t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
    function lin(c, x0, y0, x1, y1, st) { var g = c.createLinearGradient(x0, y0, x1, y1); st.forEach(function (s) { g.addColorStop(s[0], s[1]); }); return g; }
    function canvas(w, h, S) { var cv = document.createElement('canvas'); cv.width = Math.round(w * S); cv.height = Math.round(h * S); var c = cv.getContext('2d'); c.scale(S, S); return c; }
    // a soft pool of light (or, with op 'source-over' and black, of shadow)
    function glow(c, x, y, rx, ry, col, a, op) {
        c.save(); c.globalCompositeOperation = op || 'screen'; c.translate(x, y); c.scale(1, ry / rx);
        var g = c.createRadialGradient(0, 0, 0, 0, 0, rx); g.addColorStop(0, rgba(col, a)); g.addColorStop(.45, rgba(col, a * .38)); g.addColorStop(1, rgba(col, 0));
        c.fillStyle = g; c.beginPath(); c.arc(0, 0, rx, 0, 6.3); c.fill(); c.restore();
    }
    function shade(c, x, y, rx, ry, a) { glow(c, x, y, rx, ry, [0, 0, 0], a, 'source-over'); }
    // paint fn on its own layer, then lay it down out of focus
    function soft(dst, w, h, S, px, fn, op) {
        var L = canvas(w, h, S); fn(L); dst.save(); dst.setTransform(1, 0, 0, 1, 0, 0);
        dst.filter = 'blur(' + (px * S).toFixed(1) + 'px)'; if (op) dst.globalCompositeOperation = op;
        dst.drawImage(L.canvas, 0, 0); dst.restore();
    }
    var PINK = [255, 45, 150], CYAN = [45, 225, 240], AMBER = [255, 180, 80], VIOLET = [150, 110, 255], WARM = [255, 196, 120];
    var NEON = [PINK, CYAN, AMBER, VIOLET];

    /* ---------- the street, seen through the glass (w x h = the window opening) ---------- */
    function paintOut(c, w, h, S) {
        var r = rng(7), i, j, gy = h * .8;
        c.fillStyle = lin(c, 0, 0, 0, h, [[0, '#060918'], [.4, '#15123a'], [.68, '#3a1a55'], [.8, '#2a1c4a'], [1, '#0a0d1c']]); c.fillRect(0, 0, w, h);
        glow(c, w * .37, h * .6, 300, 260, [255, 80, 180], .34);
        glow(c, w * .4, h * .74, 230, 120, [255, 170, 110], .25);
        soft(c, w, h, S, 3.5, function (L) {                                   // far towers, lost in the haze
            for (i = 0; i < 18; i++) {
                var x = r() * w, bw = 22 + r() * 50, bh = 150 + r() * 260;
                L.fillStyle = 'rgb(' + (38 + r() * 14 | 0) + ',' + (28 + r() * 8 | 0) + ',' + (84 + r() * 20 | 0) + ')'; L.fillRect(x, gy - bh, bw, bh);
                for (j = 0; j < 14; j++) { L.fillStyle = rgba(NEON[(r() * 3) | 0], .35 + r() * .4); L.fillRect(x + 3 + r() * (bw - 8), gy - bh + 8 + r() * (bh - 20), 2.2, 2.6); }
                L.fillStyle = 'rgba(255,60,60,.9)'; L.fillRect(x + bw / 2, gy - bh - 4, 2.5, 2.5);
            }
        });
        c.fillStyle = lin(c, 0, h * .2, 0, gy, [[0, 'rgba(130,60,170,0)'], [1, 'rgba(160,70,170,.32)']]); c.fillRect(0, 0, w, gy);
        soft(c, w, h, S, 2.4, function (L) {                                   // this side of the street
            function block(x, bw, top, col) {
                L.fillStyle = col; L.fillRect(x, top, bw, gy - top);
                for (var yy = top + 14; yy < gy - 110; yy += 19) for (var xx = x + 8; xx < x + bw - 10; xx += 15) {
                    var q = r(); L.fillStyle = q < .11 ? rgba(WARM, .5 + r() * .5) : q < .14 ? rgba(CYAN, .6) : q < .165 ? rgba(PINK, .6) : 'rgba(30,32,74,.35)';
                    L.fillRect(xx, yy, 7, 9);
                }
                L.fillStyle = 'rgba(0,0,0,.35)'; for (yy = top + 80; yy < gy - 100; yy += 84) L.fillRect(x, yy, bw, 3);
            }
            function sign(x, y, sw, sh, col) {                                 // a lit vertical sign with dark glyph blocks
                L.fillStyle = rgba(col, .95); L.fillRect(x, y, sw, sh); L.fillStyle = 'rgba(10,6,30,.7)';
                for (var yy = y + 8; yy < y + sh - 14; yy += 24) { L.fillRect(x + 5, yy, sw - 10, 4); L.fillRect(x + 5, yy + 7, 4, 9); L.fillRect(x + sw - 9, yy + 7, 4, 9); }
            }
            block(-10, 178, -20, '#0b0c1f'); block(286, 236, 96, '#0e0e26'); block(548, 120, -20, '#090a1a');
            L.strokeStyle = '#05050c'; L.lineWidth = 1.5;                       // cables across the gap, roof clutter
            L.beginPath(); L.moveTo(168, 150); L.quadraticCurveTo(228, 196, 286, 160); L.moveTo(168, 208); L.quadraticCurveTo(230, 240, 286, 214); L.stroke();
            L.fillStyle = '#0e0e26'; L.fillRect(330, 70, 3, 26); L.fillRect(470, 60, 2, 36); L.fillRect(420, 74, 34, 22);
            // the holo board
            L.fillStyle = lin(L, 310, 126, 310, 236, [[0, '#ff4fa8'], [.55, '#ff9a5a'], [1, '#7a5cff']]); L.fillRect(310, 126, 150, 110);
            L.fillStyle = 'rgba(255,240,220,.9)'; L.beginPath(); L.arc(385, 186, 30, 0, 6.3); L.fill();
            L.fillStyle = 'rgba(60,20,90,.45)'; for (i = 0; i < 6; i++) L.fillRect(310, 188 + i * 9, 150, 2 + i * .6);
            sign(132, 120, 26, 190, CYAN); sign(600, 84, 24, 216, PINK);
            // the place across the road: awning, warm window, people
            L.fillStyle = '#12122c'; L.fillRect(286, 318, 236, gy - 318);
            L.fillStyle = rgba(PINK, .95); L.fillRect(318, 322, 118, 12);
            L.fillStyle = lin(L, 0, 352, 0, 428, [[0, '#ffe2a0'], [1, '#ff9d4a']]); L.fillRect(300, 352, 208, 76);
            L.fillStyle = '#5a1730'; L.fillRect(292, 340, 224, 13);
            L.fillStyle = 'rgba(40,18,10,.8)'; L.fillRect(300, 404, 208, 8); L.fillRect(368, 352, 4, 76); L.fillRect(440, 352, 4, 76);
            [[326, 372], [344, 376], [470, 370]].forEach(function (p) { L.beginPath(); L.arc(p[0], p[1], 7, 0, 6.3); L.fill(); L.fillRect(p[0] - 8, p[1] + 7, 16, 28); });
            // left: a shutter and a small sign; right: vending machines
            L.fillStyle = '#070812'; L.fillRect(20, 350, 120, gy - 350); L.fillStyle = rgba(CYAN, .9); L.fillRect(40, 328, 46, 12);
            L.fillStyle = 'rgba(200,245,255,.95)'; L.fillRect(566, 378, 22, 50); L.fillStyle = 'rgba(255,200,220,.95)'; L.fillRect(594, 378, 22, 50);
            // a street lamp in the gap, two people under umbrellas
            L.fillStyle = '#05050c'; L.fillRect(231, 296, 3, gy - 296); L.fillRect(214, 296, 20, 3);
            L.fillStyle = '#fff3d6'; L.fillRect(210, 298, 10, 4);
            L.fillStyle = '#05050d';
            [[402, 1], [252, .8]].forEach(function (p) { var k = p[1]; L.beginPath(); L.arc(p[0], gy - 34 * k, 14 * k, Math.PI, 0); L.fill(); L.fillRect(p[0] - 4 * k, gy - 32 * k, 8 * k, 32 * k); });
            // kerb and road
            L.fillStyle = '#1a1c36'; L.fillRect(0, gy, w, 12); L.fillStyle = 'rgba(255,255,255,.10)'; L.fillRect(0, gy + 12, w, 1.5);
            L.fillStyle = lin(L, 0, gy + 13, 0, h, [[0, '#10122a'], [.25, '#090a18'], [1, '#04050c']]); L.fillRect(0, gy + 13, w, h - gy);
        });
        // sign bloom
        glow(c, 145, 215, 70, 150, CYAN, .26); glow(c, 612, 190, 70, 170, PINK, .28); glow(c, 385, 180, 130, 100, [255, 110, 170], .24);
        glow(c, 404, 392, 190, 90, [255, 180, 100], .34); glow(c, 215, 300, 70, 70, [255, 235, 200], .5); glow(c, 590, 400, 70, 70, [200, 240, 255], .3);
        soft(c, w, h, S, 5, function (L) {                                     // the wet road keeps every light
            function refl(x, rw, col, a) { L.fillStyle = lin(L, 0, gy + 12, 0, h + 30, [[0, rgba(col, a)], [1, rgba(col, 0)]]); L.fillRect(x - rw / 2, gy + 12, rw, h - gy); }
            refl(404, 200, [255, 190, 110], .6); refl(145, 34, CYAN, .6); refl(612, 34, PINK, .65); refl(385, 120, [255, 90, 170], .28); refl(590, 50, [200, 240, 255], .45); refl(215, 22, [255, 235, 200], .6);
        }, 'screen');
        for (i = 0; i < 46; i++) { c.fillStyle = 'rgba(4,5,12,.42)'; c.fillRect(r() * w - 40, gy + 16 + r() * (h - gy - 16), 30 + r() * 110, 1.3); }
        c.fillStyle = lin(c, 0, 0, 0, h * .5, [[0, 'rgba(3,4,14,.55)'], [1, 'rgba(3,4,14,0)']]); c.fillRect(0, 0, w, h * .5);
        c.save(); c.globalCompositeOperation = 'screen';                      // out-of-focus lights
        for (i = 0; i < 44; i++) {
            var bx = r() * w, by = h * (.3 + r() * .68), br = 5 + r() * 20, col = NEON[(r() * 4) | 0], a = .07 + r() * .17;
            c.fillStyle = rgba(col, a); c.beginPath(); c.arc(bx, by, br, 0, 6.3); c.fill(); c.strokeStyle = rgba(col, a * 1.2); c.lineWidth = 1; c.stroke();
        }
        c.restore();
    }

    /* ---------- water on the glass ---------- */
    function drop(c, x, y, rad) {
        var g = c.createLinearGradient(0, y - rad, 0, y + rad * 1.2); g.addColorStop(0, 'rgba(4,5,18,.6)'); g.addColorStop(.55, 'rgba(60,70,120,.22)'); g.addColorStop(1, 'rgba(225,235,255,.7)');
        c.fillStyle = g; c.beginPath(); c.ellipse(x, y, rad, rad * 1.2, 0, 0, 6.3); c.fill();
        if (rad > 1.2) { c.fillStyle = 'rgba(255,255,255,.75)'; c.beginPath(); c.arc(x - rad * .3, y - rad * .35, rad * .22, 0, 6.3); c.fill(); }
    }
    function paintGlass(c, w, h) {
        var r = rng(23), i;
        c.fillStyle = lin(c, 0, h * .4, 0, h, [[0, 'rgba(170,185,255,0)'], [1, 'rgba(170,185,255,.14)']]); c.fillRect(0, 0, w, h);   // fogged near the sill
        for (i = 0; i < 28; i++) {
            var x = r() * w, y = r() * h * .8, len = 40 + r() * 170, tw = 1 + r() * 2.2;
            c.fillStyle = lin(c, 0, y, 0, y + len, [[0, 'rgba(220,230,255,0)'], [1, 'rgba(220,230,255,.11)']]); c.fillRect(x, y, tw, len); drop(c, x + tw / 2, y + len, tw * 1.25 + 1);
        }
        for (i = 0; i < 520; i++) drop(c, r() * w, r() * h, .6 + r() * r() * 3.2);
    }
    // two stacked copies (the lower one shifted by dx) so the layer can loop down and sideways without a seam
    function paintRain(c, w, h, dx, n, len, a, lw, seed) {
        var r = rng(seed), i, t, k = dx / h; c.lineCap = 'round';
        for (i = 0; i < n; i++) {
            var x = r() * (w + dx), l = len * (.5 + r() * .5), y = r() * (h - l);
            c.strokeStyle = 'rgba(200,215,255,' + (a * (.4 + r() * .6)).toFixed(3) + ')'; c.lineWidth = lw * (.6 + r() * .8);
            for (t = 0; t < 2; t++) { var X = x - (t ? dx : 0), Y = y + t * h; c.beginPath(); c.moveTo(X, Y); c.lineTo(X - k * l, Y + l); c.stroke(); }
        }
    }

    function paintSnow(c, w, h, dx, n, seed, big) {
        var r = rng(seed), i, t;
        for (i = 0; i < n; i++) {
            var x = r() * (w + dx), y = r() * h, rad = (.8 + r() * 1.5) * (big || 1); c.fillStyle = 'rgba(240,244,255,' + (.45 + r() * .5).toFixed(2) + ')';
            for (t = 0; t < 2; t++) { c.beginPath(); c.arc(x - (t ? dx : 0), y + t * h, rad, 0, 6.3); c.fill(); }
        }
    }
    // drawing in the fog: each stroke is kept with its time, wipes the mist clear, then mists over again
    function fogSeg(g, k, pass) {
        var c = fogC; c.lineCap = 'round'; c.globalCompositeOperation = pass ? 'destination-out' : 'source-over';
        c.strokeStyle = pass ? 'rgba(0,0,0,' + k.toFixed(3) + ')' : 'rgba(232,240,255,' + (.14 * k).toFixed(3) + ')'; c.lineWidth = pass ? 9 : 15;
        c.beginPath(); c.moveTo(g[0], g[1]); c.lineTo(g[2], g[3]); c.stroke(); c.globalCompositeOperation = 'source-over';
    }
    function fogDraw() {
        var now = Date.now(), c = fogC; segs = segs.filter(function (g) { return now - g[4] < FOG_MS; });
        c.clearRect(0, 0, WIN.w, WIN.h); c.drawImage(fog0, 0, 0);
        [0, 1].forEach(function (pass) { segs.forEach(function (g) { fogSeg(g, Math.max(0, Math.min(1, 2 * (1 - (now - g[4]) / FOG_MS))), pass); }); });
        if (!segs.length) { clearInterval(fogT); fogT = 0; }
    }
    function fireworks() {
        if (fwT || !fwC) return; lore('fireworks'); var c = fwC, parts = [], t0 = performance.now(), i, j;
        for (i = 0; i < 5; i++) {
            var x = 90 + Math.random() * 450, y = 50 + Math.random() * 170, col = NEON[i % 4];
            for (j = 0; j < 46; j++) { var an = Math.random() * 6.283, sp = 30 + Math.random() * 80; parts.push([x, y, Math.cos(an) * sp, Math.sin(an) * sp, col, i * .42]); }
        }
        (function tick(now) {
            var t = (now - t0) / 1000, alive = false; c.clearRect(0, 0, WIN.w, WIN.h); c.globalCompositeOperation = 'lighter';
            parts.forEach(function (q) {
                var u = t - q[5]; if (u < 0) { alive = true; return; } if (u > 1.8) return; alive = true;
                var k = 1 - Math.exp(-2.2 * u); c.fillStyle = rgba(q[4], Math.max(0, 1 - u / 1.8).toFixed(2));
                c.beginPath(); c.arc(q[0] + q[2] * k, q[1] + q[3] * k + 22 * u * u, 1.9, 0, 6.3); c.fill();
            });
            if (alive && open) fwT = requestAnimationFrame(tick); else { fwT = 0; c.clearRect(0, 0, WIN.w, WIN.h); }
        })(t0);
    }

    /* ---------- the room (the window opening is left clear) ---------- */
    function paintIn(c, S, lamp, part) {
        var r = rng(41), i, x, y, wx = WIN.x, wy = WIN.y, ww = WIN.w, wh = WIN.h, ty = 716;
        function rr(x, y, w, h, q) { c.beginPath(); c.moveTo(x + q, y); c.arcTo(x + w, y, x + w, y + h, q); c.arcTo(x + w, y + h, x, y + h, q); c.arcTo(x, y + h, x, y, q); c.arcTo(x, y, x + w, y, q); c.closePath(); }
        function ell(x, y, a, b, fill) { c.fillStyle = fill; c.beginPath(); c.ellipse(x, y, a, b, 0, 0, 6.3); c.fill(); }
        function quad(p, fill) { c.fillStyle = fill; c.beginPath(); c.moveTo(p[0], p[1]); for (var k = 2; k < p.length; k += 2) c.lineTo(p[k], p[k + 1]); c.closePath(); c.fill(); }
        if (part === 'shaker') { shaker(); return; }
        if (part === 'leaves') { leaves(); return; }
        if (part === 'cat') { cat(); return; }
        if (part === 'tail') { tail(); return; }
        if (part === 'cup2') { c.translate(650, 218); c.scale(.7, .7); cup(); ell(660, 731, 39, 7, '#24120a'); ell(648, 729.5, 14, 2, 'rgba(255,220,180,.22)'); return; }   // Juno's cup: the same cup, a little further back

        // wall: dark plaster, never one flat colour
        c.fillStyle = lin(c, 0, 0, 0, ty, [[0, '#11181c'], [.5, '#1f292d'], [1, '#1a2125']]); c.fillRect(0, 0, W, ty);
        for (i = 0; i < 70; i++) { x = r() * W; y = r() * 620; if (r() < .5) glow(c, x, y, 60 + r() * 120, 40 + r() * 90, [150, 190, 200], .028); else shade(c, x, y, 60 + r() * 120, 40 + r() * 90, .08); }
        // light on the wall: warm over the painting and by the lamp, neon by the jukebox, a cold breath round the window
        glow(c, 1008, 300, 560, 420, WARM, .46); glow(c, 1008, 180, 400, 190, [255, 214, 150], .42);
        glow(c, 1455, 400, 390, 450, PINK, .36); glow(c, 1455, 250, 260, 220, CYAN, .18);
        if (lamp) glow(c, 335, 600, 540, 430, [255, 160, 80], .46);
        glow(c, 365, 336, 540, 430, [80, 90, 230], .11);
        c.fillStyle = lin(c, 0, 0, 0, 180, [[0, 'rgba(0,0,0,.5)'], [1, 'rgba(0,0,0,0)']]); c.fillRect(0, 0, W, 180);

        // window: opening, steel casing, mullions
        c.clearRect(wx, wy, ww, wh);
        var t = 16, steel = '#07090e';
        c.lineWidth = t; c.strokeStyle = lin(c, 0, wy, 0, wy + wh + t, [[0, '#090b11'], [.55, '#11131a'], [1, lamp ? '#3a2a1c' : '#15171e']]); c.strokeRect(wx - t / 2, wy - t / 2, ww + t, wh + t);
        c.fillStyle = steel; c.fillRect(wx + ww / 3 - 5, wy, 10, wh); c.fillRect(wx + ww * 2 / 3 - 5, wy, 10, wh); c.fillRect(wx, wy + 113, ww, 10);
        c.lineWidth = 1; c.strokeStyle = 'rgba(120,135,255,.22)'; c.strokeRect(wx + .6, wy + .6, ww - 1.2, wh - 1.2);
        c.fillStyle = 'rgba(120,135,255,.18)';
        [wx + ww / 3 - 5, wx + ww / 3 + 4, wx + ww * 2 / 3 - 5, wx + ww * 2 / 3 + 4].forEach(function (mx) { c.fillRect(mx, wy, 1, wh); });
        c.fillRect(wx, wy + 113, ww, 1); c.fillRect(wx, wy + 122, ww, 1);
        c.strokeStyle = 'rgba(255,205,150,.26)'; c.strokeRect(wx - t, wy - t, ww + 2 * t, wh + 2 * t);

        // a wooden ledge runs along the wall at sill height; planks below it
        var ly = wy + wh + t;
        c.fillStyle = lin(c, 0, 0, W, 0, [[0, '#4a3220'], [.2, '#6a4628'], [.44, '#3a2c3a'], [.63, '#5e442c'], [.84, '#55263c'], [1, '#3c1c30']]); c.fillRect(0, ly, W, 13);
        c.fillStyle = 'rgba(255,235,210,.24)'; c.fillRect(0, ly, W, 1.2);
        c.fillStyle = lin(c, 0, ly + 13, 0, ly + 26, [[0, '#1c130e'], [1, '#0a0605']]); c.fillRect(0, ly + 13, W, 13);
        c.fillStyle = lin(c, 0, ly + 26, 0, ty, [[0, '#1b1310'], [1, '#0d0908']]); c.fillRect(0, ly + 26, W, ty - ly - 26);
        for (x = 14; x < W; x += 54) { c.fillStyle = 'rgba(0,0,0,.5)'; c.fillRect(x, ly + 26, 2, ty - ly - 26); c.fillStyle = 'rgba(255,220,180,.05)'; c.fillRect(x + 2, ly + 26, 1, ty - ly - 26); }
        c.fillStyle = lin(c, 0, ly + 26, 0, ly + 62, [[0, 'rgba(0,0,0,.6)'], [1, 'rgba(0,0,0,0)']]); c.fillRect(0, ly + 26, W, 36);
        if (lamp) glow(c, 335, 690, 400, 110, [255, 165, 85], .42);
        glow(c, 1455, 690, 220, 80, PINK, .26); glow(c, 1008, 640, 330, 60, WARM, .16);

        // fairy lights swagged across the top of the window
        var pins = [wx - 6, wx + ww / 3, wx + ww * 2 / 3, wx + ww + 6];
        for (i = 0; i < 3; i++) {
            var ax = pins[i], bx = pins[i + 1], ay = wy + 10, sag = 34;
            c.strokeStyle = 'rgba(0,0,0,.85)'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(ax, ay); c.quadraticCurveTo((ax + bx) / 2, ay + sag * 2, bx, ay); c.stroke();
            [.14, .38, .62, .86].forEach(function (q) {
                var px = (1 - q) * (1 - q) * ax + 2 * q * (1 - q) * (ax + bx) / 2 + q * q * bx, py = ay + 2 * q * (1 - q) * sag * 2 + 3;
                ell(px, py, 2.8, 3.4, '#4a4034');                              // the glow of each bulb is an HTML layer (#dn-fairy)
            });
        }

        // the frame: gilt moulding lit from above, a cream mount; the picture itself is an HTML layer on top
        var ox = 740, oy = 110, ow = 536, oh = 402, m = 20;
        c.save(); c.shadowColor = 'rgba(0,0,0,.78)'; c.shadowBlur = 38 * S; c.shadowOffsetY = 20 * S; c.fillStyle = '#1a1208'; c.fillRect(ox, oy, ow, oh); c.restore();
        quad([ox, oy, ox + ow, oy, ox + ow - m, oy + m, ox + m, oy + m], lin(c, 0, oy, 0, oy + m, [[0, '#f0d08c'], [.5, '#b89048'], [1, '#6f5223']]));
        quad([ox, oy + oh, ox + ow, oy + oh, ox + ow - m, oy + oh - m, ox + m, oy + oh - m], lin(c, 0, oy + oh - m, 0, oy + oh, [[0, '#3a2a10'], [.5, '#7a5c2a'], [1, '#2a1d0a']]));
        quad([ox, oy, ox + m, oy + m, ox + m, oy + oh - m, ox, oy + oh], lin(c, ox, 0, ox + m, 0, [[0, '#8f6f34'], [.5, '#c09a50'], [1, '#4f3a18']]));
        quad([ox + ow, oy, ox + ow - m, oy + m, ox + ow - m, oy + oh - m, ox + ow, oy + oh], lin(c, ox + ow - m, 0, ox + ow, 0, [[0, '#4f3a18'], [.5, '#a88443'], [1, '#7a5c2a']]));
        c.fillStyle = '#ece2ca'; c.fillRect(ox + m, oy + m, ow - 2 * m, oh - 2 * m);
        c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 3; c.strokeRect(ox + m + 1.5, oy + m + 1.5, ow - 2 * m - 3, oh - 2 * m - 3);
        c.fillStyle = '#cfc4aa'; c.fillRect(ART.x, ART.y, ART.w, ART.h);
        c.strokeStyle = '#fffaf0'; c.lineWidth = 2; c.strokeRect(ART.x - 1, ART.y - 1, ART.w + 2, ART.h + 2);
        c.fillStyle = lin(c, 0, oy, 0, oy + oh, [[0, 'rgba(20,10,0,0)'], [1, 'rgba(20,10,0,.42)']]); c.fillRect(ox, oy, ow, oh);
        // the picture light
        c.strokeStyle = '#6b5324'; c.lineWidth = 3; c.beginPath(); c.moveTo(958, oy); c.lineTo(958, 84); c.moveTo(1058, oy); c.lineTo(1058, 84); c.stroke();
        rr(896, 72, 224, 15, 7); c.fillStyle = lin(c, 0, 72, 0, 87, [[0, '#6b5324'], [.3, '#f0d49a'], [.6, '#8a6a30'], [1, '#33240c']]); c.fill();
        c.fillStyle = '#fff6dc'; c.fillRect(904, 87, 208, 2.5); glow(c, 1008, 92, 170, 30, [255, 225, 170], .85);

        // the jukebox: an arch-top cabinet edged in neon tube
        var jx = 1340, jw = 230, jc = jx + jw / 2, jr = jw / 2, jy = 315;
        function arch(inset) { c.beginPath(); c.moveTo(jx + inset, 740); c.lineTo(jx + inset, jy); c.arc(jc, jy, jr - inset, Math.PI, 0); c.lineTo(jx + jw - inset, 740); }
        arch(0); c.closePath(); c.fillStyle = lin(c, jx, 0, jx + jw, 0, [[0, '#07080d'], [.5, '#1b1d2b'], [1, '#06070b']]); c.fill();
        arch(3); c.lineWidth = 5; c.strokeStyle = lin(c, 0, 200, 0, 716, [[0, '#eef2f8'], [.2, '#5d6676'], [.45, '#cfd6e2'], [.7, '#3a404c'], [1, '#9aa2b0']]); c.stroke();
        function tube(inset, col, core, lw) {
            c.save(); c.shadowColor = rgba(col, 1); c.shadowBlur = 24 * S; c.strokeStyle = rgba(col, .95); c.lineWidth = lw; arch(inset); c.stroke();
            c.shadowBlur = 8 * S; c.stroke(); c.shadowBlur = 0; c.strokeStyle = core; c.lineWidth = lw * .38; c.stroke(); c.restore();
        }
        tube(15, PINK, '#ffe0f2', 7); tube(29, CYAN, '#e6ffff', 4);
        c.save(); c.beginPath(); c.moveTo(jx + 44, 440); c.lineTo(jx + 44, jy); c.arc(jc, jy, jr - 44, Math.PI, 0); c.lineTo(jx + jw - 44, 440); c.closePath();
        c.fillStyle = '#04050b'; c.fill(); c.clip();                           // the display, behind glass
        glow(c, jc, 370, 120, 120, [70, 90, 220], .26);
        c.font = '800 15px Inter, "Segoe UI", sans-serif'; c.textAlign = 'center'; try { c.letterSpacing = '3px'; } catch (e) {}
        c.shadowColor = '#ff9a2e'; c.shadowBlur = 10 * S; c.fillStyle = '#ffd08a'; c.fillText('ULTRON FM', jc + 1.5, 305); c.shadowBlur = 0;
        c.fillStyle = 'rgba(45,225,240,.35)'; c.fillRect(1392, 425, 126, 1);
        quad([jx + 44, 250, jx + 110, 244, jx + 60, 440, jx + 44, 440], 'rgba(255,255,255,.05)');
        c.restore();
        c.beginPath(); c.moveTo(jx + 44, 440); c.lineTo(jx + 44, jy); c.arc(jc, jy, jr - 44, Math.PI, 0); c.lineTo(jx + jw - 44, 440); c.closePath(); c.strokeStyle = '#b98a3c'; c.lineWidth = 2; c.stroke();
        rr(1380, 452, 150, 26, 4); c.fillStyle = '#03060a'; c.fill(); c.strokeStyle = 'rgba(45,225,240,.55)'; c.lineWidth = 1.2; c.stroke();
        for (i = 0; i < 8; i++) { var bc = [AMBER, PINK, CYAN][i % 3]; c.save(); c.shadowColor = rgba(bc, 1); c.shadowBlur = 9 * S; rr(1383 + i * 18.7, 490, 13, 13, 3); c.fillStyle = rgba(bc, .92); c.fill(); c.restore(); }
        c.save(); rr(1378, 522, 154, 230, 14); c.fillStyle = '#160904'; c.fill(); c.clip();      // the speaker, lit from inside
        glow(c, jc, 640, 105, 135, [255, 160, 60], .85);
        c.strokeStyle = 'rgba(6,3,2,.93)'; c.lineWidth = 2.6; c.beginPath();
        for (i = -260; i < 200; i += 13) { c.moveTo(1378 + i, 522); c.lineTo(1378 + i + 240, 762); c.moveTo(1532 - i, 522); c.lineTo(1532 - i - 240, 762); }
        c.stroke(); c.restore();
        rr(1378, 522, 154, 230, 14); c.strokeStyle = 'rgba(210,180,120,.55)'; c.lineWidth = 1.5; c.stroke();
        ell(jc, 604, 25, 25, '#0a0b10'); c.beginPath(); c.arc(jc, 604, 24, 0, 6.3); c.lineWidth = 3; c.strokeStyle = lin(c, 0, 580, 0, 628, [[0, '#f4f6fa'], [.5, '#5a6270'], [1, '#c8d0dc']]); c.stroke();
        glow(c, jc, 604, 14, 14, AMBER, .9);

        // the table: dark gloss that keeps every light in the room
        c.fillStyle = lin(c, 0, ty - 44, 0, ty, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,.66)']]); c.fillRect(0, ty - 44, W, 44);
        c.fillStyle = lin(c, 0, ty, 0, H, [[0, '#3d2a20'], [.14, '#2c1c15'], [1, '#100a08']]); c.fillRect(0, ty, W, H - ty);
        for (i = 0; i < 150; i++) {
            y = ty + 2 + r() * r() * (H - ty); x = r() * W - 200; var gl = 200 + r() * 700;
            c.strokeStyle = r() < .5 ? 'rgba(255,210,170,.04)' : 'rgba(0,0,0,.14)'; c.lineWidth = .7 + r() * 1.6;
            c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + gl / 2, y + (r() - .5) * 7, x + gl, y + (r() - .5) * 4); c.stroke();
        }
        soft(c, W, H, S, 11, function (L) {
            function refl(x, w2, col, a, d) { L.fillStyle = lin(L, 0, ty, 0, ty + d, [[0, rgba(col, a)], [1, rgba(col, 0)]]); L.fillRect(x, ty, w2, d); }
            refl(1350, 22, PINK, .8, 184); refl(1548, 22, PINK, .8, 184); refl(1368, 9, CYAN, .6, 150); refl(1541, 9, CYAN, .6, 150); refl(1382, 146, [255, 150, 60], .5, 160);
            refl(760, 496, [255, 205, 150], .30, 150);
            refl(52, 204, [110, 100, 240], .42, 170); refl(266, 200, [110, 100, 240], .42, 170); refl(476, 204, [150, 90, 220], .42, 170);
        }, 'screen');
        c.fillStyle = 'rgba(255,225,200,.2)'; c.fillRect(0, ty, W, 1.4);

        // the lamp: an amber glass dome, the warmest thing in the room
        var lx = 335;
        if (lamp) { glow(c, lx, 790, 520, 120, [255, 165, 85], .5); glow(c, lx, 764, 310, 64, [255, 180, 100], .5); glow(c, lx, 757, 120, 24, [255, 225, 170], .55); }
        ell(lx, 755, 47, 11, '#221608'); ell(lx, 750, 44, 10, lin(c, lx - 44, 0, lx + 44, 0, [[0, '#3a2a12'], [.35, '#e2c078'], [.6, '#8a6a30'], [1, '#2a1d0a']]));
        c.fillStyle = lin(c, lx - 4, 0, lx + 4, 0, [[0, '#5a4218'], [.4, '#f0d69a'], [1, '#4a3512']]); c.fillRect(lx - 4, 650, 8, 100);
        c.beginPath(); c.moveTo(lx - 72, 654); c.bezierCurveTo(lx - 72, 592, lx - 38, 562, lx, 562); c.bezierCurveTo(lx + 38, 562, lx + 72, 592, lx + 72, 654); c.closePath();
        var lg = c.createRadialGradient(lx, 640, 4, lx, 630, 100); lg.addColorStop(0, '#fff6d6'); lg.addColorStop(.38, '#ffc86e'); lg.addColorStop(.8, '#e67e24'); lg.addColorStop(1, '#a04a10'); c.fillStyle = lg; c.fill();
        if (!lamp) { c.fillStyle = lin(c, lx - 72, 0, lx + 72, 0, [[0, '#3a2414'], [.4, '#6e4828'], [1, '#22140a']]); c.fill(); }
        ell(lx, 654, 72, 6, lin(c, lx - 72, 0, lx + 72, 0, [[0, '#e8963c'], [.5, '#fff3cf'], [1, '#e8963c']])); ell(lx - 28, 594, 15, 8, 'rgba(255,255,255,.24)'); if (!lamp) ell(lx, 654, 72, 6, '#1c1009');
        if (lamp) { glow(c, lx, 624, 250, 210, [255, 180, 100], .55); glow(c, lx, 636, 90, 70, [255, 238, 200], .45); }

        // the cup: warm key light from the lamp on its left, a thin neon rim on its right
        function cup() {
        var cx = 660; c.save(); c.translate(0, -22);
        shade(c, cx + 46, 820, 130, 22, .6);
        ell(cx, 813, 86, 18, lin(c, cx - 86, 0, cx + 86, 0, [[0, '#fff0d0'], [.45, '#e6d6b8'], [.9, '#7d6c66'], [1, '#c0589a']]));
        ell(cx, 811, 62, 12, 'rgba(0,0,0,.14)');
        c.strokeStyle = lin(c, cx + 44, 0, cx + 80, 0, [[0, '#cfc3b0'], [.7, '#8a7f80'], [1, '#d060a4']]); c.lineWidth = 7; c.beginPath(); c.moveTo(cx + 44, 764); c.bezierCurveTo(cx + 78, 760, cx + 78, 798, cx + 40, 796); c.stroke();
        c.beginPath(); c.moveTo(cx - 48, 752); c.lineTo(cx - 43, 792); c.quadraticCurveTo(cx - 40, 809, cx, 809); c.quadraticCurveTo(cx + 40, 809, cx + 43, 792); c.lineTo(cx + 48, 752); c.closePath();
        c.fillStyle = lin(c, cx - 48, 0, cx + 48, 0, [[0, '#ffe6b8'], [.25, '#fbeccd'], [.68, '#bfae98'], [.92, '#7a6a72'], [1, '#e06ab0']]); c.fill();
        ell(cx, 752, 48, 10, '#f8eeda'); ell(cx, 753, 42, 8, lin(c, cx - 42, 0, cx + 42, 0, [[0, '#7d6f60'], [.5, '#c4b59d'], [1, '#efe2c8']]));
        ell(cx, 757, 24, 3.4, 'rgba(70,36,16,.5)');
        c.strokeStyle = '#c9ccd2'; c.lineWidth = 3; c.lineCap = 'round'; c.beginPath(); c.moveTo(cx + 54, 812); c.lineTo(cx + 84, 804); c.stroke(); c.lineCap = 'butt'; c.restore();
        }
        cup();

        // the sugar shaker and the leaves move, so paint() gives each its own small canvas; only the shaker's shadow is baked in here
        shade(c, 1216, 741, 44, 8, .55);
        function shaker() {
        rr(1186, 684, 28, 55, 3); c.fillStyle = lin(c, 1186, 0, 1214, 0, [[0, 'rgba(255,230,200,.34)'], [.3, 'rgba(255,255,255,.10)'], [.75, 'rgba(255,255,255,.05)'], [1, 'rgba(255,80,170,.5)']]); c.fill();
        c.fillStyle = 'rgba(240,235,225,.3)'; c.fillRect(1188, 706, 24, 31);
        c.beginPath(); c.moveTo(1184, 687); c.quadraticCurveTo(1200, 662, 1216, 687); c.closePath(); c.fillStyle = lin(c, 1184, 0, 1216, 0, [[0, '#f3e2c4'], [.4, '#6c717b'], [.7, '#d6dbe4'], [1, '#ff6bb8']]); c.fill();
        }

        // a cat on the sill, watching the rain: a dark shape, warm rim on the lamp side, neon rim on the other (own canvases: it breathes, the tail swings)
        function cat() {
            c.fillStyle = '#0a090f';
            c.beginPath(); c.moveTo(562, 622); c.bezierCurveTo(554, 586, 574, 558, 589, 549); c.lineTo(611, 549); c.bezierCurveTo(626, 558, 646, 586, 638, 622); c.closePath(); c.fill();
            c.beginPath(); c.moveTo(581, 531); c.lineTo(584, 505); c.lineTo(599, 520); c.closePath(); c.fill();
            c.beginPath(); c.moveTo(619, 531); c.lineTo(616, 505); c.lineTo(601, 520); c.closePath(); c.fill();
            ell(600, 536, 21, 18, '#0a090f');
            glow(c, 552, 588, 26, 70, [255, 175, 95], .62, 'source-atop'); glow(c, 578, 524, 14, 26, [255, 175, 95], .45, 'source-atop');
            glow(c, 648, 588, 24, 70, PINK, .58, 'source-atop'); glow(c, 622, 524, 13, 26, PINK, .45, 'source-atop'); glow(c, 600, 513, 30, 9, [150, 165, 255], .5, 'source-atop');
        }
        function tail() {
            c.lineCap = 'round'; c.strokeStyle = '#0a090f'; c.lineWidth = 9; c.beginPath(); c.moveTo(630, 618); c.bezierCurveTo(652, 628, 640, 652, 650, 668); c.stroke();
            glow(c, 657, 646, 12, 34, PINK, .55, 'source-atop');
        }
        // leaves in the near corner, rimmed in neon (blurred in CSS)
        function leaves() {
            var L = c;
            for (i = 0; i < 9; i++) {
                var an = Math.PI * (1.03 + i * .06 + r() * .04), ln = 180 + r() * 140, wd = 32 + r() * 26, bx0 = 1630, by0 = 950;
                var ex = bx0 + Math.cos(an) * ln, ey = by0 + Math.sin(an) * ln, nx = -Math.sin(an) * wd, ny = Math.cos(an) * wd, mx = (bx0 + ex) / 2, my = (by0 + ey) / 2;
                L.beginPath(); L.moveTo(bx0, by0); L.quadraticCurveTo(mx + nx, my + ny, ex, ey); L.quadraticCurveTo(mx - nx, my - ny, bx0, by0); L.closePath();
                L.fillStyle = i % 2 ? '#0a1a14' : '#12281d'; L.fill();
                L.beginPath(); L.moveTo(bx0, by0); L.quadraticCurveTo(mx - nx, my - ny, ex, ey); L.strokeStyle = 'rgba(255,80,170,.7)'; L.lineWidth = 3; L.stroke();
            }
        }

        // film grain over everything, so no surface is perfectly clean
        var n = document.createElement('canvas'); n.width = n.height = 128; var nc = n.getContext('2d'), id = nc.createImageData(128, 128), d = id.data;
        for (i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255 * r() | 0; d[i + 3] = 20; }
        nc.putImageData(id, 0, 0);
        c.save(); c.beginPath(); c.rect(0, 0, W, H); c.rect(wx, wy, ww, wh); c.clip('evenodd'); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'overlay'; c.fillStyle = c.createPattern(n, 'repeat'); c.fillRect(0, 0, c.canvas.width, c.canvas.height); c.restore();
    }

    function paint() {
        var S = Math.max(1, Math.min(1.6, Math.max(innerWidth, innerHeight * 16 / 9) * (window.devicePixelRatio || 1) / W));
        function put(name, c) { var ph = el.querySelector('[data-cv="' + name + '"]'); if (!ph) return; c.canvas.className = ph.className; c.canvas.style.cssText = ph.style.cssText; if (ph.id) c.canvas.id = ph.id; ph.parentNode.replaceChild(c.canvas, ph); }
        var c;
        c = canvas(WIN.w, WIN.h, S); paintOut(c, WIN.w, WIN.h, S); put('out', c);
        c = canvas(WIN.w, WIN.h, S); paintGlass(c, WIN.w, WIN.h); put('wet', c);
        c = canvas(WIN.w + RDX, WIN.h * 2, 1); paintRain(c, WIN.w, WIN.h, RDX, 170, 46, .17, 1, 5); put('rain-far', c);
        c = canvas(WIN.w + RDX, WIN.h * 2, 1); paintRain(c, WIN.w, WIN.h, RDX, 60, 120, .22, 1.7, 9); put('rain-near', c);
        c = canvas(WIN.w + RDX, WIN.h * 2, 1); paintSnow(c, WIN.w, WIN.h, RDX, 150, 13); put('snow-far', c);
        c = canvas(WIN.w + RDX, WIN.h * 2, 1); paintSnow(c, WIN.w, WIN.h, RDX, 70, 17, 1.7); put('snow-near', c);
        c = canvas(WIN.w, WIN.h, 1); c.fillStyle = lin(c, 0, 0, 0, WIN.h, [[0, 'rgba(196,206,245,.05)'], [1, 'rgba(196,206,245,.17)']]); c.fillRect(0, 0, WIN.w, WIN.h);
        fog0 = document.createElement('canvas'); fog0.width = WIN.w; fog0.height = WIN.h; fog0.getContext('2d').drawImage(c.canvas, 0, 0); fogC = c; put('fog', c);
        fwC = canvas(WIN.w, WIN.h, 1); put('fw', fwC);
        c = canvas(W, H, S); paintIn(c, S, true); put('in', c);
        [['shaker', SHK], ['leaves', LEAF], ['cat', CAT], ['tail', TAIL], ['cup2', CUP2]].forEach(function (d) { var q = canvas(d[1].w, d[1].h, S); q.translate(-d[1].x, -d[1].y); paintIn(q, S, true, d[0]); put(d[0], q); });
        paintOff = function () { paintOff = null; var q = canvas(W, H, S); paintIn(q, S, false); put('in0', q); };
        setTimeout(function () { if (paintOff) paintOff(); }, 1500);
    }

    function build() {
        var runs = '', eq = '', i;
        [[7, 19, -3], [19, 27, -14], [31, 16, -8], [46, 23, -19], [58, 31, -6], [72, 18, -11], [88, 25, -21], [95, 21, -2]].forEach(function (d) {
            runs += '<i class="dn-run" style="left:' + d[0] + '%;animation-duration:' + d[1] + 's;animation-delay:' + d[2] + 's"></i>';
        });
        for (i = 0; i < 12; i++) eq += '<i></i>';
        var bulbs = '', hots = '', pins = [WIN.x - 6, WIN.x + WIN.w / 3, WIN.x + WIN.w * 2 / 3, WIN.x + WIN.w + 6];
        for (i = 0; i < 3; i++) [.14, .38, .62, .86].forEach(function (q) {
            var ax = pins[i], bx = pins[i + 1], px = (1 - q) * (1 - q) * ax + 2 * q * (1 - q) * (ax + bx) / 2 + q * q * bx, py = WIN.y + 13 + 2 * q * (1 - q) * 68;
            bulbs += '<i style="left:' + pct(px - 60, W) + ';top:' + pct(py - 60, H) + '"></i>';
        });
        HOT.forEach(function (h) { hots += '<button type="button" class="dn-hot ' + h[6] + '" data-act="' + h[0] + '" data-tip="' + h[5] + '" aria-label="' + h[5] + '" style="' + box({ x: h[1], y: h[2], w: h[3], h: h[4] }) + '"></button>'; });
        el = document.createElement('div'); el.id = 'diner'; el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<div id="dn-stage">' +
            '<div id="dn-view" style="' + box(WIN) + '"><i data-cv="out" class="dn-fill dn-out"></i><i class="dn-aurora"></i><i class="dn-dawn"></i><i data-cv="fw" class="dn-fill"></i><i class="dn-car dn-car-a"></i><i class="dn-car dn-car-b"></i>' +
            '<i data-cv="rain-far" class="dn-rain dn-rain-far"></i><i data-cv="rain-near" class="dn-rain dn-rain-near"></i><i data-cv="snow-far" class="dn-rain dn-snow dn-snow-far"></i><i data-cv="snow-near" class="dn-rain dn-snow dn-snow-near"></i><i data-cv="wet" class="dn-fill"></i><i data-cv="fog" class="dn-fill"></i><i class="dn-bolt"></i>' + runs +
            '<svg class="dn-sign" viewBox="0 -34 120 154"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M30 -34V-2M90 -34V-2" stroke="#05060a" stroke-width="1.5"/>' +
            '<g class="dn-sp" stroke="#ff6fbd" stroke-width="4.5"><path d="M26 52h58v20a29 29 0 0 1-58 0z"/><path d="M84 58h7a11 11 0 0 1 0 22h-9"/><path d="M16 110h78"/></g>' +
            '<g class="dn-sc" stroke="#7cf3f8" stroke-width="4"><path d="M40 40q-8-10 0-20t0-18"/><path d="M56 40q-8-10 0-20t0-18"/><path d="M72 40q-8-10 0-20t0-18"/></g></g></svg></div>' +
            '<i data-cv="in0" class="dn-room"></i><i data-cv="in" id="dn-in" class="dn-room"></i><div id="dn-fairy">' + bulbs + '</div>' +
            '<div id="dn-art" style="' + box(ART) + '" data-act="art-next" title="Next painting"><img class="dn-img" alt=""><img class="dn-img" alt=""><i class="dn-lit"></i>' +
            '<button type="button" class="dn-nav dn-nav-l" data-act="art-prev" title="Back (Left)"><i class="fas fa-chevron-left"></i></button>' +
            '<button type="button" class="dn-nav dn-nav-r" data-act="art-next" title="Next (Space)"><i class="fas fa-chevron-right"></i></button></div>' +
            '<div id="dn-plaque"></div><i class="dn-dim" style="' + box(DIM) + '"><i></i></i><i class="dn-pulse"></i><div id="dn-eq">' + eq + '</div><div id="dn-jb-title"></div>' +
            '<i class="dn-cupin" style="' + box(COF) + '"><i></i></i><div class="dn-steam"><i></i><i></i><i></i></div>' +
            '<i data-cv="cat" class="dn-spr dn-cat" style="' + box(CAT) + '"></i><i data-cv="tail" class="dn-spr dn-tail" style="' + box(TAIL) + '"></i><i class="dn-hearts">&#9829;<b>&#9829;</b><u>&#9829;</u></i>' +
            '<i data-cv="cup2" class="dn-spr dn-cup2" style="' + box(CUP2) + '"></i><i data-cv="shaker" class="dn-spr dn-shaker" style="' + box(SHK) + '"></i><i class="dn-grains"></i><i data-cv="leaves" class="dn-spr dn-leaves" style="' + box(LEAF) + '"></i>' +
            '<i class="dn-book" style="' + box(BOOK) + '"><i></i></i><div id="dn-card"><b>The Third Cup</b><span>Ninth &amp; Lantern &middot; Lowlight</span></div>' +
            hots + '<div id="dn-toast"></div></div><i class="dn-vig"></i>' +
            '<div id="dn-now" class="dn-glass"><div class="dn-top"><div class="dn-cov"><i class="fas fa-music"></i><img id="dn-cover" alt=""></div>' +
            '<div class="dn-meta"><b id="dn-t">Nothing playing</b><span id="dn-a">Press play for music</span></div>' +
            '<button type="button" data-act="play" class="dn-main" title="Play / pause"><i id="dn-playi" class="fas fa-play"></i></button></div>' +
            '<div class="dn-bar"><i id="dn-prog"></i></div>' +
            '<div class="dn-more"><div><button type="button" data-act="prev" title="Previous song"><i class="fas fa-backward-step"></i></button>' +
            '<button type="button" data-act="next" title="Next song"><i class="fas fa-forward-step"></i></button>' +
            '<i class="fas fa-volume-low dn-vi"></i><input id="dn-vol" type="range" min="0" max="100" value="40" title="Volume">' +
            '<button type="button" data-act="link" title="Add music from a link (YouTube, YouTube Music)"><i class="fas fa-link"></i></button>' +
            '<button type="button" data-act="min" title="Hide the player (M)"><i class="fas fa-chevron-down"></i></button></div></div></div>' +
            '<button id="dn-dock" type="button" data-act="min" title="Show the player (M)"><i class="fas fa-music"></i></button>' +
            '<button id="dn-leave" type="button" title="Leave (Esc)"><i class="fas fa-xmark"></i></button>' +
            '<div id="dn-hint"><span id="dn-found"></span><b>Click things in the room</b><kbd>Space</kbd> next painting <kbd>&larr;</kbd> back <kbd>N</kbd> empty frame <kbd>M</kbd> hide player <kbd>B</kbd> guest book <kbd>Esc</kbd> leave</div>';
        document.body.appendChild(el);
        try { paint(); } catch (e) { console.error('diner paint', e); }
        imgs = Array.prototype.slice.call(el.querySelectorAll('.dn-img'));
        $('dn-leave').onclick = leave;
        $('dn-vol').addEventListener('input', function (e) { var A = au(); if (!A) return; A.volume = e.target.value / 100; A.muted = false; try { var v = $('vol'); if (v) { v.value = e.target.value; paintAudioVol(); } } catch (x) {} });
        // the window: a plain click changes the weather, a drag draws in the fog
        var hw = el.querySelector('[data-act="x-wx"]'), last = null, drew = false;
        function fogPt(e) { var b = fogC.canvas.getBoundingClientRect(); return [(e.clientX - b.left) / b.width * WIN.w, (e.clientY - b.top) / b.height * WIN.h]; }
        hw.addEventListener('pointerdown', function (e) { if (!fogC) return; last = fogPt(e); drew = false; try { hw.setPointerCapture(e.pointerId); } catch (x) {} });
        hw.addEventListener('pointermove', function (e) {
            if (!last || !(e.buttons & 1)) return; var q = fogPt(e); if (!drew && Math.abs(q[0] - last[0]) + Math.abs(q[1] - last[1]) < 6) return;
            drew = true; var g = [last[0], last[1], q[0], q[1], Date.now()]; segs.push(g); fogSeg(g, 1, 0); if (segs.length > 1) fogSeg(segs[segs.length - 2], 1, 1); fogSeg(g, 1, 1);
            last = q; if (!fogT) fogT = setInterval(fogDraw, 600);
        });
        hw.addEventListener('pointerup', function () { last = null; });
        el.addEventListener('click', function (e) {
            var t = e.target.closest ? e.target.closest('[data-act]') : null; if (!t) return; e.stopPropagation();
            if (t === hw && drew) { drew = false; mark('draw', t, ''); lore('draw', { n: segs.length }); return; }
            act(t.getAttribute('data-act'), t);
        });
        el.addEventListener('animationend', function (e) { if (e.target.classList && e.target.classList.contains('go')) e.target.classList.remove('go'); });
    }

    function load() {
        if (works) return Promise.resolve(works);
        if (!loading) loading = fetch('/api/art/list', { headers: { 'X-LMP': '1' } }).then(function (r) { return r.json(); })
            .then(function (j) { works = (j && j.works) || []; return works; }).catch(function () { loading = null; return []; });
        return loading;
    }
    function pick() {
        var all = works || [], pool = all.filter(function (w) { return seen.indexOf(w.id) < 0; });
        if (!pool.length) { seen = cur ? [cur.id] : []; pool = all.filter(function (w) { return !cur || w.id !== cur.id; }); }
        if (!pool.length) pool = all;
        return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    }
    // the little brass label under the frame
    function plaque(w) {
        var p = $('dn-plaque');
        p.innerHTML = w ? '<b>' + esc(w.title) + '</b>' + esc(w.artist) + (w.year ? ', ' + esc(w.year) : '') : '';
        p.classList.toggle('on', !!w);
    }
    function show(w, fade, back) {
        if (!w || !open) return;
        lore('art', { id: w.id });
        var url = w.url || '/art/' + w.id + '.jpg', im = new Image();
        im.onload = function () {
            if (!open || empty) return;
            var nu = imgs[1 - front], old = imgs[front];
            nu.style.transition = 'none'; nu.style.opacity = '0'; nu.src = url; void nu.getBoundingClientRect();
            nu.style.transition = 'opacity ' + fade + 'ms ease'; nu.style.opacity = '1';
            clearTimeout(fadeT); fadeT = setTimeout(function () { old.style.opacity = '0'; }, fade + 50);
            front = 1 - front;
            if (cur && !back) hist.push(cur);
            if (hist.length > 30) hist.shift();
            cur = w; if (seen.indexOf(w.id) < 0) seen.push(w.id);
            plaque(w);
        };
        im.onerror = function () { works = (works || []).filter(function (x) { return x.id !== w.id; }); var n = pick(); if (n && n.id !== w.id) show(n, fade, back); };
        im.src = url;
    }
    function next() { if (empty) { empty = false; } show(pick(), FADE); armDrift(); }
    function prev() { var w = hist.pop(); if (!w) return; empty = false; show(w, FADE, true); armDrift(); }
    function nothing() {
        empty = !empty; clearTimeout(fadeT); lore('empty', { on: empty });
        if (empty) { imgs.forEach(function (i) { i.style.transition = 'opacity 1.2s ease'; i.style.opacity = '0'; }); plaque(null); clearTimeout(driftT); }
        else next();
    }
    function armDrift() { clearTimeout(driftT); if (open && !empty) driftT = setTimeout(function () { if (!document.hidden) next(); else armDrift(); }, DRIFT_MS); }

    function wakeMouse() { if (!el) return; el.classList.add('mouse'); clearTimeout(mouseT); mouseT = setTimeout(function () { if (el) el.classList.remove('mouse'); }, MOUSE_MS); }

    var vol = 40, playing = false, hooks = null;
    function setText(id, t) { var n = $(id); if (n && n.textContent !== t) n.textContent = t; }
    function setPlaying(on) { playing = !!on; if (el) el.classList.toggle('playing', playing); }
    // the app's own music player (app.js): audio element, queue, togglePlay / nextTrack / prevTrack / shuffleAllMusic
    function au() { try { return typeof audio !== 'undefined' ? audio : null; } catch (e) { return null; } }
    function track() { try { return queue[order[pos]] || null; } catch (e) { return null; } }
    function hasQueue() { try { return !!(queue && queue.length); } catch (e) { return false; } }
    function trim(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
    function sync() {
        var a = au(); if (!el) return;
        var t = track();
        if (a) vol = Math.round((a.muted ? 0 : a.volume) * 100);
        setPlaying(!!(a && t && !a.paused));
        setText('dn-jb-title', t ? trim(t.title, 24) : (lore('radio') || 'press play'));
        setText('dn-t', t ? t.title : 'Nothing playing'); setText('dn-a', t ? (t.artist || '') : 'Press play for music');
        var im = $('dn-cover'); if (im) { var u = t && t.cover || ''; if (im.getAttribute('data-u') !== u) { im.setAttribute('data-u', u); if (u) im.src = u; else im.removeAttribute('src'); } im.style.visibility = u ? 'visible' : 'hidden'; }
        var pg = $('dn-prog'); if (pg) pg.style.width = (a && t && a.duration ? Math.min(100, a.currentTime / a.duration * 100) : 0) + '%';
        var vs = $('dn-vol'); if (vs && document.activeElement !== vs) vs.value = vol;
        var pi = $('dn-playi'); if (pi) pi.className = 'fas ' + (playing ? 'fa-pause' : 'fa-play');
    }
    function music(a) {
        var A = au(); if (!A) return;
        if (a === 'play') {
            if (!hasQueue()) { try { shuffleAllMusic(); } catch (e) {} } else { try { togglePlay(); } catch (e) {} }
        } else if (a === 'next') { try { if (hasQueue()) nextTrack(false); } catch (e) {} }
        else if (a === 'prev') { try { if (hasQueue()) prevTrack(); } catch (e) {} }
        setTimeout(sync, 60);
    }
    // the state of the room (kept between visits)
    var st = { lamp: 1, fairy: 0, sign: 1, wx: 0, pic: 1 }, sip = 0, pets = 0, refills = 0, found = {}, FOUND = 12;
    var IDS = { 'x-lamp': 'lamp', 'x-fairy': 'fairy', 'x-sign': 'sign', 'x-wx': 'wx', 'x-pic': 'pic', 'x-sip': 'sip', 'x-sugar': 'sugar', 'x-leaves': 'leaves', 'x-zoom': 'zoom', 'x-cat': 'cat', 'x-shuffle': 'juke' };
    try { (JSON.parse(localStorage.getItem('ultron_diner_found') || '[]') || []).forEach(function (k) { found[k] = 1; }); } catch (e) {}
    function nFound() { return Object.keys(found).length; }
    // count a thing the first time it is used; the last one sets off the fireworks
    function lore(ev, d) { try { return window.dinerLore ? window.dinerLore.on(ev, d || {}) : null; } catch (e) { console.error('diner lore', e); return null; } }
    var API = { toast: toast, state: function () { return { st: st, sip: sip, empty: empty, playing: playing, art: cur ? cur.title : '' }; }, set: function (k, v) { st[k] = v; applyRoom(); }, own: function () { var w = ownArt(); if (!w) return; addOwn(w); empty = false; show(w, FADE); armDrift(); } };
    function addOwn(w) { if (works && !works.some(function (x) { return x.id === '_juno'; })) works.push(w); }
    // Juno's painting is this room, seen from your stool
    function ownArt() {
        try {
            var o = el.querySelector('canvas.dn-out'), r = $('dn-in'), k = r.width / W, q = document.createElement('canvas'), c = q.getContext('2d');
            var sx = 0, sy = 60, sw = 1136, sh = 800; q.width = 904; q.height = 636; var f = q.width / sw;
            c.filter = 'saturate(1.2) contrast(.92) blur(.6px)';
            c.drawImage(o, (WIN.x - sx) * f, (WIN.y - sy) * f, WIN.w * f, WIN.h * f);
            c.drawImage(r, sx * k, sy * k, sw * k, sh * k, 0, 0, q.width, q.height);
            return { id: '_juno', title: 'The Third Cup, 3 a.m.', artist: 'Juno', year: '', url: q.toDataURL('image/jpeg', .9) };
        } catch (e) { return null; }
    }
    function mark(id, t, say) {
        if (id && !found[id]) {
            found[id] = 1; try { localStorage.setItem('ultron_diner_found', JSON.stringify(Object.keys(found))); } catch (e) {}
            say = (say ? say + '   ' : '') + (lore('found', { id: id }) || '\u2605 ' + nFound() + '/' + FOUND); applyRoom();
            if (nFound() >= FOUND) setTimeout(function () { if (!open) return; toast(el.querySelector('[data-act="x-fw"]'), 'You found everything'); fireworks(); }, 1900);
        }
        if (say) toast(t, say);
    }
    try { var sv = JSON.parse(localStorage.getItem('ultron_diner_room') || '{}'); Object.keys(st).forEach(function (k) { if (typeof sv[k] === 'number') st[k] = sv[k]; }); } catch (e) {}
    function applyRoom() {
        if (!el) return; var c = el.classList;
        if (!st.lamp && paintOff) paintOff();
        c.toggle('lamp-off', !st.lamp); c.toggle('fairy-tw', st.fairy === 1); c.toggle('fairy-off', st.fairy === 2); c.toggle('sign-off', !st.sign);
        c.toggle('wx-storm', st.wx === 1); c.toggle('wx-snow', st.wx === 2); c.toggle('wx-clear', st.wx === 3); c.toggle('wx-aurora', st.wx === 4); c.toggle('wx-dawn', st.wx === 5); c.toggle('pic-off', !st.pic); c.toggle('cup-empty', sip >= 4);
        el.style.setProperty('--sip', Math.min(sip, 4));
        var n = nFound(), f = $('dn-found'), fw = el.querySelector('[data-act="x-fw"]');
        if (f) f.textContent = lore('count') || '\u2605 ' + n + '/' + FOUND + ' found'; if (fw) fw.setAttribute('data-tip', n >= FOUND ? 'Fireworks' : '???');
        try { localStorage.setItem('ultron_diner_room', JSON.stringify(st)); } catch (e) {}
    }
    function kick(sel) { var n = el.querySelector(sel); if (!n) return; n.classList.remove('go'); void n.getBoundingClientRect(); n.classList.add('go'); }
    function toast(t, text) {
        var n = $('dn-toast'); if (!n || !t) return; n.textContent = text;
        n.style.left = (parseFloat(t.style.left) + parseFloat(t.style.width) / 2) + '%'; n.style.top = (parseFloat(t.style.top) + parseFloat(t.style.height) / 2) + '%'; kick('#dn-toast');
    }
    function room(a, t) {
        var say = '';
        if (a === 'x-lamp') { st.lamp = st.lamp ? 0 : 1; say = st.lamp ? 'Lamp on' : 'Lamp off'; }
        else if (a === 'x-fairy') { st.fairy = (st.fairy + 1) % 3; say = ['Fairy lights on', 'Twinkle', 'Fairy lights off'][st.fairy]; }
        else if (a === 'x-sign') { st.sign = st.sign ? 0 : 1; if (st.sign) kick('.dn-sign'); say = st.sign ? 'Neon on' : 'Neon off'; }
        else if (a === 'x-wx') { var ns = lore('nights') || [0, 1, 2, 3]; st.wx = ns[(ns.indexOf(st.wx) + 1) % ns.length]; say = ['Rain', 'Downpour', 'Snow', 'Clear night', 'The fifth night', 'First morning'][st.wx]; }
        else if (a === 'x-pic') { st.pic = st.pic ? 0 : 1; say = st.pic ? 'Picture light on' : 'Picture light off'; }
        else if (a === 'x-sip') { if (sip >= 4) { sip = 0; refills++; say = 'Refilled'; } else { sip++; say = sip >= 4 ? 'Empty. Click for a refill' : 'Sip'; } }
        else if (a === 'x-sugar') { kick('.dn-shaker'); kick('.dn-grains'); say = 'A little sugar'; }
        else if (a === 'x-leaves') { kick('.dn-leaves'); }
        else if (a === 'x-zoom') { el.classList.toggle('zoom'); }
        else if (a === 'x-cat') { kick('.dn-cat'); kick('.dn-tail'); kick('.dn-hearts'); say = ['Purr', 'Purrrr', 'Mrrp'][pets++ % 3]; }
        else if (a === 'x-shuffle') { try { shuffleAllMusic(); } catch (e) {} setTimeout(sync, 80); say = 'Shuffle'; }
        else if (a === 'x-book') { lore('book'); return; }
        else if (a === 'x-juno') { lore('juno'); return; }
        else if (a === 'x-fw') { if (nFound() >= FOUND) fireworks(); else toast(t, 'Locked. Find everything first: \u2605 ' + nFound() + '/' + FOUND); return; }
        if (!st.lamp && st.fairy === 2 && !st.sign && !st.pic && /lamp|fairy|sign|pic/.test(a)) say = 'Lights out. Just the city now.';
        applyRoom(); mark(IDS[a], t, say); lore('room', { a: a, st: st, pets: pets, refills: refills });
    }
    function act(a, t) {
        if (a.indexOf('x-') === 0) { room(a, t); return; }
        if (a === 'min') { el.classList.toggle('jb-min'); return; }
        if (a === 'art-next') { next(); return; }
        if (a === 'art-prev') { prev(); return; }
        if (a === 'link') { try { leave(); switchTab('dl-view', 'tab-dl'); } catch (e) {} }
        else { music(a); if (a === 'next') lore('skip'); if (a === 'play') lore('play'); if (t && t.classList.contains('dn-hot')) mark('juke', t, a === 'next' ? 'Next song' : ''); }
        try { if (hooks) hooks(a, vol); } catch (e) { console.error(e); }
    }
    function onKey(e) {
        if (!open) return;
        var kr = lore('key', { k: e.key }); if (kr) { if (kr !== 'pass') { e.preventDefault(); e.stopPropagation(); } return; }
        var k = e.key, used = true;
        if (k === 'm' || k === 'M') { act('min'); e.preventDefault(); e.stopPropagation(); return; }
        if (k === 'Escape') { if (el.classList.contains('zoom')) el.classList.remove('zoom'); else leave(); }
        else if (k === ' ' || k === 'ArrowRight') next();
        else if (k === 'ArrowLeft') prev();
        else if (k === 'n' || k === 'N') nothing();
        else used = false;
        if (used || !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); }
    }

    function enter() {
        if (open) return;
        if (!el) build();
        open = true; empty = false; hist = []; seen = []; cur = null;
        imgs.forEach(function (i) { i.style.transition = 'none'; i.style.opacity = '0'; i.removeAttribute('src'); });
        plaque(null); el.classList.remove('zoom'); lore('enter', { el: el, found: Object.keys(found), api: API }); applyRoom(); kick('#dn-card');
        document.documentElement.classList.add('diner-open');
        requestAnimationFrame(function () { if (open) el.classList.add('on'); });
        load().then(function () { if (open) { if (lore('own')) { var jw = ownArt(); if (jw) addOwn(jw); } show(pick(), 1500); armDrift(); } });
        sync(); clearInterval(syncT); syncT = setInterval(sync, 1000);
        wakeMouse(); clearTimeout(mouseT); mouseT = setTimeout(function () { if (el) el.classList.remove('mouse'); }, 6000);
    }
    function leave() {
        if (!open) return; open = false; lore('leave');
        [driftT, fadeT].forEach(clearTimeout); clearInterval(syncT);
        document.documentElement.classList.remove('diner-open');
        if (el) el.classList.remove('on');
    }
    addEventListener('keydown', onKey, true);
    var parT = 0;                                          // the street and the near leaves shift a little with the mouse, like moving your head
    addEventListener('mousemove', function (e) {
        if (!open) return; wakeMouse(); if (parT) return;
        parT = requestAnimationFrame(function () {
            parT = 0; if (!el) return;
            el.style.setProperty('--px', ((e.clientX / innerWidth - .5) * 2).toFixed(3)); el.style.setProperty('--py', ((e.clientY / innerHeight - .5) * 2).toFixed(3));
        });
    }, { passive: true });
    // /#diner opens straight into the room
    if (/(^|[#&])diner\b/.test(location.hash)) addEventListener('load', function () { setTimeout(enter, 200); });

    window.diner = { onCommand: function (fn) { hooks = fn; }, setNowPlaying: function (title, time, on) { setText('dn-jb-title', title || 'press play'); if (on != null) setPlaying(on); },
                     open: enter, close: leave, toggle: function () { open ? leave() : enter(); }, isOpen: function () { return open; } };
})();
