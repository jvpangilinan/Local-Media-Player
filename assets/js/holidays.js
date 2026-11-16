/* Holiday themes: ULTRON knows the date. On a holiday (or your birthday) the accent colours follow the day and a quiet effect
   plays behind the page: snow at Christmas, bats at Halloween, sparkles at New Year, lanterns at Lunar New Year, hearts on
   Valentine's Day, petals at Easter, candle embers on All Saints / All Souls, confetti on your birthday.
   Prefs: holidays (on / off), birthday ("MM-DD" or ""). Sets html[data-occasion]; the palettes are in holidays.css.
   The effect is one small canvas behind the page (z-below, like flair's dust): 30 fps, stops while a video plays, when the
   window is hidden, with reduced motion, Minimal UI or Plain mode (Plain also drops the colours).
   Settings > Appearance > Holiday themes (#hol-*): on / off, your birthday, "what's next", and a Preview that lasts until reload. */
(function () {
    'use strict';
    var D = document, R = D.documentElement;
    var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    function $(i) { return D.getElementById(i); }
    function pref() { try { return (typeof prefs !== 'undefined' && prefs) || {}; } catch (e) { return {}; } }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function md(d) { return pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function day0(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
    function within(k, a, b) { return k >= a && k <= b; }               // "MM-DD" strings compare in date order
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function rnd(a, b) { return a + Math.random() * (b - a); }

    /* ---------- the calendar ---------- */
    var LUNAR = { 2025: '01-29', 2026: '02-17', 2027: '02-06', 2028: '01-26', 2029: '02-13', 2030: '02-03', 2031: '01-23',
                  2032: '02-11', 2033: '01-31', 2034: '02-19', 2035: '02-08', 2036: '01-28' };
    function easter(y) {                                                  // Western Easter Sunday (anonymous Gregorian algorithm)
        var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
            g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
            l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31);
        return new Date(y, mo - 1, ((h + l - 7 * m + 114) % 31) + 1);
    }
    var EV = {
        newyear:   { name: 'New Year',               fx: 'sparkle', hello: 'Happy New Year!', days: { '12-31': 'The last night of the year.' } },
        lunar:     { name: 'Lunar New Year',         fx: 'lantern', hello: 'Happy Lunar New Year!' },
        valentine: { name: "Valentine's Day",        fx: 'hearts',  hello: "Happy Valentine's Day." },
        easter:    { name: 'Easter',                 fx: 'petals',  hello: 'Happy Easter.' },
        halloween: { name: 'Halloween',              fx: 'bats',    hello: 'Halloween week. Something is flying around in here.', days: { '10-31': 'Happy Halloween.' } },
        souls:     { name: 'All Saints & All Souls', fx: 'embers',  hello: 'All Souls. A candle for the ones we miss.', days: { '11-01': "All Saints' Day. A candle for the ones we miss." } },
        xmas:      { name: 'Christmas',              fx: 'snow',    hello: 'Christmas season. It is snowing in here.', days: { '12-24': 'Christmas Eve.', '12-25': 'Merry Christmas!' } },
        birthday:  { name: 'Your birthday',          fx: 'confetti', hello: 'Happy birthday!' }
    };
    var ORDER = ['newyear', 'lunar', 'valentine', 'easter', 'halloween', 'souls', 'xmas', 'birthday'];
    function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

    // which occasion a date falls on ('' = none). bday is "MM-DD" or ''.
    function which(date, bday) {
        var d = day0(date), k = md(d), y = d.getFullYear();
        if (bday && (bday === k || (bday === '02-29' && k === '02-28' && !isLeap(y)))) return 'birthday';
        if (k === '12-31' || k === '01-01') return 'newyear';
        var l = LUNAR[y];
        if (l) { var ld = new Date(y, +l.slice(0, 2) - 1, +l.slice(3)); if (d >= ld && d < addDays(ld, 3)) return 'lunar'; }   // the first three days
        if (k === '02-14') return 'valentine';
        var e = easter(y); if (d >= e && d <= addDays(e, 1)) return 'easter';                                                 // Sunday and Monday
        if (within(k, '10-25', '10-31')) return 'halloween';
        if (within(k, '11-01', '11-02')) return 'souls';
        if (within(k, '12-01', '12-26')) return 'xmas';
        return '';
    }
    // the next occasion after today's: { key, days } or null
    function upcoming(date, bday) {
        var d = day0(date), now = which(d, bday);
        for (var i = 1; i <= 400; i++) { var o = which(addDays(d, i), bday); if (o && o !== now) return { key: o, days: i }; }
        return null;
    }

    /* ---------- the effect canvas ---------- */
    var fx = (function () {
        var c = null, x = null, kind = '', ps = [], raf = 0, last = 0, W = 0, H = 0, nextBat = 0, glow = null;
        var PAL = [[255, 255, 255], [255, 255, 255], [255, 255, 255]];
        function readPal() {
            var cs = getComputedStyle(R);
            ['--pr1rgb', '--pr2rgb', '--pr3rgb'].forEach(function (v, i) {
                var m = cs.getPropertyValue(v).split(',').map(Number);
                if (m.length === 3 && m.every(isFinite)) PAL[i] = m;
            });
        }
        function rgba(col, a) { return 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + a + ')'; }
        function live() { return !!kind && !reduce && !D.hidden && !R.classList.contains('in-player') && !R.classList.contains('lm-lite') && !R.classList.contains('lm-plain'); }
        function ensure() {
            if (c) return;
            c = D.createElement('canvas'); c.id = 'hol-fx'; c.setAttribute('aria-hidden', 'true');
            D.body.appendChild(c); x = c.getContext('2d');
            addEventListener('resize', function () { fit(); fill(); });
            D.addEventListener('visibilitychange', start);
            new MutationObserver(start).observe(R, { attributes: true, attributeFilter: ['class'] });
            fit();
        }
        function fit() {
            var r = Math.min(window.devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight;
            c.width = Math.round(W * r); c.height = Math.round(H * r); x.setTransform(r, 0, 0, r, 0, 0); glow = null;
        }
        // how many of each, scaled to the window
        var DENS = { snow: [26000, 18, 60], hearts: [70000, 8, 18], sparkle: [38000, 16, 40], lantern: [120000, 5, 11],
                     petals: [55000, 10, 26], embers: [60000, 10, 26], confetti: [36000, 16, 44], bats: [1, 0, 0] };
        function want() { var d = DENS[kind]; return d ? Math.round(clamp(W * H / d[0], d[1], d[2])) : 0; }
        function make(fresh) {
            var p = { x: rnd(0, W), y: fresh ? rnd(0, H) : 0, t: rnd(0, 6.283), c: (Math.random() * 3) | 0 };
            switch (kind) {
                case 'snow': p.r = rnd(1, 3.2); p.vy = .25 + p.r * .22; p.sw = rnd(.3, 1); p.a = rnd(.35, .8); if (!fresh) p.y = -6; break;
                case 'hearts': p.s = rnd(7, 15); p.vy = -rnd(.25, .6); p.a = rnd(.25, .5); if (!fresh) p.y = H + 20; break;
                case 'sparkle': p.s = rnd(3, 7.5); p.vy = -rnd(.03, .12); p.sp = rnd(.03, .07); break;
                case 'lantern': p.s = rnd(9, 18); p.vy = -rnd(.18, .4); p.a = rnd(.55, .85); if (!fresh) p.y = H + 40; break;
                case 'petals': p.s = rnd(4, 8); p.vy = rnd(.3, .7); p.rot = rnd(0, 6.283); p.vr = rnd(-.03, .03); p.a = rnd(.45, .75);
                    p.col = [[247, 198, 217], [215, 196, 245], [251, 234, 165], [191, 238, 221]][(Math.random() * 4) | 0]; if (!fresh) p.y = -10; break;
                case 'embers': p.r = rnd(.8, 2.2); p.vy = -rnd(.2, .55); p.top = rnd(.35, .7); if (fresh) p.y = rnd(H * .5, H); else p.y = H + 4; break;
                case 'confetti': p.w = rnd(4, 8); p.h = rnd(2, 4); p.vy = rnd(.35, .8); p.rot = rnd(0, 6.283); p.vr = rnd(-.06, .06); p.a = rnd(.45, .8); if (!fresh) p.y = -10; break;
            }
            return p;
        }
        function fill() { var n = want(); while (ps.length < n) ps.push(make(true)); ps.length = n; }
        function bat() {                                                    // one bat crossing the window, left or right
            var ltr = Math.random() < .5;
            return { bat: true, ltr: ltr, x: ltr ? -40 : W + 40, y0: rnd(H * .08, H * .55), y: 0, s: rnd(18, 32), vx: rnd(1.4, 2.4) * (ltr ? 1 : -1), t: rnd(0, 6.283), bob: rnd(10, 30) };
        }
        function heart(s) {
            x.beginPath(); x.moveTo(0, s * .3);
            x.bezierCurveTo(0, 0, -s * .5, 0, -s * .5, s * .3); x.bezierCurveTo(-s * .5, s * .6, 0, s * .8, 0, s);
            x.bezierCurveTo(0, s * .8, s * .5, s * .6, s * .5, s * .3); x.bezierCurveTo(s * .5, 0, 0, 0, 0, s * .3); x.fill();
        }
        function star(s) {
            x.beginPath(); x.moveTo(0, -s); x.quadraticCurveTo(0, 0, s, 0); x.quadraticCurveTo(0, 0, 0, s);
            x.quadraticCurveTo(0, 0, -s, 0); x.quadraticCurveTo(0, 0, 0, -s); x.fill();
        }
        function wing(s, f) {                                               // right wing + half body; f = flap (-1..1)
            var ty = -s * .55 * f;
            x.beginPath(); x.moveTo(0, -s * .14);
            x.quadraticCurveTo(s * .45, -s * .3 + ty * .5, s, ty);
            x.quadraticCurveTo(s * .82, s * .06 + ty * .35, s * .64, s * .1 + ty * .25);
            x.quadraticCurveTo(s * .5, s * .02 + ty * .2, s * .34, s * .18 + ty * .1);
            x.quadraticCurveTo(s * .2, s * .08, 0, s * .26);
            x.closePath(); x.fill();
        }
        function backdrop() {                                               // soft light that belongs to the occasion
            if (kind !== 'bats' && kind !== 'embers') return;
            if (!glow) {
                if (kind === 'bats') { glow = x.createRadialGradient(W * .86, H * .14, 0, W * .86, H * .14, Math.min(W, H) * .42); glow.addColorStop(0, 'rgba(255,150,60,.13)'); glow.addColorStop(1, 'rgba(255,150,60,0)'); }
                else { glow = x.createLinearGradient(0, H, 0, H * .55); glow.addColorStop(0, 'rgba(255,170,80,.10)'); glow.addColorStop(1, 'rgba(255,170,80,0)'); }
            }
            x.fillStyle = glow; x.fillRect(0, 0, W, H);
        }
        function frame(ts) {
            raf = 0;
            if (!live()) { if (x) x.clearRect(0, 0, W, H); return; }
            raf = requestAnimationFrame(frame);
            if (ts - last < 33) return; last = ts;
            x.clearRect(0, 0, W, H); backdrop();
            if (kind === 'bats') {
                if (ts > nextBat && ps.length < 3) { ps.push(bat()); nextBat = ts + rnd(5000, 14000); }
                x.shadowColor = 'rgba(255,140,40,.55)'; x.shadowBlur = 12; x.fillStyle = 'rgba(22,12,30,.92)';
                for (var b = ps.length - 1; b >= 0; b--) {
                    var q = ps[b]; q.t += .45; q.x += q.vx; q.y = q.y0 + Math.sin(q.t * .12) * q.bob;
                    if (q.x < -60 || q.x > W + 60) { ps.splice(b, 1); continue; }
                    var f = Math.sin(q.t);
                    x.save(); x.translate(q.x, q.y); wing(q.s, f); x.scale(-1, 1); wing(q.s, f); x.restore();
                }
                x.shadowBlur = 0; return;
            }
            for (var i = 0; i < ps.length; i++) {
                var p = ps[i]; p.t += .03;
                switch (kind) {
                    case 'snow':
                        p.y += p.vy; p.x += Math.sin(p.t) * p.sw * .5;
                        if (p.y > H + 6) ps[i] = make(false);
                        x.fillStyle = 'rgba(255,255,255,' + p.a + ')'; x.beginPath(); x.arc(p.x, p.y, p.r, 0, 6.283); x.fill(); break;
                    case 'hearts':
                        p.y += p.vy; p.x += Math.sin(p.t) * .35;
                        if (p.y < -30) ps[i] = make(false);
                        x.fillStyle = rgba(PAL[p.c === 2 ? 0 : 1], p.a); x.save(); x.translate(p.x, p.y); x.rotate(Math.sin(p.t) * .25); heart(p.s); x.restore(); break;
                    case 'sparkle':
                        p.t += p.sp; p.y += p.vy; if (p.y < -10) { p.y = H + 10; p.x = rnd(0, W); }
                        var tw = Math.max(0, Math.sin(p.t)); if (tw < .02) break;
                        x.fillStyle = rgba(PAL[p.c === 2 ? 2 : 0], .9 * tw); x.save(); x.translate(p.x, p.y); star(p.s * (.6 + .4 * tw)); x.restore(); break;
                    case 'lantern':
                        p.y += p.vy; p.x += Math.sin(p.t * .6) * .25;
                        if (p.y < -60) ps[i] = make(false);
                        var s = p.s, g = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, s * 2.4);
                        g.addColorStop(0, 'rgba(255,120,50,' + (.3 * p.a) + ')'); g.addColorStop(1, 'rgba(255,120,50,0)');
                        x.fillStyle = g; x.fillRect(p.x - s * 2.4, p.y - s * 2.4, s * 4.8, s * 4.8);
                        x.fillStyle = 'rgba(214,40,40,' + p.a + ')'; x.beginPath(); x.ellipse(p.x, p.y, s * .62, s * .5, 0, 0, 6.283); x.fill();
                        x.fillStyle = 'rgba(255,200,90,' + p.a + ')'; x.fillRect(p.x - s * .28, p.y - s * .58, s * .56, s * .12); x.fillRect(p.x - s * .28, p.y + s * .46, s * .56, s * .12); break;
                    case 'petals':
                        p.y += p.vy; p.x += Math.sin(p.t) * .6; p.rot += p.vr;
                        if (p.y > H + 12) ps[i] = make(false);
                        x.fillStyle = rgba(p.col, p.a); x.beginPath(); x.ellipse(p.x, p.y, p.s, p.s * .5, p.rot, 0, 6.283); x.fill(); break;
                    case 'embers':
                        p.y += p.vy; p.x += Math.sin(p.t * 2) * .2;
                        var life = (p.y - H * (1 - p.top)) / (H * p.top);           // 1 at the bottom, 0 where it fades out
                        if (life <= 0) { ps[i] = make(false); break; }
                        x.fillStyle = 'rgba(255,' + (150 + ((p.c * 30) | 0)) + ',70,' + (.7 * life * (.6 + .4 * Math.sin(p.t * 5))) + ')';
                        x.beginPath(); x.arc(p.x, p.y, p.r, 0, 6.283); x.fill(); break;
                    case 'confetti':
                        p.y += p.vy; p.x += Math.sin(p.t) * .5; p.rot += p.vr;
                        if (p.y > H + 10) ps[i] = make(false);
                        x.fillStyle = rgba(PAL[p.c], p.a); x.save(); x.translate(p.x, p.y); x.rotate(p.rot); x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.t * 2))); x.restore(); break;
                }
            }
        }
        function start() { if (!raf && live()) raf = requestAnimationFrame(frame); }
        return {
            set: function (k) {
                if (k === kind) return;
                kind = k || ''; ps = []; glow = null; nextBat = 0;
                if (!kind) { if (x) x.clearRect(0, 0, W, H); return; }
                ensure(); readPal(); fill(); start();
            }
        };
    })();

    /* ---------- applying it ---------- */
    var cur = null, preview = '';
    function bday() { var b = pref().birthday; return typeof b === 'string' ? b : ''; }
    function want() { if (preview) return preview; if (pref().holidays === false) return ''; return which(new Date(), bday()); }
    // one greeting per occasion per year, plus one on each special day (Dec 24, Dec 25, Oct 31...); a preview always greets
    var pending = '';
    function greet(k, force) {
        var d = new Date(), day = EV[k].days && EV[k].days[md(d)], text = day || EV[k].hello,
            id = k + ':' + d.getFullYear() + (day ? ':' + md(d) : '');
        if (!force) {
            var seen; try { seen = localStorage.getItem('ultron_hol_seen'); } catch (e) { return; }
            if (seen === id || pending === id) return;
            pending = id;
        }
        setTimeout(function () {
            if (!force) {
                pending = '';
                if (want() !== k) return;                                   // the saved prefs arrived meanwhile and said off
                try { localStorage.setItem('ultron_hol_seen', id); } catch (e) {}
            }
            if (typeof toast === 'function') toast(text, 5000);
        }, force ? 0 : 1800);
    }
    function apply() {
        var k = want();
        if (k !== cur) {
            cur = k;
            if (k) R.setAttribute('data-occasion', k); else R.removeAttribute('data-occasion');
            fx.set(k ? EV[k].fx : '');
        }
        if (k && !preview) greet(k, false);
        paintRow();
    }

    /* ---------- Settings row ---------- */
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function opt(sel, v, t) { var o = D.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
    function paintRow() {
        var a = $('hol-on'), b = $('hol-off'); if (!a) return;
        var on = pref().holidays !== false; a.classList.toggle('on', on); b.classList.toggle('on', !on);
        var tr = $('hol-try');
        if (tr && tr.options.length < 2) { opt(tr, '', 'Preview a holiday...'); ORDER.forEach(function (k) { opt(tr, k, EV[k].name); }); }
        if (tr) tr.value = preview || '';
        var bm = $('hol-bm'), bd = $('hol-bd');
        if (bm && bm.options.length < 2) {
            opt(bm, '', 'Month'); MONTHS.forEach(function (m, i) { opt(bm, pad(i + 1), m); });
            opt(bd, '', 'Day'); for (var i = 1; i <= 31; i++) opt(bd, pad(i), String(i));
        }
        var bv = bday(); if (bm && D.activeElement !== bm && D.activeElement !== bd) { bm.value = bv.slice(0, 2); bd.value = bv.slice(3); }
        var n = $('hol-now'); if (!n) return;
        if (preview) n.textContent = 'Previewing ' + EV[preview].name + '. Reload or pick "Preview a holiday..." to go back.';
        else if (!on) n.textContent = 'Off.';
        else {
            var t = which(new Date(), bv), u = upcoming(new Date(), bv);
            n.textContent = (t ? 'Today: ' + EV[t].name + '. ' : '') + (u ? 'Next: ' + EV[u.key].name + (u.days === 1 ? ' tomorrow.' : ' in ' + u.days + ' days.') : '');
        }
    }
    window.holidays = {
        which: which, upcoming: upcoming,
        set: function (on) { if (typeof setPref === 'function') setPref({ holidays: !!on }); },
        preview: function (k) { preview = EV[k] ? k : ''; apply(); paintRow(); if (preview) greet(preview, true); },
        birthday: function () {
            var m = $('hol-bm').value, d = $('hol-bd').value;
            if (!m) { if (typeof setPref === 'function') setPref({ birthday: '' }); return; }
            if (m && d && typeof setPref === 'function') setPref({ birthday: m + '-' + d });
        }
    };

    var _ps = window.paintSettings;
    if (typeof _ps === 'function') window.paintSettings = function () { var r = _ps.apply(this, arguments); try { apply(); } catch (e) { console.error(e); } return r; };
    function boot() { apply(); setInterval(apply, 10 * 60 * 1000); }          // the clock passing midnight changes the occasion
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); }); else setTimeout(boot, 0);
})();
