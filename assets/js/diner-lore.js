/* The Diner: the world of Lowlight and The Third Cup, told through the guest book on the table.
   Data (PAGES, RADIO), the unlock rules and the book overlay. diner.js calls window.dinerLore.on(event, data); every event is also
   forwarded to window.dinerTalk (Juno's story, diner-talk.js) when that exists. Extra events used only by dinerTalk:
   'pages' (number unlocked), 'unlock' ({ id } -> page title or null), 'isbook' (is the book open), 'refresh' (redraw the open book).
   Voice for any new page: short, warm, dry, no exclamation marks, never mentions the app or clicking. */
(function () {
    'use strict';
    var PAGES = [
     { id: 'rules', kind: 'open', title: "House rules", by: "Oda, night cook", text: "One. The lamp stays on for whoever comes in next.\nTwo. Nobody asks why you're awake.\nThree. Write in the book if you like. Nobody checks." },
     { id: 'lamp', kind: 'item', title: "The lamp", by: "O.", text: "If you turn it off, that's fine. It only means you're the one keeping watch tonight." },
     { id: 'fairy', kind: 'item', title: "The string lights", by: "O.", text: "Put up for a party nine winters ago. Nobody could agree whose turn it was to take them down, so now they're structural. Twinkle is for good news." },
     { id: 'sign', kind: 'item', title: "The sign", by: "painted on the back of the sign", text: "Three lines of steam, one for each cup. The first wakes you up. The second keeps you here. Nobody has ever needed the third one explained." },
     { id: 'wx', kind: 'item', title: "The window", by: "Wren, ULTRON FM", text: "Don't trust it for the forecast. It doesn't show tonight. It shows a night. Tap the glass and it finds you another. We call it changing the channel." },
     { id: 'draw', kind: 'item', title: "The fog", by: "Sol, age 9, waiting for the bus", text: "The glass forgets everything in under a minute. That's why it's safe to tell it things." },
     { id: 'sip', kind: 'item', title: "The coffee", by: "a regular, stool 3", text: "I've never seen anyone pour it. You finish the cup, you look at the rain, you look back. Full. I stopped asking around the fortieth cup." },
     { id: 'sugar', kind: 'item', title: "The sugar", by: "stool 3 again", text: "The shaker has been half full since I got here. I asked Oda about it. Oda said this is a diner, not a philosophy class, and refilled it anyway." },
     { id: 'pic', kind: 'item', title: "The picture light", by: "Juno, deliveries", text: "Leave it on when a painting needs company. Turn it off when the painting needs sleep. You'll know which." },
     { id: 'zoom', kind: 'item', title: "The brass label", by: "the driver, Bus 9", text: "People lean in to read the label and forget to lean back. I watched a man miss three buses that way. Best seat in the city." },
     { id: 'juke', kind: 'item', title: "The jukebox", by: "the Tuner", text: "There are no records in it. I've had the back off twice. It plays whatever you carried in with you. It's not a jukebox. It's a mirror with a speaker." },
     { id: 'leaves', kind: 'item', title: "The plant", by: "O.", text: "Nobody waters it. It is thriving out of spite. We respect that." },
     { id: 'cat', kind: 'item', title: "Decaf", by: "O.", text: "Walked in during the blackout storm, shook off on the good stool and took the windowsill. Doesn't belong to anyone. Strictly speaking, the diner belongs to Decaf." },
     { id: 'blackout', kind: 'secret', hint: "Sit through a storm with the lamp off.", title: "The blackout", by: "the Tuner", text: "The night the whole grid went, this window was the only light on Ninth. People came in from six blocks away. Oda made coffee on a camp stove. A wet cat got the best seat. Nobody went home until the first bus." },
     { id: 'snow', kind: 'secret', hint: "Snow looks better when the lights twinkle.", title: "First snow", by: "Wren, ULTRON FM", text: "It snowed once in Lowlight, properly, the year the lights went up. The window kept that night. On the bad ones I put it on and set the lights to twinkle. Works every time." },
     { id: 'clear', kind: 'secret', hint: "On a clear night, the sign gets in the way.", title: "The clear night", by: "Sol", text: "With the sign off you can count them. I got to forty-one stars before the 9 came. Mum says there are more, but forty-one is already a lot." },
     { id: 'dark', kind: 'secret', hint: "Turn everything off.", title: "Lights out", by: "O.", text: "Sometimes the kindest thing a room can do is stop being looked at. The city will hold the light for you. Turn one back on when you're ready. No rush." },
     { id: 'decaf', kind: 'secret', hint: "The cat respects persistence.", title: "What Decaf wants", by: "stool 3, bleeding slightly", text: "Seven. It's always seven. Six and you're a stranger. Eight and you're pushing it." },
     { id: 'third', kind: 'secret', hint: "First cup wakes you. Second keeps you.", title: "The third cup", by: "written inside the menu", text: "The first cup is for waking up. The second is for staying. The third is when you stop pretending you came in for the coffee." },
     { id: 'glass', kind: 'secret', hint: "Tell the glass something long.", title: "What Sol drew", by: "Sol", text: "I drew the whole bus route on the window once, all the stops. It was gone before the 9 came. That's okay. I know where it goes." },
     { id: 'empty', kind: 'secret', hint: "Look at nothing for a while.", title: "The empty frame", by: "O.", text: "Juno was late once and the frame hung empty all night. Nobody complained. Turns out a wall with a light on it is also a painting." },
     { id: 'juno', kind: 'secret', hint: "Stay for seven paintings.", title: "The courier", by: "Juno", text: "The paintings are on loan from the day side. Somebody has to keep them company at night. I swap them while you blink. If you ever catch me at it, the coffee's on me." },
     { id: 'tuner', kind: 'secret', hint: "Be picky with the jukebox.", title: "Skipping", by: "the Tuner", text: "Skipping isn't rude. It's the machine asking, are you sure that's how you feel, and you saying, not quite. Keep going. It'll find it." },
     { id: 'bus', kind: 'secret', hint: "Stay ten minutes.", title: "Bus 9", by: "the driver, Bus 9", text: "The last bus and the first bus are the same bus. The loop takes exactly one song. I've timed it. If you're still here when I come round again, I wave. Look for the headlights." },
     { id: 'radio', kind: 'secret', hint: "Come back another night. And another.", title: "ULTRON FM", by: "Wren", text: "Tonight's forecast: rain, then more rain, then a feeling. This is ULTRON FM, the station for people who are still up. I keep seeing the same face in that window. Good." },
     { id: 'board', kind: 'secret', hint: "The billboard is waiting for something.", title: "The Board", by: "unsigned, in fresh ink", text: "It has said COMING SOON for as long as anyone remembers. It was never an advert. It was waiting for someone to notice everything else first." },
     { id: 'regular', kind: 'end', hint: "This page writes itself when the others are full.", title: "Regular", by: "O.", text: "You read the whole book. That makes you one of us. Your stool is the one you're on. The lamp has been on for you since {date}.\n\nP.S. Tap the window. There's a fifth night now." }
    ];
    var RADIO = ['ULTRON FM 88.1', 'rain, then more rain', 'bus 9 is on time', 'still up? same here', 'no requests, only yours', 'lowlight after hours'];

    var KEY = 'ultron_diner_lore', BUS_MS = 10 * 60 * 1000, EMPTY_MS = 20 * 1000, TOAST_MS = 1800;
    var S = { pages: ['rules'], read: [], first: '', days: [] };
    var el = null, api = null, book = null, shown = -1, isOpen = false, inScene = false;
    var arts = 0, skips = 0, busT = 0, emptyT = 0, toastT = 0, endT = 0, queue = [];

    function load() {
        try {
            var j = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
            if (j.pages instanceof Array) S.pages = j.pages; if (j.read instanceof Array) S.read = j.read;
            if (typeof j.first === 'string') S.first = j.first; if (j.days instanceof Array) S.days = j.days;
        } catch (e) {}
        if (S.pages.indexOf('rules') < 0) S.pages.push('rules');
    }
    function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
    load();

    function byId(id) { for (var i = 0; i < PAGES.length; i++) if (PAGES[i].id === id) return PAGES[i]; return null; }
    function has(id) { return S.pages.indexOf(id) >= 0; }
    function today() { var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); }
    function dateText() {
        var p = (S.first || today()).split('-'), d = new Date(+p[0], +p[1] - 1, +p[2]);
        try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return S.first; }
    }
    function countText() { return '✎ ' + S.pages.length + '/' + PAGES.length + ' pages'; }
    function tk(ev, d) { try { return window.dinerTalk ? window.dinerTalk.on(ev, d || {}) : null; } catch (e) { console.error('diner talk', e); return null; } }
    function bookEl() { return el ? el.querySelector('.dn-book') : null; }

    /* ---------- toasts: one element, so lore toasts wait their turn behind diner.js's own ---------- */
    function pump() {
        if (toastT || !queue.length) return;
        toastT = setTimeout(function () {
            toastT = 0; var t = queue.shift();
            if (el && api && el.classList.contains('on')) { try { api.toast(el.querySelector('[data-act="x-book"]'), t); } catch (e) {} }
            pump();
        }, TOAST_MS);
    }
    function say(t) { queue.push(t); pump(); }

    /* ---------- unlocking ---------- */
    function unlock(id, quiet) {
        var p = byId(id); if (!p || has(id)) return null;
        S.pages.push(id); save();
        var f = el && el.querySelector('#dn-found'); if (f) f.textContent = countText();
        var b = bookEl(); if (b) b.classList.add('new');
        if (!quiet) say('✎ New page: ' + p.title);
        checkEnd();
        if (isOpen && !inScene) show(shown);
        return '✎ ' + p.title;
    }
    function checkEnd() {
        if (has('regular') || endT) return;
        for (var i = 0; i < PAGES.length; i++) if (PAGES[i].id !== 'regular' && !has(PAGES[i].id)) return;
        endT = setTimeout(function () { endT = 0; unlock('regular'); }, 2500);
    }

    /* ---------- the book ---------- */
    function make() {
        book = document.createElement('div'); book.id = 'dn-book'; book.setAttribute('aria-hidden', 'true');
        book.innerHTML = '<div class="dn-page" role="dialog" aria-label="Guest book"><div class="dn-pg-n"></div><h3 class="dn-pg-t"></h3><p class="dn-pg-x"></p><div class="dn-pg-by"></div>' +
            '<div class="dn-pg-sc"></div><div class="dn-pg-extra"></div>' +
            '<div class="dn-pg-nav"><button type="button" data-bk="prev" title="Previous page">&lsaquo;</button><button type="button" data-bk="close" title="Close (Esc)">&times;</button><button type="button" data-bk="next" title="Next page">&rsaquo;</button></div></div>';
        el.appendChild(book);
        book.addEventListener('click', function (e) {
            e.stopPropagation();
            var b = e.target.closest ? e.target.closest('[data-bk]') : null;
            if (!b) { if (e.target === book) close(); return; }
            var a = b.getAttribute('data-bk');
            if (a === 'close') close(); else if (a === 'prev') flip(-1); else if (a === 'next') flip(1);
        });
    }
    function q(s) { return book.querySelector(s); }
    function show(i) {
        i = Math.max(0, Math.min(PAGES.length - 1, i)); shown = i; inScene = false;
        var p = PAGES[i], ok = has(p.id), pg = q('.dn-page');
        pg.classList.remove('scene'); pg.classList.toggle('locked', !ok);
        q('.dn-pg-sc').innerHTML = ''; q('.dn-pg-extra').innerHTML = '';
        q('.dn-pg-n').textContent = (i + 1) + ' / ' + PAGES.length;
        q('.dn-pg-t').textContent = ok ? p.title : '· · ·';
        q('.dn-pg-x').textContent = ok ? p.text.replace('{date}', dateText()) : (p.hint || "Something in the room you haven't touched yet.");
        q('.dn-pg-by').textContent = ok ? '— ' + p.by : 'blank page';
        if (ok && S.read.indexOf(p.id) < 0) { S.read.push(p.id); save(); }
        pg.scrollTop = 0;
        if (ok) tk('bookpage', { id: p.id, box: q('.dn-pg-extra') });
    }
    function flip(n) { var i = Math.max(0, Math.min(PAGES.length - 1, shown + n)); show(i); }
    function open() {
        if (!el || !book || isOpen) return;
        isOpen = true; book.classList.add('on'); book.setAttribute('aria-hidden', 'false');
        var b = bookEl(); if (b) b.classList.remove('new');
        var i, first = -1;
        for (i = 0; i < PAGES.length; i++) if (has(PAGES[i].id) && S.read.indexOf(PAGES[i].id) < 0) { first = i; break; }
        if (first >= 0) shown = first; else if (shown < 0) shown = 0;
        inScene = !!tk('bookopen', { page: q('.dn-page'), box: q('.dn-pg-sc') });
        if (inScene) { q('.dn-page').classList.add('scene'); q('.dn-page').scrollTop = 0; } else show(shown);
    }
    function close() {
        if (!isOpen) return;
        isOpen = false; book.classList.remove('on'); book.setAttribute('aria-hidden', 'true'); tk('bookclose');
    }

    function on(ev, d) {
        d = d || {}; var out;
        switch (ev) {
        case 'enter':
            el = d.el; api = d.api; if (!book || book.parentNode !== el) make();
            if (!S.first) S.first = today();
            if (S.days.indexOf(today()) < 0) S.days.push(today());
            (d.found || []).forEach(function (id) { unlock(id, true); });
            if (S.days.length >= 3) unlock('radio', true);
            arts = 0; skips = 0; clearTimeout(busT); busT = setTimeout(function () { unlock('bus'); }, BUS_MS);
            save(); var f = el.querySelector('#dn-found'); if (f) f.textContent = countText();
            checkEnd();
            break;
        case 'leave':
            clearTimeout(busT); clearTimeout(emptyT); clearTimeout(toastT); toastT = 0; queue = []; close();
            break;
        case 'found':
            out = unlock(d.id, true); if (out && byId(d.id).kind !== 'item') out = null;
            break;
        case 'room':
            var st = d.st || {};
            if (st.wx === 1 && !st.lamp) unlock('blackout');
            if (st.wx === 2 && st.fairy === 1) unlock('snow');
            if (st.wx === 3 && !st.sign) unlock('clear');
            if (!st.lamp && st.fairy === 2 && !st.sign && !st.pic) unlock('dark');
            if (d.pets >= 7) unlock('decaf');
            if (d.refills >= 3) unlock('third');
            break;
        case 'draw': if (d.n >= 400) unlock('glass'); break;
        case 'art': clearTimeout(emptyT); arts++; if (arts >= 7) unlock('juno'); break;
        case 'empty': clearTimeout(emptyT); if (d.on) emptyT = setTimeout(function () { unlock('empty'); }, EMPTY_MS); break;
        case 'skip': skips++; if (skips >= 5) unlock('tuner'); break;
        case 'fireworks': unlock('board'); break;
        case 'book': if (isOpen) close(); else open(); break;
        case 'key':
            var kr = tk('key', d); if (kr) return kr;       // true = used, 'pass' = typing in a field: let it through
            if (isOpen) {
                var k = d.k;
                if (k === 'Escape' || k === 'b' || k === 'B') close();
                else if (k === 'ArrowLeft') flip(-1);
                else if (k === 'ArrowRight' || k === ' ') flip(1);
                return true;
            }
            if (d.k === 'b' || d.k === 'B') { open(); return true; }
            return false;
        case 'count': return countText();
        case 'nights': return [0, 1, 2, 3].concat(has('regular') ? [4] : [], tk('hasend', { id: 'morning' }) ? [5] : []);
        case 'own': return !!tk('own');
        case 'radio': var i = Math.floor(Date.now() / 20000); return i % 2 ? RADIO[(i >> 1) % RADIO.length] : 'press play';
        case 'pages': return S.pages.length;
        case 'unlock': return unlock(d.id, !!d.quiet);
        case 'isbook': return isOpen;
        case 'refresh': if (isOpen) { var s2 = !!tk('bookopen', { page: q('.dn-page'), box: q('.dn-pg-sc') }); inScene = s2; q('.dn-page').classList.toggle('scene', s2); if (!s2) show(shown); } break;
        }
        var fw = tk(ev, d);
        return out !== undefined ? out : (ev === 'juno' ? fw : null);
    }

    window.dinerLore = { on: on, PAGES: PAGES, RADIO: RADIO };
})();
