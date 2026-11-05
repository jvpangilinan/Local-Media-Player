/* ffmpeg + ffprobe are optional now: videos are played by libmpv as they are. ULTRON still uses ffmpeg for black-bar detection,
   the precision trimmer, clips, auto subtitles and the downloader. This screen offers a one-click setup and can be skipped
   (the choice is remembered; Settings > Downloader tools still lets you set a folder). */
(function () {
    var H = { 'Content-Type': 'application/json', 'X-LMP': '1' };
    var box = null, timer = 0, busy = false, SKIP = 'ultron_ffmpeg_skip';
    function skipped() { try { return localStorage.getItem(SKIP) === '1'; } catch (e) { return false; } }

    function get(url) { return fetch(url, { headers: { 'X-LMP': '1' } }).then(function (r) { return r.json(); }); }
    function send(url, body) {
        return fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body || {}) }).then(function (r) {
            return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Failed'); return j; });
        });
    }
    function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    function css() {
        if (document.getElementById('ffgate-css')) return;
        var st = document.createElement('style'); st.id = 'ffgate-css';
        st.textContent =
            '#ffgate{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(6,6,8,.97);color:#eee;font-family:Inter,system-ui,sans-serif}' +
            '#ffgate .ffc{width:min(560px,92vw);padding:28px 30px;border:1px solid #6b1118;border-radius:14px;background:#0e0e11;box-shadow:0 0 60px rgba(225,29,46,.18)}' +
            '#ffgate h2{margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:.04em;color:#ff3b4a}' +
            '#ffgate p{margin:8px 0;font-size:14px;line-height:1.5;color:#c9c9d0}' +
            '#ffgate .ffs{margin:14px 0;padding:10px 12px;border-radius:8px;background:#17171c;font-size:13px}' +
            '#ffgate .ok{color:#4ade80}#ffgate .no{color:#ff6b78}' +
            '#ffgate button{cursor:pointer;border:0;border-radius:8px;padding:10px 16px;font-weight:700;font-size:14px;color:#fff;background:#c4162a}' +
            '#ffgate button:hover{background:#e11d2e}#ffgate button.ffg{background:#26262d}#ffgate button.ffg:hover{background:#34343d}' +
            '#ffgate button:disabled{opacity:.5;cursor:default}' +
            '#ffgate .ffr{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}' +
            '#ffgate input{flex:1;min-width:0;padding:9px 10px;border-radius:8px;border:1px solid #33333b;background:#111116;color:#eee;font-size:13px}' +
            '#ffgate .ffbar{height:8px;border-radius:5px;background:#26262d;overflow:hidden;margin-top:10px}' +
            '#ffgate .ffbar i{display:block;height:100%;width:0;background:#e11d2e;transition:width .3s}' +
            '#ffgate .fferr{color:#ff6b78;font-size:13px;margin-top:8px;min-height:16px}';
        document.head.appendChild(st);
    }

    function render(s) {
        css();
        if (!box) { box = document.createElement('div'); box.id = 'ffgate'; document.body.appendChild(box); }
        var ins = s.install || {}, running = ins.state === 'running';
        var line = function (name, p) { return '<div>' + (p ? '<span class="ok">\u2714</span> ' : '<span class="no">\u2716</span> ') + name + (p ? ' <span style="opacity:.5">' + esc(p) + '</span>' : ' not found') + '</div>'; };
        box.innerHTML =
            '<div class="ffc"><h2>FFMPEG (OPTIONAL)</h2>' +
            '<p>Videos play as they are (MKV, HEVC, AC3/DTS and all), so nothing is converted and you never need HandBrake. <b>ffmpeg</b> and <b>ffprobe</b> are only used for black-bar detection, the precision trimmer, clips, auto subtitles and the downloader.</p>' +
            '<div class="ffs">' + line('ffmpeg', s.ffmpeg) + line('ffprobe', s.ffprobe) + '</div>' +
            (running ? '<p>' + esc(ins.msg || 'Working...') + ' ' + (ins.pct || 0) + '%</p><div class="ffbar"><i style="width:' + (ins.pct || 0) + '%"></i></div>' :
                (s.windows ? '<div class="ffr"><button id="ff-dl">Download FFmpeg automatically</button><button id="ff-re" class="ffg">Check again</button></div>' :
                    '<p>Install ffmpeg with your package manager (for example <b>sudo apt install ffmpeg</b>), then press Check again.</p><div class="ffr"><button id="ff-re" class="ffg">Check again</button></div>')) +
            '<p style="margin-top:16px;font-size:12px;opacity:.7">Already have them? Pick the folder that contains ffmpeg.exe and ffprobe.exe:</p>' +
            '<div class="ffr" style="margin-top:4px"><input id="ff-path" spellcheck="false" placeholder="e.g. C:\\ffmpeg\\bin"><button id="ff-br" class="ffg">Browse</button><button id="ff-use" class="ffg">Use folder</button></div>' +
            '<div class="ffr"><button id="ff-skip" class="ffg">Skip for now</button></div>' +
            '<div class="fferr" id="ff-err">' + esc(ins.state === 'error' ? 'Download failed: ' + ins.error : '') + '</div></div>';
        var q = function (id) { return box.querySelector(id); };
        if (q('#ff-dl')) q('#ff-dl').onclick = function () { fail(''); send('/api/ffmpeg/install').then(refresh).catch(function (e) { fail(e.message); }); };
        if (q('#ff-re')) q('#ff-re').onclick = refresh;
        if (q('#ff-skip')) q('#ff-skip').onclick = function () { try { localStorage.setItem(SKIP, '1'); } catch (e) {} if (box) { box.remove(); box = null; } clearInterval(timer); timer = 0; };
        if (q('#ff-br')) q('#ff-br').onclick = function () {
            var a = window.pywebview && window.pywebview.api;
            if (!a || !a.pick_folder) { fail('The folder picker is not available here. Type the path instead.'); return; }
            a.pick_folder().then(function (p) { if (p) q('#ff-path').value = p; });
        };
        if (q('#ff-use')) q('#ff-use').onclick = function () {
            send('/api/ffmpeg/folder', { path: q('#ff-path').value }).then(refresh).catch(function (e) { fail(e.message); });
        };
    }
    function fail(m) { var e = box && box.querySelector('#ff-err'); if (e) e.textContent = m; }

    function refresh() {
        if (busy || skipped()) return; busy = true;
        get('/api/ffmpeg/status').then(function (s) {
            busy = false;
            if (s.ok) { if (box) { box.remove(); box = null; } clearInterval(timer); timer = 0; return; }
            var typing = box && document.activeElement && document.activeElement.id === 'ff-path';
            if (!typing) render(s);
            if (!timer) timer = setInterval(refresh, 1500);
        }).catch(function () { busy = false; });
    }
    window.addEventListener('focus', function () { if (box) refresh(); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh); else refresh();
})();
