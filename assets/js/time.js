/* Time: world clock, alarms, stopwatch, timers. Alarms and timers keep running while the app is open, on any screen. */
(function () {
    'use strict';
    const CITY_SRC = 'Abu Dhabi|AE|Asia/Dubai;Accra|GH|Africa/Accra;Addis Ababa|ET|Africa/Addis_Ababa;Adelaide|AU|Australia/Adelaide;Algiers|DZ|Africa/Algiers;Almaty|KZ|Asia/Almaty;Amman|JO|Asia/Amman;Amsterdam|NL|Europe/Amsterdam;Anchorage|US|America/Anchorage;Ankara|TR|Europe/Istanbul;Antananarivo|MG|Indian/Antananarivo;Asuncion|PY|America/Asuncion;Athens|GR|Europe/Athens;Atlanta|US|America/New_York;Auckland|NZ|Pacific/Auckland;Baghdad|IQ|Asia/Baghdad;Baku|AZ|Asia/Baku;Bangkok|TH|Asia/Bangkok;Barcelona|ES|Europe/Madrid;Beijing|CN|Asia/Shanghai;Beirut|LB|Asia/Beirut;Belgrade|RS|Europe/Belgrade;Bengaluru|IN|Asia/Kolkata;Berlin|DE|Europe/Berlin;Bogota|CO|America/Bogota;Boston|US|America/New_York;Brasilia|BR|America/Sao_Paulo;Brisbane|AU|Australia/Brisbane;Brussels|BE|Europe/Brussels;Bucharest|RO|Europe/Bucharest;Budapest|HU|Europe/Budapest;Buenos Aires|AR|America/Argentina/Buenos_Aires;Cairo|EG|Africa/Cairo;Calgary|CA|America/Edmonton;Cape Town|ZA|Africa/Johannesburg;Caracas|VE|America/Caracas;Casablanca|MA|Africa/Casablanca;Cebu|PH|Asia/Manila;Chicago|US|America/Chicago;Colombo|LK|Asia/Colombo;Copenhagen|DK|Europe/Copenhagen;Dallas|US|America/Chicago;Dar es Salaam|TZ|Africa/Dar_es_Salaam;Darwin|AU|Australia/Darwin;Davao|PH|Asia/Manila;Delhi|IN|Asia/Kolkata;Denver|US|America/Denver;Detroit|US|America/Detroit;Dhaka|BD|Asia/Dhaka;Doha|QA|Asia/Qatar;Dubai|AE|Asia/Dubai;Dublin|IE|Europe/Dublin;Edmonton|CA|America/Edmonton;Frankfurt|DE|Europe/Berlin;Guatemala City|GT|America/Guatemala;Halifax|CA|America/Halifax;Hanoi|VN|Asia/Bangkok;Harare|ZW|Africa/Harare;Havana|CU|America/Havana;Helsinki|FI|Europe/Helsinki;Ho Chi Minh City|VN|Asia/Ho_Chi_Minh;Hong Kong|HK|Asia/Hong_Kong;Honolulu|US|Pacific/Honolulu;Houston|US|America/Chicago;Indianapolis|US|America/Indiana/Indianapolis;Islamabad|PK|Asia/Karachi;Istanbul|TR|Europe/Istanbul;Jakarta|ID|Asia/Jakarta;Jerusalem|IL|Asia/Jerusalem;Johannesburg|ZA|Africa/Johannesburg;Kabul|AF|Asia/Kabul;Kampala|UG|Africa/Kampala;Karachi|PK|Asia/Karachi;Kathmandu|NP|Asia/Kathmandu;Khartoum|SD|Africa/Khartoum;Kolkata|IN|Asia/Kolkata;Kuala Lumpur|MY|Asia/Kuala_Lumpur;Kuwait City|KW|Asia/Kuwait;Kyiv|UA|Europe/Kyiv;La Paz|BO|America/La_Paz;Lagos|NG|Africa/Lagos;Lahore|PK|Asia/Karachi;Las Vegas|US|America/Los_Angeles;Lima|PE|America/Lima;Lisbon|PT|Europe/Lisbon;London|GB|Europe/London;Los Angeles|US|America/Los_Angeles;Madrid|ES|Europe/Madrid;Managua|NI|America/Managua;Manila|PH|Asia/Manila;Melbourne|AU|Australia/Melbourne;Mexico City|MX|America/Mexico_City;Miami|US|America/New_York;Minneapolis|US|America/Chicago;Minsk|BY|Europe/Minsk;Montevideo|UY|America/Montevideo;Montreal|CA|America/Toronto;Moscow|RU|Europe/Moscow;Mumbai|IN|Asia/Kolkata;Muscat|OM|Asia/Muscat;Nairobi|KE|Africa/Nairobi;New Orleans|US|America/Chicago;New York|US|America/New_York;Oslo|NO|Europe/Oslo;Ottawa|CA|America/Toronto;Paris|FR|Europe/Paris;Perth|AU|Australia/Perth;Phoenix|US|America/Phoenix;Prague|CZ|Europe/Prague;Reykjavik|IS|Atlantic/Reykjavik;Rio de Janeiro|BR|America/Sao_Paulo;Riyadh|SA|Asia/Riyadh;Rome|IT|Europe/Rome;Salt Lake City|US|America/Denver;San Francisco|US|America/Los_Angeles;San Juan|PR|America/Puerto_Rico;San Salvador|SV|America/El_Salvador;Santiago|CL|America/Santiago;Santo Domingo|DO|America/Santo_Domingo;Sao Paulo|BR|America/Sao_Paulo;Seattle|US|America/Los_Angeles;Seoul|KR|Asia/Seoul;Shanghai|CN|Asia/Shanghai;Singapore|SG|Asia/Singapore;Sofia|BG|Europe/Sofia;St. John\'s|CA|America/St_Johns;Stockholm|SE|Europe/Stockholm;Suva|FJ|Pacific/Fiji;Sydney|AU|Australia/Sydney;Taipei|TW|Asia/Taipei;Tallinn|EE|Europe/Tallinn;Tashkent|UZ|Asia/Tashkent;Tbilisi|GE|Asia/Tbilisi;Tegucigalpa|HN|America/Tegucigalpa;Tehran|IR|Asia/Tehran;Tokyo|JP|Asia/Tokyo;Toronto|CA|America/Toronto;Tunis|TN|Africa/Tunis;Ulaanbaatar|MN|Asia/Ulaanbaatar;Vancouver|CA|America/Vancouver;Vienna|AT|Europe/Vienna;Warsaw|PL|Europe/Warsaw;Washington DC|US|America/New_York;Wellington|NZ|Pacific/Auckland;Winnipeg|CA|America/Winnipeg;Yangon|MM|Asia/Yangon;Yerevan|AM|Asia/Yerevan;Zagreb|HR|Europe/Zagreb;Zurich|CH|Europe/Zurich';
    const CITIES = CITY_SRC.split(';').map(x => { const p = x.split('|'); return { n: p[0], cc: p[1], tz: p[2] }; });
    const LOCAL_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();
    const H12 = (() => { try { return !!new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12; } catch (e) { return false; } })();
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const SOUNDS = { classic: 'Classic beeps', chime: 'Soft chime', digital: 'Digital pulse' };
    const TABS = [['clocks', 'Clocks', 'fa-globe'], ['alarms', 'Alarms', 'fa-bell'], ['stopwatch', 'Stopwatch', 'fa-stopwatch'], ['timer', 'Timer', 'fa-hourglass-half']];
    const $$ = id => document.getElementById(id), pad = (n, l) => String(n).padStart(l || 2, '0'), E = s => esc(s);

    let tm = { cities: ['New York', 'London', 'Tokyo'], style: 'logo', alarms: [], timers: [], sw: { run: false, t0: 0, acc: 0, laps: [] } };
    let tab = 'clocks', loaded = false, editing = null, q = '', sortBy = 'city', alDays = [], ringing = [], snoozes = [], lastMin = -1, swRaf = 0;
    const view = () => $$('time-view'), visible = () => typeof currentView !== 'undefined' && currentView === 'time-view';

    // ---------- storage ----------
    let saveT = null;
    function save() { clearTimeout(saveT); saveT = setTimeout(() => { api('/api/time', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tm) }).catch(() => {}); }, 300); }
    api('/api/time').then(d => {
        if (d && typeof d === 'object') {
            if (Array.isArray(d.cities)) tm.cities = d.cities;
            if (d.style) tm.style = d.style;
            if (Array.isArray(d.alarms)) tm.alarms = d.alarms;
            if (Array.isArray(d.timers)) tm.timers = d.timers;
            if (d.sw) tm.sw = Object.assign(tm.sw, d.sw);
        }
        tm.timers.forEach(t => { if (t.state === 'run' && t.end <= Date.now()) { t.state = 'done'; t.left = 0; } });   // finished while the app was closed: no alarm sound
        loaded = true; if (visible()) render();
    }).catch(() => { loaded = true; });

    // ---------- helpers ----------
    function homeCity() { const c = CITIES.find(x => x.tz === LOCAL_TZ); return { n: c ? c.n : (LOCAL_TZ ? LOCAL_TZ.split('/').pop().replace(/_/g, ' ') : 'Local time'), cc: c ? c.cc : '', tz: LOCAL_TZ, home: true }; }
    function fmtClock(tz, sec) { const p = clockParts(tz); let h = p.h, ap = ''; if (H12) { ap = h < 12 ? ' AM' : ' PM'; h = h % 12 || 12; } return DOW[p.dow] + ' ' + (H12 ? h : pad(h)) + ':' + pad(p.m) + (sec ? ':' + pad(Math.floor(p.s)) : '') + ap; }
    function fmtHM(h, m) { return H12 ? [(h % 12 || 12) + ':' + pad(m), h < 12 ? 'AM' : 'PM'] : [pad(h) + ':' + pad(m), '']; }
    function offsetLabel(tz) { const d = (tzOffsetMs(tz) - tzOffsetMs(LOCAL_TZ)) / 3600000; if (Math.abs(d) < .01) return 'Same time as you'; const a = Math.abs(d), h = Math.floor(a), m = Math.round((a - h) * 60); return (d > 0 ? '+' : '\u2212') + h + (m ? ':' + pad(m) : '') + 'h from you'; }
    const _dst = {};
    function isDST(tz) {
        if (tz in _dst) return _dst[tz];
        let r = false;
        try {
            const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
            const off = d => { const p = {}; f.formatToParts(d).forEach(x => { p[x.type] = +x.value; }); return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - Math.floor(d.getTime() / 60000) * 60000; };
            const y = new Date().getUTCFullYear(), a = off(new Date(Date.UTC(y, 0, 1))), b = off(new Date(Date.UTC(y, 6, 1))), n = off(new Date());
            r = a !== b && n === Math.max(a, b);
        } catch (e) {}
        return (_dst[tz] = r);
    }
    function styleTiles(cur, fn) { return Object.keys(CLOCK_STYLES).map(k => `<button class="ck-tile${k === cur ? ' on' : ''}" onclick="${fn}('${k}')" title="${CLOCK_STYLES[k]}">${clockSVG({ style: k, size: 'compact', at: [10, 10, 30] })}<span>${CLOCK_STYLES[k]}</span></button>`).join(''); }
    window.ckStyleTiles = styleTiles;

    // ---------- sound ----------
    let actx = null, ringTimer = 0, ringKill = 0;
    function ctx() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) {} return actx; }
    document.addEventListener('pointerdown', () => ctx(), { passive: true });
    function tone(f, at, dur, type, vol) {
        const c = ctx(); if (!c) return;
        const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + at;
        o.type = type; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
    }
    function pattern(name) {
        if (name === 'chime') { [660, 880, 1320].forEach((f, i) => tone(f, i * 0.28, 1.1, 'sine', 0.22)); }
        else if (name === 'digital') { for (let i = 0; i < 4; i++) tone(1800, i * 0.16, 0.09, 'square', 0.11); }
        else { for (let i = 0; i < 4; i++) tone(1000, i * 0.2, 0.12, 'square', 0.13); }
    }
    function startRing(sound) { stopRing(); pattern(sound); ringTimer = setInterval(() => pattern(sound), 1700); ringKill = setTimeout(() => dismissAll(), 180000); }
    function stopRing() { clearInterval(ringTimer); clearTimeout(ringKill); ringTimer = 0; }

    // ---------- ringing overlay ----------
    function ringBox() {
        let b = $$('tm-ringbox');
        if (!b) { b = document.createElement('div'); b.id = 'tm-ringbox'; b.className = 'tm-ringbox'; document.body.appendChild(b); }
        return b;
    }
    function renderRing() {
        const b = ringBox();
        if (!ringing.length) { b.classList.remove('on'); b.innerHTML = ''; stopRing(); return; }
        const r = ringing[0];
        b.innerHTML = `<div class="tm-ringcard"><div class="tm-ringic"><i class="fas ${r.kind === 'alarm' ? 'fa-bell' : 'fa-hourglass-end'}"></i></div>
            <div class="tm-ringbig">${E(r.big)}</div><div class="tm-ringsub">${E(r.sub || '')}${ringing.length > 1 ? ` &middot; +${ringing.length - 1} more` : ''}</div>
            <div class="tm-ringbtns">${r.kind === 'alarm' ? `<button class="tm-btn" onclick="TM.snooze()">Snooze ${r.snooze} min</button>` : `<button class="tm-btn" onclick="TM.plusMin()">+1 min</button>`}<button class="tm-btn danger" onclick="TM.stop()">Stop</button></div></div>`;
        b.classList.add('on');
    }
    function pushRing(r) { ringing.push(r); renderRing(); if (ringing.length === 1) startRing(r.sound); }
    function dismissAll() { ringing = []; renderRing(); }
    function nextRing() { ringing.shift(); renderRing(); if (ringing.length) startRing(ringing[0].sound); }

    // ---------- alarms ----------
    function daysLabel(d) { if (!d.length) return 'Once'; if (d.length === 7) return 'Every day'; const s = d.slice().sort().join(); if (s === '1,2,3,4,5') return 'Weekdays'; if (s === '0,6') return 'Weekends'; return d.slice().sort().map(i => DOW[i]).join(' '); }
    function nextAlarmText() {
        const now = new Date(); let best = null;
        tm.alarms.filter(a => a.on).forEach(a => {
            for (let k = 0; k < 8; k++) {
                const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k, a.h, a.m, 0, 0);
                if (t <= now) continue; if (a.days.length && !a.days.includes(t.getDay())) continue;
                if (!best || t < best) best = t; break;
            }
        });
        snoozes.forEach(s => { const t = new Date(s.until); if (!best || t < best) best = t; });
        if (!best) return 'No alarm is set.';
        const mins = Math.max(1, Math.round((best - now) / 60000)), d = Math.floor(mins / 1440), h = Math.floor(mins % 1440 / 60), m = mins % 60;
        return 'Next alarm in ' + [d ? d + 'd' : '', h ? h + 'h' : '', (m || (!d && !h)) ? m + 'm' : ''].filter(Boolean).join(' ');
    }
    function fireAlarm(a) { pushRing({ kind: 'alarm', id: a.id, big: fmtHM(a.h, a.m).join(' ').trim(), sub: a.label || 'Alarm', sound: a.sound || 'classic', snooze: a.snooze || 5 }); }

    // ---------- views ----------
    function head() {
        return `<div class="tm-head"><div><h1>Time</h1><p id="tm-today"></p></div><div class="tm-tabs">${TABS.map(t => `<button class="${t[0] === tab ? 'on' : ''}" onclick="TM.tab('${t[0]}')"><i class="fas ${t[2]}"></i>${t[1]}</button>`).join('')}</div></div>`;
    }
    function card(c) {
        return `<div class="tm-card" data-city="${E(c.n)}">${clockSVG({ style: tm.style, size: 'compact', tz: c.tz })}
            <div class="tm-cname">${c.home ? '<i class="fas fa-house" style="font-size:.8rem;opacity:.7"></i>' : (c.cc ? `<span class="tm-cc">${E(c.cc)}</span>` : '')}${E(c.n)}</div>
            <div class="tm-ctime" data-ctz="${E(c.tz)}">${fmtClock(c.tz, true)}</div>
            <div class="tm-cmeta">${c.home ? 'Your time' : offsetLabel(c.tz)}</div>
            ${c.home ? '' : `<button class="tm-x" title="Remove" onclick="event.stopPropagation();TM.toggleCity('${E(c.n).replace(/'/g, '&#39;')}')"><i class="fas fa-xmark"></i></button>`}</div>`;
    }
    function cardsHTML() { return [homeCity()].concat(tm.cities.map(n => CITIES.find(c => c.n === n)).filter(Boolean)).map(card).join(''); }
    function tableHTML() {
        let list = CITIES.filter(c => !q || (c.n + ' ' + c.cc).toLowerCase().includes(q));
        list = sortBy === 'time' ? list.slice().sort((a, b) => tzOffsetMs(a.tz) - tzOffsetMs(b.tz) || a.n.localeCompare(b.n)) : list;
        if (!list.length) return '<div class="tm-note">No city matches that.</div>';
        return list.map(c => `<div class="tm-row" data-city="${E(c.n)}" onclick="TM.toggleCity(this.dataset.city)" title="Click to add or remove"><button class="tm-star${tm.cities.includes(c.n) ? ' on' : ''}"><i class="fas fa-star"></i></button><span class="tm-n">${E(c.n)}${isDST(c.tz) ? ' <span style="opacity:.55">*</span>' : ''}</span><span class="tm-t" data-rtz="${E(c.tz)}">${fmtClock(c.tz, false)}</span></div>`).join('');
    }
    function clocksHTML() {
        return `<div class="tm-sec-h" style="margin-top:0"><h2>My cities</h2></div><div id="tm-cards" class="tm-cards">${cardsHTML()}</div>
            <div class="tm-sec-h"><h2>Clock design</h2><span class="tm-note">Logo puts your logo on the dial</span></div><div class="ck-tiles" id="tm-styles">${styleTiles(tm.style, 'TM.style')}</div>
            <div class="tm-panel" style="margin-top:1.8rem"><div class="tm-bar"><h2>Current local times around the world</h2>
              <input id="tm-q" class="tm-in" placeholder="Search city" value="${E(q)}" oninput="TM.search(this.value)">
              <select class="tm-sel" onchange="TM.sort(this.value)"><option value="city"${sortBy === 'city' ? ' selected' : ''}>Sort by city</option><option value="time"${sortBy === 'time' ? ' selected' : ''}>Sort by time</option></select></div>
              <div id="tm-table" class="tm-table">${tableHTML()}</div><p class="tm-note" style="margin-top:1rem">Click a city to add it to My cities. * means daylight saving time is on right now.</p></div>`;
    }
    function alarmsHTML() {
        const e = editing ? tm.alarms.find(a => a.id === editing) : null, t = e ? pad(e.h) + ':' + pad(e.m) : '07:00';
        const rows = tm.alarms.slice().sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m)).map(a => { const hm = fmtHM(a.h, a.m);
            return `<div class="al-row${a.on ? '' : ' off'}"><div class="al-time" onclick="TM.alEdit('${a.id}')" title="Edit">${hm[0]}<small>${hm[1]}</small></div>
              <div class="al-meta"><div class="al-label">${E(a.label || 'Alarm')}</div><div class="al-sub">${daysLabel(a.days)} &middot; ${SOUNDS[a.sound] || 'Classic beeps'}</div></div>
              <button class="set-switch${a.on ? ' on' : ''}" onclick="TM.alToggle('${a.id}')" title="On / off"></button>
              <button class="tm-ic" onclick="TM.alEdit('${a.id}')" title="Edit"><i class="fas fa-pen"></i></button><button class="tm-ic" onclick="TM.alDel('${a.id}')" title="Delete"><i class="fas fa-trash"></i></button></div>`; }).join('');
        return `<div class="tm-grid2"><div class="tm-panel tm-form"><h2>${e ? 'Edit alarm' : 'New alarm'}</h2>
            <input id="al-time" type="time" class="tm-in al-big" value="${t}">
            <input id="al-label" class="tm-in" maxlength="80" placeholder="Label (optional)" value="${E(e ? e.label : '')}">
            <div class="al-days" id="al-days">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => `<button class="${alDays.includes(i) ? 'on' : ''}" onclick="TM.alDay(${i})" title="${DOW[i]}">${d}</button>`).join('')}</div>
            <div class="tm-note" style="margin-top:-.4rem">No day selected means it rings once.</div>
            <div class="tm-row2"><select id="al-sound" class="tm-sel">${Object.keys(SOUNDS).map(k => `<option value="${k}"${e && e.sound === k ? ' selected' : ''}>${SOUNDS[k]}</option>`).join('')}</select>
              <select id="al-snooze" class="tm-sel">${[5, 10, 15, 30].map(m => `<option value="${m}"${(e ? e.snooze : 5) === m ? ' selected' : ''}>Snooze ${m} min</option>`).join('')}</select></div>
            <div class="tm-row2"><button class="tm-btn" onclick="TM.alTest()"><i class="fas fa-volume-high"></i>Test sound</button>${e ? '<button class="tm-btn" onclick="TM.alCancel()">Cancel</button>' : ''}<button class="tm-btn primary" onclick="TM.alSave()">${e ? 'Save changes' : 'Add alarm'}</button></div>
            <p class="tm-note">Alarms ring while the app is open, on any screen.</p></div>
          <div><div class="al-next" id="al-next">${nextAlarmText()}</div>${rows || '<div class="tm-empty">No alarms yet. Set one on the left.</div>'}</div></div>`;
    }
    function fmtSW(ms) { const cs = Math.floor(ms / 10) % 100, s = Math.floor(ms / 1000) % 60, m = Math.floor(ms / 60000) % 60, h = Math.floor(ms / 3600000); return [(h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s), '.' + pad(cs)]; }
    const swMs = () => tm.sw.acc + (tm.sw.run ? Date.now() - tm.sw.t0 : 0);
    function lapsHTML() {
        const L = tm.sw.laps; if (!L.length) return '';
        const sp = L.map((t, i) => t - (i ? L[i - 1] : 0)), best = L.length > 2 ? Math.min.apply(null, sp) : -1, worst = L.length > 2 ? Math.max.apply(null, sp) : -1;
        return '<div class="sw-lap hd"><span>Lap</span><span>Split</span><span>Total</span></div>' + L.map((t, i) => i).reverse().map(i => { const a = fmtSW(sp[i]), b = fmtSW(L[i]); return `<div class="sw-lap${sp[i] === best ? ' best' : sp[i] === worst ? ' worst' : ''}"><span>${i + 1}</span><span>${a[0]}${a[1]}</span><span>${b[0]}${b[1]}</span></div>`; }).join('');
    }
    function stopwatchHTML() {
        const t = fmtSW(swMs()), C = 2 * Math.PI * 138;
        return `<div class="sw-wrap"><div class="sw-ring"><svg viewBox="0 0 300 300"><circle class="trk" cx="150" cy="150" r="138"/><circle id="sw-arc" class="arc" cx="150" cy="150" r="138" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}"/></svg>
            <div class="stw-time"><span id="sw-main">${t[0]}</span><small id="sw-cs">${t[1]}</small></div></div>
          <div class="sw-btns"><button id="sw-lap" class="tm-round" onclick="TM.swLap()"></button><button id="sw-go" class="tm-round go" onclick="TM.swToggle()"></button></div>
          <div class="sw-laps" id="sw-laps">${lapsHTML()}</div></div>`;
    }
    function swButtons() {
        const lap = $$('sw-lap'), go = $$('sw-go'); if (!lap || !go) return;
        const run = tm.sw.run, has = swMs() > 0;
        go.textContent = run ? 'Stop' : (has ? 'Resume' : 'Start'); go.className = 'tm-round ' + (run ? 'stop' : 'go');
        lap.textContent = run || !has ? 'Lap' : 'Reset'; lap.disabled = !run && !has;
    }
    function swPaint() {
        const m = $$('sw-main'); if (!m) return;
        const ms = swMs(), t = fmtSW(ms); m.textContent = t[0]; $$('sw-cs').textContent = t[1];
        const a = $$('sw-arc'); if (a) { const C = 2 * Math.PI * 138; a.setAttribute('stroke-dashoffset', (C * (1 - (ms % 60000) / 60000)).toFixed(1)); }
    }
    function swLoop() { cancelAnimationFrame(swRaf); const f = () => { if (visible() && tab === 'stopwatch' && $$('sw-main')) { swPaint(); if (tm.sw.run) swRaf = requestAnimationFrame(f); } }; swRaf = requestAnimationFrame(f); }
    function timerLeft(t) { return t.state === 'run' ? Math.max(0, t.end - Date.now()) : t.state === 'done' ? 0 : t.left; }
    function fmtT(ms) { const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return h ? h + ':' + pad(m) + ':' + pad(r) : pad(m) + ':' + pad(r); }
    function timerCard(t) {
        const R = 54, C = 2 * Math.PI * R, left = timerLeft(t), off = C * (1 - (t.total ? left / t.total : 0));
        return `<div class="tt-card${t.state === 'done' ? ' done' : ''}" data-tid="${t.id}"><div class="tt-ring"><svg viewBox="0 0 120 120"><circle class="trk" cx="60" cy="60" r="${R}"/><circle class="arc" cx="60" cy="60" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg><div class="tt-left">${t.state === 'done' ? '0:00' : fmtT(left)}</div></div>
          <div class="tt-name">${E(t.label || fmtT(t.total) + ' timer')}</div><div class="tt-sub">${t.state === 'done' ? 'Time\u2019s up' : t.state === 'run' ? 'Running' : t.state === 'pause' ? 'Paused' : 'Ready'}</div>
          <div class="tt-acts">${t.state === 'done' ? `<button class="tm-btn" onclick="TM.ttReset('${t.id}')">Restart</button>` : `<button class="tm-btn primary" onclick="TM.ttToggle('${t.id}')">${t.state === 'run' ? 'Pause' : 'Start'}</button><button class="tm-ic" onclick="TM.ttPlus('${t.id}')" title="Add 1 minute"><i class="fas fa-plus"></i></button><button class="tm-ic" onclick="TM.ttReset('${t.id}')" title="Reset"><i class="fas fa-rotate-left"></i></button>`}<button class="tm-ic" onclick="TM.ttDel('${t.id}')" title="Delete"><i class="fas fa-trash"></i></button></div></div>`;
    }
    function timerHTML() {
        return `<div class="tm-grid2"><div class="tm-panel tm-form"><h2>New timer</h2>
            <div class="tt-hms"><label><input id="tt-h" type="number" min="0" max="99" value="0"><span>h</span></label><label><input id="tt-m" type="number" min="0" max="59" value="5"><span>m</span></label><label><input id="tt-s" type="number" min="0" max="59" value="0"><span>s</span></label></div>
            <div class="tt-pre">${[[60, '1 min'], [300, '5 min'], [600, '10 min'], [900, '15 min'], [1500, '25 min'], [1800, '30 min'], [3600, '1 hour']].map(p => `<button onclick="TM.ttPreset(${p[0]})">${p[1]}</button>`).join('')}</div>
            <input id="tt-label" class="tm-in" maxlength="80" placeholder="Label (optional)">
            <button class="tm-btn primary" onclick="TM.ttAdd()"><i class="fas fa-play"></i>Start timer</button><p class="tm-note">Timers run while the app is open, on any screen.</p></div>
          <div id="tt-list">${tm.timers.length ? '<div class="tt-cards">' + tm.timers.map(timerCard).join('') + '</div>' : '<div class="tm-empty">No timers yet. Pick a time on the left and press Start.</div>'}</div></div>`;
    }
    function render() {
        const v = view(); if (!v) return;
        v.innerHTML = head() + '<div id="tm-body">' + (tab === 'clocks' ? clocksHTML() : tab === 'alarms' ? alarmsHTML() : tab === 'stopwatch' ? stopwatchHTML() : timerHTML()) + '</div>';
        if (tab === 'stopwatch') { swButtons(); swLoop(); }
        tickText(true);
    }
    function tickText(force) {
        const td = $$('tm-today'); if (td) { const d = new Date(); td.textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
        document.querySelectorAll('.tm-ctime').forEach(el => { el.textContent = fmtClock(el.dataset.ctz, true); });
        const m = new Date().getMinutes();
        if (force || m !== lastMin) {
            lastMin = m;
            document.querySelectorAll('.tm-t').forEach(el => { el.textContent = fmtClock(el.dataset.rtz, false); });
            const n = $$('al-next'); if (n) n.textContent = nextAlarmText();
        }
    }
    function updateTimers() {
        document.querySelectorAll('.tt-card').forEach(el => {
            const t = tm.timers.find(x => x.id === el.dataset.tid); if (!t) return;
            const left = timerLeft(t), C = 2 * Math.PI * 54, l = el.querySelector('.tt-left'), a = el.querySelector('.arc');
            const txt = t.state === 'done' ? '0:00' : fmtT(left); if (l.textContent !== txt) l.textContent = txt;
            a.setAttribute('stroke-dashoffset', (C * (1 - (t.total ? left / t.total : 0))).toFixed(1));
        });
    }

    // ---------- global tick: alarms and timers fire from any screen ----------
    function tick() {
        let dirty = false, redraw = false;
        if (loaded) {
            const now = new Date(), key = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate() + ' ' + now.getHours() + ':' + now.getMinutes();
            tm.alarms.forEach(a => {
                if (a.on && a.h === now.getHours() && a.m === now.getMinutes() && a.last !== key && now.getSeconds() < 45 && (!a.days.length || a.days.includes(now.getDay()))) {
                    a.last = key; if (!a.days.length) a.on = false; fireAlarm(a); dirty = redraw = true;
                }
            });
            snoozes = snoozes.filter(s => { if (Date.now() >= s.until) { const a = tm.alarms.find(x => x.id === s.id); if (a) fireAlarm(a); return false; } return true; });
            tm.timers.forEach(t => { if (t.state === 'run' && Date.now() >= t.end) { t.state = 'done'; t.left = 0; pushRing({ kind: 'timer', id: t.id, big: 'Time\u2019s up', sub: t.label || fmtT(t.total) + ' timer', sound: 'digital' }); dirty = redraw = true; } });
            if (dirty) save();
        }
        if (!visible()) return;
        if (redraw) { if (tab === 'alarms' || tab === 'timer') render(); return; }
        tickText(false); if (tab === 'timer') updateTimers();
    }
    setInterval(tick, 250);

    // ---------- actions (called from the page) ----------
    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    window.TM = {
        tab(t) { tab = t; render(); },
        style(k) { tm.style = k; save(); const c = $$('tm-cards'); if (c) c.innerHTML = cardsHTML(); const s = $$('tm-styles'); if (s) s.innerHTML = styleTiles(k, 'TM.style'); },
        toggleCity(n) { const i = tm.cities.indexOf(n); if (i >= 0) tm.cities.splice(i, 1); else tm.cities.push(n); save(); const c = $$('tm-cards'); if (c) c.innerHTML = cardsHTML(); const t = $$('tm-table'); if (t) t.querySelectorAll('.tm-row').forEach(r => r.querySelector('.tm-star').classList.toggle('on', tm.cities.includes(r.dataset.city))); },
        search(v) { q = v.trim().toLowerCase(); const t = $$('tm-table'); if (t) t.innerHTML = tableHTML(); },
        sort(v) { sortBy = v; const t = $$('tm-table'); if (t) t.innerHTML = tableHTML(); },
        // alarms
        alDay(i) { const k = alDays.indexOf(i); if (k >= 0) alDays.splice(k, 1); else alDays.push(i); document.querySelectorAll('#al-days button').forEach((b, j) => b.classList.toggle('on', alDays.includes(j))); },
        alSave() {
            const v = ($$('al-time').value || '07:00').split(':'), a = { h: +v[0] || 0, m: +v[1] || 0, label: $$('al-label').value.trim(), days: alDays.slice().sort(), sound: $$('al-sound').value, snooze: +$$('al-snooze').value || 5, on: true, last: '' };
            if (editing) { const o = tm.alarms.find(x => x.id === editing); if (o) Object.assign(o, a); } else tm.alarms.push(Object.assign({ id: uid() }, a));
            editing = null; alDays = []; save(); render(); toast('Alarm saved');
        },
        alEdit(id) { const a = tm.alarms.find(x => x.id === id); if (!a) return; editing = id; alDays = a.days.slice(); render(); },
        alCancel() { editing = null; alDays = []; render(); },
        alToggle(id) { const a = tm.alarms.find(x => x.id === id); if (!a) return; a.on = !a.on; a.last = ''; save(); render(); },
        alDel(id) { tm.alarms = tm.alarms.filter(x => x.id !== id); snoozes = snoozes.filter(s => s.id !== id); if (editing === id) { editing = null; alDays = []; } save(); render(); },
        alTest() { const s = $$('al-sound'); pattern(s ? s.value : 'classic'); },
        // ringing
        stop() { stopRing(); nextRing(); },
        snooze() { const r = ringing[0]; if (r && r.kind === 'alarm') { snoozes.push({ id: r.id, until: Date.now() + r.snooze * 60000 }); toast('Snoozed for ' + r.snooze + ' min'); } nextRing(); if (visible() && tab === 'alarms') tickText(true); },
        plusMin() { const r = ringing[0], t = r && tm.timers.find(x => x.id === r.id); if (t) { t.state = 'run'; t.total = 60000; t.end = Date.now() + 60000; save(); } nextRing(); if (visible() && tab === 'timer') render(); },
        // stopwatch
        swToggle() { const s = tm.sw; if (s.run) { s.acc += Date.now() - s.t0; s.run = false; } else { s.t0 = Date.now(); s.run = true; } save(); swButtons(); swLoop(); swPaint(); },
        swLap() { const s = tm.sw; if (s.run) { s.laps.push(swMs()); $$('sw-laps').innerHTML = lapsHTML(); } else { s.acc = 0; s.laps = []; $$('sw-laps').innerHTML = ''; } save(); swButtons(); swPaint(); },
        // timers
        ttPreset(sec) { $$('tt-h').value = Math.floor(sec / 3600); $$('tt-m').value = Math.floor(sec % 3600 / 60); $$('tt-s').value = sec % 60; },
        ttAdd() {
            const ms = ((+$$('tt-h').value || 0) * 3600 + (+$$('tt-m').value || 0) * 60 + (+$$('tt-s').value || 0)) * 1000;
            if (ms < 1000) { toast('Set a time first'); return; }
            tm.timers.unshift({ id: uid(), label: $$('tt-label').value.trim(), total: ms, state: 'run', end: Date.now() + ms, left: ms }); ctx(); save(); render();
        },
        ttToggle(id) { const t = tm.timers.find(x => x.id === id); if (!t) return; if (t.state === 'run') { t.left = Math.max(0, t.end - Date.now()); t.state = 'pause'; } else { if (!t.left || t.state === 'idle') t.left = t.total; t.end = Date.now() + t.left; t.state = 'run'; ctx(); } save(); render(); },
        ttPlus(id) { const t = tm.timers.find(x => x.id === id); if (!t) return; if (t.state === 'run') t.end += 60000; else t.left += 60000; t.total += 60000; save(); render(); },
        ttReset(id) { const t = tm.timers.find(x => x.id === id); if (!t) return; t.left = t.total; t.state = 'idle'; save(); render(); },
        ttDel(id) { tm.timers = tm.timers.filter(x => x.id !== id); save(); render(); }
    };
    window.timeOpened = function () { render(); };
})();
