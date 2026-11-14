/* ULTRON auto subtitles (UI).
   Player: CC menu > "Generate subtitles..." opens a small panel (translate into / spoken language / quality), a pill shows progress,
   and the finished track is added to the player by itself. Settings > Subtitles: default language + quality, model download, "all videos".
   The work happens in autosubs.py (Whisper + NLLB, all on this PC). */
(function () {
    'use strict';
    var HX = { 'X-LMP': '1' }, HJ = { 'Content-Type': 'application/json', 'X-LMP': '1' };

    function jget(u) {
        return fetch(u, { headers: HX }).then(function (r) {
            return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Failed'); e.data = j; throw e; } return j; });
        });
    }
    function jpost(u, b) {
        return fetch(u, { method: 'POST', headers: HJ, body: JSON.stringify(b || {}) }).then(function (r) {
            return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Failed'); e.data = j; throw e; } return j; });
        });
    }
    function el(id) { return document.getElementById(id); }
    function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function vid() { try { return (typeof playingId !== 'undefined') ? playingId : null; } catch (e) { return null; } }
    function pf() { try { return prefs || {}; } catch (e) { return {}; } }
    function say(msg) { try { if (typeof hint === 'function') hint(msg); } catch (e) {} }

    var S = { cur: null, st: null, tracks: [], jobs: [], timer: 0, modal: null, prev: {}, first: false, busy: false };

    // ------------------------------------------------------------------ styles
    function css() {
        if (el('asub-css')) return;
        var st = document.createElement('style'); st.id = 'asub-css';
        st.textContent =
            '#asub-modal{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62);font-family:Inter,system-ui,sans-serif;color:#eee}' +
            '#asub-modal.hidden{display:none}' +
            '.asub-card{width:min(470px,92vw);max-height:90vh;overflow:auto;padding:20px 22px;border:1px solid #6b1118;border-radius:14px;background:#0e0e11;box-shadow:0 0 60px rgba(225,29,46,.2)}' +
            '.asub-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}' +
            '.asub-h b{font-size:17px;letter-spacing:.03em;color:#ff3b4a}' +
            '.asub-x{background:none;border:0;color:#aaa;font-size:16px;cursor:pointer}.asub-x:hover{color:#fff}' +
            '.asub-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:9px 0;font-size:13px}' +
            '.asub-row select{width:220px;max-width:58%;padding:7px 8px;border-radius:8px;border:1px solid #33333b;background:#111116;color:#eee;font-size:13px}' +
            '.asub-chk{display:flex;gap:8px;align-items:center;margin:10px 0;font-size:12px;color:#aaa;cursor:pointer}' +
            '.asub-box{margin:10px 0;padding:10px 12px;border-radius:8px;background:#17171c;font-size:12.5px;line-height:1.5;color:#c9c9d0}' +
            '.asub-box.err{color:#ff8892;background:#2a1519}' +
            '.asub-trk{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px}.asub-trk span{flex:1}' +
            '.asub-btn{cursor:pointer;border:0;border-radius:8px;padding:9px 15px;font-weight:700;font-size:13px;color:#fff;background:#26262d}' +
            '.asub-btn:hover{background:#34343d}.asub-btn.p{background:#c4162a}.asub-btn.p:hover{background:#e11d2e}.asub-btn:disabled{opacity:.5;cursor:default}' +
            '.asub-btn.s{padding:4px 10px;font-size:12px}' +
            '.asub-bar{height:7px;border-radius:4px;background:#26262d;overflow:hidden;margin-top:7px}.asub-bar i{display:block;height:100%;width:0;background:#e11d2e;transition:width .4s}' +
            '.asub-act{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}' +
            '.asub-note{margin-top:10px;font-size:11.5px;color:#777;line-height:1.4}' +
            '#asub-pill{position:absolute;top:78px;left:16px;z-index:45;max-width:min(420px,70vw);padding:7px 12px;border-radius:999px;background:rgba(14,14,17,.88);border:1px solid #6b1118;color:#eee;font:12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '#asub-pill.hidden{display:none}#asub-pill:hover{border-color:#e11d2e}' +
            '.asub-sep{height:1px;margin:4px 8px;background:rgba(255,255,255,.12)}';
        document.head.appendChild(st);
    }

    // ------------------------------------------------------------------ data
    function loadStatus() {
        return jget('/api/autosubs/status').then(function (s) { S.st = s; return s; }).catch(function () { return S.st; });
    }
    function langOptions(withOrig, withAuto) {
        var l = (S.st && S.st.langs) || [];
        var h = withOrig ? '<option value="orig">Original language (no translation)</option>' : '';
        if (withAuto) h = '<option value="">Auto-detect</option>';
        return h + l.map(function (x) { return '<option value="' + esc(x.code) + '">' + esc(x.name) + '</option>'; }).join('');
    }
    function myJobs() { return S.jobs || []; }
    function active(j) { return j && (j.state === 'queued' || j.state === 'running'); }
    function activeJob() { return myJobs().filter(active)[0] || null; }

    function syncTracks(list) {
        var p = el('player'); if (!p) return [];
        var have = {}, added = [];
        [].slice.call(p.querySelectorAll('track[data-asub]')).forEach(function (t) {
            if (!list.some(function (x) { return x.target === t.dataset.asub; })) t.remove(); else have[t.dataset.asub] = t;
        });
        list.forEach(function (x) {
            var old = have[x.target];
            if (old && old.dataset.created === String(x.created)) return;
            if (old) { x.__ws = !!(old.track && old.track.mode === 'showing'); old.remove(); }
            var t = document.createElement('track');
            t.kind = 'subtitles'; t.label = x.label; t.srclang = x.lang || 'und';
            t.src = x.url + '?v=' + x.created;
            t.dataset.asub = x.target; t.dataset.created = String(x.created);
            p.appendChild(t);
            added.push(x);
        });
        return added;
    }
    function showTrack(target) {
        var p = el('player'); if (!p) return;
        var t = p.querySelector('track[data-asub="' + target + '"]'); if (!t || !t.track) return;
        [].slice.call(p.textTracks).forEach(function (x) { x.mode = (x === t.track) ? 'showing' : 'disabled'; });
        var cc = el('p-cc'); if (cc) cc.classList.add('on');
    }
    function anyShowing() {
        var p = el('player'); return !!p && [].slice.call(p.textTracks).some(function (t) { return t.mode === 'showing'; });
    }

    function refresh() {
        var id = vid();
        if (!id) return Promise.resolve();
        return jget('/api/videos/' + id + '/autosubs').then(function (d) {
            if (vid() !== id) return;
            var finished = d.jobs.filter(function (j) { return j.state === 'done' && S.prev[j.id] && (S.prev[j.id] === 'running' || S.prev[j.id] === 'queued'); });
            d.jobs.forEach(function (j) { S.prev[j.id] = j.state; });
            var prevT = {}; (S.tracks || []).forEach(function (x) { prevT[x.target] = true; });
            S.jobs = d.jobs; S.tracks = d.tracks;
            var added = syncTracks(d.tracks), shown = false;
            if (finished.length && added.length) {
                var a = added[added.length - 1];
                if (a.__ws || !prevT[a.target]) showTrack(a.target);      // finished: keep the user's choice if they turned it off while it grew
                say('Subtitles ready: ' + a.label); shown = true;
            } else {
                added.forEach(function (a) {                                                  // a growing track was swapped for a longer one: keep showing it
                    if (a.__ws || (a.partial && !prevT[a.target] && pf().subs_auto !== false && !anyShowing())) {
                        showTrack(a.target); shown = true;
                        if (!prevT[a.target]) say('First subtitles are ready, the rest follows while you watch');
                    }
                });
            }
            if (shown) {
            } else if (S.first && d.tracks.length && pf().subs_auto !== false && !anyShowing()) {
                var pref = d.tracks.filter(function (x) { return x.target === pf().asub_lang; })[0] || d.tracks[0];
                setTimeout(function () { if (!anyShowing()) showTrack(pref.target); }, 150);
            }
            S.first = false;
            paintModal(); paintPill(); schedule();
        }).catch(function () {});
    }
    function schedule() {
        clearTimeout(S.timer); S.timer = 0;
        var open = S.modal && !S.modal.classList.contains('hidden');
        if (vid() && (open || activeJob())) S.timer = setTimeout(function () { (open ? loadStatus() : Promise.resolve()).then(refresh); }, 1500);
    }

    // ------------------------------------------------------------------ pill
    function featureOn() { return pf().asub_enabled !== false; }          // the master switch in Settings
    function paintPill() {
        var pm = el('player-modal'); if (!pm) return;
        var pill = el('asub-pill');
        if (!featureOn()) { if (pill) pill.classList.add('hidden'); return; }
        if (!pill) {
            pill = document.createElement('div'); pill.id = 'asub-pill'; pill.className = 'p-ui hidden';   // p-ui: fades out together with the player controls
            pill.onclick = function () { window.asubOpen(); };
            pm.appendChild(pill);
        }
        var j = activeJob();
        if (!j && !S.dlTxt) { pill.classList.add('hidden'); return; }
        pill.classList.remove('hidden');
        if (!j) { pill.textContent = S.dlTxt; return; }
        pill.textContent = 'AI subtitles ' + (j.state === 'queued' ? '- waiting' : j.pct + '%') + (j.msg && j.state === 'running' ? ' - ' + j.msg : '');
    }

    // ------------------------------------------------------------------ the panel
    function build() {
        css();
        if (S.modal) return S.modal;
        var m = document.createElement('div'); m.id = 'asub-modal'; m.className = 'hidden';
        m.innerHTML =
            '<div class="asub-card">' +
            '<div class="asub-h"><b>Generate subtitles</b><button class="asub-x" onclick="asubClose()" title="Close">\u2715</button></div>' +
            '<div id="asub-existing"></div>' +
            '<div id="asub-engine"></div>' +
            '<div class="asub-row"><span>Translate into</span><select id="asub-target"></select></div>' +
            '<div class="asub-row"><span>Spoken language</span><select id="asub-source"></select></div>' +
            '<div class="asub-row"><span>Quality</span><select id="asub-mode"><option value="accurate">Accurate (slower)</option><option value="fast">Fast</option></select></div>' +
            '<label class="asub-chk"><input type="checkbox" id="asub-force"> Redo the speech recognition (ignore the saved text)</label>' +
            '<div id="asub-prog"></div>' +
            '<div class="asub-act"><button id="asub-go" class="asub-btn p" onclick="asubStart()">Generate</button><button class="asub-btn" onclick="asubClose()">Close</button></div>' +
            '<div class="asub-note">Everything runs on this PC. You can close this window and keep watching: the subtitles appear by themselves when they are ready. A second language for the same video only needs the translation step.</div>' +
            '</div>';
        ['keydown', 'keyup', 'keypress'].forEach(function (ev) {
            m.addEventListener(ev, function (e) { e.stopPropagation(); if (ev === 'keydown' && e.key === 'Escape') window.asubClose(); });
        });
        m.addEventListener('mousedown', function (e) { if (e.target === m) window.asubClose(); });
        m.addEventListener('click', function (e) { e.stopPropagation(); });
        m.addEventListener('dblclick', function (e) { e.stopPropagation(); });
        (el('player-modal') || document.body).appendChild(m);
        S.modal = m;
        return m;
    }
    function fillSelects() {
        var t = el('asub-target'), s = el('asub-source'); if (!t || t.dataset.ready === '1' || !S.st || !(S.st.langs || []).length) return;
        t.innerHTML = langOptions(true, false); s.innerHTML = langOptions(false, true);
        t.value = pf().asub_lang || 'en'; el('asub-mode').value = pf().asub_mode || 'accurate';
        t.dataset.ready = '1';
        t.onchange = el('asub-mode').onchange = function () { paintModal(); };
    }
    function paintModal() {
        if (!S.modal || S.modal.classList.contains('hidden')) return;
        fillSelects();
        var id = vid(), st = S.st || {};
        // existing generated tracks
        var ex = el('asub-existing');
        ex.innerHTML = S.tracks.length ? '<div class="asub-box">' + S.tracks.map(function (x) {
            return '<div class="asub-trk"><span>' + esc(x.label) + '</span><button class="asub-btn s" onclick="asubShow(\'' + esc(x.target) + '\')">Show</button><button class="asub-btn s" onclick="asubDelete(\'' + esc(x.target) + '\')">Delete</button></div>';
        }).join('') + '</div>' : '';
        // engine state
        var eng = el('asub-engine'), tgt = (el('asub-target') || {}).value, mode = (el('asub-mode') || {}).value || 'accurate';
        var dl = st.download || {}, html = '', blocked = false;
        if (!S.st) { html = '<div class="asub-box">Checking the engine...</div>'; blocked = true; }
        else if (st.available === false) { html = '<div class="asub-box err">Auto subtitles are not part of this build.</div>'; blocked = true; }
        else if (st.packages && !st.packages.ok) {
            html = '<div class="asub-box err">The AI packages are missing (' + esc((st.packages.missing || []).join(', ')) + '). Run build_exe.bat again.<br><span style="opacity:.7">' + esc(st.packages.error || '') + '</span></div>'; blocked = true;
        } else if (dl.state === 'running') {
            html = '<div class="asub-box">' + esc(dl.msg || 'Downloading...') + ' ' + (dl.pct || 0) + '%<div class="asub-bar"><i style="width:' + (dl.pct || 0) + '%"></i></div></div>'; blocked = true;
        } else if (!st.can_transcribe || (tgt !== 'orig' && !st.nllb)) {
            html = '<div class="asub-box">The speech and translation models are not installed yet (about 2.3 GB, one time).' +
                (dl.error ? '<div style="color:#ff8892;margin-top:6px">' + esc(dl.error) + '</div>' : '') +
                '<div style="margin-top:8px"><button class="asub-btn p s" onclick="asubDownload([\'' + (mode === 'fast' ? 'fast' : 'accurate') + '\',\'nllb\'])">Download now</button></div></div>'; blocked = true;
        } else if (mode === 'accurate' && !(st.whisper || {}).accurate) {
            html = '<div class="asub-box">The accurate model is not installed, so Fast will be used. <button class="asub-btn s" onclick="asubDownload([\'accurate\'])">Download accurate (1.6 GB)</button></div>';
        } else if (mode === 'fast' && !(st.whisper || {}).fast) {
            html = '<div class="asub-box">The fast model is not installed, so Accurate will be used.</div>';
        }
        eng.innerHTML = html;
        // progress of this request
        var j = myJobs().filter(function (x) { return x.target === tgt; })[0], prog = el('asub-prog'), go = el('asub-go');
        if (active(j)) {
            prog.innerHTML = '<div class="asub-box">' + esc(j.msg || '') + ' (' + j.pct + '%)<div class="asub-bar"><i style="width:' + j.pct + '%"></i></div></div>';
            go.textContent = 'Cancel'; go.disabled = false; go.dataset.mode = 'cancel';
        } else {
            prog.innerHTML = j && j.state === 'error' ? '<div class="asub-box err">' + esc(j.error) + '</div>' : (j && j.state === 'cancelled' ? '<div class="asub-box">Cancelled.</div>' : '');
            go.textContent = 'Generate'; go.disabled = blocked || !id; go.dataset.mode = 'go';
        }
    }

    window.asubOpen = function () {
        if (!vid() || !featureOn()) return;
        try { if (typeof closeMenu === 'function') closeMenu(); } catch (e) {}
        var m = build(); m.classList.remove('hidden');
        paintModal();
        loadStatus().then(function () { paintModal(); refresh(); });
    };
    window.asubClose = function () { if (S.modal) S.modal.classList.add('hidden'); schedule(); };
    window.asubShow = function (t) { showTrack(t); window.asubClose(); };
    window.asubDelete = function (t) {
        var id = vid(); if (!id) return;
        jpost('/api/videos/' + id + '/autosubs/delete', { target: t }).then(refresh);
    };
    window.asubStart = function () {
        var id = vid(), go = el('asub-go'); if (!id || !go) return;
        if (go.dataset.mode === 'cancel') { jpost('/api/videos/' + id + '/autosubs/cancel').then(refresh); return; }
        var body = { target: el('asub-target').value, source: el('asub-source').value, mode: el('asub-mode').value, force: el('asub-force').checked };
        go.disabled = true;
        jpost('/api/videos/' + id + '/autosubs', body).then(function () {
            try { if (typeof setPref === 'function' && (pf().asub_lang !== body.target || pf().asub_mode !== body.mode)) setPref({ asub_lang: body.target, asub_mode: body.mode }); } catch (e) {}
            el('asub-force').checked = false;
            return refresh();
        }).catch(function (e) {
            el('asub-prog').innerHTML = '<div class="asub-box err">' + esc(e.message) + '</div>';
            return loadStatus().then(function () { go.disabled = false; });
        });
    };
    window.asubDownload = function (models) {
        jpost('/api/autosubs/download', models ? { models: models } : {}).then(function (d) {
            if (S.st) S.st.download = d; paintModal(); asubPaint(); pollStatus();
        }).catch(function (e) { if (S.st) S.st.download = { state: 'error', error: e.message }; paintModal(); asubPaint(); });
    };
    var dlTimer = 0;
    function pollStatus() {
        clearTimeout(dlTimer);
        dlTimer = setTimeout(function () {
            loadStatus().then(function (s) {
                paintModal(); asubPaint();
                if (s && s.download && s.download.state === 'running') pollStatus();
            });
        }, 1200);
    }

    // ------------------------------------------------------------------ CC menu + player hooks
    function hookMenu() {
        if (typeof window.openMenu !== 'function' || window.openMenu.__asub) return !!(window.openMenu && window.openMenu.__asub);
        var orig = window.openMenu;
        window.openMenu = function (kind) {
            var r = orig.apply(this, arguments);
            try {
                var m = el('p-menu');
                if (kind === 'cc' && featureOn() && m && !m.classList.contains('hidden')) {
                    m.insertAdjacentHTML('beforeend', '<div class="asub-sep"></div><button class="menu-item" onclick="asubOpen()"><span><i class="fas fa-wand-magic-sparkles"></i>&nbsp; Generate subtitles\u2026</span></button>');
                }
            } catch (e) {}
            return r;
        };
        window.openMenu.__asub = true;
        return true;
    }
    // No subtitles at all (no file, none inside the video, none made before)? Listen to the video and make them by itself.
    function autoStart(id) {
        if (!featureOn() || pf().asub_auto !== true || vid() !== id) return;      // only when the feature is on AND automatic is switched on
        jpost('/api/videos/' + id + '/autosubs/auto').then(function (d) {
            if (vid() !== id) return;
            if (d.started) { say('No subtitles in this video: listening and making them now'); refresh(); }
            else if (d.reason === 'need_models') {
                if (/packages/i.test(d.error || '')) { if (!S.nudged) { S.nudged = true; say('The AI packages are missing: run build_exe.bat once'); } }
                else if (!S.autoDlFail) autoModels(id);
            }
        }).catch(function () {});
    }
    // First time only: the speech + translation models are not on this PC yet, so fetch them by themselves, then carry on.
    function autoModels(id) {
        if (S.autoDl) return; S.autoDl = true;
        var mode = pf().asub_mode === 'fast' ? 'fast' : 'accurate';
        jpost('/api/autosubs/download', { models: [mode, 'nllb'] }).then(function () {
            say('Downloading the subtitle models (one time only)');
            (function poll() {
                loadStatus().then(function (st) {
                    var d = (st && st.download) || {};
                    S.dlTxt = d.state === 'running' ? 'Downloading subtitle models ' + (d.pct || 0) + '%' : '';
                    paintPill();
                    if (d.state === 'running') { setTimeout(poll, 1500); return; }
                    S.autoDl = false;
                    if (d.state === 'error') { S.autoDlFail = true; say('Model download failed: ' + (d.error || 'unknown error')); return; }
                    if (vid()) autoStart(vid());
                });
            })();
        }).catch(function (e) { S.autoDl = false; S.autoDlFail = true; say(e.message || 'Could not start the model download'); });
    }
    window.asubAuto = function () { var id = vid(); if (id) autoStart(id); };

    function hookPlayer() {
        var p = el('player'); if (!p || p.__asub) return;
        p.__asub = true;
        p.addEventListener('loadstart', function () {
            var id = vid(); if (!id) return;
            var cc = el('p-cc'); if (cc) cc.classList.remove('hidden');
            if (id !== S.cur) {                       // a different video: start fresh (the same video reloading, e.g. after a playable copy, keeps the panel open)
                S.cur = id; S.tracks = []; S.jobs = []; S.first = true;
                if (S.modal) S.modal.classList.add('hidden');
                setTimeout(function () { autoStart(id); }, 2500);          // let the player list the tracks inside the file first
            } else { S.first = false; }
            refresh();
        });
    }

    // ------------------------------------------------------------------ settings panel
    function jobsText(j) {
        var a = (j.jobs || []).filter(active);
        if (!a.length) return '';
        var r = a.filter(function (x) { return x.state === 'running'; })[0] || a[0];
        return a.length + ' video' + (a.length > 1 ? 's' : '') + ' in line. Now: ' + (r.title || '') + ' - ' + (r.msg || '') + ' (' + r.pct + '%)';
    }
    window.asubPaint = function () {
        var l = el('set-asublang'); if (!l) return;
        if (!S.st) { loadStatus().then(function () { asubPaint(); }); return; }
        var ab = el('set-asubauto'); if (ab) { var aon = pf().asub_auto === true; ab.classList.toggle('on', aon); ab.setAttribute('aria-checked', aon ? 'true' : 'false'); }
        var eb = el('set-asubon'); if (eb) { var eon = featureOn(); eb.classList.toggle('on', eon); eb.setAttribute('aria-checked', eon ? 'true' : 'false'); var bx = el('set-asubbox'); if (bx) bx.style.opacity = eon ? '' : '.4'; }
        if (l.dataset.ready !== '1' && (S.st.langs || []).length) { l.innerHTML = langOptions(true, false); l.dataset.ready = '1'; }
        if (document.activeElement !== l) l.value = pf().asub_lang || 'en';
        var m = el('set-asubmode'); if (m && document.activeElement !== m) m.value = pf().asub_mode || 'accurate';
        var st = S.st, t = el('set-asubstat'), b = el('set-asubdl'), dl = st.download || {};
        var txt = '', showDl = false;
        if (st.available === false) txt = 'Auto subtitles are not part of this build.';
        else if (st.packages && !st.packages.ok) txt = 'AI packages missing (' + (st.packages.missing || []).join(', ') + '). Run build_exe.bat again.';
        else if (dl.state === 'running') txt = (dl.msg || 'Downloading...') + ' ' + (dl.pct || 0) + '%';
        else {
            var w = st.whisper || {};
            txt = 'Accurate model: ' + (w.accurate ? 'installed' : 'missing') + '  |  Fast model: ' + (w.fast ? 'installed' : 'missing') + '  |  Translator: ' + (st.nllb ? 'installed' : 'missing');
            showDl = !(w.accurate && w.fast && st.nllb);
            if (dl.error) txt += '\n' + dl.error;
        }
        if (t) { t.textContent = txt; t.style.whiteSpace = 'pre-line'; }
        if (b) { b.classList.toggle('hidden', !showDl); b.disabled = dl.state === 'running'; }
        jget('/api/autosubs/jobs').then(function (j) { var q = el('set-asubq'); if (q && !q.dataset.msg) q.textContent = jobsText(j); }).catch(function () {});
    };
    window.asubQueueAll = function () {
        var q = el('set-asubq'); if (!q) return;
        q.dataset.msg = '1';
        jpost('/api/autosubs/queue-all', {}).then(function (d) {
            q.textContent = d.queued ? ('Queued ' + d.queued + ' video' + (d.queued > 1 ? 's' : '') + (d.skipped ? ' (' + d.skipped + ' already have subtitles)' : '') + '. They run one after another in the background.') : 'Nothing to do: every video already has subtitles.';
            setTimeout(function () { q.dataset.msg = ''; }, 6000);
        }).catch(function (e) { q.textContent = e.message; setTimeout(function () { q.dataset.msg = ''; }, 8000); });
    };
    window.asubStopAll = function () {
        jpost('/api/autosubs/cancel-all', {}).then(function () { var q = el('set-asubq'); if (q) { q.dataset.msg = '1'; q.textContent = 'Stopping...'; setTimeout(function () { q.dataset.msg = ''; asubPaint(); }, 3000); } });
    };

    // ------------------------------------------------------------------ boot
    function boot() {
        css(); hookPlayer();
        if (!hookMenu()) setTimeout(hookMenu, 500);
        setInterval(function () {
            var t = el('set-asubstat');
            if (t && t.offsetParent !== null) loadStatus().then(function () { asubPaint(); });
        }, 3000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
    window.addEventListener('load', function () { hookMenu(); hookPlayer(); });
})();
