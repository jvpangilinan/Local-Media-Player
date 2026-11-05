/* Optional lock for the Photos section. It uses the SAME password as the private library (one password for
   everything); entering it in either place opens both. Server side: /api/plock/*. A locked gallery answers 423;
   this file shows the unlock screen, the Settings controls, and locks again after idle time / Ctrl+L.
   Uses globals from app.js ($, api, post, PH, HP, enterPrivate, ...). */
(function () {
    'use strict';

    const PL = { on: false, hasPw: false, unlocked: true };
    window.PL = PL;
    const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
    const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const errText = e => { const d = (e && e.data) || {}; return e && e.status === 429 ? 'Too many attempts. Try again in ' + (d.retry_after || 30) + 's.' : (d.error || 'Something went wrong.'); };

    // ---------------------------------------------------------------- unlock screen (inside the Photos tab)
    window.plShow = function (box) {
        PL.on = true; PL.hasPw = true; PL.unlocked = false; paintAll();
        if (!box) return;
        box.innerHTML = '<div class="pl-wrap"><div class="pl-card"><div class="pl-ico"><i class="fas fa-lock"></i></div>' +
            '<div class="pl-h">Photos are locked</div><p>Enter your password to continue. It is the same one as the private library.</p>' +
            '<input id="pl-pass" class="pl-input" type="password" placeholder="Password" autocomplete="off">' +
            '<div class="pl-err" id="pl-err"></div><button class="pl-btn" id="pl-go">Unlock</button></div></div>';
        const go = async () => {
            const pw = $('pl-pass').value;
            try {
                const r = await post('/api/plock/unlock', { password: pw });
                PL.unlocked = true; paintAll();
                HP.pub.t = 0; if (typeof dashSoon === 'function') dashSoon();
                if (r && r.token && typeof enterPrivate === 'function') enterPrivate(r.token, true);     // same password: the private library opens too
                loadPhotos(true);
            } catch (e) {
                $('pl-err').textContent = errText(e);
                const c = box.querySelector('.pl-card'); c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake');
                $('pl-pass').select();
            }
        };
        $('pl-go').onclick = go;
        $('pl-pass').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
        setTimeout(() => { const i = $('pl-pass'); if (i) i.focus(); }, 30);
    };

    // ---------------------------------------------------------------- refresh from the server (called after the private library unlocks)
    window.plRefresh = async function () {
        let s; try { s = await api('/api/plock/status'); } catch (e) { return; }
        const wasLocked = !PL.unlocked;
        PL.on = !!s.enabled; PL.hasPw = !!s.has_password; PL.unlocked = !!s.unlocked;
        paintAll();
        if (PL.unlocked && wasLocked) {
            HP.pub.t = 0; if (typeof dashSoon === 'function') dashSoon();
            if (typeof currentView !== 'undefined' && currentView === 'photos-view') loadPhotos(true);
        }
    };

    // ---------------------------------------------------------------- lock again
    window.plLockNow = async function () {
        if (!PL.on || !PL.unlocked) return;
        try { await post('/api/plock/lock', {}); } catch (e) { /* the server drops the session anyway on restart */ }
        PL.unlocked = false;
        try { closePhotoNow(); } catch (e) {}
        PH.items = []; PH.view = []; PH.loaded = false; PH.album = null; PH.next = null; PH.bak = null;
        HP.pub.items = []; HP.pub.t = 0;
        paintAll();
        if (typeof dashSoon === 'function') dashSoon();
        if (typeof currentView !== 'undefined' && currentView === 'photos-view') loadPhotos(true);
    };

    // ---------------------------------------------------------------- the little bar above the gallery + the Settings section
    function paintBar() {
        const b = $('pl-bar'); if (!b) return;
        b.innerHTML = (PL.on && PL.unlocked) ? '<button class="pl-pill" onclick="plLockNow()" title="Lock Photos (Ctrl+L)"><i class="fas fa-lock"></i> Lock Photos</button>'
            : !PL.on ? '<button class="pl-pill" onclick="plTurnOn()" title="Ask for your private-library password on Photos"><i class="fas fa-key"></i> Add a password</button>' : '';
    }
    function paintSettings() {
        const s = $('set-photolock'); if (!s) return;
        s.innerHTML = 
            '<div class="flex items-center justify-between gap-4 mb-3"><div><div class="text-sm font-semibold">Ask for the password on Photos</div>' +
            '<div class="text-xs text-gray-500">' + (PL.on
                ? 'On. It is the same password as your private library, so one password covers both and entering it in either place opens both. Photos lock again after you are idle, or with Ctrl+L.'
                : 'Off. Anyone who opens the app can see Photos. Turn it on to use your private-library password here too' + (PL.hasPw ? '.' : ' (you will pick one now).')) + '</div></div>' +
            '<div class="flex gap-2 flex-none">' + (PL.on
                ? '<button class="chip" onclick="plChangePw()">Change password</button><button class="chip" onclick="plDialog(\'off\')">Turn off</button>'
                : '<button class="chip" onclick="plTurnOn()">Turn on</button>') + '</div></div>';
    }
    function paintAll() { paintBar(); paintSettings(); }
    window.plPaint = paintAll;

    // ---------------------------------------------------------------- turn on / off, change
    window.plTurnOn = async function () {
        if (!PL.hasPw) return plDialog('create');
        try { await post('/api/plock/enable', {}); PL.on = true; PL.unlocked = true; paintAll(); if (typeof toast === 'function') toast('Photos now ask for your private-library password'); }
        catch (e) { if (typeof toast === 'function') toast(errText(e)); }
    };
    window.plChangePw = function () {                  // the one password is changed from the private-library lock
        if (typeof token !== 'undefined' && token) { if (typeof closeSettings === 'function') try { closeSettings(); } catch (e) {} openLockModal('change'); }
        else if (typeof toast === 'function') toast('Unlock first (lock icon in the sidebar), then you can change the password.');
    };

    let dlg = null;
    window.plDialog = function (mode) {
        if (dlg) dlg.remove();
        const T = { create: ['Pick a password', 'This becomes the password for Photos and for your private library. At least 4 characters.', 'Save and turn on'],
                    off: ['Turn off the Photos lock', 'Enter your password. Photos will be open to everyone again; your private library keeps its lock.', 'Turn off'] }[mode];
        dlg = el('div', 'pl-modal');
        dlg.innerHTML = '<div class="pl-card"><div class="pl-h">' + E(T[0]) + '</div><p>' + E(T[1]) + '</p>' +
            (mode === 'off' ? '<input id="pld-old" class="pl-input" type="password" placeholder="Password" autocomplete="off">'
                : '<input id="pld-new" class="pl-input" type="password" placeholder="Password" autocomplete="off"><input id="pld-new2" class="pl-input" type="password" placeholder="Confirm password" autocomplete="off">') +
            '<div class="pl-err" id="pld-err"></div><div class="pl-row"><button class="pl-btn ghost" id="pld-x">Cancel</button><button class="pl-btn" id="pld-ok">' + E(T[2]) + '</button></div></div>';
        document.body.appendChild(dlg);
        const close = () => { if (dlg) { dlg.remove(); dlg = null; } };
        dlg.addEventListener('mousedown', e => { if (e.target === dlg) close(); });
        $('pld-x').onclick = close;
        const fail = m => { $('pld-err').textContent = m; const c = dlg.querySelector('.pl-card'); c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake'); };
        const ok = async () => {
            try {
                if (mode === 'off') {
                    await post('/api/plock/disable', { password: $('pld-old').value });
                    PL.on = false; PL.unlocked = true;
                } else {
                    const n = $('pld-new').value;
                    if (n.length < 4) return fail('Use at least 4 characters.');
                    if (n !== $('pld-new2').value) return fail('The passwords do not match.');
                    await post('/api/plock/enable', { password: n });
                    PL.on = true; PL.hasPw = true; PL.unlocked = true;
                    if (typeof hasPassword !== 'undefined') hasPassword = true;           // the sidebar lock now asks for it too
                }
                close(); paintAll();
            } catch (e) { fail(errText(e)); }
        };
        $('pld-ok').onclick = ok;
        dlg.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); else if (e.key === 'Escape') close(); });
        setTimeout(() => { const i = $(mode === 'off' ? 'pld-old' : 'pld-new'); if (i) i.focus(); }, 30);
    };

    // ---------------------------------------------------------------- auto-lock + Ctrl+L
    setInterval(() => {
        if (!PL.on || !PL.unlocked) return;
        if (typeof IDLE_LOCK_MINUTES !== 'undefined' && Date.now() - lastActivity > IDLE_LOCK_MINUTES * 60000) plLockNow();
    }, 10000);
    document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') plLockNow(); }, true);

    // ---------------------------------------------------------------- start
    (async function init() {
        try { const s = await api('/api/plock/status'); PL.on = !!s.enabled; PL.hasPw = !!s.has_password; PL.unlocked = !!s.unlocked; } catch (e) {}
        paintAll();
    })();
})();
