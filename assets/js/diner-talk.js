/* The Diner: Juno's story engine. Plays the script in diner-story.js (window.DINER_STORY, format in the plan and the header there)
   in two places: as margin pages in the guest book (where: 'book') and in the dialogue box #dn-talk (where: 'stool').
   Driven by diner-lore.js, which forwards every diner event here: window.dinerTalk.on(ev, d).
   Events used: enter, leave, juno, room, draw, art, empty, skip, play, fireworks, book, key, bookopen, bookpage, bookclose, own, hasend.
   State: localStorage 'ultron_diner_story'. Nothing is timed against the user: a waiting scene is only a second cup and a glow. */
(function () {
    'use strict';
    var KEY = 'ultron_diner_story', WAIT_MS = 4 * 60 * 1000, GRACE_MS = 60 * 1000, TYPE_MS = 28, REACT_GAP = 8000, REACT_MAX = 4;
    var PRO = {
        she: { they: 'she', them: 'her', their: 'her', They: 'She', Their: 'Her', s: 's', is: 'is', has: 'has', was: 'was' },
        he: { they: 'he', them: 'him', their: 'his', They: 'He', Their: 'His', s: 's', is: 'is', has: 'has', was: 'was' },
        they: { they: 'they', them: 'them', their: 'their', They: 'They', Their: 'Their', s: '', is: 'are', has: 'have', was: 'were' }
    };
    var ST = window.DINER_STORY || { order: [], scenes: {}, react: [], after: {} }, SC = ST.scenes, ORDER = ST.order;
    var T = { at: 0, t: 0, p: 0, d: 0, flags: {}, name: '', pro: '', loop: 0, ends: [], own: false, cur: null, lastEnd: 0, afterN: 0, endId: '' };
    try { var j = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; Object.keys(T).forEach(function (k) { if (j[k] != null && typeof j[k] === typeof T[k]) T[k] = j[k]; }); } catch (e) {}
    function save() { try { localStorage.setItem(KEY, JSON.stringify(T)); } catch (e) {} }

    var el = null, api = null, box = null, wx = null, wo = null, wt = null, wopt = null;
    var V = null, mode = null, typing = false, typeT = 0, full = '', contFn = null, pick = null, inj = [], holdT = 0, holdP = 0, holdSpec = null;
    var fresh = true, avail = null, refT = 0, graceT = 0, grace = false, cupForce = null, noteDue = false, fired = {}, reacts = 0, lastReact = 0;
    var bk = null, calm = false;
    try { calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

    /* ---------- conditions, effects, text ---------- */
    function room() { try { return api ? api.state() : { st: {} }; } catch (e) { return { st: {} }; } }
    function pagesN() { try { return window.dinerLore.on('pages') || 0; } catch (e) { return 0; } }
    function top() { return T.t >= T.p && T.t >= T.d ? 't' : T.p > T.t && T.p >= T.d ? 'p' : 'd'; }
    function cmp(a, op, b) { return op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b : op === '<' ? a < b : a === b; }
    function tok(c) {
        var neg = false, m, r = room(), st = r.st || {};
        if (c.charAt(0) === '!') { neg = true; c = c.slice(1); }
        var v;
        if ((m = /^(t|p|d|loop|pages)(>=|<=|>|<|=)(\d+)$/.exec(c))) v = cmp(m[1] === 'loop' ? T.loop : m[1] === 'pages' ? pagesN() : T[m[1]], m[2], +m[3]);
        else if ((m = /^top=([tpd])$/.exec(c))) v = top() === m[1];
        else if ((m = /^(lamp|fairy|sign|pic|wx)=(\d+)$/.exec(c))) v = +st[m[1]] === +m[2];
        else if (c === 'dark') v = !st.lamp && st.fairy === 2 && !st.sign && !st.pic;
        else if (c === 'playing') v = !!r.playing;
        else if (c === 'empty') v = !!r.empty;
        else if (c === 'name') v = !!T.name;
        else if ((m = /^f:(\w+)$/.exec(c))) v = !!T.flags[m[1]];
        else if ((m = /^end:(\w+)$/.exec(c))) v = T.ends.indexOf(m[1]) >= 0;
        else v = false;
        return neg ? !v : v;
    }
    function cond(s) { if (!s) return true; var a = String(s).split(/\s+/); for (var i = 0; i < a.length; i++) if (a[i] && !tok(a[i])) return false; return true; }
    function fx(s) {
        if (!s) return; String(s).split(/\s+/).forEach(function (c) {
            var m;
            if (!c) return;
            if ((m = /^([tpd])([+-])(\d+)$/.exec(c))) T[m[1]] = Math.max(0, T[m[1]] + (m[2] === '+' ? 1 : -1) * +m[3]);
            else if ((m = /^f:(\w+)$/.exec(c))) T.flags[m[1]] = 1;
            else if ((m = /^f-(\w+)$/.exec(c))) delete T.flags[m[1]];
            else if ((m = /^cup:([01])$/.exec(c))) { cupForce = +m[1]; paintHere(); }
            else if (c === 'own:1') { T.own = true; try { if (api) api.own(); } catch (e) {} }
            else if ((m = /^set:(\w+)=(\d+)$/.exec(c))) { try { if (api) api.set(m[1], +m[2]); } catch (e) {} }
            else if ((m = /^page:(\w+)$/.exec(c))) { try { window.dinerLore.on('unlock', { id: m[1] }); } catch (e) {} }
            else if ((m = /^end:(\w+)$/.exec(c))) { if (T.ends.indexOf(m[1]) < 0) T.ends.push(m[1]); T.endId = m[1]; }
        });
        save();
    }
    function fill(t) {
        return String(t).replace(/\{([A-Za-z]+)(?:\|([^}]*))?\}/g, function (m, k, fb) {
            if (k === 'name') return T.name || fb || '';
            if (k === 'art') { var r = room(); return (!r.empty && r.art) || fb || ''; }
            var P = PRO[T.pro || 'they']; return P.hasOwnProperty(k) ? P[k] : m;
        });
    }

    /* ---------- which scene is waiting ---------- */
    function nextId() {
        var a = T.at; while (a < ORDER.length && SC[ORDER[a]] && SC[ORDER[a]].once && T.loop >= 1) a++;
        return a < ORDER.length ? ORDER[a] : null;
    }
    function refresh() {
        clearTimeout(refT); avail = null;
        var id = T.cur ? T.cur.id : nextId(), sc = id && SC[id];
        if (sc && (T.cur || cond(sc.gate))) {
            if (T.cur || fresh || Date.now() - T.lastEnd >= WAIT_MS) avail = { id: id, where: sc.where };
            else if (el && el.classList.contains('on')) refT = setTimeout(refresh, Math.max(1000, WAIT_MS - (Date.now() - T.lastEnd) + 200));
        }
        paintHere();
        var b = el && el.querySelector('.dn-book');
        if (b && ((avail && avail.where === 'book') || noteDue || (avail && !T.pro && T.loop > 0))) b.classList.add('new');
    }
    function paintHere() {
        if (!el) return;
        var here = cupForce != null ? !!cupForce : !!((avail && avail.where === 'stool') || (T.cur && SC[T.cur.id] && SC[T.cur.id].where === 'stool') || grace || T.ends.indexOf('stay') >= 0);
        el.classList.toggle('juno-here', here);
        var h = el.querySelector('[data-act="x-juno"]'); if (h) h.setAttribute('data-tip', T.flags.met ? 'Juno' : "Someone's here");
    }

    /* ---------- the runner (shared by the book page and the dialogue box) ---------- */
    function jump(label) {
        var st = SC[T.cur.id].steps;
        for (var i = 0; i < st.length; i++) if (st[i][0] === '#' && st[i][1] === label) { T.cur.i = i; return; }
        T.cur.i = st.length;
    }
    function drain(next) {
        if (V && inj.length && V.talk) { var l = inj.shift(); V.say(l[0], fill(l[1]), function () { drain(next); }); } else next();
    }
    function ensurePro(cb) {
        if (T.pro) { cb(); return; }
        V.choose('Juno is:', ['she', 'he', 'they'], function (k) { T.pro = ['she', 'he', 'they'][k]; save(); cb(); });
    }
    function begin(view) {
        V = view; if (!T.cur) { var id = nextId(); if (!id) return; T.cur = { id: id, i: 0 }; save(); }
        ensurePro(step);
    }
    function step() {
        if (!T.cur || !V) return;
        var c = T.cur, sc = SC[c.id]; if (!sc || c.i >= sc.steps.length) { finish(); return; }
        var s = sc.steps[c.i], k = s[0];
        if (k === 'j' || k === 'n') { mode = 'line'; V.say(k, fill(s[1]), function () { c.i++; save(); drain(step); }); }
        else if (k === '?') {
            mode = 'choice';
            var opts = s.slice(1); V.choose(null, opts.map(function (o) { return fill(o[0]); }), function (n) { var o = opts[n]; mode = null; fx(o[1]); if (o[2]) jump(o[2]); else c.i++; save(); step(); });
        }
        else if (k === '#') { c.i++; step(); }
        else if (k === '>') { jump(s[1]); step(); }
        else if (k === 'if') { if (cond(s[1])) jump(s[2]); else c.i++; step(); }
        else if (k === 'do') { fx(s[1]); c.i++; save(); step(); }
        else if (k === 'hold') {
            var go = function (label) { clearHold(); mode = null; jump(label); save(); step(); };
            if (!V.talk) { go(s[4]); return; }
            if (cond(s[1])) { go(s[3]); return; }
            mode = 'hold'; holdSpec = { cond: s[1], yes: function () { go(s[3]); } };
            V.hold(fill(s[5] || ''), function () { go(s[4]); });
            holdT = setTimeout(function () { go(s[4]); }, Math.max(1, s[2]) * 1000);
            holdP = setInterval(checkHold, 500);
        }
        else if (k === 'ask') { mode = 'ask'; V.ask(fill(s[2] || ''), function (v) { mode = null; T.name = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 20); c.i++; save(); step(); }); }
        else if (k === 'go') { c.id = s[1]; c.i = 0; save(); step(); }
        else finish();
    }
    function clearHold() { clearTimeout(holdT); clearInterval(holdP); holdT = holdP = 0; holdSpec = null; }
    function checkHold() { if (holdSpec && cond(holdSpec.cond)) { var h = holdSpec; clearHold(); h.yes(); return true; } return false; }
    function finish() {
        clearHold(); mode = null; inj = [];
        var id = T.cur ? T.cur.id : '', sc = SC[id], k = ORDER.indexOf(id), stool = sc && sc.where === 'stool';
        T.at = k >= 0 ? k + 1 : ORDER.length; T.cur = null; T.lastEnd = Date.now(); fresh = false; cupForce = null; save();
        if (V && V.done) V.done();
        if (el) el.classList.remove('talk');
        if (stool) { grace = true; clearTimeout(graceT); graceT = setTimeout(function () { grace = false; paintHere(); }, GRACE_MS); }
        V = null; refresh();
    }

    /* ---------- the dialogue box ---------- */
    function makeBox() {
        wx = document.createElement('div'); wx.id = 'dn-talk'; wx.setAttribute('aria-live', 'polite');
        wx.innerHTML = '<div class="dn-tk-who"></div><p class="dn-tk-x"></p><div class="dn-tk-opt"></div><div class="dn-tk-esc">Esc: step away</div>';
        el.appendChild(wx); wo = wx.querySelector('.dn-tk-who'); wt = wx.querySelector('.dn-tk-x'); wopt = wx.querySelector('.dn-tk-opt');
        wx.addEventListener('click', function (e) {
            e.stopPropagation();
            var b = e.target.closest ? e.target.closest('[data-tk]') : null;
            if (b) { var a = b.getAttribute('data-tk'); if (a === 'ok') submitAsk(); else if (pick) pick(+a); return; }
            if (e.target.tagName !== 'INPUT') advance();
        });
    }
    function stopType() { clearInterval(typeT); typeT = 0; typing = false; }
    function advance() {
        if (typing) { stopType(); wt.textContent = full; return; }
        if (mode === 'line' && contFn) { var f = contFn; contFn = null; f(); }
    }
    var talkView = {
        talk: true,
        say: function (kind, text, cont) {
            wopt.innerHTML = ''; pick = null; wo.textContent = kind === 'j' ? 'Juno' : ''; wt.className = 'dn-tk-x' + (kind === 'n' ? ' nar' : '');
            stopType(); full = text; contFn = cont;
            if (calm) { wt.textContent = text; return; }
            var i = 0; wt.textContent = ''; typing = true;
            typeT = setInterval(function () { i++; wt.textContent = text.slice(0, i); if (i >= text.length) stopType(); }, TYPE_MS);
        },
        choose: function (prompt, labels, cb) {
            stopType(); contFn = null;
            if (prompt) { wo.textContent = ''; wt.className = 'dn-tk-x nar'; wt.textContent = prompt; }
            wopt.innerHTML = ''; labels.forEach(function (l, i) { var b = document.createElement('button'); b.type = 'button'; b.setAttribute('data-tk', i); b.textContent = (i + 1) + '.  ' + l; wopt.appendChild(b); });
            pick = function (n) { if (n >= 0 && n < labels.length) { wopt.innerHTML = ''; pick = null; cb(n); } };
        },
        hold: function (prompt, notNow) {
            stopType(); contFn = null; wo.textContent = ''; wt.className = 'dn-tk-x nar'; wt.textContent = prompt;
            wopt.innerHTML = '<button type="button" data-tk="0">Not now</button>'; pick = function () { wopt.innerHTML = ''; pick = null; notNow(); };
        },
        ask: function (prompt, cb) {
            stopType(); contFn = null; wo.textContent = ''; wt.className = 'dn-tk-x nar'; wt.textContent = prompt;
            wopt.innerHTML = '<div style="display:grid;gap:8px"><input type="text" maxlength="20" autocomplete="off" spellcheck="false" style="padding:9px 14px;border-radius:12px;border:1px solid rgba(244,230,200,.3);background:rgba(244,230,200,.08);color:inherit;font:inherit"><button type="button" data-tk="ok">OK</button></div>';
            var inp = wopt.querySelector('input'); pick = function () {}; askCb = cb;
            inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); submitAsk(); } });
            setTimeout(function () { try { inp.focus(); } catch (e) {} }, 50);
        }
    };
    var askCb = null;
    function submitAsk() {
        var f = askCb, inp = (wx && wx.querySelector('input')) || (box && box.querySelector('input')); if (!f || !inp) return;
        var v = inp.value; askCb = null; var p = inp.parentNode; if (p && p.parentNode) p.parentNode.removeChild(p); f(v);
    }
    function startTalk() {
        if (!el) return;
        if (!T.cur && !(avail && avail.where === 'stool')) return;
        el.classList.add('talk'); begin(talkView);
    }
    function stepAway() {
        clearHold(); stopType(); mode = null; inj = []; contFn = null; pick = null; askCb = null;
        if (el) el.classList.remove('talk');
        if (V === talkView) V = null;
        refresh();
    }

    /* ---------- the book page ---------- */
    function para(cls, text) { var p = document.createElement('p'); p.className = cls; p.textContent = text; box.appendChild(p); if (bk && bk.page) bk.page.scrollTop = bk.page.scrollHeight; return p; }
    var bookView = {
        talk: false,
        say: function (kind, text, cont) { para(kind === 'j' ? 'juno' : 'nar', text); cont(); },
        choose: function (prompt, labels, cb) {
            if (prompt) para('nar', prompt);
            var d = document.createElement('div'); d.className = 'dn-pg-opt';
            labels.forEach(function (l, i) { var b = document.createElement('button'); b.type = 'button'; b.setAttribute('data-tk', i); b.textContent = l; d.appendChild(b); });
            box.appendChild(d); pick = function (n) { if (n >= 0 && n < labels.length) { box.removeChild(d); pick = null; para('me', labels[n]); cb(n); } };
            if (bk && bk.page) bk.page.scrollTop = bk.page.scrollHeight;
        },
        hold: function () {},
        ask: function (prompt, cb) {
            para('nar', prompt);
            var d = document.createElement('div'); d.className = 'dn-pg-opt';
            d.innerHTML = '<input type="text" maxlength="20" autocomplete="off" spellcheck="false" style="font:inherit;background:none;border:0;border-bottom:1px dashed rgba(58,44,34,.5);color:inherit;padding:0 8px"><button type="button" data-tk="ok">OK</button>';
            box.appendChild(d); var inp = d.querySelector('input'); pick = function () {}; askCb = cb;
            inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); submitAsk(); } });
            setTimeout(function () { try { inp.focus(); } catch (e) {} }, 50);
        },
        done: function () {}
    };
    function bind() {
        box.onclick = function (e) {
            var b = e.target.closest ? e.target.closest('[data-tk]') : null; if (!b) return;
            var a = b.getAttribute('data-tk'); if (a === 'ok') submitAsk(); else if (a === 'more') anotherNight(); else if (pick) pick(+a);
        };
    }
    function heading(t) { var h = document.createElement('h4'); h.textContent = t; box.appendChild(h); }
    function openBook(d) {
        bk = d; box = d.box; box.innerHTML = ''; bind(); pick = null; askCb = null;
        var id = T.cur ? T.cur.id : (avail && avail.id), sc = id && SC[id];
        if (sc && sc.where === 'book' && (T.cur || avail)) { heading(sc.title || 'In the margin'); begin(bookView); return true; }
        if (!T.cur && avail && !T.pro && T.loop > 0) { V = bookView; heading('Another night'); ensurePro(function () { V = null; setTimeout(function () { try { window.dinerLore.on('refresh'); } catch (e) {} refresh(); }, 200); }); return true; }
        if (noteDue && T.endId && ST.after[T.endId]) {
            var n = ST.after[T.endId][T.afterN]; noteDue = false;
            if (n) { heading('In the margin'); para('juno', n); T.afterN++; save(); return true; }
        }
        box.innerHTML = ''; return false;
    }
    function bookPage(d) {
        if (d.id !== 'regular') return;
        var b = d.box; b.innerHTML = ''; box = b; bind();
        var p = document.createElement('p'); p.className = 'nar'; p.textContent = 'Nights ended: ' + T.ends.length + ' of 4'; b.appendChild(p);
        if (T.ends.length && !T.cur && !nextId()) { var o = document.createElement('div'); o.className = 'dn-pg-opt'; o.innerHTML = '<button type="button" data-tk="more">Another night</button>'; b.appendChild(o); }
    }
    function anotherNight() {
        var f = 0; while (f < ORDER.length && SC[ORDER[f]] && SC[ORDER[f]].once) f++;
        T.at = f; T.t = T.p = T.d = 0; T.flags = {}; T.cur = null; T.afterN = 0; T.endId = ''; T.pro = ''; T.own = false; T.loop++; T.lastEnd = 0; fresh = true; noteDue = false; cupForce = null; grace = false;
        save(); refresh(); try { window.dinerLore.on('refresh'); } catch (e) {}
    }

    /* ---------- what you do in the room ---------- */
    function inject(lines) {
        if (!V || !V.talk || !T.pro) return;
        inj = inj.concat(lines);
        if (mode === 'choice' || mode === 'hold' || mode === 'ask') { clearHold(); mode = null; pick = null; askCb = null; drain(step); }
    }
    function react(on, d) {
        if (!T.cur || V !== talkView || !el.classList.contains('talk')) return;
        var sc = SC[T.cur.id]; if (!sc || sc.where !== 'stool') return;
        if (on === 'empty' && d && !d.on) return;
        var now = Date.now(); if (now - lastReact < REACT_GAP || reacts >= REACT_MAX) return;
        for (var i = 0; i < ST.react.length; i++) {
            var e = ST.react[i]; if (e.on !== on || fired[i]) continue;
            if (e.only) { if (e.only !== T.cur.id) continue; } else if (sc.quiet) continue;
            if (e.if && !cond(e.if)) continue;
            fired[i] = 1; reacts++; lastReact = now; fx(e.fx); inject(e.say); return;
        }
    }
    function happened(on, d) {
        if (mode === 'hold' && holdSpec && V === talkView && el.classList.contains('talk') && checkHold()) return;
        react(on, d);
    }

    function on(ev, d) {
        d = d || {};
        switch (ev) {
        case 'enter':
            el = d.el; api = d.api; if (!wx || wx.parentNode !== el) makeBox();
            fresh = true; fired = {}; reacts = 0; lastReact = 0; grace = false; cupForce = null; el.classList.remove('talk');
            noteDue = !!(T.endId && !T.cur && !nextId() && ST.after[T.endId] && T.afterN < ST.after[T.endId].length);
            refresh();
            break;
        case 'leave': stepAway(); clearTimeout(refT); clearTimeout(graceT); break;
        case 'juno':
            if (!el) break;
            if (T.cur && SC[T.cur.id] && SC[T.cur.id].where === 'stool' || avail && avail.where === 'stool') { if (V !== talkView) startTalk(); }
            else if (api) api.toast(el.querySelector('[data-act="x-juno"]'), 'Still warm.');
            break;
        case 'room': happened(d.a, d); break;
        case 'draw': case 'art': case 'empty': case 'skip': case 'play': case 'fireworks': happened(ev, d); break;
        case 'bookopen': { var r = openBook(d); if (!r) happened('book', d); return r; }
        case 'bookpage': bookPage(d); break;
        case 'bookclose': if (V === bookView) V = null; pick = null; askCb = null; bk = null; box = null; refresh(); break;
        case 'key': return key(d.k);
        case 'own': return !!T.own;
        case 'hasend': return T.ends.indexOf(d.id) >= 0;
        }
        return null;
    }
    function key(k) {
        if (!el) return false;
        var ae = document.activeElement, typingIn = ae && ae.tagName === 'INPUT' && el.contains(ae), booked = false;
        try { booked = !!window.dinerLore.on('isbook'); } catch (e) {}
        if (typingIn) { if (k === 'Escape') { ae.blur(); } else return 'pass'; }
        var n = /^[1-4]$/.test(k) ? +k - 1 : -1;
        if (booked) { if (n >= 0 && pick && V === bookView) { pick(n); return true; } return false; }
        if (!el.classList.contains('talk')) return false;
        if (n >= 0) { if (pick) pick(n); return true; }
        if (k === ' ' || k === 'Enter') { advance(); return true; }
        if (k === 'Escape') { stepAway(); return true; }
        return false;
    }

    window.dinerTalk = { on: on };
})();
