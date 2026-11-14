        // ======================= settings =======================
        let IDLE_LOCK_MINUTES = 5;      // auto-lock the private library after this much inactivity
        const PROGRESS_SAVE_MS = 10000;    // save the playback position at most this often
        let NEXT_COUNTDOWN = 8;         // seconds before the next episode starts by itself
        const ROWS = [
            { key: 'continue', title: 'Continue Watching', hideEmpty: true },
            { key: 'recent', title: 'Recently Added', hideEmpty: true },
            { key: 'most_watched', title: 'Most Watched', empty: 'Nothing watched yet. Play something and it will show up here.' },
            { key: 'unwatched', title: "Haven't Watched Yet", empty: 'You have watched everything!' },
            { key: 'standalone', title: 'Videos' }
        ];

        // the private library stays plain: what you were watching, what is new, what you have not seen
        const PRIVATE_ROWS = ['continue', 'recent', 'standalone'];
        const rowsFor = scope => scope === 'private' ? ROWS.filter(r => PRIVATE_ROWS.includes(r.key)) : ROWS.filter(r => r.key === 'continue');

        // ======================= helpers =======================
        const $ = id => document.getElementById(id);
        const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
        const fmtTime = sec => { sec = Math.round(sec || 0); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
        const fmtClock = sec => { sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
        const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
        const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
        const errMsg = e => (e && e.data && e.data.error) || (e && e.message) || 'Something went wrong.';
        const show = (id, on, flex) => { $(id).classList.toggle('hidden', !on); if (flex) $(id).classList.toggle('flex', on); };
        let toastTimer = null;
        function toast(msg, ms) {
            const t = $('toast');
            t.textContent = msg; t.classList.remove('hidden');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 3500);
        }

        const store = {
            get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
            set(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} }
        };
        const TOKEN_KEY = 'lmp_private_token', TAB_KEY = 'lmp_tab';
        let token = store.get(TOKEN_KEY);
        function setToken(t) { token = t || null; store.set(TOKEN_KEY, token); }

        let hasPassword = false;
        const privateIds = new Set();
        const titles = {};
        // every id whose title came from the private library; wiped from `titles` the moment it locks
        const privTitleKeys = new Set();
        function setTitle(id, t, priv) { titles[id] = t; if (priv || privateIds.has(id)) privTitleKeys.add(id); }
        function purgePrivateTitles() {
            privTitleKeys.forEach(k => { delete titles[k]; });
            privateIds.forEach(k => { delete titles[k]; });
            privTitleKeys.clear();
        }

        async function api(url, options) {
            options = options || {};
            const headers = Object.assign({}, options.headers || {});
            headers['X-LMP'] = '1';
            if (token) headers['X-Private-Token'] = token;
            const res = await fetch(url, Object.assign({}, options, { headers }));
            if (res.status === 403 && token && !url.startsWith('/api/lock')) lockNow();
            if (!res.ok) {
                const err = new Error('HTTP ' + res.status);
                err.status = res.status;
                try { err.data = await res.json(); } catch (e) { err.data = {}; }
                throw err;
            }
            return res.json();
        }
        const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        // Private media is authorised by an HttpOnly session cookie now, so URLs never carry the token.
        const withToken = url => url;
        // uploads / moves rescan in the background now: wait for it, then reload the lists
        async function waitForScan(maxMs) {
            const end = Date.now() + (maxMs || 20000);
            await new Promise(r => setTimeout(r, 150));
            while (Date.now() < end) {
                try { if (!(await api('/api/scan/status')).scanning) return; } catch (e) { return; }
                await new Promise(r => setTimeout(r, 250));
            }
        }
        const scopeOf = id => privateIds.has(id) ? 'private' : 'public';

        // ======================= tabs / nav =======================
        const VIEWS = { 'home-view': 'tab-home', 'video-view': 'tab-video', 'series-view': 'tab-video', 'videos-view': 'tab-video', 'music-view': 'tab-music', 'dl-view': 'tab-dl', 'photos-view': 'tab-photos', 'time-view': 'tab-time', 'private-view': 'tab-private' };
        let currentView = 'home-view';
        function syncPrivateUI() {
            $('tab-private').classList.toggle('hidden', !token);
            $('private-pill').classList.toggle('hidden', !token || currentView !== 'private-view');
        }
        function switchTab(viewId, tabId) {
            heroStop();
            currentView = viewId;
            Object.keys(VIEWS).forEach(v => {
                $(v).classList.add('hidden');
                $(v).classList.remove('block');
                $(VIEWS[v]).classList.remove('active');
            });
            $(viewId).classList.remove('hidden');
            $(viewId).classList.add('block');
            $(VIEWS[viewId] || tabId).classList.add('active');
            if (viewId === 'music-view' && !document.body.classList.contains('rail') && store.get('lmp_rail') !== '0') { document.body.classList.add('rail'); musicAutoRail = true; }
            else if (viewId !== 'music-view' && musicAutoRail) { document.body.classList.remove('rail'); musicAutoRail = false; }
            if (viewId === 'home-view') { HP.pub.t = HP.priv.t = 0; renderDashboard(); }
            document.body.style.overflowY = viewId === 'music-view' ? 'hidden' : '';
            store.set(TAB_KEY, viewId);
            if (viewId === 'music-view') musicOpened();
            if (viewId === 'dl-view') dlOpened();
            if (viewId === 'time-view' && window.timeOpened) timeOpened();
            if (viewId === 'photos-view') { phScope = 'public'; loadPhotos(true); }
            if (viewId === 'series-view' || viewId === 'videos-view') renderSections();
            syncPrivateUI();
            document.body.scrollTo({ top: 0, behavior: 'instant' });
            closeLockMenu(); closeQueue();
        }


        // ======================= settings panel =======================
        // Server-side defaults/validation live in app.py (PREF_DEFAULTS / clean_pref). Add a row to the modal, then
        // read prefs.<key> wherever the setting is used.
        const RES_PRESETS = [[1280, 720], [1366, 768], [1440, 900], [1600, 900], [1920, 1080], [2560, 1440]];
        let prefs = { wheel_rows: true, display_mode: 'windowed', win_width: 1440, win_height: 900, remember_size: true, close_to_tray: true, idle_lock_minutes: 5,
                      next_countdown: 8, default_volume: 80, default_speed: 1, default_fit: 'fit', subs_auto: true, subs_size: 115, asub_lang: 'en', asub_mode: 'accurate', asub_auto: false, asub_enabled: true, native_player: true,
                      start_tab: 'last', bg_mode: 'dark', bg_image: '', bg_custom_v: 0, clock_style: 'logo', hover_preview: true, tile_motion: false, ag_online: false, fav_public: true, fav_private: true, show_clock: false, browse_bar: 'auto', music_ui: 'prism', home_clock: true, folders: { video: '', music: '', private: '' },
                      ytdlp_dir: '', dl_vcodec: 'h264', dl_acodec: 'mp3', dl_mcodec: 'flac', dl_vargs: '', dl_aargs: '', dl_margs: '',
                      dl_audio_sub: 'Audio', dl_music_sub: 'Music' };
        let displayMode = 'windowed';
        function applyPrefs(p) {
            Object.assign(prefs, p || {});
            wheelRows = prefs.wheel_rows !== false;
            document.body.classList.toggle('priv-clear', prefs.private_blur_covers === false);
            IDLE_LOCK_MINUTES = prefs.idle_lock_minutes;
            NEXT_COUNTDOWN = prefs.next_countdown;
            displayMode = prefs.display_mode;
            player.defaultPlaybackRate = prefs.default_speed;
            applySubStyle();
            syncWheelBtn();
            applyTheme();
            { const cs = prefs.clock_style || 'logo'; if (applyPrefs.cs !== undefined && applyPrefs.cs !== cs) { const cc = $('corner-clock'); if (cc) cc.innerHTML = ''; try { if (currentView === 'home-view') renderDashboard(); } catch (e) {} } applyPrefs.cs = cs; }
            applyClock();
            try { hcKey = ''; tickHome(); if ($('dh-top')) renderDashboard(); } catch (e) {}
            { const de = document.documentElement, mu = 'prism', was = de.getAttribute('data-music-ui');
              de.setAttribute('data-music-ui', mu);
              try { localStorage.setItem('lmp_music_ui', mu); } catch (e) {}
              if (was !== mu) { try { if (currentView === 'music-view' && view && view.kind === 'home') renderHome(); } catch (e) {} } }
            if (window.paintBar) window.paintBar();
        }
        function applyVolumes() {
            const v = clamp(prefs.default_volume / 100, 0, 1);
            audio.volume = v; audio.muted = false; $('vol').value = prefs.default_volume; paintAudioVol();
            player.volume = v;
        }
        function applySubStyle() {
            let st = $('cue-style');
            if (!st) { st = document.createElement('style'); st.id = 'cue-style'; document.head.appendChild(st); }
            st.textContent = `video::cue { font-size: ${(prefs.subs_size / 100).toFixed(2)}em; }`;
        }
        function paintSettings() {
            document.querySelectorAll('#set-bg .bg-opt').forEach(b => b.classList.toggle('on', b.dataset.bg === (prefs.bg_mode || 'dark'))); paintBgImages(); paintClockStyles();
            $('set-hover').classList.toggle('on', prefs.hover_preview !== false);
            document.querySelectorAll('#set-mode .set-seg').forEach(b => b.classList.toggle('on', b.dataset.mode === prefs.display_mode));
            const cur = prefs.win_width + 'x' + prefs.win_height;
            const list = RES_PRESETS.filter(r => r[0] <= (screen.availWidth || 1e5) && r[1] <= (screen.availHeight || 1e5));
            if (!list.some(r => r[0] + 'x' + r[1] === cur)) list.push([prefs.win_width, prefs.win_height]);
            list.sort((a, b) => a[0] - b[0]);
            $('set-res').innerHTML = list.map(r => `<option value="${r[0]}x${r[1]}">${r[0]} \u00d7 ${r[1]}</option>`).join('');
            $('set-res').value = cur;
            const win = prefs.display_mode === 'windowed';
            $('set-res').disabled = !win; $('set-res-row').classList.toggle('opacity-40', !win);
            $('set-wheel').classList.toggle('on', wheelRows);
            $('set-remember').classList.toggle('on', !!prefs.remember_size);
            $('set-subs').classList.toggle('on', !!prefs.subs_auto);
            $('set-idle').value = String(prefs.idle_lock_minutes);
            if ($('set-hp')) $('set-hp').value = prefs.private_headphones || 'once';
            $('set-next').value = String(prefs.next_countdown);
            $('set-vol').value = prefs.default_volume; $('set-vol-val').textContent = prefs.default_volume;
            $('set-speed').value = String(prefs.default_speed);
            if ($('set-fit')) $('set-fit').value = prefs.default_fit;
            $('set-subsize').value = String(prefs.subs_size);
            if (window.asubPaint) { try { window.asubPaint(); } catch (e) {} }
            $('set-tab').value = prefs.start_tab;
            $('set-browse').value = prefs.browse_bar || 'auto';
            
            [['set-fav-public', prefs.fav_public !== false], ['set-fav-private', prefs.fav_private !== false], ['set-hover', prefs.hover_preview !== false], ['set-tilemotion', !!prefs.tile_motion], ['set-agonline', !!prefs.ag_online],
             ['set-wheel', wheelRows], ['set-remember', !!prefs.remember_size], ['set-tray', prefs.close_to_tray !== false], ['set-subs', !!prefs.subs_auto], ['set-clock', !!prefs.show_clock], ['set-homeclock', !!prefs.home_clock], ['set-privmute', prefs.private_start_muted !== false], ['set-privblur', prefs.private_blur_covers !== false]]
                .forEach(([id, on]) => { const b = $(id); b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
            [['set-ytdlp', 'ytdlp_dir'], ['set-vcodec', 'dl_vcodec'], ['set-acodec', 'dl_acodec'], ['set-mcodec', 'dl_mcodec'], ['set-vargs', 'dl_vargs'],
             ['set-aargs', 'dl_aargs'], ['set-margs', 'dl_margs'], ['set-asub', 'dl_audio_sub'], ['set-msub', 'dl_music_sub']]
                .forEach(([id, key]) => { const el = $(id); if (document.activeElement !== el) el.value = prefs[key] || ''; });
            ['video', 'music', 'private', 'photos', 'clips', 'shots'].forEach(k => { const el = $('set-f-' + k); if (document.activeElement !== el) el.value = (prefs.folders || {})[k] || ''; });
        }
        async function setPref(patch) {
            applyPrefs(patch); paintSettings();                       // instant feedback
            if ('private_sort' in patch && vdata.private) { try { paintStandalone('private', vdata.private); } catch (e) {} }
            if ('default_volume' in patch) applyVolumes();
            if ('fav_public' in patch || 'fav_private' in patch) favPrefsChanged();
            try { applyPrefs(await post('/api/prefs', patch)); paintSettings(); }
            catch (e) { toast(errMsg(e)); }
        }
        async function setFolder(kind, path) {
            try {
                applyPrefs(await post('/api/folders/set', { kind, path })); paintSettings();
                toast('Folder updated. Scanning...', 2500);
                await rescan();
            } catch (e) { toast(errMsg(e)); paintSettings(); }
        }
        async function browseFolder(kind) {
            const bridge = window.pywebview && window.pywebview.api;
            if (!bridge || !bridge.pick_folder) { toast('Folder browsing needs the desktop app. Type the path instead.', 3500); return; }
            const p = await bridge.pick_folder();
            if (p) setFolder(kind, p);
        }
        async function openArtistRules() {
            try { await post('/api/artist-rules/open'); toast('Opened artist_rules.txt. Press the rescan button after saving.', 4500); }
            catch (e) { toast(errMsg(e)); }
        }
        let resetArmed = null;
        async function resetPrefs() {
            const b = $('set-reset');
            if (!resetArmed) {
                b.textContent = 'Click again to confirm'; resetArmed = setTimeout(() => { resetArmed = null; b.innerHTML = '<i class="fas fa-rotate-left mr-1"></i>Reset settings to defaults'; }, 4000);
                return;
            }
            clearTimeout(resetArmed); resetArmed = null; b.innerHTML = '<i class="fas fa-rotate-left mr-1"></i>Reset settings to defaults';
            try { applyPrefs(await post('/api/prefs/reset')); applyVolumes(); paintSettings(); toast('Settings reset.'); }
            catch (e) { toast(errMsg(e)); }
        }
        // ---- backup / restore (Settings > Backup) ----
        async function exportBackup() {
            toast('Making your backup...', 8000);
            try {
                const d = await post('/api/backup/export');
                if (d.mode === 'cancelled') { toast('Backup cancelled.'); return; }
                toast('Backup saved: ' + d.path, 7000);
            } catch (e) { toast(errMsg(e), 6000); }
        }
        async function importBackup(inp) {
            const f = inp.files && inp.files[0]; inp.value = '';
            if (!f) return;
            if (!confirm('Restore "' + f.name + '"?\n\nYour current favorites, progress, playlists and settings are replaced by the ones in the backup. A safety copy of what you have now is saved first. Your media folders stay as they are.')) return;
            toast('Restoring...', 15000);
            try {
                const d = await api('/api/backup/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
                try { const ls = await api('/api/ls'); Object.keys(ls).forEach(k => localStorage.setItem(k, ls[k])); } catch (e) {}
                toast('Restored (' + (d.restored || []).join(', ') + '). Reloading...', 4000);
                setTimeout(() => location.reload(), 1000);
            } catch (e) { toast(errMsg(e), 6000); }
        }
        function openSettings() { closeLockMenu(); paintSettings(); show('settings-modal', true, true); refreshYtStatus(); }
        function closeSettings() { show('settings-modal', false, true); }

        // ======================= mouse wheel scrolls the rows =======================
        // Over a row the wheel scrolls it sideways (smoothly). At either end of the row it scrolls the page again.
        // Hold Alt to scroll the page while the pointer is over a row. The mouse button in the top bar turns this off
        // (then Shift + wheel still scrolls rows).
        let wheelRows = true;
        const wheelState = new WeakMap();
        function syncWheelBtn() {
            const b = $('wheel-btn');
            b.classList.toggle('text-accent', wheelRows);
            b.title = wheelRows ? 'Wheel scrolls video rows: on (hold Alt to scroll the page). Click to turn off.' : 'Wheel scrolls video rows: off (Shift + wheel still works). Click to turn on.';
        }
        async function toggleWheel() {
            wheelRows = !wheelRows; prefs.wheel_rows = wheelRows; syncWheelBtn();
            toast(wheelRows ? 'Scroll wheel now scrolls the rows. Hold Alt to scroll the page.' : 'Scroll wheel scrolls the page. Shift + wheel scrolls rows.', 4000);
            try { await post('/api/prefs', { wheel_rows: wheelRows }); } catch (e) {}
        }
        document.addEventListener('wheel', e => {
            if (e.ctrlKey || playingId) return;
            const el = e.target.closest && (e.target.closest('.hscroll') || (e.target.closest('.carousel-container') || document.createElement('i')).querySelector('.hscroll'));
            if (!el || !(wheelRows || e.shiftKey) || (wheelRows && e.altKey)) return;
            const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            const max = el.scrollWidth - el.clientWidth;
            if (!delta || max <= 2) return;
            let st = wheelState.get(el);
            if (!st) { st = { target: 0, raf: 0 }; wheelState.set(el, st); }
            const base = st.raf ? st.target : el.scrollLeft;
            const dir = delta > 0 ? 1 : -1;
            if ((dir > 0 && base >= max - 1) || (dir < 0 && base <= 1)) return;      // at the end: let the page scroll
            e.preventDefault();
            st.target = clamp(base + (e.deltaMode === 1 ? delta * 40 : delta) * 1.6, 0, max);
            if (!st.raf) {
                const step = () => {
                    const d = st.target - el.scrollLeft;
                    if (Math.abs(d) < 1) { el.scrollLeft = st.target; st.raf = 0; return; }
                    el.scrollLeft += Math.sign(d) * Math.max(1, Math.abs(d) * 0.18);
                    st.raf = requestAnimationFrame(step);
                };
                st.raf = requestAnimationFrame(step);
            }
        }, { passive: false });

        // ======================= video rows =======================
        function scrollCarousel(containerId, direction) {
            const el = $(containerId);
            el.scrollBy({ left: el.clientWidth * 0.8 * direction, behavior: 'smooth' });
        }
        function updateArrows(containerId) {
            const el = $(containerId);
            if (!el) return;
            if (!el.clientWidth) return;                       // hidden right now: leave the arrows alone
            const overflow = el.scrollWidth > el.clientWidth + 4;
            el.parentElement.querySelectorAll('.carousel-btn').forEach(b => { b.style.display = overflow ? '' : 'none'; });
        }

        const skeleton = () => Array.from({ length: 8 }, () => '<div class="skeleton vcard flex-none aspect-square rounded-md"></div>').join('');
        function sectionHtml(id, title, extra, hidden, body) {
            return `
            <section id="${id}-sec" class="mb-10 ${hidden ? 'hidden' : ''}">
                <div class="flex items-center gap-4 mb-3"><h2 class="text-xl md:text-2xl font-bold text-lm-text">${esc(title)}</h2>${extra || ''}</div>
                <div class="carousel-container relative">
                    <button class="carousel-btn absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-black/80 to-transparent hover:from-black z-20 flex items-center justify-center text-3xl" onclick="scrollCarousel('${id}', -1)"><i class="fas fa-chevron-left"></i></button>
                    <div id="${id}" class="hscroll flex gap-3 overflow-x-auto hide-scrollbar relative z-10 py-6 -my-6 px-1">${body == null ? skeleton() : body}</div>
                    <button class="carousel-btn absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-l from-black/80 to-transparent hover:from-black z-20 flex items-center justify-center text-3xl" onclick="scrollCarousel('${id}', 1)"><i class="fas fa-chevron-right"></i></button>
                </div>
            </section>`;
        }
        const heroCur = {}, saShown = { private: 48 };
        const standaloneHtml = scope => `<section id="${scope}-standalone-sec" class="mb-10"><h2 class="text-xl md:text-2xl font-bold text-lm-text mb-4">Videos<span id="${scope}-standalone-n"></span></h2><div id="${scope}-standalone" class="vgrid">${skeleton()}</div><div id="${scope}-standalone-more" class="text-center mt-8"></div></section>`;
        function paintStandalone(scope, d) {
            const el = $(scope + '-standalone'); if (!el) return;
            let all = d.loose || [];
            if (scope === 'private') {                                                   // the Private strip's sort: newest (default), oldest or A-Z
                const mode = prefs.private_sort || 'new', byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true, sensitivity: 'base' });
                all = all.slice().sort(mode === 'az' ? byTitle : (a, b) => ((mode === 'old' ? 1 : -1) * ((a.added || 0) - (b.added || 0))) || byTitle(a, b));
            }
            const n = saShown[scope] || 48;
            $(scope + '-standalone-sec').classList.toggle('hidden', !!d.total && !all.length);
            $(scope + '-standalone-n').textContent = all.length ? all.length : '';
            el.innerHTML = all.length ? cardsHtml(all.slice(0, n), scope)
                : `<div class="col-span-full border border-dashed border-white/10 rounded-lg px-6 py-8 text-sm text-gray-500">${scope === 'private' ? 'No private videos found. Put some in media/private and press the refresh icon.' : 'No videos found.'}</div>`;
            $(scope + '-standalone-more').innerHTML = all.length > n ? `<button class="chip" onclick="saShown['${scope}'] += 48; paintStandalone('${scope}', vdata['${scope}'])">Show more</button>` : '';
        }
        function buildView(scope) {
            if (scope !== 'private' && typeof window.ubhBuild === 'function') { window.ubhBuild(); return; }   // Browse hub builds its own page
            const inner = `
                <div id="${scope}-hero"></div>
                <div id="${scope}-rows" class="px-6 md:px-12 pt-10 pb-12">
                    <div id="${scope}-genrebar" class="hscroll hide-scrollbar flex items-center gap-2 mb-8 overflow-x-auto"></div>
                    ${rowsFor(scope).map(r => r.key === 'standalone' ? standaloneHtml(scope) : sectionHtml(scope + '-' + r.key, r.title, '', r.hideEmpty)).join('')}
                </div>`;
            $(scope === 'private' ? 'private-view' : 'video-view').innerHTML = scope === 'private'
                ? `<div id="private-bar"><button class="pv-tab on" data-m="videos" onclick="privateMode('videos')">Videos</button><button class="pv-tab" data-m="photos" onclick="privateMode('photos')">Photos</button><select id="pv-sort" class="pv-sort" aria-label="Sort private videos" title="Sort the videos" onchange="setPref({private_sort: this.value})"><option value="new">Newest</option><option value="old">Oldest</option><option value="az">A\u2013Z</option></select></div>
                   <div id="private-videos">${inner}</div><div id="private-photos" class="hidden"></div>`
                : inner;
            if (scope === 'private' && $('pv-sort')) $('pv-sort').value = prefs.private_sort || 'new';
            // auto-sorted collections, then your own folders (genres), sit right under "Continue Watching"
            const anchor = $(scope + (scope === 'private' ? '-recent-sec' : '-continue-sec'));
            const holder = document.createElement('div');
            holder.id = scope + '-genres';
            anchor.after(holder);
            if (scope !== 'private') { const cl = document.createElement('div'); cl.id = 'public-collections'; anchor.after(cl); }
        }

        function starsHtml(id, rating) {
            let html = '';
            for (let i = 1; i <= 5; i++) {
                html += i <= rating
                    ? `<i class="fas fa-star text-yellow-400 cursor-pointer drop-shadow-md hover:scale-125 transition-transform" onclick="rateVideo(event, '${id}', ${i})"></i>`
                    : `<i class="far fa-star text-gray-300 cursor-pointer drop-shadow-md hover:scale-125 hover:text-yellow-400 transition-transform" onclick="rateVideo(event, '${id}', ${i})"></i>`;
            }
            return html;
        }
        const avgText = v => `<i class="fas fa-star text-yellow-500 mr-1"></i>${v.avg_rating == null ? '-' : v.avg_rating} / 5`;
        const posterUrl = (v, scope) => scope === 'private' ? withToken(v.poster) : v.poster;
        const newBadge = (v, side) => v.is_new ? `<div class="absolute top-2 ${side || 'left-2'} z-20 text-[10px] font-black bg-accent rounded px-2 py-1 tracking-wider shadow-lg transition-opacity ${side ? '' : 'group-hover:opacity-0'}">NEW</div>` : '';
        const progressBar = v => v.progress
            ? `<div class="absolute bottom-0 inset-x-0 h-1 bg-white/25 z-20"><div class="h-full bg-accent" style="width:${Math.round(v.progress * 100)}%"></div></div>`
            : '';

        // private cards: poster, title on hover, nothing else
        function createPrivateCard(v) {
            return `
                <div class="video-card vcard flex-none aspect-[2/3] relative rounded-md overflow-hidden bg-lm-card cursor-pointer group" data-id="${v.id}" data-rating="${v.user_rating}" onclick="playVideo('${v.id}')">
                    <img src="${posterUrl(v, 'private')}" alt="" loading="lazy" class="w-full h-full object-cover">
                    ${progressBar(v)}
                    <div class="absolute inset-0 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-gradient-to-t from-black/90 via-black/10 to-transparent flex items-end p-3">
                        <div class="text-sm font-medium leading-tight line-clamp-2" data-title-id="${v.id}">${esc(v.title)}</div>
                    </div>
                </div>`;
        }
        // square tile (same look as the Music tab): square cover, thin border, bold title, small uppercase line below
        const tileUrl = (v, scope) => scope === 'private' ? posterUrl(v, scope)
            : String(v.poster || '').replace('/seriesart/', '/seriestile/').replace('/poster/', '/tile/');
        function createVideoCard(v, scope) {
            if (scope === 'private') return createPrivateCard(v);
            const sub = [v.series || '', v.year || '', v.view_count ? v.view_count + 'x viewed' : ''].filter(Boolean).join(' \u00b7 ');
            return `
                <div class="video-card vcard utile group flex-none cursor-pointer" data-id="${v.id}" data-rating="${v.user_rating}" onclick="playVideo('${v.id}')">
                    <div class="ut-cover">
                        <img src="${tileUrl(v, scope)}" alt="" loading="lazy">
                        ${progressBar(v)}${v.is_new ? '<span class="ut-new">NEW</span>' : ''}
                        <button class="ut-edit" title="Rename" onclick="editTitle(event, '${v.id}')"><i class="fas fa-pen"></i></button>
                        <button class="ut-img" data-tk="video" data-tkey="${v.id}" title="Thumbnail"><i class="far fa-image"></i></button>
                        <div class="ut-stars rating-stars" title="Your rating">${starsHtml(v.id, v.user_rating)}</div>
                        <span class="ut-play"><i class="fas fa-play"></i></span>
                    </div>
                    <div class="ut-title" data-title-id="${v.id}">${esc(v.title)}</div>
                    <div class="ut-sub">${esc(sub) || 'Movie'}</div>
                </div>`;
        }
        // a series: one square tile with the show's title; opening it lists the episodes
        function createSeriesCard(s, scope) {
            const label = `${s.episodes} episode${s.episodes === 1 ? '' : 's'}`;
            return `
                <div class="video-card vcard utile group flex-none cursor-pointer" data-sid="${s.id}" onclick="openSeries('${s.id}', '${scope}')">
                    <div class="ut-cover">
                        <img src="${tileUrl(s, scope)}" alt="" loading="lazy">
                        ${s.watched ? `<div class="ut-prog"><i style="width:${Math.round(s.progress * 100)}%"></i></div>` : ''}
                        ${s.is_new ? '<span class="ut-new">NEW</span>' : ''}
                        <button class="ut-img" data-tk="series" data-tkey="${s.id}" title="Thumbnail"><i class="far fa-image"></i></button>
                        <button class="ut-play" title="${s.watched ? 'Resume' : 'Play'}" onclick="event.stopPropagation(); playVideo('${s.resume}')"><i class="fas fa-play"></i></button>
                    </div>
                    <div class="ut-title">${esc(s.title)}</div>
                    <div class="ut-sub">Series &middot; ${label}${s.watched ? ' &middot; ' + s.watched + ' watched' : ''}</div>
                </div>`;
        }
        const cardsHtml = (items, scope) => items.map(c => c.kind === 'series' ? createSeriesCard(c, scope) : createVideoCard(c, scope)).join('');

        function renderHero(scope, f) {
            heroStop();
            const hero = $(scope + '-hero'), rows = $(scope + '-rows');
            heroCur[scope] = f ? f.id : null;
            if (!f) { hero.innerHTML = ''; rows.classList.add('pt-10'); return; }
            rows.classList.remove('pt-10');
            const priv = scope === 'private';
            const img = posterUrl(f, scope);
            const base = priv ? 'Private pick' : (f.progress ? 'Continue watching' : (f.view_count ? 'Watch again' : 'New for you'));
            const label = f.series ? base + ' \u2022 ' + f.series : base;
            const bd = priv ? withToken(f.backdrop) : f.backdrop;
            const meta = priv ? '' : `
                            <div class="flex items-center gap-4 text-sm text-gray-200 mb-6">
                                <span><i class="fas fa-eye mr-1 text-gray-400"></i>${f.view_count}x viewed</span>
                                <span>${avgText(f)}</span>
                            </div>`;
            const buttons = priv ? `
                                <button onclick="playVideo('${f.id}')" class="bg-white text-black font-semibold py-3 px-8 rounded-md flex items-center gap-2 hover:bg-white/80 transition-colors"><i class="fas fa-play"></i> ${f.progress ? 'Resume' : 'Play'}</button>
                                <button onclick="surprise('${scope}')" class="bg-gray-500/50 hover:bg-gray-500/30 backdrop-blur text-white h-12 w-12 rounded-md flex items-center justify-center transition-colors" title="Surprise me"><i class="fas fa-shuffle"></i></button>`
                : `
                                <button onclick="playVideo('${f.id}')" class="bg-white text-black font-bold py-3 px-8 rounded-md flex items-center gap-2 hover:bg-white/80 transition-colors"><i class="fas fa-play"></i> ${f.progress ? 'Resume' : 'Play'}</button>
                                <button onclick="surprise('${scope}')" class="bg-gray-500/50 hover:bg-gray-500/30 backdrop-blur text-white font-bold py-3 px-6 rounded-md flex items-center gap-2 transition-colors"><i class="fas fa-shuffle"></i> Surprise me</button>
                                <button onclick="editTitle(event, '${f.id}')" class="bg-gray-500/50 hover:bg-gray-500/30 backdrop-blur text-white h-12 w-12 rounded-md flex items-center justify-center transition-colors" title="Rename"><i class="fas fa-pen"></i></button>`;
            hero.innerHTML = `
                <section class="hero-sec relative ${priv ? 'min-h-[72vh]' : 'min-h-[74vh]'} flex items-end overflow-hidden mb-6" onmouseenter="heroEnter(this, '${f.id}', '${scope}')" onmouseleave="heroStop()">
                    <div class="absolute inset-0 bg-cover bg-center scale-125 blur-3xl opacity-70" style="background-image:url('${img}')"></div>
                    <img src="${bd}" alt="" class="absolute inset-0 h-full w-full object-cover" onerror="this.parentElement.querySelector('.hero-poster').classList.remove('hidden'); this.remove()">
                    <div class="hero-shade absolute inset-0 bg-gradient-to-t from-lm-base via-lm-base/25 to-black/50"></div>
                    <div class="absolute inset-0 bg-gradient-to-r from-black/85 via-black/35 to-transparent"></div>
                    <div class="relative z-10 w-full px-6 md:px-12 pb-14 pt-32 flex items-end justify-between gap-10">
                        <div class="max-w-[44rem]">
                            <div class="flex items-center gap-2 text-xs font-bold tracking-[0.25em] uppercase text-accent mb-4"><span class="h-px w-8 bg-accent"></span>${esc(label)}</div>
                            <h1 class="font-black leading-[1.05] mb-${priv ? '7' : '4'} drop-shadow-lg line-clamp-3 break-words" style="font-size:clamp(1.75rem,3.4vw,4rem)" data-title-id="${f.id}">${esc(f.title)}</h1>${meta}
                            <div class="flex items-center gap-3">${buttons}
                            </div>
                        </div>
                        <img src="${img}" alt="" class="hero-poster hidden h-[46vh] aspect-[2/3] object-cover rounded-lg shadow-2xl ring-1 ring-white/10 cursor-pointer" onclick="playVideo('${f.id}')">
                    </div>
                </section>`;
        }

        // the big pick plays a muted preview when you rest the mouse on it (same idea as the small cards)
        let heroT = 0, heroV = null, heroSec = null;
        function heroStop() {
            clearTimeout(heroT); heroT = 0;
            if (heroV) { heroV.pause(); heroV.removeAttribute('src'); heroV.remove(); heroV = null; }
            heroSec = null;
        }
        function heroEnter(sec, id, scope) {
            if (prefs.hover_preview === false || playingId) return;
            heroStop(); heroSec = sec;
            heroT = setTimeout(() => heroStart(sec, id, scope), 450);
        }
        function heroStart(sec, id, scope) {
            if (heroSec !== sec || playingId || !sec.isConnected) return;
            const v = document.createElement('video');
            v.className = 'hero-video'; v.muted = true; v.playsInline = true; v.preload = 'auto';
            const url = `/media/video/${id}`; v.src = scope === 'private' ? withToken(url) : url;
            let a = 0, b = 0;
            v.addEventListener('loadedmetadata', () => {
                const d = v.duration || 0;
                a = d > 120 ? Math.min(d * 0.2, d - 60) : 0; b = a + 40;             // a 40 s window, looped
                if (a) v.currentTime = a;
                v.play().catch(() => {});
            });
            v.addEventListener('timeupdate', () => { if (b && v.currentTime > b) v.currentTime = a; });
            v.addEventListener('ended', () => { v.currentTime = a; v.play().catch(() => {}); });
            v.addEventListener('playing', () => v.classList.add('on'));
            sec.insertBefore(v, sec.querySelector('.hero-shade'));
            heroV = v;
        }

        // ---- genres ----
        const genreData = { public: [], private: [] };
        function renderGenres(scope, genres) {
            genreData[scope] = genres;
            $(scope + '-genrebar').innerHTML = genres.map((g, i) =>
                `<button class="chip" onclick="jumpGenre('${scope}', ${i})">${esc(g.name)} <span class="text-gray-400 ml-1">${g.count}</span></button>`).join('') +
                `<button class="chip" onclick="openManage(event, '${scope}')"><i class="fas fa-sliders mr-1.5 text-xs"></i>Manage<i class="fas fa-chevron-down ml-1.5 text-[10px]"></i></button>`;
            $(scope + '-genres').innerHTML = genres.map((g, i) => {
                const id = `${scope}-g-${i}`;
                const extra = `<button class="text-xs font-semibold text-gray-300 hover:text-white bg-white/10 hover:bg-white/20 rounded-full px-3 py-1 transition-colors" onclick="openAddGenre('${scope}', ${i})"><i class="fas fa-plus mr-1"></i>Add videos</button>
                               <button class="text-xs font-semibold text-gray-300 hover:text-white bg-white/10 hover:bg-white/20 rounded-full px-3 py-1 transition-colors" onclick="openOrganize('${scope}', { genre: ${jq(g.name)}, title: ${jq('Add videos to ' + g.name)} })" title="Move videos you already have into this genre"><i class="fas fa-folder-tree mr-1"></i>From library</button>
                               <button class="text-xs text-gray-400 hover:text-white transition-colors" onclick="openFolder('${scope}', ${i})" title="Open this genre's folder"><i class="fas fa-folder-open"></i></button>
                               <button class="text-xs text-gray-400 hover:text-red-400 transition-colors" onclick="deleteGenre('${scope}', ${i})" title="Delete this genre (only when it is empty)"><i class="fas fa-trash"></i></button>`;
                const body = g.items.length ? cardsHtml(g.items, scope)
                    : `<div class="w-full border border-dashed border-white/10 rounded-lg px-6 py-8 text-sm text-gray-500 flex items-center gap-3"><i class="far fa-folder-open text-lg opacity-60"></i>Nothing here yet. Press "Add videos", or drop files into the "${esc(g.name)}" folder. Put episodes inside a sub-folder to make a series.</div>`;
                return sectionHtml(id, g.name, extra, false, body);
            }).join('');
            genres.forEach((g, i) => updateArrows(`${scope}-g-${i}`));
        }
        async function deleteGenre(scope, i) {
            const g = (genreData[scope] || [])[i]; if (!g) return;
            if (g.count) { toast(`"${g.name}" still has videos. Move them to another genre first.`, 4500); return; }
            if (!confirm(`Delete the empty genre "${g.name}"?`)) return;
            try {
                await post('/api/genres/' + encodeURIComponent(g.name) + '/delete', { private: scope === 'private' });
                toast(`Deleted ${g.name}`);
                await waitForScan(); await loadVideos(scope);
            } catch (e) { toast(errMsg(e)); }
        }
        function jumpGenre(scope, i) {
            const sec = $(`${scope}-g-${i}-sec`);
            if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // Browse is for stand-alone videos: no series cards, no series episodes
        const standalone = c => !!c && c.kind !== 'series' && !c.series;
        function browseOnly(d) {
            const o = Object.assign({}, d);
            ['continue', 'recent', 'most_watched', 'unwatched'].forEach(k => { o[k] = (d[k] || []).filter(standalone); });
            o.genres = (d.genres || []).map(g => { const items = (g.items || []).filter(standalone); return Object.assign({}, g, { items, count: items.length, had: (g.items || []).length }); }).filter(g => g.count || !g.had);
            const loose = d.loose || [];
            o.featured = standalone(d.featured) ? d.featured : (loose.length ? loose[Math.floor(Math.random() * loose.length)] : null);
            return o;
        }
        const pools = { public: [], private: [] };
        async function loadVideos(scope) {
            scope = scope || 'public';
            try {
                const d = await api(scope === 'private' ? '/api/videos?private=1' : '/api/videos');
                pools[scope] = d.pool;
                vdata[scope] = d; (d.loose || []).forEach(c => setTitle(c.id, c.title, scope === 'private'));
                if (scope === 'private') { privateIds.clear(); d.pool.forEach(id => privateIds.add(id)); }
                [d.featured].concat(...ROWS.map(r => d[r.key] || []), ...(d.genres || []).map(g => g.items))
                    .forEach(c => { if (c && c.kind !== 'series') setTitle(c.id, c.title, scope === 'private'); });
                if (scope === 'public' && typeof window.ubhPaint === 'function') { window.ubhPaint(d); return; }   // Browse hub paints the public library
                const V = scope === 'public' ? browseOnly(d) : d;
                renderHero(scope, V.featured);
                renderGenres(scope, V.genres || []);
                if (scope === 'public' && typeof window.paintCollections === 'function') { try { window.paintCollections(V); } catch (e) { console.error(e); } }
                rowsFor(scope).forEach(r => {
                    if (r.key === 'standalone') { paintStandalone(scope, d); return; }
                    const id = scope + '-' + r.key, cards = V[r.key] || [];
                    if (r.hideEmpty) $(id + '-sec').classList.toggle('hidden', !cards.length);
                    const empty = r.key === 'unwatched' && !d.total
                        ? (scope === 'private' ? 'No private videos found. Put some in media/private and press the refresh icon.' : 'No videos found. Make a genre above, or put videos in media/videos, then press the refresh icon.')
                        : r.empty;
                    $(id).innerHTML = cards.length
                        ? cardsHtml(cards, scope)
                        : (r.hideEmpty ? '' : `<div class="w-full border border-dashed border-white/10 rounded-lg px-6 py-8 text-sm text-gray-500 flex items-center gap-3"><i class="far fa-folder-open text-lg opacity-60"></i>${esc(empty)}</div>`);
                    updateArrows(id);
                });
                if (scope === 'public') renderSections();
            } catch (e) { console.error(e); }
        }

        function surprise(scope) {
            if (scope === 'private') {                       // swap the Private pick, never start playing by itself
                const d = vdata.private; if (!d) return;
                const seen = new Map();
                [d.featured].concat(d.loose || [], d.continue || [], d.recent || []).forEach(c => { if (c && c.kind !== 'series') seen.set(c.id, c); });
                const list = [...seen.values()].filter(c => c.id !== heroCur.private);
                if (!list.length) return;
                renderHero('private', list[Math.floor(Math.random() * list.length)]);
                const s = $('private-hero').firstElementChild; if (s) s.classList.add('hero-fade');
                return;
            }
            const pool = pools[scope];
            if (pool && pool.length) playVideo(pool[Math.floor(Math.random() * pool.length)]);
        }

        function updateCards(id, stats) {
            document.querySelectorAll(`.video-card[data-id="${id}"]`).forEach(card => {
                card.dataset.rating = stats.user_rating;
                const rs = card.querySelector('.rating-stars'), vw = card.querySelector('.views'), av = card.querySelector('.avg');
                if (rs) rs.innerHTML = starsHtml(id, stats.user_rating);
                if (vw) vw.textContent = stats.view_count + 'x Viewed';
                if (av) av.innerHTML = avgText(stats);
            });
        }

        async function rateVideo(event, id, starIndex) {
            event.stopPropagation();
            const card = event.target.closest('.video-card');
            const current = Number(card.dataset.rating || 0);
            const stars = starIndex === current ? 0 : starIndex;
            try { updateCards(id, await post(`/api/videos/${id}/rating`, { stars })); } catch (e) { console.error(e); }
        }

        // ======================= new genre / add videos =======================
        let genreScope = 'public';
        function openGenreModal(scope) {
            genreScope = scope || 'public';
            $('genre-input').value = ''; $('genre-error').textContent = '';
            show('genre-modal', true, true);
            setTimeout(() => $('genre-input').focus(), 30);
        }
        function closeGenreModal() { show('genre-modal', false, true); }
        async function saveGenre() {
            const name = $('genre-input').value.trim();
            if (!name) { $('genre-error').textContent = 'Give the genre a name.'; return; }
            try {
                const r = await post('/api/genres', { name, private: genreScope === 'private' });
                closeGenreModal();
                await loadVideos(genreScope);
                toast(`Genre "${r.name}" created`);
                const i = genreData[genreScope].findIndex(g => g.name === r.name);
                if (i >= 0) { jumpGenre(genreScope, i); openAddGenre(genreScope, i); }
            } catch (e) { $('genre-error').textContent = errMsg(e); }
        }

        let addCtx = null, addFiles = [], uploading = false;
        function openAddGenre(scope, i) {
            const g = genreData[scope][i];
            if (!g) return;
            const names = [...new Set(g.items.filter(x => x.kind === 'series').map(x => x.folder))];
            openAddModal(scope, g.name, '', names);
        }
        function openAddModal(scope, genre, series, names) {
            addCtx = { scope, genre }; addFiles = []; uploading = false;
            $('add-title').textContent = `Add videos to ${genre}`;
            $('add-series').value = series || '';
            $('series-choices').innerHTML = (names || []).map(n => `<option value="${esc(n)}">`).join('');
            $('add-pick').textContent = 'Click to choose files, or drop them here';
            $('add-files').value = '';
            $('add-error').textContent = ''; show('add-prog', false);
            $('add-go').disabled = false;
            show('add-modal', true, true);
        }
        function closeAddModal() { if (uploading) return; show('add-modal', false, true); }
        function setAddFiles(list) {
            addFiles = Array.from(list || []);
            const total = addFiles.reduce((a, f) => a + f.size, 0);
            $('add-pick').textContent = addFiles.length ? `${addFiles.length} file${addFiles.length === 1 ? '' : 's'} selected (${(total / 1048576).toFixed(total > 1e9 ? 0 : 1)} MB)` : 'Click to choose files, or drop them here';
            $('add-error').textContent = '';
        }
        $('add-files').addEventListener('change', e => setAddFiles(e.target.files));
        const dz = $('add-drop');
        ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('border-accent'); }));
        ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('border-accent'); }));
        dz.addEventListener('drop', e => setAddFiles(e.dataTransfer.files));
        window.addEventListener('dragover', e => e.preventDefault());
        window.addEventListener('drop', e => e.preventDefault());       // a stray drop must not navigate away from the app

        function submitAdd() {
            if (!addCtx || uploading) return;
            if (!addFiles.length) { $('add-error').textContent = 'Choose at least one file.'; return; }
            const fd = new FormData();
            fd.append('series', $('add-series').value.trim());
            fd.append('private', addCtx.scope === 'private' ? '1' : '0');
            addFiles.forEach(f => fd.append('files', f, f.name));
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/genres/' + encodeURIComponent(addCtx.genre) + '/upload');
            xhr.setRequestHeader('X-LMP', '1');
            if (token) xhr.setRequestHeader('X-Private-Token', token);
            uploading = true; $('add-go').disabled = true; show('add-prog', true);
            xhr.upload.onprogress = e => {
                if (!e.lengthComputable) return;
                const p = Math.round(e.loaded / e.total * 100);
                $('add-bar').style.width = p + '%'; $('add-pct').textContent = `Copying... ${p}%`;
            };
            xhr.onload = async () => {
                uploading = false;
                let d = {};
                try { d = JSON.parse(xhr.responseText); } catch (e) {}
                if (xhr.status !== 200) { $('add-error').textContent = d.error || 'Upload failed.'; $('add-go').disabled = false; return; }
                const scope = addCtx.scope;
                show('add-modal', false, true);
                toast(`Added ${d.saved} file${d.saved === 1 ? '' : 's'}` + (d.skipped ? ` (${d.skipped} skipped: unsupported type)` : ''), 5000);
                await waitForScan();
                await loadVideos(scope);
                if (seriesCtx) refreshSeries();
            };
            xhr.onerror = () => { uploading = false; $('add-error').textContent = 'Upload failed.'; $('add-go').disabled = false; };
            xhr.send(fd);
        }
        async function openFolder(scope, i) {
            scope = scope || (addCtx && addCtx.scope) || 'public';
            let genre = '', series = '';
            if (typeof i === 'number') genre = (genreData[scope][i] || {}).name || '';
            else if (addCtx && !$('add-modal').classList.contains('hidden')) { genre = addCtx.genre; series = $('add-series').value.trim(); }
            try { await post('/api/folders/open', { genre, series, private: scope === 'private' }); }
            catch (e) { toast(series ? 'That series folder does not exist yet.' : errMsg(e)); }
        }

        // ======================= series page =======================
        let seriesCtx = null;
        async function openSeries(id, scope) {
            try {
                const d = await api('/api/series/' + id);
                seriesCtx = { id, scope, data: d };
                renderSeries();
                show('series-modal', true);
                $('series-modal').scrollTop = 0;
            } catch (e) { toast(errMsg(e)); }
        }
        async function refreshSeries() {
            if (!seriesCtx) return;
            try { seriesCtx.data = await api('/api/series/' + seriesCtx.id); renderSeries(); } catch (e) { closeSeries(); }
        }
        function closeSeries() { show('series-modal', false); seriesCtx = null; }
        function renderSeries() {
            const { scope, data: d } = seriesCtx, priv = scope === 'private';
            const u = x => priv ? withToken(x) : x;
            const watched = d.episodes.filter(e => e.view_count > 0).length;
            const resumeEp = d.episodes.find(e => e.id === d.resume);
            let lastSeason = null;
            const rows = d.episodes.map((e, n) => {
                let head = '';
                if (e.season !== lastSeason) { lastSeason = e.season; if (e.season) head = `<div class="px-3 pt-5 pb-1 text-sm font-bold text-gray-400">${esc(e.season)}</div>`; }
                setTitle(e.id, e.title, priv);
                return head + `
                <div class="group flex items-center gap-4 p-3 rounded-lg hover:bg-white/10 cursor-pointer transition-colors" onclick="playVideo('${e.id}')">
                    <div class="w-8 text-center text-xl font-semibold text-gray-400">${n + 1}</div>
                    <div class="relative w-44 flex-none aspect-video rounded-md overflow-hidden bg-lm-card">
                        <img src="${u(e.poster)}" alt="" loading="lazy" class="h-full w-full object-cover">
                        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"><i class="fas fa-play text-2xl"></i></div>
                        ${e.progress ? `<div class="absolute bottom-0 inset-x-0 h-1 bg-white/25"><div class="h-full bg-accent" style="width:${Math.round(e.progress * 100)}%"></div></div>` : ''}
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="font-semibold truncate" data-title-id="${e.id}">${esc(e.title)}</div>
                        <div class="text-xs text-gray-400 mt-1">${e.progress ? Math.round(e.progress * 100) + '% watched &middot; resume' : (e.view_count ? '<i class="fas fa-check text-accent mr-1"></i>Watched ' + e.view_count + 'x' : 'Not watched yet')}</div>
                    </div>
                    <button class="flex-none h-8 w-8 rounded-full bg-white/10 hover:bg-white hover:text-black flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-all" title="Rename" onclick="editTitle(event, '${e.id}')"><i class="fas fa-pen"></i></button>
                </div>`;
            }).join('');
            $('series-card').innerHTML = `
                <div class="relative h-72 overflow-hidden">
                    <img src="${u(d.backdrop)}" alt="" class="absolute inset-0 h-full w-full object-cover" onerror="this.style.display='none'">
                    <div class="absolute inset-0 bg-gradient-to-t from-[#181818] via-[#181818]/50 to-black/30"></div>
                    <button onclick="closeSeries()" class="absolute top-4 right-4 h-10 w-10 rounded-full bg-black/60 hover:bg-white hover:text-black flex items-center justify-center transition-colors" title="Close"><i class="fas fa-xmark"></i></button>
                    <div class="absolute bottom-0 inset-x-0 p-8">
                        <div class="text-xs font-bold tracking-[0.25em] uppercase text-accent mb-2">${esc(d.genre)}</div>
                        <h2 class="font-black leading-tight mb-4" style="font-size:clamp(1.8rem,3vw,3.2rem)">${esc(d.name)}</h2>
                        <div class="flex flex-wrap items-center gap-3">
                            <button onclick="playVideo('${d.resume}')" class="bg-white text-black font-bold py-2.5 px-7 rounded-md flex items-center gap-2 hover:bg-white/80 transition-colors"><i class="fas fa-play"></i>${watched || (resumeEp && resumeEp.progress) ? 'Resume' : 'Play'}${resumeEp ? ' &middot; ' + esc(resumeEp.title).slice(0, 28) : ''}</button>
                            <button onclick="openAddModal('${scope}', ${JSON.stringify(d.genre).replace(/"/g, '&quot;')}, ${JSON.stringify(d.folder).replace(/"/g, '&quot;')}, [])" class="bg-gray-500/50 hover:bg-gray-500/30 backdrop-blur font-semibold py-2.5 px-5 rounded-md flex items-center gap-2 transition-colors"><i class="fas fa-upload"></i> Upload files</button>
                            <button onclick="openOrganize('${scope}', { genre: ${jq(d.genre)}, series: ${jq(d.folder)}, title: 'Add videos to ' + ${jq(d.name)} })" class="bg-gray-500/50 hover:bg-gray-500/30 backdrop-blur font-semibold py-2.5 px-5 rounded-md flex items-center gap-2 transition-colors"><i class="fas fa-folder-tree"></i> From library</button>
                            <button onclick="openRename()" class="bg-gray-500/50 hover:bg-gray-500/30 backdrop-blur font-semibold py-2.5 px-4 rounded-md flex items-center gap-2 transition-colors" title="Rename this series"><i class="fas fa-pen"></i></button>
                            <button onclick="ungroupSeries(this)" class="bg-gray-500/50 hover:bg-red-700/70 backdrop-blur font-semibold py-2.5 px-4 rounded-md flex items-center gap-2 transition-colors" title="Turn the episodes back into standalone videos"><i class="fas fa-link-slash"></i> Ungroup</button>
                            <span class="text-sm text-gray-300">${d.episodes.length} episode${d.episodes.length === 1 ? '' : 's'} &middot; ${watched} watched</span>
                        </div>
                    </div>
                </div>
                <div class="px-5 pb-6 pt-2">${rows || '<div class="p-8 text-gray-500 text-center">No episodes yet.</div>'}</div>`;
        }

        // ======================= editable titles =======================
        let editingId = null;
        function editTitle(event, id) {
            if (event) event.stopPropagation();
            if (!id) return;
            editingId = id;
            $('title-input').value = titles[id] || '';
            $('title-error').textContent = '';
            show('title-modal', true, true);
            setTimeout(() => { $('title-input').focus(); $('title-input').select(); }, 30);
        }
        function closeTitleModal() { show('title-modal', false, true); editingId = null; }
        async function saveTitle(reset) {
            if (!editingId) return;
            const title = reset ? '' : $('title-input').value.trim();
            if (!reset && !title) { $('title-error').textContent = 'Enter a name, or use "Reset to file name".'; return; }
            try {
                const r = await post(`/api/videos/${editingId}/title`, { title });
                applyTitle(editingId, r.title);
                closeTitleModal();
            } catch (e) { $('title-error').textContent = 'Could not save the name.'; }
        }
        function applyTitle(id, title) {
            setTitle(id, title);
            document.querySelectorAll(`[data-title-id="${id}"]`).forEach(el => { el.textContent = title; });
            if (playingId === id) { $('player-title').textContent = title; }
        }

        // ======================= video player =======================
        const player = $('player'), pm = $('player-modal');
        let playingId = null, playInfo = null, viewCounted = false, resumeAt = 0, resumed = false, ready = false;
        let lastSave = 0, progressDirty = false, sessionDirty = false, musicWasPlaying = false;
        let uiTimer = null, isFS = false, fitFill = false, nextTimer = null, dragging = false, hintTimer = null;

        function clearTracks() { player.querySelectorAll('track').forEach(t => t.remove()); }

        // ---- keeping the music hub and the video player from fighting each other ----
        function pauseMusicForVideo() {
            musicWasPlaying = !audio.paused;
            if (musicWasPlaying) audio.pause();
        }
        function resumeMusicAfterVideo() {
            if (musicWasPlaying) audio.play().catch(() => {});
            musicWasPlaying = false;
        }

        let nextResume = null, miniWinId = null, miniWinPrivate = false;
        // Native Qt player (libmpv inside a Qt window): opened as its own window; the web player below stays as the fallback
        let nativeBroken = false;
        async function playNative(id) {
            if (nativeBroken || prefs.native_player === false || !(window.pywebview && pywebview.api && pywebview.api.play_native)) return false;
            try { heroStop(); } catch (e) {}                                     // the home-screen preview must not keep playing behind the native window
            try {
                if (await pywebview.api.play_native(String(id), token || '')) {
                    pauseMusicForVideo();
                    try { post('/api/player/stop', {}); } catch (e) {}              // and the old in-window picture (libmpv child window) must be gone
                    return true;
                }
            } catch (e) { console.error(e); }
            return false;
        }
        window.nativePlayerFailed = function (id) {
            if (playingId || String(id) !== String(lastNativeId)) return;        // another video took over: never start a second picture
            nativeBroken = true; if (typeof toast === 'function') toast('The native player could not start, using the built-in one (see native_player.log)'); playVideo(id);
        };
        window.nativePlayerClosed = function () { try { resumeMusicAfterVideo(); } catch (e) {} Promise.resolve().then(async () => { try { await loadVideos(scopeOf(lastNativeId)); refreshSeries(); } catch (e) { console.error(e); } }); };
        let lastNativeId = null;
        async function playVideo(id) {
            if (!playingId) { lastNativeId = id; if (await playNative(id)) return; }
            heroStop();
            hideNext();
            if (miniMode && !keepMini) exitMini();
            keepMini = false;
            const opening = !playingId;
            if (playingId) { saveProgress(true); sessionDirty = sessionDirty || viewCounted || progressDirty; }
            playingId = id; playInfo = null; viewCounted = false; resumeAt = 0; resumed = false; ready = false; progressDirty = false;
            lastSave = Date.now();
            $('player-title').textContent = titles[id] || '';
            $('player-sub').textContent = '';
            $('player-error').classList.add('hidden');
            $('start-over').classList.add('hidden');
            ['p-prev', 'p-nextbtn', 'p-cc'].forEach(b => $(b).classList.add('hidden'));
            clearTracks();
            if (opening) {
                pauseMusicForVideo();
                pm.classList.remove('hidden');
                fitFill = prefs.default_fit === 'fill'; player.style.objectFit = fitFill ? 'cover' : 'contain'; $('p-fit-icon').className = 'fas ' + (fitFill ? 'fa-compress' : 'fa-expand');
            }
            updateTimeUI(); showUI();

            let info = {};
            try { info = await api(`/api/videos/${id}/info`); } catch (e) { console.error(e); }
            if (playingId !== id) return;                                // closed or locked while loading
            playInfo = info;
            if (info.title) setTitle(id, info.title);
            $('player-title').textContent = titles[id] || '';
            $('player-sub').textContent = info.series ? `${info.series} \u2022 Episode ${info.index} of ${info.total}` : '';
            $('p-prev').classList.toggle('hidden', !info.prev);
            $('p-nextbtn').classList.toggle('hidden', !info.next);
            titleCard(info.series ? `${info.series} \u2022 Episode ${info.index}` : '', titles[id] || '');
            resumeAt = nextResume != null ? nextResume : (info.resume || 0); nextResume = null; resumed = resumeAt > 0;
            const priv = scopeOf(id) === 'private';
            (info.subtitles || []).forEach((s, i) => {
                const t = document.createElement('track');
                t.kind = 'subtitles'; t.label = s.label; t.srclang = s.lang || 'und';
                t.src = priv ? withToken(s.url) : s.url;
                if (i === 0 && prefs.subs_auto) t.default = true;
                player.appendChild(t);
            });
            $('p-cc').classList.toggle('hidden', !(info.subtitles || []).length);
            const url = `/media/video/${id}`;
            player.defaultPlaybackRate = prefs.default_speed;
            let quiet = priv && prefs.private_start_muted !== false;
            if (priv) {
                const hp = await headphoneGate();                                          // 'sound' | 'muted' | null (cancelled) | '' (no prompt needed)
                if (playingId !== id) return;                                              // closed or locked while the prompt was open
                if (hp === null) { closePlayer(true); return; }
                if (hp === 'sound') quiet = false; else if (hp === 'muted') quiet = true;
            }
            if (quiet) { player.muted = true; privAutoMuted = true; }                 // private videos start muted (before the source, so libmpv gets it too)
            else if (privAutoMuted) { player.muted = false; privAutoMuted = false; }  // that mute was ours, not yours: sound back for normal videos
            player.src = priv ? withToken(url) : url;
            setupMediaSession('video');
            if (miniMode) paintMini();
            player.play().catch(() => {});
            if (quiet) hint('Private video starts muted \u2022 Press M for sound');
        }
        let privAutoMuted = false;
        let hpDone = null;
        async function headphoneGate() {
            let need = false;
            try { need = !!(await api('/api/private/headphones')).prompt; } catch (e) { return ''; }
            if (!need) return '';
            player.pause();
            const m = $('hp-modal'); $('hp-check').checked = false; $('hp-sound').disabled = true;
            m.classList.remove('hidden'); m.classList.add('flex');
            return new Promise(res => { hpDone = c => { hpDone = null; m.classList.add('hidden'); m.classList.remove('flex'); res(c); }; });
        }
        function hpPick(c) {
            if (!hpDone) return;
            if (c === 'sound' && !$('hp-check').checked) return;                           // sound only with the box ticked
            if (c) { api('/api/private/headphones/ack', { method: 'POST' }).catch(() => {}); }
            hpDone(c);
        }
        window.hpPick = hpPick;
        document.addEventListener('keydown', e => {                                        // the prompt owns the keyboard until it is answered
            if (!hpDone) return;
            if (e.key === 'Escape') hpPick(null);
            else if (e.key === 'Tab' || e.key === 'Enter') return;
            else if (e.target && e.target.id === 'hp-check') return;
            e.stopImmediatePropagation(); e.preventDefault();
        }, true);

        function titleCard(sub, title) {
            $('tc-sub').textContent = sub; $('tc-title').textContent = title;
            const tc = $('p-titlecard');
            tc.classList.remove('go'); void tc.offsetWidth; tc.classList.add('go');
        }
        function startOver() { player.currentTime = 0; resumed = false; $('start-over').classList.add('hidden'); }

        function saveProgress(force, keepalive) {
            if (!playingId || !ready || !(player.duration > 0) || !isFinite(player.duration)) return null;
            const now = Date.now();
            if (!force && now - lastSave < PROGRESS_SAVE_MS) return null;
            lastSave = now; progressDirty = true;
            const headers = { 'Content-Type': 'application/json', 'X-LMP': '1' };
            if (token) headers['X-Private-Token'] = token;
            return fetch(`/api/videos/${playingId}/progress`, {
                method: 'POST', headers, keepalive: !!keepalive,
                body: JSON.stringify({ position: player.currentTime, duration: player.duration })
            }).catch(() => {});
        }

        function closePlayer(skipReload) {
            if (!playingId) return;
            const scope = scopeOf(playingId);
            const saved = saveProgress(true);
            const needsReload = sessionDirty || viewCounted || progressDirty;
            hideNext(); closeMenu();
            player.pause(); player.removeAttribute('src'); clearTracks(); player.load();
            pm.classList.add('hidden'); pm.classList.remove('mini'); miniMode = false; keepMini = false;
            if (isFS) setFS(false);
            playingId = null; playInfo = null; ready = false; sessionDirty = false;
            resumeMusicAfterVideo();
            setupMediaSession('music');
            if (needsReload && !skipReload) Promise.resolve(saved).then(async () => { await loadVideos(scope); refreshSeries(); });
        }

        // ---- UI helpers ----
        function showUI() {
            pm.classList.remove('ui-hidden');
            clearTimeout(uiTimer);
            if (!player.paused && $('p-menu').classList.contains('hidden') && !dragging) uiTimer = setTimeout(() => pm.classList.add('ui-hidden'), 3000);
        }
        ['mousemove', 'mousedown', 'touchstart'].forEach(ev => pm.addEventListener(ev, showUI, { passive: true }));
        function flash(icon, txt) {
            $('p-flash-icon').className = 'fas ' + icon; $('p-flash-txt').textContent = txt || '';
            const f = $('p-flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
        }
        function hint(text) {
            const h = $('p-hint'); h.textContent = text; h.style.opacity = 1;
            clearTimeout(hintTimer); hintTimer = setTimeout(() => { h.style.opacity = 0; }, 1300);
        }
        function updateTimeUI() {
            const d = player.duration > 0 && isFinite(player.duration) ? player.duration : 0, t = player.currentTime || 0;
            $('p-time').textContent = fmtClock(t) + ' / ' + fmtClock(d);
            if (dragging) return;
            const pct = d ? t / d * 100 : 0;
            $('p-played').style.width = pct + '%'; $('p-thumb').style.left = pct + '%';
        }

        // ---- controls ----
        function togglePlayVideo() {
            if (!playingId) return;
            if (player.paused) { player.play().catch(() => {}); flash('fa-play'); } else { player.pause(); flash('fa-pause'); }
        }
        function skip(sec) {
            if (!ready) return;
            player.currentTime = clamp(player.currentTime + sec, 0, player.duration || 0);
            flash(sec > 0 ? 'fa-rotate-right' : 'fa-rotate-left', Math.abs(sec) + 's'); showUI();
        }
        function stepEpisode(dir) {
            const id = dir > 0 ? playInfo && playInfo.next : playInfo && playInfo.prev;
            if (id) playVideo(id);
        }
        function setVol(v) {
            v = clamp(v, 0, 1); player.volume = v; player.muted = v === 0;
        }
        function toggleMute() { privAutoMuted = false; player.muted = !player.muted; if (!player.muted && player.volume === 0) player.volume = 0.5; hint(player.muted ? 'Muted' : 'Volume ' + Math.round(player.volume * 100) + '%'); }
        $('p-vol').addEventListener('input', e => setVol(e.target.value / 100));
        $('p-vol').addEventListener('change', e => e.target.blur());
        player.addEventListener('volumechange', () => {
            const v = player.muted ? 0 : player.volume;
            $('p-vol').value = Math.round(v * 100);
            $('p-vol-icon').className = 'fas ' + (v === 0 ? 'fa-volume-xmark' : v < 0.4 ? 'fa-volume-low' : 'fa-volume-high');
        });
        pm.addEventListener('wheel', e => {
            e.preventDefault();
            setVol((player.muted ? 0 : player.volume) - Math.sign(e.deltaY) * 0.05);
            hint('Volume ' + Math.round(player.volume * 100) + '%'); showUI();
        }, { passive: false });
        function toggleFit() {
            fitFill = !fitFill; player.style.objectFit = fitFill ? 'cover' : 'contain';
            $('p-fit-icon').className = 'fas ' + (fitFill ? 'fa-compress' : 'fa-expand');
            hint(fitFill ? 'Fill screen' : 'Fit to screen');
        }
        let domFS = false;
        const coversScreen = () => innerWidth >= screen.width - 2 && innerHeight >= screen.height - 2;
        async function setFS(on) {
            const bridge = window.pywebview && window.pywebview.api;
            try {
                if (!on && displayMode === 'fullscreen') isFS = false;                        // app is set to Fullscreen: stay in it
                else if (bridge && bridge.set_fullscreen) {
                    isFS = !!(await bridge.set_fullscreen(on));                               // whole desktop window: no title bar, no borders
                    if (on) {                                                                 // still borders / taskbar showing? let the picture itself go fullscreen
                        await new Promise(r => setTimeout(r, 350));
                        if (isFS && !coversScreen() && !document.fullscreenElement) { try { await pm.requestFullscreen(); domFS = true; } catch (e) {} }
                    } else if (document.fullscreenElement) { domFS = false; try { await document.exitFullscreen(); } catch (e) {} }
                }
                else if (on) { await pm.requestFullscreen(); isFS = true; }
                else { if (document.fullscreenElement) await document.exitFullscreen(); isFS = false; }
            } catch (e) { console.error(e); }
            $('p-fs-icon').className = 'fas ' + (isFS ? 'fa-minimize' : 'fa-maximize');
        }
        const toggleFS = () => setFS(!isFS);
        document.addEventListener('fullscreenchange', () => { if (window.pywebview && domFS && !document.fullscreenElement && isFS) { domFS = false; setFS(false); return; } if (!window.pywebview) { isFS = !!document.fullscreenElement; $('p-fs-icon').className = 'fas ' + (isFS ? 'fa-minimize' : 'fa-maximize'); } });

        // click = play/pause, double click = fullscreen
        let clickT = null;
        $('p-hit').addEventListener('click', () => {
            if (!$('p-menu').classList.contains('hidden')) { closeMenu(); return; }
            if (clickT) { clearTimeout(clickT); clickT = null; toggleFS(); return; }
            clickT = setTimeout(() => { clickT = null; togglePlayVideo(); }, 230);
        });

        // speed + subtitle menus
        let menuKind = null;
        function closeMenu() { $('p-menu').classList.add('hidden'); menuKind = null; showUI(); }
        function openMenu(kind) {
            if (menuKind === kind) { closeMenu(); return; }
            menuKind = kind;
            let html = '';
            if (kind === 'speed') {
                html = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(r => `<button class="menu-item ${player.playbackRate === r ? 'sel' : ''}" onclick="setSpeed(${r})">${r === 1 ? 'Normal' : r + 'x'}${player.playbackRate === r ? '<i class="fas fa-check text-xs"></i>' : ''}</button>`).join('');
            } else {
                const tt = [...player.textTracks], active = tt.findIndex(t => t.mode === 'showing');
                html = `<button class="menu-item ${active < 0 ? 'sel' : ''}" onclick="setCC(-1)">Off${active < 0 ? '<i class="fas fa-check text-xs"></i>' : ''}</button>` +
                    tt.map((t, i) => `<button class="menu-item ${active === i ? 'sel' : ''}" onclick="setCC(${i})">${esc(t.label || 'Subtitles')}${active === i ? '<i class="fas fa-check text-xs"></i>' : ''}</button>`).join('');
            }
            $('p-menu').innerHTML = html;
            $('p-menu').classList.remove('hidden'); showUI();
        }
        function setSpeed(r) { player.playbackRate = r; closeMenu(); hint('Speed ' + (r === 1 ? 'normal' : r + 'x')); }
        function setCC(i) {
            [...player.textTracks].forEach((t, n) => { t.mode = n === i ? 'showing' : 'disabled'; });
            $('p-cc').classList.toggle('on', i >= 0); closeMenu();
            hint(i >= 0 ? 'Subtitles: ' + (player.textTracks[i].label || 'on') : 'Subtitles off');
        }
        function cycleCC() {
            const tt = [...player.textTracks]; if (!tt.length) return;
            const active = tt.findIndex(t => t.mode === 'showing');
            setCC(active + 1 >= tt.length ? -1 : active + 1);
        }

        // seek bar (click, drag, hover time)
        const seekEl = $('p-seek');
        const fracAt = e => { const r = seekEl.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
        function previewDrag(e) {
            const f = fracAt(e), d = player.duration || 0;
            $('p-played').style.width = f * 100 + '%'; $('p-thumb').style.left = f * 100 + '%';
            $('p-time').textContent = fmtClock(f * d) + ' / ' + fmtClock(d);
            return f;
        }
        seekEl.addEventListener('pointerdown', e => { if (!ready) return; dragging = true; seekEl.setPointerCapture(e.pointerId); previewDrag(e); });
        seekEl.addEventListener('pointermove', e => {
            const f = fracAt(e), tip = $('p-tip');
            tip.classList.remove('hidden'); tip.style.left = f * 100 + '%'; tip.textContent = fmtClock(f * (player.duration || 0));
            if (dragging) previewDrag(e);
        });
        seekEl.addEventListener('pointerup', e => {
            if (!dragging) return;
            const f = previewDrag(e); dragging = false;
            player.currentTime = f * (player.duration || 0); showUI();
        });
        seekEl.addEventListener('pointerleave', () => $('p-tip').classList.add('hidden'));

        // ---- up next ----
        function showNext() {
            if (!playInfo || !playInfo.next) return;
            $('pn-title').textContent = playInfo.next_title || 'Next episode';
            const priv = scopeOf(playInfo.next) === 'private';
            $('pn-img').src = (priv ? withToken : x => x)(`/poster/${playInfo.next}`);
            let left = NEXT_COUNTDOWN;
            $('pn-count').textContent = left;
            const bar = $('pn-bar'); bar.style.transition = 'none'; bar.style.width = '0';
            $('p-next').classList.remove('hidden');
            void bar.offsetWidth; bar.style.transition = `width ${NEXT_COUNTDOWN}s linear`; bar.style.width = '100%';
            clearInterval(nextTimer);
            nextTimer = setInterval(() => {
                left--; $('pn-count').textContent = Math.max(left, 0);
                if (left <= 0) playNextNow();
            }, 1000);
        }
        function hideNext() { clearInterval(nextTimer); nextTimer = null; $('p-next').classList.add('hidden'); }
        function playNextNow() { const id = playInfo && playInfo.next; hideNext(); if (id) { if (miniMode) keepMini = true; playVideo(id); } }

        // ---- media keys / OS media controls ----
        function setupMediaSession(kind) {
            if (!('mediaSession' in navigator)) return;
            const ms = navigator.mediaSession, h = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) {} };
            try {
                if (kind === 'video' && playingId) {
                    ms.metadata = new MediaMetadata({ title: titles[playingId] || 'Video', artist: (playInfo && playInfo.series) || 'ULTRON' });
                    h('play', () => player.play()); h('pause', () => player.pause());
                    h('seekbackward', () => skip(-10)); h('seekforward', () => skip(10));
                    h('nexttrack', () => stepEpisode(1)); h('previoustrack', () => stepEpisode(-1));
                } else {
                    const t = curTrack();
                    ms.metadata = t ? new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: [{ src: t.cover, sizes: '512x512' }] }) : null;
                    h('play', () => audio.play()); h('pause', () => audio.pause());
                    h('seekbackward', null); h('seekforward', null);
                    h('nexttrack', () => nextTrack(false)); h('previoustrack', prevTrack);
                }
            } catch (e) {}
        }

        // ---- video element events ----
        player.addEventListener('loadedmetadata', () => {
            if (!playingId) return;
            if (resumeAt > 0 && resumeAt < player.duration) {
                player.currentTime = resumeAt;
                $('start-over').classList.remove('hidden');
            } else { resumed = false; }
            ready = true; updateTimeUI();
            const tt = player.textTracks;
            if (prefs.subs_auto && tt.length && ![...tt].some(t => t.mode === 'showing')) tt[0].mode = 'showing';
            $('p-cc').classList.toggle('on', [...tt].some(t => t.mode === 'showing'));
        });
        player.addEventListener('play', async () => {
            $('p-play-icon').className = 'fas fa-pause'; showUI();
            if (!audio.paused) { audio.pause(); musicWasPlaying = true; }       // video wins: never two things playing
            if (!playingId || viewCounted) return;
            viewCounted = true;
            if (resumed) return;
            try { updateCards(playingId, await post(`/api/videos/${playingId}/view`)); } catch (e) { console.error(e); }
        });
        player.addEventListener('pause', () => { $('p-play-icon').className = 'fas fa-play ml-0.5'; saveProgress(true); showUI(); });
        player.addEventListener('timeupdate', () => { updateTimeUI(); saveProgress(false); });
        player.addEventListener('progress', () => {
            try { if (player.buffered.length && player.duration) $('p-buf').style.width = player.buffered.end(player.buffered.length - 1) / player.duration * 100 + '%'; } catch (e) {}
        });
        player.addEventListener('waiting', () => $('p-spin').classList.remove('hidden'));
        ['playing', 'canplay', 'seeked'].forEach(ev => player.addEventListener(ev, () => $('p-spin').classList.add('hidden')));
        player.addEventListener('ratechange', () => { $('p-speed').textContent = (player.playbackRate === 1 ? '1' : player.playbackRate) + 'x'; });
        player.addEventListener('ended', () => { saveProgress(true); showUI(); showNext(); });
        player.addEventListener('error', () => { if (playingId) { $('player-error').classList.remove('hidden'); $('p-spin').classList.add('hidden'); } });
        window.addEventListener('beforeunload', () => saveProgress(true, true));

        async function rescan() {
            const icon = $('rescan-icon');
            icon.classList.add('fa-spin');
            try { await post('/api/rescan'); await loadVideos('public'); if (token) await loadVideos('private'); if (currentView === 'music-view') musicOpened(); } catch (e) { console.error(e); }
            icon.classList.remove('fa-spin');
        }


        // ======================= private photos: gallery + lightbox =======================
        const PH = { items: [], view: [], loaded: false, folder: '', shuffled: false, album: null, next: null, pub: false, albums: [] };
        const phThumb = p => p.pub ? `/pphoto/${p.id}/thumb?v=${p.v}` : withToken(`/photo/${p.id}/thumb?v=${p.v}`);
        const phFull = p => p.pub ? `/pphoto/${p.id}?v=${p.v}` : withToken(`/photo/${p.id}?v=${p.v}`);
        let phScope = 'private';
        const phBox = () => $(phScope === 'public' ? 'public-photos' : 'private-photos');
        const favOn = pub => pub ? prefs.fav_public !== false : prefs.fav_private !== false;
        const nPhotos = n => n + ' photo' + (n === 1 ? '' : 's');

        function privateMode(m) {
            heroStop();
            document.querySelectorAll('#private-bar .pv-tab').forEach(b => b.classList.toggle('on', b.dataset.m === m));
            $('private-videos').classList.toggle('hidden', m !== 'videos');
            if ($('pv-sort')) $('pv-sort').classList.toggle('hidden', m !== 'videos');
            $('private-photos').classList.toggle('hidden', m !== 'photos');
            document.body.scrollTo({ top: 0, behavior: 'instant' });
            if (m === 'photos') { phScope = 'private'; loadPhotos(true); }
        }
        // reset = opening the gallery (lands on the albums); without it (Refresh) you stay inside the album you are in
        async function loadPhotos(reset) {
            const box = phBox();
            if (!box) return;
            try {
                const pub = phScope === 'public';
                const d = await api(pub ? '/api/pphotos' : '/api/photos');
                PH.pub = pub; PH.items = (d.photos || []).map(p => pub ? Object.assign(p, { pub: true }) : p); PH.folder = d.folder || ''; PH.dirs = d.albums || []; PH.loaded = true;
                if (reset) { PH.album = PH.next; PH.shuffled = false; }
                PH.next = null;
                renderPhotos();
            } catch (e) {
                if (e.status === 423 && window.plShow) { PH.items = []; PH.view = []; plShow(box); return; }      // Photos password is on and not entered yet
                console.error(e); box.innerHTML = `<div class="ph-empty">${esc(errMsg(e))}</div>`;
            }
        }
        function shuffleCopy(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
        // albums = the first subfolder of the gallery folder. Making an album means making a folder.
        function phAlbums() {
            const m = new Map();
            PH.items.forEach(p => { if (!p.album) return; const a = m.get(p.album); if (a) a.count++; else m.set(p.album, { name: p.album, count: 1, cover: p }); });
            (PH.dirs || []).forEach(n => { if (!m.has(n)) m.set(n, { name: n, count: 0, cover: null }); });      // brand-new albums have no photos yet
            return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        }
        const phFavs = () => favOn(PH.pub) ? PH.items.filter(p => p.fav) : [];
        // does the gallery have anything to sort into? if not, skip the albums screen and show the stream
        function phSettle() {
            PH.albums = phAlbums();
            if (PH.album === '__fav' && !favOn(PH.pub)) PH.album = null;
            if (PH.album && PH.album !== 'all' && PH.album !== '__fav' && !PH.albums.some(a => a.name === PH.album)) PH.album = null;
            if (PH.album === '__fav' && !PH.albums.length && !phFavs().length) PH.album = 'all';
            const sorted = PH.albums.length > 0 || (favOn(PH.pub) && phFavs().length > 0);
            if (PH.album === null && !sorted) PH.album = 'all';
            return sorted;
        }
        function phBuildView() {
            const a = PH.album;
            const base = a === 'all' ? PH.items : a === '__fav' ? phFavs() : PH.items.filter(p => p.album === a);
            PH.view = PH.shuffled ? shuffleCopy(base) : base.slice();
        }
        function phAlbum(a) { PH.album = a; PH.shuffled = false; renderPhotos(); document.body.scrollTo({ top: 0, behavior: 'instant' }); }
        const phAlbumAt = i => phAlbum(PH.albums[i].name);
        function photoShuffle() { PH.shuffled = !PH.shuffled; phBuildView(); renderPhotos(true); }
        async function photoFolder() { try { await post(PH.pub ? '/api/pphotos/open-folder' : '/api/photos/open-folder', {}); } catch (e) { toast(errMsg(e)); } }
        function renderPhotos(keepView) {
            const box = phBox();
            if (!box) return;
            if (!PH.items.length) {
                box.innerHTML = `<div class="ph-empty"><div>No photos yet.</div><div class="ph-sub">Put pictures in <span>${PH.pub ? 'media/Photos' : 'media/private/Photos'}</span> and come back.</div><button class="ph-act" onclick="photoFolder()">Open folder</button></div>`;
                return;
            }
            const sorted = phSettle();
            const realAlbum = PH.album && PH.album !== 'all' && PH.album !== '__fav';
            const acts = (shuffle) => `<span class="ph-acts">${PH.album === null || PH.album === 'all' ? '<button class="ph-act" onclick="pxNewAlbum()"><i class="fas fa-plus"></i> New album</button>' : ''}${PH.album !== null && PH.view.length ? '<button class="ph-act" onclick="pxSelStart()">Select</button>' : ''}${realAlbum ? '<button class="ph-act" onclick="pxRenameAlbum()">Rename</button><button class="ph-act" onclick="pxUngroupAlbum()" title="Photos go back to the main gallery, nothing is deleted">Ungroup</button>' : ''}${shuffle ? `<button class="ph-act ${PH.shuffled ? 'on' : ''}" onclick="photoShuffle()">Shuffle</button>` : ''}<button class="ph-act" onclick="loadPhotos()">Refresh</button><button class="ph-act" onclick="photoFolder()">Folder</button></span>`;
            if (PH.album === null) {                                   // ---- the albums screen
                const cover = (p, name, n, click, empty) => `<button class="al" onclick="${click}"><span class="al-cover${p ? '' : ' empty'}">${p ? `<img src="${phThumb(p)}" loading="lazy" decoding="async" alt="">` : `<i class="far ${name === 'Favorites' ? 'fa-heart' : 'fa-images'}"></i>`}</span><span class="al-name">${esc(name)}</span><span class="al-n">${empty || nPhotos(n)}</span></button>`;
                const favs = phFavs();
                box.innerHTML = `<div class="ph-head"><span class="ph-title"><b>Photos</b><span>${nPhotos(PH.items.length)}</span></span>${acts(false)}</div>
                    <div id="ph-albums">${favOn(PH.pub) ? cover(favs[0], 'Favorites', favs.length, "phAlbum('__fav')", favs.length ? '' : 'Heart a photo to add it') : ''}${cover(PH.items[0], 'All photos', PH.items.length, "phAlbum('all')")}${PH.albums.map((a, i) => cover(a.cover, a.name, a.count, `phAlbumAt(${i})`)).join('')}</div>`;
                return;
            }
            if (!keepView) phBuildView();                              // ---- inside an album (or the whole stream)
            const name = PH.album === 'all' ? 'All photos' : PH.album === '__fav' ? 'Favorites' : PH.album;
            const title = sorted ? `<span class="ph-title"><button class="ph-back" onclick="phAlbum(null)">Albums</button><b>${esc(name)}</b><span>${nPhotos(PH.view.length)}</span></span>` : `<span>${nPhotos(PH.view.length)}</span>`;
            box.innerHTML = `<div class="ph-head">${title}${acts(PH.view.length > 1)}</div>`
                + (PH.view.length ? '<div id="ph-grid"></div>' : (PH.album === '__fav' ? `<div class="ph-empty"><div>No favorites yet.</div><div class="ph-sub">Heart a photo while viewing it and it shows up here.</div></div>` : `<div class="ph-empty"><div>This album is empty.</div><div class="ph-sub">Open <b>All photos</b>, tap <b>Select</b>, pick some photos and choose <b>Add to album</b>.</div></div>`));
            layoutPhotos();
        }
        // justified rows: every row is exactly as wide as the screen, photos keep their own shape (no cropping, no gaps)
        function layoutPhotos() {
            const grid = $('ph-grid');
            if (!grid || !PH.view.length) return;
            const W = grid.clientWidth;
            if (!W) return;
            const gap = W < 700 ? 4 : 6, target = clamp(W / 5.4, 140, 290);
            let row = [], sum = 0, html = '';
            const flush = last => {
                let h = (W - gap * (row.length - 1)) / sum;
                if (last && h > target * 1.4) h = target;
                html += `<div class="ph-row" style="height:${h.toFixed(2)}px;gap:${gap}px;margin-bottom:${gap}px">` + row.map(i => {
                    const p = PH.view[i];
                    return `<button class="ph-tile${p.fav && favOn(PH.pub) ? ' is-fav' : ''}" data-i="${i}" style="width:${Math.floor(p.ar * h * 100) / 100}px" onclick="openPhoto(${i}, this)"><img src="${phThumb(p)}" loading="lazy" decoding="async" alt=""></button>`;
                }).join('') + '</div>';
                row = []; sum = 0;
            };
            PH.view.forEach((p, i) => {
                p.ar = clamp((p.w || 4) / (p.h || 3), 0.45, 3.4);
                row.push(i); sum += p.ar;
                if (sum * target + gap * (row.length - 1) >= W) flush(false);
            });
            if (row.length) flush(true);
            grid.innerHTML = html;
        }
        let phResizeT = 0;
        window.addEventListener('resize', () => {
            clearTimeout(phResizeT);
            phResizeT = setTimeout(() => { const g = $('ph-grid'); if (g && g.clientWidth && (currentView === 'private-view' || currentView === 'photos-view')) layoutPhotos(); if (LB.open) lbRefit(); }, 120);
        });

        // ---- home shelves: a few recent photos, public and (while unlocked) private ----
        const HP = { pub: { items: [], t: 0, busy: false }, priv: { items: [], t: 0, busy: false } };
        async function loadHomePhotos(k) {
            const h = HP[k];
            if (k === 'priv' && !token) { h.items = []; return; }
            if (h.busy || Date.now() - h.t < 20000) return;
            h.busy = true; h.t = Date.now();
            try { const d = await api(k === 'pub' ? '/api/pphotos' : '/api/photos'); h.items = (d.photos || []).map(p => k === 'pub' ? Object.assign(p, { pub: true }) : p); }
            catch (e) { h.items = []; }
            h.busy = false; dashSoon();
        }
        const ensureHomePhotos = () => { loadHomePhotos('pub'); loadHomePhotos('priv'); };
        function openHomePhoto(k, i, el, favs) { if (!PH.bak) PH.bak = PH.view; PH.view = favs ? HP[k].items.filter(p => p.fav) : HP[k].items; openPhoto(i, el); }
        function openFavorites(k) {                  // Home -> Favorites album
            PH.next = '__fav';
            if (k === 'priv') { switchTab('private-view', 'tab-private'); privateMode('photos'); }
            else switchTab('photos-view', 'tab-photos');
        }

        // ---- favorites: a heart in the viewer. Stored by file path in the database, so rescans keep them. ----
        function phSetFav(id, on) { [PH.items, PH.view, HP.pub.items, HP.priv.items].forEach(l => l.forEach(p => { if (p.id === id) p.fav = on; })); }
        function lbFavRefresh() {
            const b = $('lb-fav'), p = PH.view[LB.i], show = !!p && favOn(!!p.pub);
            b.hidden = !show;
            if (!show) return;
            b.classList.toggle('on', !!p.fav);
            b.setAttribute('aria-pressed', p.fav ? 'true' : 'false');
            b.firstElementChild.className = (p.fav ? 'fas' : 'far') + ' fa-heart';
            b.title = (p.fav ? 'Remove from Favorites' : 'Add to Favorites') + ' (F)';
            const t = lbTile(LB.i); if (t) t.classList.toggle('is-fav', !!p.fav);
        }
        async function lbFav() {
            const p = PH.view[LB.i];
            if (!LB.open || !p || !favOn(!!p.pub)) return;
            const on = !p.fav, id = p.id, pub = !!p.pub;
            phSetFav(id, on); lbFavRefresh();
            const b = $('lb-fav'); b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
            try { await post(pub ? '/api/pphotos/fav' : '/api/photos/fav', { id, on }); }
            catch (e) { phSetFav(id, !on); lbFavRefresh(); toast(errMsg(e)); }
        }
        function favPrefsChanged() {                  // a Settings toggle: hearts and the Favorites album appear / disappear right away
            if (PH.loaded) renderPhotos();
            dashSoon();
        }

        // ---- lightbox: the photo grows out of its tile, then fullscreen if you want it ----
        const LB = { i: -1, open: false, fs: false, busy: false, seq: 0, idleT: 0, wheelT: 0 };
        const setRect = (el, r) => { el.style.left = r.left + 'px'; el.style.top = r.top + 'px'; el.style.width = r.width + 'px'; el.style.height = r.height + 'px'; };
        function lbFit(p) {
            const vw = innerWidth, vh = innerHeight, pad = LB.fs ? 0 : Math.round(Math.min(56, vw * 0.04));
            const s = Math.min((vw - pad * 2) / (p.w || 4), (vh - pad * 2) / (p.h || 3), 2.5);
            const w = (p.w || 4) * s, h = (p.h || 3) * s;
            return { left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h };
        }
        const lbTile = i => document.querySelector(`.ph-tile[data-i="${i}"]`);
        function lbCount() { $('lb-count').textContent = (LB.i + 1) + ' / ' + PH.view.length; }
        function lbUpgrade(p) {
            const mine = ++LB.seq, im = new Image();
            im.onload = () => { if (LB.seq === mine && LB.open) $('lb-img').src = phFull(p); };
            im.src = phFull(p);
        }
        function lbNeighbours() { [1, -1].forEach(d => { const p = PH.view[(LB.i + d + PH.view.length) % PH.view.length]; if (p) new Image().src = phFull(p); }); }
        function openPhoto(i, el) {
            const p = PH.view[i]; if (!p) return;
            heroStop(); hpStop();
            LB.i = i; LB.open = true; LB.busy = false;
            const lb = $('lightbox'), img = $('lb-img');
            lb.classList.remove('hidden'); lb.classList.remove('idle');
            img.classList.remove('fade');
            img.style.transition = 'none';
            img.src = phThumb(p);
            const from = el ? el.getBoundingClientRect() : null;
            setRect(img, from || lbFit(p));
            img.style.opacity = 1;
            void img.offsetWidth;
            img.style.transition = '';
            lb.classList.add('on');
            setRect(img, lbFit(p));
            lbCount(); lbFavRefresh(); lbUpgrade(p); lbNeighbours();
        }
        function lbRefit() { const p = PH.view[LB.i]; if (LB.open && p) setRect($('lb-img'), lbFit(p)); }
        function lbShowTile(i) { const t = lbTile(i); if (t) { const r = t.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) t.scrollIntoView({ block: 'center', behavior: 'instant' }); } }
        function lbGo(d) {
            const n = PH.view.length;
            if (!LB.open || n < 2 || LB.busy) return;
            LB.busy = true;
            const img = $('lb-img');
            img.classList.add('fade');
            setTimeout(() => {
                LB.i = (LB.i + d + n) % n;
                const p = PH.view[LB.i];
                img.style.transition = 'none';
                img.src = phThumb(p); setRect(img, lbFit(p));
                void img.offsetWidth;
                img.style.transition = ''; img.classList.remove('fade');
                lbCount(); lbFavRefresh(); lbUpgrade(p); lbNeighbours(); lbShowTile(LB.i);
                LB.busy = false;
            }, 150);
        }
        async function lbSetFS(on) {
            const bridge = window.pywebview && window.pywebview.api;
            try {
                if (!on && displayMode === 'fullscreen') LB.fs = false;                  // the whole app is fullscreen: leave it be
                else if (bridge && bridge.set_fullscreen) LB.fs = !!(await bridge.set_fullscreen(on));
                else if (on) { await $('lightbox').requestFullscreen(); LB.fs = true; }
                else { if (document.fullscreenElement) await document.exitFullscreen(); LB.fs = false; }
            } catch (e) { console.error(e); }
            $('lightbox').classList.toggle('fs', LB.fs);
            $('lb-fs-icon').className = 'fas ' + (LB.fs ? 'fa-compress' : 'fa-expand');
            lbWake();
            setTimeout(lbRefit, 60); setTimeout(lbRefit, 350);
        }
        const lbToggleFS = () => lbSetFS(!LB.fs);
        function lbWake() {
            const lb = $('lightbox');
            lb.classList.remove('idle'); clearTimeout(LB.idleT);
            if (LB.fs) LB.idleT = setTimeout(() => lb.classList.add('idle'), 2200);
        }
        async function closePhoto() {
            if (!LB.open) return;
            LB.open = false; if (PH.bak) { PH.view = PH.bak; PH.bak = null; }
            const lb = $('lightbox'), img = $('lb-img');
            if (LB.fs) await lbSetFS(false);
            lb.classList.remove('on');
            const t = lbTile(LB.i), r = t && t.getBoundingClientRect();
            if (r && r.bottom > 0 && r.top < innerHeight) setRect(img, r); else img.style.opacity = 0;
            setTimeout(() => {
                if (LB.open) return;
                lb.classList.add('hidden'); img.removeAttribute('src');
                if (PH.album === '__fav' && $('ph-grid')) renderPhotos();   // un-hearted photos leave the Favorites album once you close the viewer
                dashSoon();
            }, 400);
        }
        function closePhotoNow() {             // used when the library locks: gone instantly, nothing left on screen
            LB.open = false; LB.fs = false; clearTimeout(LB.idleT); if (PH.bak) { PH.view = PH.bak; PH.bak = null; }
            const lb = $('lightbox'); if (!lb) return;
            lb.classList.add('hidden'); lb.classList.remove('on', 'fs', 'idle');
            const img = $('lb-img'); img.removeAttribute('src');
            try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
            try { const b = window.pywebview && window.pywebview.api; if (b && b.set_fullscreen && displayMode !== 'fullscreen') b.set_fullscreen(false); } catch (e) {}
        }
        window.addEventListener('keydown', e => {
            if (!LB.open) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            e.stopPropagation();
            const k = e.key;
            if (k === 'Escape') { e.preventDefault(); if (LB.fs) lbSetFS(false); else closePhoto(); }
            else if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ') { e.preventDefault(); lbGo(1); }
            else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); lbGo(-1); }
            else if (k === 'f' || k === 'F') { e.preventDefault(); lbFav(); }
            else if (k === 'Enter') { e.preventDefault(); lbToggleFS(); }
            lbWake();
        }, true);
        document.addEventListener('fullscreenchange', () => {
            if (!LB.open || window.pywebview) return;
            LB.fs = !!document.fullscreenElement; $('lightbox').classList.toggle('fs', LB.fs);
            $('lb-fs-icon').className = 'fas ' + (LB.fs ? 'fa-compress' : 'fa-expand'); setTimeout(lbRefit, 60);
        });
        $('lightbox').addEventListener('mousemove', lbWake);
        $('lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox' || e.target.id === 'lb-bg') closePhoto(); });
        $('lightbox').addEventListener('wheel', e => {
            e.preventDefault();
            if (LB.wheelT || Math.abs(e.deltaY) < 8) return;
            LB.wheelT = setTimeout(() => { LB.wheelT = 0; }, 380);
            lbGo(e.deltaY > 0 ? 1 : -1);
        }, { passive: false });
        $('lb-img').addEventListener('dblclick', lbToggleFS);

        // ======================= private library lock =======================
        let lockMode = 'unlock';
        function onLockClick() {
            if (token) { $('lock-menu').classList.toggle('hidden'); return; }
            openLockModal(hasPassword ? 'unlock' : 'setup');
        }
        function closeLockMenu() { $('lock-menu').classList.add('hidden'); }
        function openLockModal(mode) {
            closeLockMenu();
            lockMode = mode;
            const t = { unlock: ['Private Library', 'Enter your password to continue.', 'Unlock'],
                        setup: ['Create a password', 'Choose a password for your private library.', 'Save password'],
                        change: ['Change password', 'Enter your current and new password.', 'Update password'] }[mode];
            $('lock-title').textContent = t[0]; $('lock-sub').textContent = t[1]; $('lock-submit').textContent = t[2];
            $('lock-old').classList.toggle('hidden', mode !== 'change');
            $('lock-pass2').classList.toggle('hidden', mode === 'unlock');
            $('lock-pass').placeholder = mode === 'change' ? 'New password' : 'Password';
            ['lock-old', 'lock-pass', 'lock-pass2'].forEach(i => { $(i).value = ''; });
            $('lock-error').textContent = '';
            show('lock-modal', true, true);
            setTimeout(() => $(mode === 'change' ? 'lock-old' : 'lock-pass').focus(), 30);
        }
        function closeLockModal() {
            show('lock-modal', false, true);
            ['lock-old', 'lock-pass', 'lock-pass2'].forEach(i => { $(i).value = ''; });
        }
        function lockError(msg) {
            $('lock-error').textContent = msg;
            const card = $('lock-card');
            card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
            $('lock-pass').select();
        }
        async function submitLock() {
            const pw = $('lock-pass').value;
            try {
                if (lockMode === 'unlock') {
                    const r = await post('/api/lock/unlock', { password: pw });
                    enterPrivate(r.token);
                } else {
                    if (pw.length < 4) return lockError('Use at least 4 characters.');
                    if (pw !== $('lock-pass2').value) return lockError('The passwords do not match.');
                    if (lockMode === 'setup') {
                        const r = await post('/api/lock/setup', { password: pw });
                        hasPassword = true;
                        enterPrivate(r.token);
                    } else {
                        await post('/api/lock/change', { old: $('lock-old').value, new: pw });
                        closeLockModal();
                    }
                }
            } catch (e) {
                const d = e.data || {};
                lockError(e.status === 429 ? `Too many attempts. Try again in ${d.retry_after || 30}s.` : (d.error || 'Something went wrong.'));
            }
        }
        function enterPrivate(newToken, stay) {
            setToken(newToken);
            closeLockModal();
            $('lock-icon').className = 'fas fa-lock-open text-accent';
            if (window.plRefresh) plRefresh();               // one password: the Photos lock opens with it
            buildView('private');
            if (!stay) switchTab('private-view', 'tab-private');
            syncPrivateUI();
            return loadVideos('private');
        }
        function lockNow() {
            if (miniWinPrivate) { try { window.pywebview.api.mini_close(); } catch (e) {} miniWinPrivate = false; }
            if (!token) return;
            const old = token;
            if (playingId && privateIds.has(playingId)) closePlayer(true);
            if (privAutoMuted) { try { player.muted = false; } catch (e) {} privAutoMuted = false; }   // the private mute resets with every lock
            if (hpDone) hpDone(null);                                                                   // a headphones prompt still open closes with the lock
            if (seriesCtx && seriesCtx.scope === 'private') closeSeries();
            setToken(null);
            fetch('/api/lock/lock', { method: 'POST', headers: { 'X-Private-Token': old, 'X-LMP': '1' } }).catch(() => {});
            purgePrivateTitles();                       // no private title survives in the page's JS state
            privateIds.clear(); pools.private = []; vdata.private = null;
            closePhotoNow(); PH.items = []; PH.view = []; PH.loaded = false; PH.album = null; PH.next = null; HP.priv.items = []; HP.priv.t = 0;
            $('private-view').innerHTML = '';
            $('lock-icon').className = 'fas fa-lock';
            closeLockMenu();
            switchTab('video-view', 'tab-video');
        }

        let lastActivity = Date.now();
        ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(ev =>
            document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
        async function nativeBusy() {                                                    // a private video is playing in the native window
            try { return !!(await api('/api/native/busy')).busy; } catch (e) { return false; }
        }
        setInterval(async () => {
            if (!token) return;
            if (playingId && !player.paused) { lastActivity = Date.now(); return; }
            if (Date.now() - lastActivity > IDLE_LOCK_MINUTES * 60000) {
                if (await nativeBusy()) { lastActivity = Date.now(); return; }           // never lock under a private video that is playing
                if (token) lockNow();
            }
        }, 10000);

        // ======================= keyboard =======================
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); lockNow(); return; }
            const open = id => !$(id).classList.contains('hidden');
            const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '') && document.activeElement.type !== 'range';
            const modalOpen = ['settings-modal', 'title-modal', 'lock-modal', 'add-modal', 'genre-modal', 'name-modal', 'lang-modal', 'org-modal', 'ren-modal'].some(open);
            if (e.key === 'Escape') {
                if (open('settings-modal')) closeSettings();
                else if (open('title-modal')) closeTitleModal();
                else if (open('lock-modal')) closeLockModal();
                else if (open('add-modal')) closeAddModal();
                else if (open('genre-modal')) closeGenreModal();
                else if (open('name-modal')) closeNameModal();
                else if (open('org-modal')) closeOrganize();
                else if (open('ren-modal')) closeRename();
                else if (open('lang-modal')) closeLangModal();
                else if (playingId && !miniMode) { if (menuKind) closeMenu(); else if (isFS) setFS(false); else closePlayer(); }
                else if (open('series-modal')) closeSeries();
                else { closeLockMenu(); closeQueue(); closeAddMenu(); }
                return;
            }
            if (e.key === 'Enter') {
                if (open('title-modal')) saveTitle(false);
                else if (open('lock-modal')) submitLock();
                return;
            }
            if (typing || modalOpen || e.ctrlKey || e.metaKey || e.altKey) return;
            if (playingId && !miniMode) {
                const k = e.key.toLowerCase();
                const acts = {
                    ' ': togglePlayVideo, k: togglePlayVideo, j: () => skip(-10), l: () => skip(10),
                    arrowleft: () => skip(-5), arrowright: () => skip(5),
                    arrowup: () => { setVol((player.muted ? 0 : player.volume) + 0.05); hint('Volume ' + Math.round(player.volume * 100) + '%'); },
                    arrowdown: () => { setVol((player.muted ? 0 : player.volume) - 0.05); hint('Volume ' + Math.round(player.volume * 100) + '%'); },
                    m: toggleMute, i: enterMini, f: toggleFS, c: cycleCC, n: () => stepEpisode(1), p: () => stepEpisode(-1),
                    '>': () => setSpeed(Math.min(2, player.playbackRate + 0.25)), '<': () => setSpeed(Math.max(0.5, player.playbackRate - 0.25))
                };
                if (acts[k]) { e.preventDefault(); acts[k](); showUI(); }
                else if (/^[0-9]$/.test(k) && ready) { player.currentTime = player.duration * Number(k) / 10; }
                return;
            }
            if (currentView === 'music-view') {
                if (e.key === ' ') { e.preventDefault(); togglePlay(); }
                else if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && nowId) {          // Shift + arrows: next / previous song, volume
                    const kk = e.key;
                    if (kk === 'ArrowRight') { e.preventDefault(); nextTrack(); }
                    else if (kk === 'ArrowLeft') { e.preventDefault(); prevTrack(); }
                    else if (kk === 'ArrowUp' || kk === 'ArrowDown') { e.preventDefault(); audio.volume = Math.max(0, Math.min(1, audio.volume + (kk === 'ArrowUp' ? 0.05 : -0.05))); audio.muted = false; $('vol').value = Math.round(audio.volume * 100); paintAudioVol(); }
                }
            }
        });
        document.addEventListener('click', e => {
            if (!e.target.closest('#lock-btn, #lock-menu')) closeLockMenu();
            if (!e.target.closest('#queue-panel, #b-queue')) closeQueue();
        });

        // ======================= MUSIC =======================
        const audio = $('audio');
        audio.volume = 0.8;
        let queue = [], order = [], pos = -1, nowId = null, shuffleOn = false, repeatMode = 'off';
        let errorStreak = 0, seeking = false;
        let viewTracks = [], view = { kind: 'home' }, playlists = [], filtersData = null, likedIds = new Set();
        let libTab = 'playlists', libQ = '', pendingIds = [], langIds = null, nameMode = 'create', knownLanguages = [];
        let artistByLabel = {}, langTimer = null, lastFilters = null, searchTimer = null, musicReady = false;
        const REGS = { lib: new Map(), home: new Map(), alb: new Map() }; let srcN = 0;
        const reg = (src, kind) => { REGS[kind || 'home'].set(++srcN, src); return srcN; };
        const getSrc = n => REGS.lib.get(n) || REGS.home.get(n) || REGS.alb.get(n);

        const SRC_LABEL = { lyrics: 'detected from the lyrics', manual: 'set by you', 'artist guess': "guessed from this artist's other songs",
                            'tags/folder': 'from the file tags or folder name', 'title/artist text': 'from the title / artist text' };

        // ---- cover helpers ----
        const coverImg = id => `<img src="/cover/${id}" alt="" loading="lazy" class="absolute inset-0 h-full w-full object-cover" onerror="this.style.display='none'">`;
        function coverBox(ids, cls, round) {
            ids = ids || [];
            const inner = !ids.length ? '' : ids.length < 4 ? coverImg(ids[0])
                : `<div class="absolute inset-0 grid grid-cols-2 grid-rows-2">${ids.slice(0, 4).map(id => `<div class="relative">${coverImg(id)}</div>`).join('')}</div>`;
            return `<div class="relative ${cls} ${round ? 'rounded-full' : 'rounded-md'} bg-gradient-to-br from-[#3a3a3a] to-[#1c1c1c] flex items-center justify-center overflow-hidden flex-none"><i class="fas ${round ? 'fa-user' : 'fa-music'} text-gray-500"></i>${inner}</div>`;
        }
        const tintBox = (name, icon, cls) => { const h = hue(name); return `<div class="relative ${cls} rounded-md flex items-center justify-center flex-none text-white/90" style="background:linear-gradient(135deg,hsl(${h} 62% 42%),hsl(${(h + 45) % 360} 70% 24%))"><i class="fas ${icon}"></i></div>`; };
        const likedBox = cls => `<div class="relative ${cls} rounded-md flex items-center justify-center flex-none text-white" style="background:linear-gradient(135deg,#5b3df5,#b9b4f5)"><i class="fas fa-heart"></i></div>`;
        const plCover = (p, cls) => p.liked ? likedBox(cls) : coverBox(p.covers, cls);

        // ---- sources: playlists, artists, language / genre mixes, search ----
        const plSrc = p => ({ type: 'playlist', id: p.id, key: 'pl:' + p.id, label: 'Playlist', title: p.name, liked: p.liked, covers: p.covers });
        const artistSrc = a => ({ type: 'filter', filter: { artist: a.name }, key: 'ar:' + a.name, label: 'Artist', title: a.name, sample: a.sample, shuffle: false });
        const langSrc = l => ({ type: 'filter', filter: { language: l.name }, key: 'lg:' + l.name, label: 'Language mix', title: l.name + ' mix', tint: l.name, icon: 'fa-language', shuffle: true });
        const genreSrc = g => ({ type: 'filter', filter: { genre: g.key }, key: 'gn:' + g.key, label: 'Genre mix', title: g.name + ' mix', tint: g.name, icon: 'fa-compact-disc', shuffle: true });
        const allSrc = () => ({ type: 'filter', filter: {}, key: 'all', label: 'Mix', title: 'All songs', tint: 'All songs', icon: 'fa-shuffle', shuffle: true });

        async function fetchSource(src) {
            if (src.tracks) return { tracks: src.tracks, name: src.title };
            if (src.type === 'recent') { const d = await api('/api/music/recent?limit=200'); return { tracks: d.tracks, name: src.title }; }
            if (src.type === 'playlist' && src.id < 0) return { tracks: [], name: src.title, missing: 0 };
            if (src.type === 'playlist') { const d = await api('/api/playlists/' + src.id); return { tracks: d.tracks, name: d.name, missing: d.missing }; }
            const d = await post('/api/playlist', Object.assign({ mode: 'all' }, src.filter));
            return { tracks: d.tracks, name: src.title };
        }
        async function openSrc(n) { const s = getSrc(n); if (s) openSource(s); }
        async function playSrc(n, shuffle) { const s = getSrc(n); if (s) playSource(s, shuffle); }
        async function playSource(src, shuffle) {
            try {
                const r = await fetchSource(src);
                if (!r.tracks.length) { toast('Nothing to play here yet.'); return; }
                playList(r.tracks, shuffle ? Math.floor(Math.random() * r.tracks.length) : 0, shuffle ? true : undefined);
            } catch (e) { toast(errMsg(e)); }
        }
        async function openSource(src) {
            try {
                const r = await fetchSource(src);
                $('m-search').value = src.key === 'search' ? $('m-search').value : '';
                view = { kind: 'list', src, key: src.key, playlist: src.type === 'playlist' ? { id: src.id, name: r.name, liked: !!src.liked } : null,
                         title: r.name || src.title, missing: r.missing || 0 };
                viewTracks = r.tracks;
                exitSel(true);
                setMainView('list'); renderListHeader(); renderTracks(); renderLibrary();
                $('m-main').scrollTop = 0;
            } catch (e) { toast(errMsg(e)); loadPlaylists(); }
        }
        const openPlaylist = id => { const p = playlists.find(x => x.id === id); openSource(p ? plSrc(p) : { type: 'playlist', id, key: 'pl:' + id, label: 'Playlist', title: '' }); };

        function setMainView(name) {
            if (selMode && name !== 'list' && name !== 'gen') exitSel(true);
            show('mv-home', name === 'home'); show('mv-albums', name === 'albums'); show('mv-playlists', name === 'playlists'); show('mv-list', name === 'list'); show('mv-gen', name === 'gen');
            show('m-table-wrap', name === 'list' || (name === 'gen' && viewTracks.length));
        }
        function showHome() { view = { kind: 'home' }; $('m-search').value = ''; setMainView('home'); renderHome(); renderLibrary(); $('m-main').scrollTop = 0; }
        function showGen() {
            if (view.kind !== 'gen') { view = { kind: 'gen' }; viewTracks = []; renderTracks(); }
            setMainView('gen'); renderGenBar(); renderLibrary(); $('m-main').scrollTop = 0;
        }
        function onSearchInput() {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                const q = $('m-search').value.trim();
                if (!q) { if (view.key === 'search') showHome(); return; }
                openSource({ type: 'filter', filter: { q }, key: 'search', label: 'Search', title: 'Results for "' + q + '"', tint: q, icon: 'fa-magnifying-glass' });
            }, 280);
        }

        // ---- sidebar library ----
        function renderLibrary() {
            const tabs = [['playlists', 'Playlists'], ['artists', 'Artists'], ['albums', 'Albums'], ['languages', 'Languages']];
            $('lib-tabs').innerHTML = tabs.map(([k, l]) => `<button class="chip !py-1 ${libTab === k ? 'on' : ''}" onclick="libTab='${k}';renderLibrary()">${l}</button>`).join('');
            REGS.lib.clear();
            const regL = s => reg(s, 'lib');
            const q = libQ.trim().toLowerCase(), f = filtersData || { artists: [], languages: [] };
            const row = (cover, title, sub, n, active) => `<button onclick="openSrc(${n})" class="w-full flex items-center gap-3 p-2 rounded-lg text-left transition-colors ${active ? 'bg-white/10' : 'hover:bg-white/[.07]'}">${cover}<div class="min-w-0"><div class="font-semibold truncate ${active ? 'text-accent' : ''}">${esc(title)}</div><div class="text-xs text-gray-400 truncate">${sub}</div></div></button>`;
            let html = '';
            if (libTab === 'playlists') {
                html = playlists.filter(p => !q || p.name.toLowerCase().includes(q)).map(p => {
                    const s = plSrc(p);
                    return row(plCover(p, 'h-12 w-12'), p.name, `${p.liked ? '<i class="fas fa-thumbtack text-accent mr-1 text-[10px]"></i>' : ''}Playlist &middot; ${p.count} song${p.count === 1 ? '' : 's'}`, regL(s), view.key === s.key);
                }).join('') || '<div class="p-4 text-sm text-gray-500">No playlists yet. Press + to create one.</div>';
            } else if (libTab === 'albums') {
                html = (albumsData || []).filter(a => !q || (a.name + ' ' + a.artist).toLowerCase().includes(q)).slice(0, 250).map(a => {
                    const s = albumSrc(a);
                    return row(coverBox([a.sample], 'h-12 w-12'), a.name, `Album &middot; ${esc(a.artist)}`, regL(s), view.key === s.key);
                }).join('') || '<div class="p-4 text-sm text-gray-500">No albums found.</div>';
            } else if (libTab === 'artists') {
                html = f.artists.filter(a => !q || a.name.toLowerCase().includes(q)).slice(0, 250).map(a => {
                    const s = artistSrc(a);
                    return row(coverBox([a.sample], 'h-12 w-12', true), a.name, `Artist &middot; ${a.count} song${a.count === 1 ? '' : 's'}`, regL(s), view.key === s.key);
                }).join('') || '<div class="p-4 text-sm text-gray-500">No artists found.</div>';
            } else {
                html = f.languages.filter(l => !q || l.name.toLowerCase().includes(q)).map(l => {
                    const s = langSrc(l);
                    return row(tintBox(l.name, 'fa-language', 'h-12 w-12'), l.name, `Language &middot; ${l.count} song${l.count === 1 ? '' : 's'}`, regL(s), view.key === s.key);
                }).join('') || '<div class="p-4 text-sm text-gray-500">No languages yet. Open Mix generator and press Detect languages.</div>';
            }
            $('lib-list').innerHTML = html;
        }

        // ---- home ----
        function shelfCard(cover, title, sub, n, shuffle, cls) {
            return `<div class="group ${cls || 'w-44 flex-none'} p-3 rounded-lg hover:bg-white/10 transition-colors cursor-pointer" onclick="openSrc(${n})">
                <div class="relative mb-3">${cover}
                    <button class="absolute right-2 bottom-2 h-11 w-11 rounded-full bg-accent text-white shadow-xl flex items-center justify-center opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all hover:scale-105" title="Play" onclick="event.stopPropagation();playSrc(${n},${!!shuffle})"><i class="fas fa-play ml-0.5"></i></button>
                </div>
                <div class="font-semibold truncate">${esc(title)}</div><div class="text-sm text-gray-400 truncate">${sub}</div></div>`;
        }
        let recentTracks = [], shelfIds = [], shelfN = 0;
        const isNewTrack = t => t && t.added && (Date.now() / 1000 - t.added) < 7 * 86400;
        const recentSrc = () => ({ type: 'recent', key: 'recent', label: 'New arrivals', title: 'New arrivals', tint: 'New arrivals', icon: 'fa-clock-rotate-left', shuffle: false });
        async function loadRecent() {
            try { recentTracks = (await api('/api/music/recent?limit=30')).tracks || []; if (view.kind === 'home') renderHome(); } catch (e) { console.error(e); }
        }
        function playRecent(i) { if (recentTracks[i]) playList(recentTracks, i); }
        function trackCard(t, i) {
            return `<div data-tid="${t.id}" class="group w-44 flex-none p-3 rounded-lg hover:bg-white/10 transition-colors cursor-pointer" onclick="playRecent(${i})">
                <div class="relative mb-3">${coverBox([t.id], 'w-full aspect-square')}${isNewTrack(t) ? '<span class="absolute top-2 left-2 z-10 text-[10px] font-black bg-accent rounded px-2 py-1 tracking-wider shadow-lg">NEW</span>' : ''}
                    <span class="absolute right-2 bottom-2 h-11 w-11 rounded-full bg-accent text-white shadow-xl flex items-center justify-center opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all"><i class="fas fa-play ml-0.5"></i></span>
                </div>
                <div class="font-semibold truncate">${esc(t.title)}</div><div class="text-sm text-gray-400 truncate">${esc(t.artist)}</div></div>`;
        }
        // every shelf is a carousel: arrow buttons + the mouse wheel scrolls it sideways (same as the video rows)
        function shelf(title, cards, more) {
            if (!cards.length) return '';
            const id = 'shelf-' + (++shelfN);
            shelfIds.push(id);
            return `<section class="mb-8"><div class="flex items-end justify-between mb-2 px-1"><h2 class="text-2xl font-bold">${esc(title)}</h2>${more || ''}</div>
                <div class="carousel-container relative">
                    <button class="carousel-btn absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-black/80 to-transparent z-20 flex items-center justify-center text-2xl" onclick="scrollCarousel('${id}', -1)"><i class="fas fa-chevron-left"></i></button>
                    <div id="${id}" class="hscroll flex overflow-x-auto hide-scrollbar relative z-10 -mx-1">${cards.join('')}</div>
                    <button class="carousel-btn absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-l from-black/80 to-transparent z-20 flex items-center justify-center text-2xl" onclick="scrollCarousel('${id}', 1)"><i class="fas fa-chevron-right"></i></button>
                </div></section>`;
        }
        window.addEventListener('resize', () => shelfIds.forEach(updateArrows));
        function renderHome() {
            const f = filtersData || { artists: [], languages: [], genres: [], total: 0 };
            const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
            REGS.home.clear(); shelfIds = [];
            const quick = [];
            const liked = playlists.find(p => p.liked);
            const tile = (cover, name, n, shuffle) => `<div class="group flex items-center gap-4 rounded-md bg-white/[.08] hover:bg-white/[.16] overflow-hidden cursor-pointer transition-colors pr-3" onclick="openSrc(${n})">${cover}<span class="font-bold truncate flex-1">${esc(name)}</span><button class="h-10 w-10 flex-none rounded-full bg-accent flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 transition-opacity" onclick="event.stopPropagation();playSrc(${n},${!!shuffle})"><i class="fas fa-play ml-0.5 text-sm"></i></button></div>`;
            quick.push(tile(likedBox('h-16 w-16 !rounded-none'), 'Liked Songs', reg(liked ? plSrc(liked) : { type: 'playlist', id: -1, key: 'pl:-1', label: 'Playlist', title: 'Liked Songs', liked: true }), false));
            if (forYou && forYou.discover.length) quick.push(tile(tintBox('Discover', 'fa-wand-magic-sparkles', 'h-16 w-16 !rounded-none'), 'Discover mix', reg(recSrc('Discover mix', forYou.discover)), false));
            if (recentTracks.length) quick.push(tile(tintBox('New arrivals', 'fa-clock-rotate-left', 'h-16 w-16 !rounded-none'), 'New arrivals', reg(recentSrc()), false));
            playlists.filter(p => !p.liked).slice(0, 5).forEach(p => quick.push(tile(plCover(p, 'h-16 w-16 !rounded-none'), p.name, reg(plSrc(p)), false)));
            if (f.total) quick.push(tile(tintBox('All songs', 'fa-shuffle', 'h-16 w-16 !rounded-none'), 'Shuffle all songs', reg(allSrc()), true));

            const mixes = [];
            f.languages.filter(l => l.name !== 'Unknown').slice(0, 8).forEach(l => mixes.push(shelfCard(tintBox(l.name + ' mix', 'fa-language text-4xl', 'w-full aspect-square'), l.name + ' mix', `${l.count} songs`, reg(langSrc(l)), true)));
            (f.genres || []).forEach(g => mixes.push(shelfCard(tintBox(g.name, 'fa-compact-disc text-4xl', 'w-full aspect-square'), g.name + ' mix', `${g.count} songs`, reg(genreSrc(g)), true)));
            const pl = playlists.filter(p => !p.liked).map(p => shelfCard(plCover(p, 'w-full aspect-square'), p.name, `${p.count} song${p.count === 1 ? '' : 's'}`, reg(plSrc(p)), false));
            const fresh = recentTracks.slice(0, 20).map((t, i) => trackCard(t, i));
            const arts = f.artists.slice(0, 20).map(a => shelfCard(coverBox([a.sample], 'w-full aspect-square', true), a.name, 'Artist', reg(artistSrc(a)), false));

            $('mv-home').innerHTML = `
                <h1 class="text-3xl font-bold mt-4 mb-5">${greet}</h1>
                ${f.total || playlists.length ? `<div class="grid gap-3 mb-10" style="grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))">${quick.join('')}</div>` : ''}
                ${f.total ? '' : '<div class="border border-dashed border-white/10 rounded-lg p-10 text-center text-gray-500"><i class="fas fa-music text-3xl mb-3 block opacity-40"></i>No music found yet. Put files in media/music and press the refresh icon.</div>'}
                ${recShelves()}
                ${shelf('New arrivals', fresh, '<button onclick="openSrc(' + reg(recentSrc()) + ')" class="text-sm font-bold text-gray-400 hover:text-white transition-colors">Show all</button>')}
                ${shelf('Made for you', mixes)}
                ${shelf('Your playlists', pl, '<button onclick="openNameModal(\'create\')" class="text-sm font-bold text-gray-400 hover:text-white transition-colors">Create new</button><button onclick="showPlaylists()" class="text-sm font-bold text-gray-400 hover:text-white transition-colors ml-4">Show all</button>')}
                ${shelf('Your artists', arts)}`;
            requestAnimationFrame(() => shelfIds.forEach(updateArrows));
        }

        // ---- list header (playlist / artist / mix / search) ----
        function actionsHtml(opts) {
            opts = opts || {};
            const b = (cls, click, icon, text, extra) => `<button onclick="${click}" class="${cls} font-semibold rounded-full px-4 py-2 text-sm transition-colors" ${extra || ''}><i class="fas ${icon} ${text ? 'mr-1.5' : ''} text-xs"></i>${text}</button>`;
            return `<button onclick="playTrack(0)" class="h-14 w-14 rounded-full bg-accent hover:bg-red-600 hover:scale-105 flex items-center justify-center shadow-xl transition-all" title="Play"><i class="fas fa-play ml-0.5 text-lg"></i></button>
                <button onclick="shufflePlayView()" class="h-11 w-11 rounded-full border border-white/25 hover:bg-white/10 flex items-center justify-center transition-colors" title="Shuffle play"><i class="fas fa-shuffle"></i></button>
                ${b('bg-white/10 hover:bg-white/20 add-btn', 'openAddMenu(event, -1)', 'fa-plus', 'Add all to playlist')}
                ${b('bg-white/10 hover:bg-white/20', 'exportList()', 'fa-file-export', 'Export .m3u')}
                ${b('bg-white/10 hover:bg-white/20', 'openLangModal(null)', 'fa-language', 'Set language', 'title="Set the language of every song shown"')}
                ${b('bg-white/10 hover:bg-white/20', 'enterSel()', 'fa-square-check', 'Select songs', 'title="Pick songs to make into an album or add to a playlist"')}
                ${opts.customAlbum ? b('bg-white/10 hover:bg-white/20', "openNameModal('album')", 'fa-pen', 'Rename album') + b('bg-white/10 hover:bg-red-700', 'dissolveAlbum()', 'fa-link-slash', 'Ungroup album', 'title="The songs stay in your library, they just stop being one album"') : ''}
                ${opts.playlist && !opts.liked ? b('bg-white/10 hover:bg-white/20', "openNameModal('rename')", 'fa-pen', 'Rename') + b('bg-white/10 hover:bg-red-700', 'deletePlaylist()', 'fa-trash', 'Delete') : ''}`;
        }
        function totalDuration(list) {
            const s = list.reduce((a, t) => a + (t.duration || 0), 0), h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60);
            return h ? `${h} hr ${m} min` : `${m} min`;
        }
        function renderListHeader() {
            const v = view, src = v.src || {}, h = hue(v.title || src.title || 'x');
            let cover;
            if (v.playlist) cover = v.playlist.liked ? likedBox('h-52 w-52 text-6xl shadow-2xl') : coverBox(viewTracks.slice(0, 4).map(t => t.id), 'h-52 w-52 shadow-2xl');
            else if (src.label === 'Album') cover = coverBox([src.sample || (viewTracks[0] && viewTracks[0].id)], 'h-52 w-52 shadow-2xl');
            else if (src.label === 'Artist') cover = coverBox([src.sample || (viewTracks[0] && viewTracks[0].id)], 'h-52 w-52 shadow-2xl', true);
            else cover = tintBox(src.tint || v.title, (src.icon || 'fa-music') + ' text-6xl', 'h-52 w-52 shadow-2xl');
            const n = viewTracks.length;
            $('mv-list').innerHTML = `
                <div class="px-6 pb-6 pt-8 flex items-end gap-6" style="background:linear-gradient(180deg,hsl(${h} 40% 28% / .85) 0%,transparent 100%)">
                    ${cover}
                    <div class="min-w-0">
                        <div class="text-sm font-bold">${esc(v.playlist ? 'Playlist' : (src.label || 'List'))}</div>
                        <h1 id="list-title" class="font-black leading-tight my-2 break-words" style="font-size:clamp(2rem,4.2vw,4.5rem)" ${v.playlist && !v.playlist.liked ? 'ondblclick="inlineRename()" title="Double-click to rename"' : ''}>${esc(v.title)}</h1>
                        <div class="text-sm text-gray-300">${src.artist ? esc(src.artist) + ' &middot; ' : ''}${n} song${n === 1 ? '' : 's'}${n ? ' &middot; ' + totalDuration(viewTracks) : ''}${v.missing ? ` &middot; ${v.missing} missing file${v.missing === 1 ? '' : 's'} hidden` : ''}</div>
                    </div>
                </div>
                <div class="px-6 py-4 flex flex-wrap items-center gap-3">${actionsHtml({ playlist: !!v.playlist, liked: v.playlist && v.playlist.liked, customAlbum: !!(src.label === 'Album' && src.custom) })}</div>`;
        }
        function inlineRename() {
            const h = $('list-title'); if (!h || !view.playlist || view.playlist.liked || h.querySelector('input')) return;
            const old = view.playlist.name, inp = document.createElement('input');
            inp.value = old; inp.maxLength = 60; inp.className = 'bg-transparent border-b-2 border-white/40 outline-none w-full font-black';
            inp.style.fontSize = 'inherit';
            h.textContent = ''; h.appendChild(inp); inp.focus(); inp.select();
            let done = false;
            const finish = async save => {
                if (done) return; done = true;
                const name = inp.value.trim();
                if (save && name && name !== old) {
                    try { const p = await post('/api/playlists/' + view.playlist.id + '/rename', { name }); view.playlist.name = p.name; view.title = p.name; await loadPlaylists(); }
                    catch (e) { toast(errMsg(e)); }
                }
                renderListHeader();
            };
            inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
            inp.addEventListener('blur', () => finish(true));
        }
        let dragFrom = -1;
        function dragStartRow(e, i) { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch (x) {} e.currentTarget.classList.add('opacity-40'); }
        function dragOverRow(e) { if (dragFrom < 0) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; document.querySelectorAll('#tracklist tr.drop-at').forEach(r => r.classList.remove('drop-at')); e.currentTarget.classList.add('drop-at'); }
        async function dropRow(e, to) {
            e.preventDefault();
            const from = dragFrom; dragFrom = -1;
            if (from < 0 || from === to || !view.playlist) { renderTracks(); return; }
            const [t] = viewTracks.splice(from, 1); viewTracks.splice(to, 0, t);
            renderTracks();
            try { await post('/api/playlists/' + view.playlist.id + '/reorder', { ids: viewTracks.map(x => x.id) }); }
            catch (err) { toast(errMsg(err)); }
        }
        function renderGenBar() {
            const on = viewTracks.length > 0;
            show('gen-bar', on, true);
            $('gen-bar').innerHTML = on ? `<div class="font-bold text-lg"><span class="text-gray-300">${view.mode === 'all' ? 'Matches' : 'Mix'}</span> <span class="text-gray-400 font-normal text-base">&middot; ${viewTracks.length} song${viewTracks.length === 1 ? '' : 's'}</span></div><div class="flex flex-wrap items-center gap-3">${actionsHtml()}</div>` : '';
            show('m-table-wrap', viewTracks.length > 0);
        }

        // ---- the track table ----
        const heartHtml = id => `<button data-heart="${id}" class="h-8 w-8 rounded-full hover:bg-white/15 transition-colors ${likedIds.has(id) ? '' : 'text-gray-400 hover:text-white'}" title="${likedIds.has(id) ? 'Remove from Liked Songs' : 'Save to Liked Songs'}" onclick="toggleLike(event,'${id}')"><i class="${likedIds.has(id) ? 'fas text-accent' : 'far'} fa-heart"></i></button>`;
        function langChip(t, i) {
            const unknown = t.language === 'Unknown';
            const tip = (SRC_LABEL[t.lang_src] || 'not detected yet') + '. Click to change.';
            return `<button class="px-2 py-0.5 rounded-full border text-xs ${unknown ? 'border-white/10 text-gray-500' : 'border-white/25 text-gray-200'} hover:border-accent hover:text-white transition-colors" title="${esc(tip)}" onclick="event.stopPropagation(); openLangModal([viewTracks[${i}].id])">${esc(t.language)}${t.also ? ' <span class="text-gray-500">+ ' + esc(t.also) + '</span>' : ''}</button>`;
        }
        function renderTracks(emptyMsg) {
            const inPlaylist = !!(view.kind === 'list' && view.playlist);
            $('tracklist').innerHTML = viewTracks.length ? viewTracks.map((t, i) => `
                <tr class="tr-row group hover:bg-white/10 transition-colors cursor-pointer rounded${selIds.has(t.id) ? ' sel-on' : ''}" data-index="${i}" data-id="${t.id}" onclick="rowClick(event, ${i})" ${inPlaylist && !selMode ? `draggable="true" ondragstart="dragStartRow(event, ${i})" ondragover="dragOverRow(event)" ondrop="dropRow(event, ${i})" ondragend="dragFrom = -1; renderTracks()"` : ''}>
                    <td class="py-2 px-3 text-gray-400 group-hover:text-white w-12">
                        <span class="sel-box ${selIds.has(t.id) ? 'on' : ''}"><i class="fas fa-check"></i></span>
                        <span class="num block group-hover:hidden">${i + 1}</span>
                        <i class="fas fa-play hidden group-hover:block text-white"></i>
                    </td>
                    <td class="py-2 px-3">
                        <div class="flex items-center gap-3 min-w-0">
                            <div class="relative h-11 w-11 flex-none rounded bg-lm-card flex items-center justify-center overflow-hidden">
                                <i class="fas fa-music text-gray-600 text-xs"></i>${coverImg(t.id)}
                            </div>
                            <div class="min-w-0">
                                <div class="title-cell font-semibold text-white truncate">${esc(t.title)}${isNewTrack(t) ? ' <span class="ml-1 align-middle text-[9px] font-black bg-accent text-white rounded px-1.5 py-0.5 tracking-wider">NEW</span>' : ''}</div>
                                <div class="text-xs text-gray-400 truncate"><span class="hover:underline hover:text-white" onclick="event.stopPropagation(); openArtistByName(${esc(JSON.stringify(t.primary))})">${esc(t.artist)}</span></div>
                            </div>
                        </div>
                    </td>
                    <td class="py-2 px-3 hidden lg:table-cell text-gray-400 truncate max-w-[14rem]" ${t.custom_album ? 'title="An album you made yourself"' : ''}>${esc(t.album)}${t.custom_album ? ' <i class="fas fa-compact-disc text-[10px] opacity-60"></i>' : ''}</td>
                    <td class="py-2 px-3 hidden sm:table-cell">${langChip(t, i)}</td>
                    <td class="py-1 px-2 text-right whitespace-nowrap">
                        ${heartHtml(t.id)}
                        <button class="add-btn h-8 w-8 rounded-full text-gray-400 hover:text-white hover:bg-white/15 transition-colors" title="Add to playlist" onclick="openAddMenu(event, ${i})"><i class="fas fa-plus"></i></button>
                        ${inPlaylist ? `<button class="h-8 w-8 rounded-full text-gray-400 hover:text-white hover:bg-white/15 transition-colors" title="Remove from this playlist" onclick="removeFromPlaylist(event, ${i})"><i class="fas fa-xmark"></i></button>` : ''}
                    </td>
                    <td class="py-2 px-3 text-gray-400 text-center">${fmtTime(t.duration)}</td>
                </tr>`).join('')
                : `<tr><td colspan="6" class="p-10 text-center text-gray-500">${esc(emptyMsg || (view.kind === 'list' && view.playlist ? 'This playlist is empty. Use the + button on any song to add it here.' : 'No tracks match.'))}</td></tr>`;
            highlightCurrent();
        }
        function highlightCurrent() {
            document.querySelectorAll('#tracklist tr[data-index]').forEach(tr => {
                const active = tr.dataset.id === nowId;
                tr.classList.toggle('playing', active);
                const num = tr.querySelector('.num');
                if (num) num.innerHTML = active ? `<span class="eq ${audio.paused ? 'paused' : ''}"><i></i><i></i><i></i></span>` : String(Number(tr.dataset.index) + 1);
            });
        }
        async function openArtistByName(name) {
            const a = filtersData && filtersData.artists.find(x => x.name === name);
            openSource(artistSrc(a || { name }));
        }
        function openNowArtist() { const t = curTrack(); if (t) openArtistByName(t.primary); }

        // ---- select songs: make into album / add to playlist ----
        let selMode = false, selIds = new Set(), selLast = -1;
        const selectedIds = () => viewTracks.filter(t => selIds.has(t.id)).map(t => t.id);      // in list order
        function enterSel() {
            if (!viewTracks.length) return;
            selMode = true; selIds = new Set(); selLast = -1;
            document.body.classList.add('sel-mode');
            renderTracks(); paintSel();
            toast('Click songs to select them. Shift-click selects a range.', 3200);
        }
        function exitSel(quiet) {
            if (!selMode && !selIds.size) return;
            selMode = false; selIds = new Set(); selLast = -1;
            document.body.classList.remove('sel-mode');
            const bar = $('sel-bar'); if (bar) bar.classList.remove('on');
            if (!quiet) renderTracks();
        }
        function rowClick(event, i) { if (!selMode) { playTrack(i); return; } toggleSel(i, event && event.shiftKey); }
        function toggleSel(i, range) {
            const t = viewTracks[i]; if (!t) return;
            if (range && selLast >= 0) {
                const on = !selIds.has(t.id);
                for (let k = Math.min(selLast, i); k <= Math.max(selLast, i); k++) { if (on) selIds.add(viewTracks[k].id); else selIds.delete(viewTracks[k].id); }
            } else if (selIds.has(t.id)) selIds.delete(t.id); else selIds.add(t.id);
            selLast = i; paintSel();
        }
        function selAll() { viewTracks.forEach(t => selIds.add(t.id)); paintSel(); }
        function selNone() { selIds.clear(); selLast = -1; paintSel(); }
        function paintSel() {
            document.querySelectorAll('#tracklist tr[data-id]').forEach(tr => {
                const on = selIds.has(tr.dataset.id);
                tr.classList.toggle('sel-on', on);
                const bx = tr.querySelector('.sel-box'); if (bx) bx.classList.toggle('on', on);
            });
            const bar = $('sel-bar'); if (!bar) return;
            bar.classList.toggle('on', selMode);
            const n = selIds.size;
            $('sel-n').textContent = n;
            $('sel-word').textContent = n === 1 ? 'song selected' : 'songs selected';
            const inAlbum = viewTracks.some(t => selIds.has(t.id) && t.custom_album);
            $('sel-remove').classList.toggle('hidden', !inAlbum);
            bar.querySelectorAll('[data-need]').forEach(b => { b.disabled = !n; });
        }
        function selAddToPlaylist(event) { if (selIds.size) openAddMenu(event, -2); }
        async function selRemoveFromAlbum() {
            const ids = selectedIds().filter(id => (viewTracks.find(t => t.id === id) || {}).custom_album);
            if (!ids.length) return;
            try {
                await post('/api/music/albums/remove', { ids });
                toast(`Took ${ids.length} song${ids.length === 1 ? '' : 's'} out of the album`);
                exitSel(true); await afterAlbumChange();
            } catch (e) { toast(errMsg(e)); }
        }
        async function afterAlbumChange() {
            const top = $('m-main') ? $('m-main').scrollTop : 0;
            await Promise.all([loadAlbums(), loadMusicFilters()]);
            if (view.kind === 'list' && view.src) { await openSource(view.src); if ($('m-main')) $('m-main').scrollTop = top; }
        }
        function openAlbumModal() {
            const ids = selectedIds(); if (!ids.length) { toast('Select some songs first.'); return; }
            const sel = viewTracks.filter(t => selIds.has(t.id));
            const top = arr => { const c = {}; arr.forEach(x => { if (x) c[x] = (c[x] || 0) + 1; }); return Object.keys(c).sort((a, b) => c[b] - c[a]); };
            const artists = top(sel.map(t => t.primary)), tags = top(sel.map(t => t.album));
            $('album-modal-sub').textContent = `${ids.length} song${ids.length === 1 ? '' : 's'} will become one album. Your files and their tags are not changed.`;
            $('album-name').value = tags.length === 1 && !sel.some(t => !t.album) ? tags[0] : '';
            $('album-artist').value = artists.length <= 1 ? (artists[0] || '') : (sel.length && (artists[0] && sel.filter(t => t.primary === artists[0]).length / sel.length >= 0.6) ? artists[0] : 'Various Artists');
            const own = (albumsData || []).filter(a => a.custom || artists.includes(a.artist)).map(a => a.name);
            $('album-names').innerHTML = [...new Set([...own, ...tags])].map(n => `<option value="${esc(n)}">`).join('');
            $('album-order').value = 'listed'; $('album-error').textContent = '';
            show('album-modal', true, true);
            setTimeout(() => { $('album-name').focus(); $('album-name').select(); }, 30);
        }
        function closeAlbumModal() { show('album-modal', false, true); }
        async function saveAlbum() {
            const name = $('album-name').value.trim();
            if (!name) { $('album-error').textContent = 'Give the album a name.'; return; }
            const ids = selectedIds();
            try {
                const r = await post('/api/music/albums/create', { ids, name, artist: $('album-artist').value.trim(), order: $('album-order').value });
                closeAlbumModal(); exitSel(true);
                toast(`Made "${r.name}" by ${r.artist} from ${r.count} song${r.count === 1 ? '' : 's'}. Find it under Albums.`, 4500);
                await afterAlbumChange();
            } catch (e) { $('album-error').textContent = errMsg(e); }
        }
        async function dissolveAlbum() {
            if (!(view.src && view.src.custom)) return;
            if (!confirm(`Ungroup the album "${view.title}"? The songs stay in your library, they just stop being one album.`)) return;
            try {
                await post('/api/music/albums/dissolve', { key: view.src.filter.album });
                toast('Album ungrouped'); await loadAlbums(); await loadMusicFilters(); showAlbums();
            } catch (e) { toast(errMsg(e)); }
        }
        window.addEventListener('keydown', e => { if (e.key === 'Escape' && selMode && $('album-modal').classList.contains('hidden')) { e.stopPropagation(); exitSel(); } }, true);

        // ---- likes ----
        async function loadLikes() { try { likedIds = new Set((await api('/api/likes')).ids); paintHearts(); } catch (e) { console.error(e); } }
        function paintHearts() {
            document.querySelectorAll('[data-heart]').forEach(b => {
                const on = likedIds.has(b.dataset.heart);
                b.innerHTML = `<i class="${on ? 'fas text-accent' : 'far'} fa-heart"></i>`;
                b.classList.toggle('text-gray-400', !on);
                b.title = on ? 'Remove from Liked Songs' : 'Save to Liked Songs';
            });
        }
        async function toggleLike(event, id) {
            if (event) event.stopPropagation();
            const want = !likedIds.has(id);
            if (want) likedIds.add(id); else likedIds.delete(id);
            paintHearts();
            try {
                await post('/api/likes', { id, liked: want });
                await loadPlaylists();
                if (view.kind === 'list' && view.playlist && view.playlist.liked) { const lp = playlists.find(p => p.liked); if (lp) openPlaylist(lp.id); }
            } catch (e) {
                if (want) likedIds.delete(id); else likedIds.add(id);
                paintHearts(); toast(errMsg(e));
            }
        }

        // ---- filters / language detection (Mix generator) ----
        function fillFilters(f) {
            filtersData = f; lastFilters = f;
            const sel = $('pl-language'), keep = sel.value;
            sel.innerHTML = '<option value="any">Any Language</option>' +
                f.languages.map(l => `<option value="${esc(l.name)}">${esc(l.name)} (${l.count})</option>`).join('');
            sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'any';
            artistByLabel = {};
            $('artist-list').innerHTML = f.artists.map(a => {
                const label = `${a.name}  (${a.count})`;
                artistByLabel[label] = a.name;
                return `<option value="${esc(label)}">`;
            }).join('');
            knownLanguages = f.languages.map(l => l.name).filter(n => n !== 'Unknown');
            renderLibrary();
            if (view.kind === 'home') renderHome();
        }
        function updateLangUI(f) {
            const job = f.job || {};
            let txt;
            if (job.running) txt = job.message || 'Working...';
            else if (!f.total) txt = f.scanning ? 'Indexing your music...' : 'No music found yet.';
            else txt = `${f.from_lyrics} of ${f.total} songs have a detected or manual language` + (f.unknown ? `, ${f.unknown} unknown.` : '.');
            if (!job.running && job.message && job.message !== 'Done.' && job.message !== 'Starting...') txt += ' ' + job.message;
            $('lang-status').textContent = txt;
            $('lang-btn').disabled = !!job.running || !f.total;
            show('lang-stop', !!job.running);
            const warn = $('lang-warn');
            warn.classList.toggle('hidden', f.langdetect);
            if (!f.langdetect) warn.textContent = 'The language library (langdetect) is not installed, so only Japanese, Korean, Chinese, Russian, Arabic and Thai can be detected. Re-run build_exe.bat, or run: pip install langdetect';
            if (job.running && !langTimer) langTimer = setInterval(pollLang, 1000);
        }
        async function loadMusicFilters() {
            try { const f = await api('/api/music/filters'); fillFilters(f); updateLangUI(f); if (f.scanning) setTimeout(loadMusicFilters, 3000); } catch (e) { console.error(e); }
        }
        async function pollLang() {
            try {
                const f = await api('/api/music/filters');
                updateLangUI(f);
                if (!f.job.running) { clearInterval(langTimer); langTimer = null; fillFilters(f); }
            } catch (e) { clearInterval(langTimer); langTimer = null; }
        }
        async function startLang() {
            try {
                await post('/api/music/lang/start', { online: $('lang-online').checked });
                $('lang-status').textContent = 'Starting...';
                $('lang-btn').disabled = true; show('lang-stop', true);
                if (!langTimer) langTimer = setInterval(pollLang, 1000);
            } catch (e) { toast(errMsg(e), 5000); }
        }
        async function stopLang() { try { await post('/api/music/lang/cancel'); } catch (e) { console.error(e); } }
        async function testLang() {
            toast('Testing the lyrics lookup...', 15000);
            try { const d = await post('/api/music/lang/test'); toast(d.message, 6000); } catch (e) { toast(errMsg(e), 6000); }
        }
        function musicOpened() {
            loadMusicFilters(); loadPlaylists(); loadLikes(); loadRecent(); loadForYou(); loadAlbums();
            if (!musicReady) { musicReady = true; showHome(); }
        }
        function artistParams() {
            const raw = $('pl-artist').value.trim();
            if (!raw || raw.toLowerCase() === 'all') return {};
            if (artistByLabel[raw]) return { artist: artistByLabel[raw] };
            const exact = Object.values(artistByLabel).find(n => n.toLowerCase() === raw.toLowerCase());
            return exact ? { artist: exact } : { artist_text: raw };
        }
        function resetFilters() { $('pl-language').value = 'any'; $('pl-genre').value = 'mix'; $('pl-artist').value = ''; $('pl-search').value = ''; }

        async function generatePlaylist(mode) {
            mode = mode || 'mix';
            const btns = [$('pl-generate'), $('pl-all')];
            btns.forEach(b => { b.disabled = true; });
            try {
                const body = Object.assign({ mode, language: $('pl-language').value, genre: $('pl-genre').value,
                                             q: $('pl-search').value.trim(), limit: Number($('pl-limit').value) || 20 }, artistParams());
                const d = await post('/api/playlist', body);
                view = { kind: 'gen', mode };
                viewTracks = d.tracks; errorStreak = 0;
                let msg = '';
                if (d.tracks.length) {
                    msg = mode === 'all'
                        ? `${d.total_matches} matching song${d.total_matches === 1 ? '' : 's'}` + (d.total_matches > d.tracks.length ? ` (showing the first ${d.tracks.length})` : '') + '.'
                        : `Mix of ${d.tracks.length} from ${d.total_matches} matching tracks.`;
                } else if (!d.library_size) {
                    msg = 'No music found. Put files in media/music and press the refresh icon.';
                } else {
                    msg = 'No songs match those filters.';
                    if (lastFilters && lastFilters.from_lyrics === 0 && body.language !== 'any') msg += ' Tip: press "Detect languages" first so songs can be sorted by language.';
                }
                if (d.scanning) msg += ' (Music library is still being indexed, try again in a moment for more results.)';
                $('pl-status').textContent = msg;
                renderTracks(msg); renderGenBar();
                if (mode === 'mix' && viewTracks.length) playTrack(0);
            } catch (e) {
                $('pl-status').textContent = 'Could not load songs: ' + errMsg(e);
            }
            btns.forEach(b => { b.disabled = false; });
        }

        // ---- saved playlists ----
        async function loadPlaylists() {
            try { playlists = await api('/api/playlists'); renderLibrary(); if (view.kind === 'home') renderHome(); } catch (e) { console.error(e); }
        }
        async function removeFromPlaylist(event, i) {
            event.stopPropagation();
            const t = viewTracks[i];
            if (!t || !view.playlist) return;
            try {
                await post('/api/playlists/' + view.playlist.id + '/remove', { id: t.id });
                viewTracks.splice(i, 1);
                renderTracks(); renderListHeader();
                if (view.playlist.liked) { likedIds.delete(t.id); paintHearts(); }
                loadPlaylists();
            } catch (e) { toast(errMsg(e)); }
        }
        async function deletePlaylist() {
            if (!view.playlist || view.playlist.liked) return;
            if (!confirm(`Delete the playlist "${view.playlist.name}"? Your music files are not touched.`)) return;
            try {
                await post('/api/playlists/' + view.playlist.id + '/delete');
                await loadPlaylists(); showHome();
            } catch (e) { toast(errMsg(e)); }
        }

        // ---- add to playlist (popup menu) ----
        function openAddMenu(event, i) {
            event.stopPropagation();
            pendingIds = i === -2 ? selectedIds() : i < 0 ? viewTracks.map(t => t.id) : (viewTracks[i] ? [viewTracks[i].id] : []);
            if (!pendingIds.length) return;
            const n = pendingIds.length;
            $('pl-menu').innerHTML = `<div class="px-4 py-2 text-xs uppercase tracking-wider text-gray-500 font-semibold">Add ${n === 1 ? 'song' : n + ' songs'} to</div>` +
                playlists.filter(p => !p.liked).map(p => `<button onclick="addToPlaylist(${p.id})" class="w-full text-left px-4 py-2 hover:bg-white/10 flex items-center justify-between gap-3"><span class="truncate"><i class="fas fa-list-ul w-5 text-gray-500"></i>${esc(p.name)}</span><span class="text-xs text-gray-500">${p.count}</span></button>`).join('') +
                `<div class="border-t border-white/10 my-1"></div><button onclick="openNameModal('create')" class="w-full text-left px-4 py-2 hover:bg-white/10"><i class="fas fa-plus w-5 text-accent"></i>New playlist...</button>`;
            const menu = $('pl-menu'), r = event.currentTarget.getBoundingClientRect();
            menu.classList.remove('hidden');
            const w = menu.offsetWidth, h = menu.offsetHeight;
            menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
            menu.style.top = Math.max(8, (r.bottom + h + 8 > window.innerHeight) ? r.top - h - 4 : r.bottom + 4) + 'px';
        }
        function closeAddMenu() { $('pl-menu').classList.add('hidden'); }
        document.addEventListener('click', e => { if (!e.target.closest('#pl-menu')) closeAddMenu(); });
        async function addToPlaylist(pid) {
            closeAddMenu();
            try {
                const d = await post('/api/playlists/' + pid + '/add', { ids: pendingIds });
                toast(d.added ? `Added ${d.added} song${d.added === 1 ? '' : 's'} to "${d.name}"` + (d.already_in ? ` (${d.already_in} already in it)` : '') : `Already in "${d.name}"`);
                await loadPlaylists();
                if (view.kind === 'list' && view.playlist && view.playlist.id === pid) openPlaylist(pid);
            } catch (e) { toast(errMsg(e)); }
        }

        // ---- create / rename playlist ----
        function openNameModal(mode) {
            closeAddMenu();
            nameMode = mode;
            const rename = mode === 'rename', album = mode === 'album';
            $('name-title').textContent = album ? 'Rename album' : rename ? 'Rename playlist' : 'New playlist';
            $('name-input').placeholder = album ? 'Album name' : 'Playlist name';
            $('name-sub').textContent = album ? 'Only the album name changes. Your files are not touched.' : rename ? '' : (pendingIds.length ? `${pendingIds.length} song${pendingIds.length === 1 ? '' : 's'} will be added to it.` : 'You can add songs with the + button.');
            $('name-input').value = album ? view.title : rename && view.playlist ? view.playlist.name : '';
            $('name-error').textContent = '';
            show('name-modal', true, true);
            setTimeout(() => { $('name-input').focus(); $('name-input').select(); }, 30);
        }
        function closeNameModal() { show('name-modal', false, true); if (nameMode === 'create') pendingIds = []; }
        async function saveName() {
            const name = $('name-input').value.trim();
            if (!name) { $('name-error').textContent = nameMode === 'album' ? 'Give the album a name.' : 'Give the playlist a name.'; return; }
            try {
                if (nameMode === 'album') {
                    const r = await post('/api/music/albums/rename', { key: view.src.filter.album, name });
                    show('name-modal', false, true);
                    await loadAlbums();
                    openSource(Object.assign({}, view.src, { filter: { album: r.key }, key: 'al:' + r.key, title: r.name, artist: r.artist }));
                    toast(`Renamed to "${r.name}"`);
                } else if (nameMode === 'rename') {
                    const p = await post('/api/playlists/' + view.playlist.id + '/rename', { name });
                    view.playlist.name = p.name; view.title = p.name;
                    show('name-modal', false, true);
                    await loadPlaylists(); renderListHeader();
                } else {
                    const p = await post('/api/playlists', { name });
                    const ids = pendingIds; pendingIds = [];
                    show('name-modal', false, true);
                    if (ids.length) { const d = await post('/api/playlists/' + p.id + '/add', { ids }); toast(`Created "${p.name}" with ${d.added} song${d.added === 1 ? '' : 's'}`); }
                    else toast(`Created "${p.name}"`);
                    await loadPlaylists();
                    if (!ids.length) openPlaylist(p.id);
                }
            } catch (e) { $('name-error').textContent = errMsg(e); }
        }

        // ---- set language by hand ----
        function openLangModal(ids) {
            langIds = ids || viewTracks.map(t => t.id);
            if (!langIds.length) return;
            const one = langIds.length === 1 ? viewTracks.find(t => t.id === langIds[0]) : null;
            $('lang-modal-sub').textContent = one ? `"${one.title}"` : `This changes ${langIds.length} song${langIds.length === 1 ? '' : 's'} (everything shown).`;
            $('lang-choices').innerHTML = [...new Set(['English', 'Filipino', 'Spanish', 'Japanese', 'Korean', 'Chinese', 'Instrumental', ...knownLanguages])].map(l => `<option value="${esc(l)}">`).join('');
            $('lang-input').value = one && one.lang_src === 'manual' ? one.language : '';
            $('lang-modal-error').textContent = '';
            show('lang-modal', true, true);
            setTimeout(() => $('lang-input').focus(), 30);
        }
        function closeLangModal() { show('lang-modal', false, true); }
        async function saveLang(remove) {
            const language = remove ? '' : $('lang-input').value.trim();
            if (!remove && !language) { $('lang-modal-error').textContent = 'Type a language, or use "Remove my setting".'; return; }
            try {
                const d = await post('/api/music/language', { ids: langIds, language });
                const byId = {}; d.tracks.forEach(t => { byId[t.id] = t; });
                viewTracks = viewTracks.map(t => byId[t.id] ? Object.assign({}, t, { language: byId[t.id].language, also: byId[t.id].also, lang_src: byId[t.id].lang_src }) : t);
                closeLangModal();
                renderTracks();
                toast(remove ? 'Manual language removed' : `Language set to ${language.charAt(0).toUpperCase() + language.slice(1)} for ${d.updated} song${d.updated === 1 ? '' : 's'}`);
                loadMusicFilters();
            } catch (e) { $('lang-modal-error').textContent = errMsg(e); }
        }

        // ---- export ----
        async function exportList() {
            if (!viewTracks.length) return;
            const name = view.playlist ? view.playlist.name : (view.title || 'Music Mix');
            try {
                const d = await post('/api/music/export', { ids: viewTracks.map(t => t.id), name });
                if (d.mode === 'saved') toast(`Saved ${d.count} songs to ${d.path}`, 6000);
                else if (d.mode === 'download') {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(new Blob([d.content], { type: 'audio/x-mpegurl' }));
                    a.download = d.filename;
                    document.body.appendChild(a); a.click();
                    const href = a.href; a.remove(); setTimeout(() => URL.revokeObjectURL(href), 3000);
                    toast(`Exported ${d.count} songs as ${d.filename}`);
                }
            } catch (e) { toast(errMsg(e), 5000); }
        }

        // ---- the player: queue, shuffle, repeat ----
        const curTrack = () => (pos >= 0 && order[pos] != null) ? queue[order[pos]] : null;
        function shuffledOrder(first) {
            const rest = queue.map((_, i) => i).filter(i => i !== first);
            for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
            return [first].concat(rest);
        }
        function paintModes() {
            $('b-shuffle').classList.toggle('text-accent', shuffleOn); $('b-shuffle').classList.toggle('text-gray-400', !shuffleOn);
            const r = $('b-repeat');
            r.classList.toggle('text-accent', repeatMode !== 'off'); r.classList.toggle('text-gray-400', repeatMode === 'off');
            r.innerHTML = repeatMode === 'one' ? '<i class="fas fa-repeat"></i><span class="absolute -top-1.5 -right-2 text-[9px] font-black">1</span>' : '<i class="fas fa-repeat"></i>';
            r.title = 'Repeat: ' + repeatMode;
        }
        function toggleShuffle() {
            shuffleOn = !shuffleOn;
            if (queue.length && pos >= 0) { const cur = order[pos]; order = shuffleOn ? shuffledOrder(cur) : queue.map((_, i) => i); pos = order.indexOf(cur); }
            paintModes(); renderQueue();
        }
        function cycleRepeat() { repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'; paintModes(); }
        function playList(list, index, forceShuffle) {
            if (!list.length) return;
            if (forceShuffle !== undefined) shuffleOn = forceShuffle;
            queue = list.slice(); index = index || 0;
            order = shuffleOn ? shuffledOrder(index) : queue.map((_, i) => i);
            pos = order.indexOf(index);
            errorStreak = 0;
            startCurrent(); paintModes();
        }
        function playTrack(i) { if (i >= 0 && i < viewTracks.length) playList(viewTracks, i); }
        function shufflePlayView() { if (viewTracks.length) playList(viewTracks, Math.floor(Math.random() * viewTracks.length), true); }
        // Songs sometimes began at 0:32 or another random spot. Whatever the cause, a track that nobody seeked must start at 0.
        // Brute force: a few files jump to 0:37 (or some random spot) on their own and snap back there even if you drag to 0.
        // 1) any jump nobody asked for in the first seconds is undone, 2) a seek to the start that does not stick is retried,
        // 3) if the file still refuses, it is reloaded (with #t=0, then as an in-memory copy) and started again from zero.
        let userSeek = false, startChecked = false, zeroLeft = 0, zeroUntil = 0, lastT = 0, fbStage = 0, blobUrl = null;
        function armZero() { userSeek = false; startChecked = false; zeroLeft = 6; zeroUntil = performance.now() + 9000; lastT = 0; fbStage = 0; }
        function clamp0() {
            if (zeroLeft <= 0) { stuckFallback(0); return; }
            zeroLeft--; try { audio.currentTime = 0; } catch (e) {}
        }
        function stuckFallback(target) {
            const t = curTrack();
            if (!t || fbStage >= 2) return;
            fbStage++;
            const wasPlaying = !audio.paused || audio.readyState < 3;
            const done = () => { try { audio.currentTime = target; } catch (e) {} zeroLeft = 3; zeroUntil = performance.now() + 6000; lastT = target; if (wasPlaying) audio.play().catch(() => {}); };
            const reload = src => { audio.src = src; audio.addEventListener('loadedmetadata', done, { once: true }); audio.load(); };
            if (fbStage === 1) reload(t.url.split('#')[0] + '#t=' + (target || 0.001));
            else fetch(t.url).then(r => r.blob()).then(b => {
                if (curTrack() !== t) return;
                if (blobUrl) URL.revokeObjectURL(blobUrl);
                blobUrl = URL.createObjectURL(b); reload(blobUrl);
            }).catch(() => {});
        }
        // seeking by hand: if the player ignores a seek to the start (or throws you back), try again, then reload
        function userSeekTo(sec, attempt) {
            attempt = attempt || 0; userSeek = true;
            try { audio.currentTime = sec; } catch (e) {}
            if (sec > 1.5) return;
            const asked = performance.now();
            setTimeout(() => {
                if (!userSeek || audio.paused && audio.currentTime <= sec + 1.5) return;
                const expected = sec + (performance.now() - asked) / 1000 + 1.2;
                if (audio.currentTime > expected) { if (attempt < 3) userSeekTo(sec, attempt + 1); else stuckFallback(sec); }
            }, 700);
        }
        ['loadedmetadata', 'loadeddata', 'canplay'].forEach(ev => audio.addEventListener(ev, () => { if (!userSeek && audio.currentTime > 0.5) clamp0(); }));
        audio.addEventListener('playing', () => { if (!startChecked) { startChecked = true; if (!userSeek && audio.currentTime > 1.5) clamp0(); } });
        audio.addEventListener('timeupdate', () => {
            const t = audio.currentTime;
            if (!userSeek && performance.now() < zeroUntil && t - lastT > 1.5) clamp0();      // a jump forward nobody asked for
            lastT = t;
        });
        function startCurrent() {
            const t = curTrack();
            if (!t) return;
            if (playingId && !miniMode) return;                           // a full-screen video: never start music underneath it
            if (playingId) player.pause();                                // mini player: the song takes over
            flushPlay();
            nowId = t.id;
            playLog = { id: t.id, max: 0, dur: t.duration || 0 };
            armZero();
            if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
            audio.src = t.url;
            audio.play().catch(() => {});
            $('np-title').textContent = t.title;
            $('np-artist').textContent = t.artist;
            $('np-cover').src = t.cover;
            $('np-heart').innerHTML = heartHtml(t.id);
            $('audio-bar').classList.remove('hidden'); $('audio-bar').classList.add('flex');
            document.documentElement.style.setProperty('--bar-h', '5.5rem');
            $('main').classList.add('pb-28');
            highlightCurrent(); renderQueue(); setupMediaSession('music');
        }
        function togglePlay() { if (!nowId || (playingId && !miniMode)) return; if (playingId && audio.paused) player.pause(); if (audio.paused) audio.play().catch(() => {}); else audio.pause(); }
        function nextTrack(auto) {
            if (!queue.length) return;
            if (pos + 1 < order.length) pos++;
            else if (repeatMode === 'all') { order = shuffleOn ? shuffledOrder(Math.floor(Math.random() * queue.length)) : queue.map((_, i) => i); pos = 0; }
            else { if (auto) { audio.pause(); } return; }
            startCurrent();
        }
        function prevTrack() { if (audio.currentTime > 3 || pos <= 0) userSeekTo(0); else { pos--; startCurrent(); } }
        function jumpTo(p) { pos = p; startCurrent(); }
        audio.addEventListener('ended', () => { errorStreak = 0; if (repeatMode === 'one') { userSeekTo(0); audio.play().catch(() => {}); } else nextTrack(true); });
        audio.addEventListener('playing', () => { errorStreak = 0; });
        audio.addEventListener('error', () => { if (++errorStreak < 5) nextTrack(true); });
        audio.addEventListener('play', () => {
            if (playingId && !player.paused) { audio.pause(); return; }   // a video is playing: it keeps the sound
            $('play-icon').className = 'fas fa-pause'; highlightCurrent();
        });
        audio.addEventListener('pause', () => { $('play-icon').className = 'fas fa-play ml-0.5'; highlightCurrent(); });
        audio.addEventListener('loadedmetadata', () => { $('t-dur').textContent = fmtTime(audio.duration); });
        audio.addEventListener('timeupdate', () => {
            $('t-cur').textContent = fmtTime(audio.currentTime);
            if (!seeking && audio.duration) { $('seek').value = Math.round(audio.currentTime / audio.duration * 1000); paintRange($('seek')); }
        });
        $('seek').addEventListener('input', () => { userSeek = true; paintRange($('seek')); seeking = true; $('t-cur').textContent = fmtTime($('seek').value / 1000 * (audio.duration || 0)); });
        $('seek').addEventListener('change', () => { if (audio.duration) userSeekTo($('seek').value / 1000 * audio.duration); seeking = false; });
        $('vol').addEventListener('input', () => { audio.volume = $('vol').value / 100; audio.muted = false; paintAudioVol(); });
        function toggleAudioMute() { audio.muted = !audio.muted; paintAudioVol(); }
        function paintRange(el) { el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%'); }
        function paintAudioVol() { paintRange($('vol')); const v = audio.muted ? 0 : audio.volume; $('a-vol-icon').className = 'fas text-sm w-4 ' + (v === 0 ? 'fa-volume-xmark' : v < 0.4 ? 'fa-volume-low' : 'fa-volume-high'); }

        // ---- queue panel ----
        function toggleQueue() { $('queue-panel').classList.toggle('hidden'); renderQueue(); }
        function closeQueue() { $('queue-panel').classList.add('hidden'); }
        function renderQueue() {
            if ($('queue-panel').classList.contains('hidden')) return;
            const t = curTrack();
            const item = (tr, p, now) => `<button class="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-white/10 text-left transition-colors" onclick="jumpTo(${p})"><div class="relative h-10 w-10 flex-none rounded bg-lm-card overflow-hidden flex items-center justify-center"><i class="fas fa-music text-gray-600 text-xs"></i>${coverImg(tr.id)}</div><div class="min-w-0"><div class="text-sm font-semibold truncate ${now ? 'text-accent' : ''}">${esc(tr.title)}</div><div class="text-xs text-gray-400 truncate">${esc(tr.artist)}</div></div></button>`;
            const next = order.slice(pos + 1, pos + 41).map((qi, k) => item(queue[qi], pos + 1 + k, false)).join('');
            $('queue-panel').innerHTML = t ? `<div class="px-2 pt-1 pb-1 text-xs font-bold text-gray-400">Now playing</div>${item(t, pos, true)}
                <div class="px-2 pt-3 pb-1 text-xs font-bold text-gray-400">Next up</div>${next || '<div class="px-2 py-3 text-sm text-gray-500">End of the queue.</div>'}`
                : '<div class="p-4 text-sm text-gray-500">Nothing is queued. Play a song to start.</div>';
        }


        // ======================= Series + Videos sections (own tabs) =======================
        const jq = x => JSON.stringify(x).replace(/"/g, '&quot;');
        const vdata = { public: null, private: null };
        const sec = { sgenre: '', sq: '', vgenre: '', vq: '', vshown: 300, hero: null };
        const searchBox = (id, ph, on) => `<div class="relative w-64"><i class="fas fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-500"></i><input id="${id}" oninput="${on}" placeholder="${ph}" autocomplete="off" class="w-full bg-white/10 rounded-full pl-8 pr-3 py-1.5 text-sm outline-none focus:bg-white/15 placeholder-gray-500"></div>`;
        function buildSections() {
            $('series-view').innerHTML = `
                <div id="sv-hero"></div>
                <div id="sv-body" class="px-6 md:px-12 pb-16">
                    <div class="flex flex-wrap items-end justify-between gap-4 mb-5">
                        <div><h1 class="text-3xl font-black">Series</h1><p id="sv-sub" class="text-gray-400 text-sm mt-1"></p></div>
                        <button class="chip" onclick="openOrganize('public', { title: 'New series', focus: 'series' })"><i class="fas fa-plus mr-1 text-xs"></i>New series</button>
                    </div>
                    <div class="flex flex-wrap items-center gap-3 mb-6">${searchBox('sv-q', 'Search series', "sec.sq=this.value.toLowerCase();paintSeriesGrid()")}<div id="sv-chips" class="flex gap-2 hscroll overflow-x-auto hide-scrollbar"></div></div>
                    <div id="sv-cont"></div>
                    <div id="sv-grid" class="vgrid"></div>
                </div>`;
            $('photos-view').innerHTML = '<div id="pl-bar"></div><div id="public-photos"></div>';
            $('videos-view').innerHTML = `
                <div class="px-6 md:px-12 pt-10 pb-16">
                    <div class="flex flex-wrap items-end justify-between gap-4 mb-5">
                        <div><h1 class="text-3xl font-black">Videos</h1><p id="vp-sub" class="text-gray-400 text-sm mt-1"></p></div>
                        <div class="flex gap-2"><button class="chip" onclick="openManage(event, 'public')"><i class="fas fa-sliders mr-1.5 text-xs"></i>Manage<i class="fas fa-chevron-down ml-1.5 text-[10px]"></i></button></div>
                    </div>
                    <div class="flex flex-wrap items-center gap-3 mb-6">${searchBox('vp-q', 'Search videos', "sec.vq=this.value.toLowerCase();sec.vshown=300;paintVideosGrid()")}<div id="vp-chips" class="flex gap-2 hscroll overflow-x-auto hide-scrollbar"></div></div>
                    <div id="vp-grid" class="vgrid"></div>
                    <div id="vp-more" class="text-center mt-8"></div>
                </div>`;
        }
        function renderSections() {
            if (!vdata.public || !$('sv-grid')) return;
            const all = vdata.public.all_series || [];
            const cont = all.filter(s => s.watched > 0 && s.watched < s.episodes);
            sec.hero = cont[0] || all[Math.floor(Math.random() * all.length)] || null;
            const hero = sec.hero;
            $('sv-hero').innerHTML = hero ? seriesHero(hero) : '';
            $('sv-body').classList.toggle('pt-10', !hero);
            paintSeriesGrid(); paintVideosGrid();
        }
        function seriesHero(s) {
            const label = s.watched && s.watched < s.episodes ? 'Continue watching' : (s.watched ? 'Watch again' : 'Series for you');
            return `<section class="relative min-h-[52vh] flex items-end overflow-hidden mb-8">
                <div class="absolute inset-0 bg-cover bg-center scale-125 blur-3xl opacity-70" style="background-image:url('${s.poster}')"></div>
                <div class="absolute inset-0 bg-gradient-to-t from-lm-base via-lm-base/30 to-black/50"></div>
                <div class="absolute inset-0 bg-gradient-to-r from-black/80 via-black/30 to-transparent"></div>
                <div class="relative z-10 w-full px-6 md:px-12 pb-10 pt-32 flex items-end justify-between gap-10">
                    <div class="max-w-[40rem]">
                        <div class="flex items-center gap-2 text-xs font-bold tracking-[0.25em] uppercase text-accent mb-3"><span class="h-px w-8 bg-accent"></span>${label}</div>
                        <h2 class="font-black leading-[1.05] mb-3 drop-shadow-lg line-clamp-3 break-words" style="font-size:clamp(1.75rem,3.2vw,3.6rem)">${esc(s.title)}</h2>
                        <div class="text-sm text-gray-200 mb-5">${s.episodes} episode${s.episodes === 1 ? '' : 's'} &middot; ${s.watched} watched${s.genre ? ' &middot; ' + esc(s.genre) : ''}</div>
                        <div class="flex gap-3">
                            <button onclick="playVideo('${s.resume}')" class="bg-white text-black font-bold py-3 px-8 rounded-md flex items-center gap-2 hover:bg-white/80 transition-colors"><i class="fas fa-play"></i> ${s.watched ? 'Resume' : 'Play'}</button>
                            <button onclick="openSeries('${s.id}', 'public')" class="bg-gray-500/50 hover:bg-gray-500/30 backdrop-blur text-white font-bold py-3 px-6 rounded-md flex items-center gap-2 transition-colors"><i class="fas fa-list"></i> Episodes</button>
                        </div>
                    </div>
                    <img src="${s.poster}" alt="" class="hidden md:block h-[40vh] aspect-[2/3] object-cover rounded-lg shadow-2xl ring-1 ring-white/10 cursor-pointer" onclick="openSeries('${s.id}', 'public')">
                </div></section>`;
        }
        const genreChips = (names, cur, fn) => ['', ...names].map(n => `<button class="chip ${cur === n ? 'on' : ''}" onclick="${fn}(${jq(n)})">${n === '' ? 'All' : esc(n === '\u0000' ? 'Unsorted' : n)}</button>`).join('');
        function setSGenre(g) { sec.sgenre = g; paintSeriesGrid(); }
        function setVGenre(g) { sec.vgenre = g; sec.vshown = 300; paintVideosGrid(); }
        function paintSeriesGrid() {
            const d = vdata.public; if (!d || !$('sv-grid')) return;
            const all = d.all_series || [];
            const names = [...new Set(all.map(s => s.genre).filter(Boolean))].sort(natCmp);
            if (sec.sgenre && !names.includes(sec.sgenre)) sec.sgenre = '';
            $('sv-sub').textContent = all.length ? `${all.length} series &middot; ${all.reduce((a, s) => a + s.episodes, 0)} episodes`.replace(/&middot;/g, '\u00b7') : '';
            $('sv-chips').innerHTML = names.length > 1 ? genreChips(names, sec.sgenre, 'setSGenre') : '';
            const cont = all.filter(s => s.watched > 0 && s.watched < s.episodes);
            $('sv-cont').innerHTML = cont.length && !sec.sq && !sec.sgenre ? sectionHtml('sv-cont-row', 'Continue Watching', '', false, cardsHtml(cont, 'public')) : '';
            if (cont.length) updateArrows('sv-cont-row');
            const list = all.filter(s => (!sec.sgenre || s.genre === sec.sgenre) && (!sec.sq || s.title.toLowerCase().includes(sec.sq)));
            $('sv-grid').innerHTML = list.length ? cardsHtml(list, 'public') : `<div class="col-span-full border border-dashed border-white/10 rounded-lg px-8 py-12 text-center text-gray-400">
                <i class="fas fa-layer-group text-3xl opacity-40 mb-3 block"></i>
                ${all.length ? 'No series match.' : 'No series yet. A series is a group of episodes shown as one card.'}
                ${all.length ? '' : '<div class="text-sm text-gray-500 mt-2">Press <b>New series</b> to group videos you already have, or download a whole playlist in Downloads - tick "Make the playlist a series".</div>'}</div>`;
        }
        function paintVideosGrid() {
            const d = vdata.public; if (!d || !$('vp-grid')) return;
            const all = d.loose || [];
            const names = [...new Set(all.map(v => v.genre || '\u0000'))].sort(natCmp);
            if (sec.vgenre && !names.includes(sec.vgenre)) sec.vgenre = '';
            $('vp-chips').innerHTML = names.length > 1 ? genreChips(names, sec.vgenre, 'setVGenre') : '';
            const list = all.filter(v => (!sec.vgenre || (v.genre || '\u0000') === sec.vgenre) && (!sec.vq || v.title.toLowerCase().includes(sec.vq)));
            $('vp-sub').textContent = `${all.length} standalone video${all.length === 1 ? '' : 's'} (episodes live in Series)`;
            $('vp-grid').innerHTML = list.length ? cardsHtml(list.slice(0, sec.vshown), 'public')
                : `<div class="col-span-full border border-dashed border-white/10 rounded-lg px-8 py-12 text-center text-gray-400"><i class="far fa-folder-open text-3xl opacity-40 mb-3 block"></i>${all.length ? 'No videos match.' : 'No standalone videos yet.'}</div>`;
            $('vp-more').innerHTML = list.length > sec.vshown ? `<button class="chip" onclick="sec.vshown+=300;paintVideosGrid()">Show more (${list.length - sec.vshown} left)</button>` : '';
        }
        const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

        // ---- organize: move videos into genres / series from inside the app ----
        let orgCtx = { scope: 'public', sel: new Set(), videos: [], mode: 'loose', q: '' };
        async function openOrganize(scope, o) {
            o = o || {}; scope = scope || 'public';
            orgCtx = { scope, sel: new Set(o.ids || []), videos: [], mode: o.mode || 'loose', q: '' };
            $('org-title').textContent = o.title || 'Organize videos';
            $('org-genre').value = o.genre || ''; $('org-series').value = o.series || ''; $('org-q').value = ''; $('org-error').textContent = '';
            $('org-genres').innerHTML = (genreData[scope] || []).map(g => `<option value="${esc(g.name)}">`).join('');
            orgFillSeries(); paintOrgModes();
            $('org-list').innerHTML = '<div class="p-6 text-center text-gray-500 text-sm">Loading...</div>';
            show('org-modal', true, true);
            try { orgCtx.videos = (await api('/api/videos/all' + (scope === 'private' ? '?private=1' : ''))).videos; } catch (e) { $('org-error').textContent = errMsg(e); }
            paintOrg();
            setTimeout(() => $(o.focus === 'series' ? 'org-series' : 'org-genre').focus(), 40);
        }
        function closeOrganize() { show('org-modal', false, true); }
        function orgFillSeries() {
            const g = (genreData[orgCtx.scope] || []).find(x => x.name.toLowerCase() === $('org-genre').value.trim().toLowerCase());
            $('org-series-list').innerHTML = g ? g.items.filter(x => x.kind === 'series').map(x => `<option value="${esc(x.folder)}">`).join('') : '';
        }
        function paintOrgModes() { $('org-m-loose').classList.toggle('on', orgCtx.mode === 'loose'); $('org-m-all').classList.toggle('on', orgCtx.mode === 'all'); }
        function orgMode(m) { orgCtx.mode = m; paintOrgModes(); paintOrg(); }
        const orgFiltered = () => orgCtx.videos.filter(v => (orgCtx.mode === 'all' || !v.series) && (!orgCtx.q || (v.title + ' ' + v.genre + ' ' + v.series).toLowerCase().includes(orgCtx.q)));
        function paintOrg() {
            const list = orgFiltered(), u = x => orgCtx.scope === 'private' ? withToken(x) : x;
            $('org-list').innerHTML = list.length ? list.slice(0, 400).map(v => `<label class="org-row"><input type="checkbox" class="accent-red-600" ${orgCtx.sel.has(v.id) ? 'checked' : ''} onchange="orgToggle('${v.id}', this.checked)">
                <img src="${u(v.poster)}" alt="" loading="lazy" class="h-12 w-8 object-cover rounded bg-lm-card flex-none">
                <div class="min-w-0 flex-1"><div class="truncate text-sm font-semibold">${esc(v.title)}</div><div class="text-xs text-gray-500 truncate">${v.series ? esc(v.genre + ' / ' + v.series) : (v.genre ? esc(v.genre) : 'Not sorted yet')}</div></div></label>`).join('')
                + (list.length > 400 ? '<div class="p-3 text-xs text-gray-500 text-center">Showing the first 400 - search to narrow it down.</div>' : '')
                : '<div class="p-8 text-center text-gray-500 text-sm">Nothing here. Try "Everything".</div>';
            orgCount();
        }
        function orgCount() { const n = orgCtx.sel.size; $('org-count').textContent = n + ' selected'; $('org-go').textContent = n ? `Move ${n} video${n === 1 ? '' : 's'}` : 'Move'; }
        function orgToggle(id, on) { if (on) orgCtx.sel.add(id); else orgCtx.sel.delete(id); orgCount(); }
        function orgSelectShown() { orgFiltered().forEach(v => orgCtx.sel.add(v.id)); paintOrg(); }
        function orgClear() { orgCtx.sel.clear(); paintOrg(); }
        async function submitOrganize() {
            const c = orgCtx, genre = $('org-genre').value.trim(), series = $('org-series').value.trim();
            if (!c.sel.size) { $('org-error').textContent = 'Tick at least one video.'; return; }
            if (series && !genre) { $('org-error').textContent = 'Pick a genre for the series.'; return; }
            $('org-go').disabled = true; $('org-error').textContent = '';
            try {
                const r = await post('/api/videos/move', { ids: [...c.sel], genre, series, private: c.scope === 'private' });
                closeOrganize();
                toast(r.moved ? `Moved ${r.moved} video${r.moved === 1 ? '' : 's'} ${r.series ? 'into "' + r.series + '"' : (r.genre ? 'into ' + r.genre : 'out of their series')}` : 'Those videos are already there');
                await waitForScan();
                await loadVideos(c.scope);
                refreshSeries();
            } catch (e) { $('org-error').textContent = errMsg(e); }
            $('org-go').disabled = false;
        }

        // ---- rename / ungroup a series ----
        function openRename() {
            if (!seriesCtx) return;
            $('ren-input').value = seriesCtx.data.folder || seriesCtx.data.name; $('ren-error').textContent = '';
            show('ren-modal', true, true);
            setTimeout(() => { $('ren-input').focus(); $('ren-input').select(); }, 30);
        }
        function closeRename() { show('ren-modal', false, true); }
        async function saveRename() {
            const name = $('ren-input').value.trim();
            if (!name) { $('ren-error').textContent = 'Give the series a name.'; return; }
            try {
                const scope = seriesCtx.scope, r = await post(`/api/series/${seriesCtx.id}/rename`, { name });
                closeRename();
                await loadVideos(scope);
                if (seriesCtx) { seriesCtx.id = r.id; await refreshSeries(); }
                toast('Series renamed');
            } catch (e) { $('ren-error').textContent = errMsg(e); }
        }
        let ungroupArm = 0;
        async function ungroupSeries(btn) {
            if (Date.now() - ungroupArm > 4000) { ungroupArm = Date.now(); btn.innerHTML = '<i class="fas fa-triangle-exclamation"></i> Click again to confirm'; return; }
            ungroupArm = 0;
            const { scope, data } = seriesCtx;
            try {
                await post('/api/videos/move', { ids: data.episodes.map(e => e.id), genre: data.genre, series: '', private: scope === 'private' });
                closeSeries(); await loadVideos(scope);
                toast('Series ungrouped - its episodes are standalone videos again');
            } catch (e) { toast(errMsg(e)); }
        }

        // ======================= video mini player =======================
        let miniMode = false, keepMini = false;
        function paintMini() {
            $('mini-title').textContent = (playInfo && playInfo.series ? playInfo.series + ' - ' : '') + (titles[playingId] || '');
            $('mini-play-icon').className = 'fas ' + (player.paused ? 'fa-play ml-0.5' : 'fa-pause');
        }
        function enterMiniInApp() {
            if (!playingId || miniMode) return;
            if (isFS) setFS(false);
            closeMenu(); hideNext();
            miniMode = true; pm.classList.add('mini'); paintMini();
        }
        async function enterMini() {
            if (!playingId || miniMode) return;
            const bridge = window.pywebview && window.pywebview.api;
            if (bridge && bridge.open_mini) {                       // desktop app: a real, separate, always-on-top window
                const id = playingId, priv = scopeOf(id) === 'private', url = `/media/video/${id}`;
                let ok = false;
                try { ok = await bridge.open_mini(priv ? withToken(url) : url, titles[id] || 'Video', player.currentTime || 0, id, '', player.paused, player.muted ? 0 : player.volume); } catch (e) { console.error(e); }
                if (ok) {
                    miniWinId = id; miniWinPrivate = priv;
                    musicWasPlaying = false;                        // the pop-out owns the sound now
                    closePlayer();
                    toast('Mini player opened. Press E in it (or double-click) to come back.', 3500);
                    return;
                }
            }
            if (document.pictureInPictureEnabled && player.readyState > 0) { try { await player.requestPictureInPicture(); return; } catch (e) {} }
            enterMiniInApp();
        }
        window.miniClosed = () => { miniWinId = null; miniWinPrivate = false; loadVideos('public').then(refreshSeries); if (token) loadVideos('private'); };
        window.miniExpand = (id, t) => { miniWinId = null; miniWinPrivate = false; nextResume = t > 1 ? t : null; playVideo(id); };
        function exitMini() { if (!miniMode) return; miniMode = false; pm.classList.remove('mini'); showUI(); }
        function miniStep(dir) { keepMini = true; stepEpisode(dir); }
        function miniSeek(e) { const r = e.currentTarget.getBoundingClientRect(); if (player.duration) player.currentTime = player.duration * clamp((e.clientX - r.left) / r.width, 0, 1); }
        player.addEventListener('timeupdate', () => { if (miniMode && player.duration) $('mini-bar').style.width = (player.currentTime / player.duration * 100) + '%'; });
        ['play', 'pause'].forEach(ev => player.addEventListener(ev, () => { if (miniMode) paintMini(); }));

        // ======================= music: listening history, recommendations, albums =======================
        let playLog = null, forYou = null, albumsData = null, albumFilter = 'albums';
        const recLists = {};
        function flushPlay() {
            if (!playLog) return;
            const p = playLog; playLog = null;
            if (nowId === p.id) p.max = Math.max(p.max, audio.currentTime || 0);
            if (p.max < 1) return;
            fetch('/api/music/played', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LMP': '1' }, keepalive: true,
                body: JSON.stringify({ id: p.id, listened: p.max, duration: p.dur || audio.duration || 0 }) }).catch(() => {});
        }
        audio.addEventListener('timeupdate', () => { if (playLog && nowId === playLog.id) playLog.max = Math.max(playLog.max, audio.currentTime); });
        audio.addEventListener('loadedmetadata', () => { if (playLog && audio.duration) playLog.dur = audio.duration; });
        audio.addEventListener('ended', () => {            // "repeat one" restarts without going through startCurrent
            if (repeatMode === 'one' && playLog) { playLog.max = playLog.dur || audio.duration || playLog.max; const id = playLog.id, dur = playLog.dur; flushPlay(); playLog = { id, max: 0, dur }; }
        });
        window.addEventListener('beforeunload', flushPlay);

        async function loadForYou() {
            try { forYou = await api('/api/music/for-you'); if (view.kind === 'home') renderHome(); } catch (e) { console.error(e); }
        }
        const recSrc = (title, tracks) => ({ type: 'tracks', tracks, key: 'rec:' + title, label: 'For you', title, tint: title, icon: 'fa-wand-magic-sparkles', shuffle: false });
        function recCard(t, key, i) {
            return `<div data-tid="${t.id}" class="group w-44 flex-none p-3 rounded-lg hover:bg-white/10 transition-colors cursor-pointer" onclick="playRec('${key}', ${i})" title="${esc(t.why || '')}">
                <div class="relative mb-3">${coverBox([t.id], 'w-full aspect-square')}
                    <span class="absolute right-2 bottom-2 h-11 w-11 rounded-full bg-accent text-white shadow-xl flex items-center justify-center opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all"><i class="fas fa-play ml-0.5"></i></span></div>
                <div class="font-semibold truncate">${esc(t.title)}</div><div class="text-sm text-gray-400 truncate">${esc(t.artist)}</div>
                <div class="text-[11px] text-gray-500 truncate mt-0.5">${esc(t.why || '')}</div></div>`;
        }
        function playRec(key, i) { const l = recLists[key]; if (l && l[i]) playList(l, i); }
        function recShelves() {
            if (!forYou) return '';
            const st = forYou.stats, out = [];
            const cards = (key, arr) => { recLists[key] = arr; return arr.map((t, i) => recCard(t, key, i)); };
            const showAll = (src, extra) => `<div class="flex items-center gap-4">${extra || ''}<button onclick="openSrc(${reg(src)})" class="text-sm font-bold text-gray-400 hover:text-white transition-colors">Show all</button></div>`;
            if (forYou.cold) out.push('<div class="mb-6 rounded-lg border border-white/10 bg-white/[.04] px-5 py-4 text-sm text-gray-300"><i class="fas fa-wand-magic-sparkles text-accent mr-2"></i>Play some songs - finish the ones you like, skip the ones you do not, tap the heart - and these picks start adapting to your taste.</div>');
            if (forYou.discover.length) out.push(shelf('Discover: songs you have not played', cards('discover', forYou.discover),
                showAll(recSrc('Discover mix', forYou.discover), `<span class="text-xs text-gray-500">${st.unplayed} of ${st.songs} not played yet</span><button onclick="loadForYou()" class="text-sm font-bold text-gray-400 hover:text-white transition-colors"><i class="fas fa-rotate mr-1"></i>Refresh</button>`)));
            // most listened artists + the songs you play most from each (built from your own plays, nothing guessed)
            const tl = forYou.top_artists_listened || [];
            if (tl.length) {
                const acards = tl.map(a => { recLists['art:' + a.artist] = a.tracks; return shelfCard(coverBox([a.sample], 'w-full aspect-square', true), a.artist, a.plays + ' listen' + (a.plays === 1 ? '' : 's'), reg(artistSrc({ name: a.artist, sample: a.sample })), false); });
                out.push(shelf('Most listened artists', acards));
                tl.slice(0, 2).forEach(a => out.push(shelf('Your top songs by ' + a.artist, cards('art:' + a.artist, a.tracks), showAll(recSrc('Top songs by ' + a.artist, a.tracks)))));
            }
            if (forYou.rediscover.length) out.push(shelf('Rediscover your favorites', cards('redisc', forYou.rediscover), showAll(recSrc('Rediscover', forYou.rediscover))));
            return out.join('');
        }

        const albumSrc = a => ({ type: 'filter', filter: { album: a.key }, key: 'al:' + a.key, label: 'Album', title: a.name, artist: a.artist, sample: a.sample, custom: !!a.custom, shuffle: false });
        async function loadAlbums() {
            try { albumsData = (await api('/api/music/albums')).albums; } catch (e) { console.error(e); }
            if (view.kind === 'albums') renderAlbums();
            renderLibrary();
        }
        function showAlbums() {
            view = { kind: 'albums' }; $('m-search').value = '';
            setMainView('albums'); renderAlbums(); renderLibrary(); $('m-main').scrollTop = 0;
            if (!albumsData) loadAlbums();
        }
        function renderAlbums() {
            const all = albumsData || [], multi = all.filter(a => a.count > 1).length;
            const list = all.filter(a => albumFilter === 'all' || (albumFilter === 'albums' ? a.count > 1 : a.count === 1));
            REGS.alb.clear();
            const chips = [['albums', 'Albums', multi], ['singles', 'Singles', all.length - multi], ['all', 'All', all.length]]
                .map(([k, l, n]) => `<button class="chip ${albumFilter === k ? 'on' : ''}" onclick="albumFilter='${k}';renderAlbums()">${l} <span class="opacity-60 ml-1">${n}</span></button>`).join('');
            const cards = list.slice(0, 600).map(a => shelfCard(coverBox([a.sample], 'w-full aspect-square'), a.name,
                `${esc(a.artist)}${a.count > 1 ? ' &middot; ' + a.count + ' songs' : ''}${a.custom ? ' &middot; <i class="fas fa-compact-disc text-[10px]" title="Made by you"></i>' : ''}`, reg(albumSrc(a), 'alb'), false, 'w-full'));
            $('mv-albums').innerHTML = `<h1 class="text-3xl font-bold mt-4 mb-4">Albums</h1><div class="flex gap-2 mb-5">${chips}</div>`
                + (cards.length ? `<div class="grid gap-2" style="grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))">${cards.join('')}</div>` + (list.length > 600 ? '<p class="text-xs text-gray-500 mt-4">Showing the first 600.</p>' : '')
                    : `<div class="border border-dashed border-white/10 rounded-lg p-10 text-center text-gray-500">${albumsData ? 'No albums here. Albums come from the album tag of your songs, or make your own: open an artist, press Select songs, then Make into album.' : 'Loading...'}</div>`);
        }

        // ======================= downloads (yt-dlp) =======================
        const DL_KIND = { video: ['fa-film', 'Video', 'MP4, best quality'], audio: ['fa-headphones', 'Audio', 'MP3'], music: ['fa-compact-disc', 'Music', 'FLAC with tags and cover art'] };
        // "Save as": what the finished files become in the library (the backend does the grouping once they are downloaded)
        const DL_SAVE = {
            video: [['videos', 'Separate videos', 'Each video on its own'], ['series', 'One series', 'A playlist becomes a series']],
            songs: [['songs', 'Separate songs', 'Each song on its own'], ['album', 'One album', 'All songs in one album'], ['playlist', 'A playlist', 'Also listed in a playlist'], ['both', 'Album + playlist', 'Both of the above']]
        };
        const DL_SAVE_HINT = {
            videos: 'Every video lands in your library on its own. Pick a genre if you want it filed under one.',
            series: 'Every video in the link becomes an episode of one series, in playlist order. Leave the series name empty to use the playlist title. A genre is needed.',
            songs: 'Every song is added to your library on its own.',
            album: 'Every song in the link becomes one album, kept in its own folder, in the link\'s order. It shows up under Music > Albums.',
            playlist: 'Every song is also put in a playlist (Music > Playlists), in the link\'s order. Type the name of a playlist you already have to add to it.',
            both: 'The songs become one album and are also put in a playlist, in the link\'s order.'
        };
        let dlSaveAs = 'videos', dlPreviewTitle = '';
        let dlKind = 'video', dlBuilt = false, dlStatus = null, dlSig = '', dlPrev = {}, dlActive = 0, dlTick = 0, dlInfoTimer = null, dlInfoKey = '', dlSending = false;
        const dlLogOpen = new Set();
        let dlJobsById = {};

        function buildDl() {
            dlBuilt = true;
            const field = 'w-full bg-black border border-gray-700 text-white rounded-lg p-3 outline-none focus:border-accent transition-colors';
            const label = 'text-xs text-gray-400 mb-1 uppercase tracking-wider font-semibold block';
            $('dl-view').innerHTML = `
            <div class="px-6 md:px-12 pt-10 pb-20 max-w-5xl mx-auto">
                <div class="flex items-end justify-between gap-4 mb-6">
                    <div><h1 class="text-3xl font-black">Downloads</h1><p class="text-gray-400 text-sm mt-1">Paste a link from YouTube or any site yt-dlp supports. Finished files land in your library by themselves.</p></div>
                    <div id="dl-ver" class="text-xs text-gray-500 text-right whitespace-nowrap"></div>
                </div>
                <div id="dl-warn" class="hidden mb-5 rounded-xl border border-yellow-500/30 bg-yellow-500/10 text-yellow-200 text-sm p-4"></div>

                <div class="bg-gradient-to-br from-lm-card/70 to-black/40 border border-white/10 rounded-xl p-6 shadow-xl">
                    <textarea id="dl-url" rows="2" spellcheck="false" placeholder="Paste a link here. Add several links, one per line, to queue them all." class="${field} resize-none" oninput="onDlUrlInput()" onkeydown="if (event.ctrlKey && event.key === 'Enter') submitDl()"></textarea>
                    <div id="dl-preview" class="hidden mt-4"></div>

                    <div id="dl-kinds" class="grid grid-cols-3 gap-2 mt-5">
                        ${Object.keys(DL_KIND).map(k => `<button data-k="${k}" onclick="setDlKind('${k}')" class="chip !rounded-xl !py-3 text-left"><i class="fas ${DL_KIND[k][0]} mr-2 text-accent"></i><span class="font-bold">${DL_KIND[k][1]}</span><span class="block text-xs text-gray-400 mt-0.5">${DL_KIND[k][2]}</span></button>`).join('')}
                    </div>

                    <div class="mt-5">
                        <label class="${label}">Save as</label>
                        <div id="dl-saveas" class="dl-seg"></div>
                        <p id="dl-saveas-hint" class="text-xs text-gray-400 mt-2"></p>
                    </div>
                    <div id="dl-names" class="grid gap-4 mt-4" style="grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))">
                        <div id="dl-album-wrap" class="hidden"><label class="${label}">Album name</label><input id="dl-album-name" autocomplete="off" maxlength="80" class="${field}"></div>
                        <div id="dl-artist-wrap" class="hidden"><label class="${label}">Album artist (optional)</label><input id="dl-album-artist" autocomplete="off" maxlength="80" placeholder="Taken from the songs if you leave it empty" class="${field}"></div>
                        <div id="dl-pl-wrap" class="hidden"><label class="${label}">Playlist name</label><input id="dl-pl-name" list="dl-pl-list" autocomplete="off" maxlength="60" class="${field}"><datalist id="dl-pl-list"></datalist></div>
                    </div>

                    <div id="dl-opts-video" class="grid gap-4 mt-5" style="grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))">
                        <div><label class="${label}">Quality</label><select id="dl-res" class="${field} cursor-pointer"><option value="best">Best available</option><option value="4320">Up to 4320p (8K)</option><option value="2160">Up to 2160p (4K)</option><option value="1440">Up to 1440p</option><option value="1080">Up to 1080p</option><option value="720">Up to 720p</option><option value="480">Up to 480p</option></select></div>
                        <div><label class="${label}">Genre</label><input id="dl-genre" list="dl-genres" autocomplete="off" placeholder="Leave empty for none" oninput="fillDlSeries()" onfocus="fillDlGenres()" class="${field}"><datalist id="dl-genres"></datalist></div>
                        <div><label class="${label}">Series (optional)</label><input id="dl-series" list="dl-series-list" autocomplete="off" placeholder="Groups episodes together" class="${field}"><datalist id="dl-series-list"></datalist></div>
                    </div>
                    <div id="dl-where-wrap" class="mt-5">
                        <label class="${label}">Save to</label>
                        <div id="dl-where" class="dl-seg"></div>
                        <input id="dl-private" type="checkbox" class="hidden" onchange="fillDlGenres()">
                    </div>
                    <div id="dl-opts-audio" class="hidden mt-5"><label class="${label}">Folder inside your music library</label><input id="dl-folder" autocomplete="off" class="${field}"></div>

                    <div class="flex flex-wrap items-center justify-between gap-4 mt-5">
                        <div class="flex flex-wrap items-center gap-5 text-sm text-gray-300">
                            <label class="flex items-center gap-2 cursor-pointer select-none"><input id="dl-playlist" type="checkbox" class="accent-red-600" onchange="dlInfoKey=''; onDlUrlInput(); syncDlAuto()"> Download the whole playlist if the link has one</label>
                        </div>
                        <button id="dl-go" onclick="submitDl()" class="bg-accent hover:bg-red-700 text-white font-bold py-3 px-8 rounded-lg transition-all hover:scale-[1.03] shadow-lg shadow-red-900/40 flex items-center gap-2 disabled:opacity-60"><i class="fas fa-download"></i> Download</button>
                    </div>
                </div>

                <div class="flex items-center justify-between mt-10 mb-3">
                    <h2 class="text-xl font-bold text-lm-text">Queue</h2>
                    <button onclick="clearDl()" class="text-sm text-gray-400 hover:text-white transition-colors">Clear finished</button>
                </div>
                <div id="dl-list" class="space-y-3"></div>
            </div>`;
            setDlKind('video');
        }
        function dlOpened() {
            if (!dlBuilt) buildDl();
            if (!token && $('dl-private').checked) $('dl-private').checked = false;
            $('dl-folder').placeholder = 'Default: ' + (dlKind === 'audio' ? prefs.dl_audio_sub : prefs.dl_music_sub);
            fillDlPlaylists(); syncDlAuto(); fillDlGenres(); refreshYtStatus(); pollDl();
        }
        function setDlKind(k) {
            dlKind = k;
            document.querySelectorAll('#dl-kinds .chip').forEach(b => b.classList.toggle('on', b.dataset.k === k));
            $('dl-opts-video').classList.toggle('hidden', k !== 'video');
            $('dl-opts-audio').classList.toggle('hidden', k === 'video');
            $('dl-folder').placeholder = 'Default: ' + (k === 'audio' ? prefs.dl_audio_sub : prefs.dl_music_sub);
            const opts = DL_SAVE[k === 'video' ? 'video' : 'songs'];
            if (!opts.some(o => o[0] === dlSaveAs)) dlSaveAs = opts[0][0];      // switching between video and music resets the choice
            if (k !== 'video' && $('dl-private').checked) { $('dl-private').checked = false; fillDlGenres(); }
            syncDlAuto();
        }
        function setDlSaveAs(v) {
            dlSaveAs = v;
            if (v !== 'songs' && v !== 'videos') $('dl-playlist').checked = true;       // a group only makes sense with the whole link
            dlInfoKey = ''; onDlUrlInput(); syncDlAuto();
        }
        function setDlWhere(priv) {
            if (priv && !token) { toast('Unlock the private library first (the lock in the sidebar), then come back.', 4200); return; }
            $('dl-private').checked = priv; fillDlGenres(); syncDlAuto();
        }
        function fillDlPlaylists() { $('dl-pl-list').innerHTML = (typeof playlists !== 'undefined' ? playlists : []).filter(p => !p.liked).map(p => `<option value="${esc(p.name)}">`).join(''); }
        // repaints everything that depends on the kind, the Save as choice, the Save to choice and the previewed link
        function syncDlAuto() {
            if (!$('dl-saveas')) return;
            const video = dlKind === 'video', opts = DL_SAVE[video ? 'video' : 'songs'];
            $('dl-saveas').innerHTML = opts.map(o => `<button class="chip !rounded-xl !py-2.5 text-left ${dlSaveAs === o[0] ? 'on' : ''}" onclick="setDlSaveAs('${o[0]}')"><span class="font-bold">${o[1]}</span><small>${o[2]}</small></button>`).join('');
            $('dl-saveas-hint').textContent = DL_SAVE_HINT[dlSaveAs] || '';
            const album = !video && (dlSaveAs === 'album' || dlSaveAs === 'both'), pl = !video && (dlSaveAs === 'playlist' || dlSaveAs === 'both');
            $('dl-album-wrap').classList.toggle('hidden', !album); $('dl-artist-wrap').classList.toggle('hidden', !album); $('dl-pl-wrap').classList.toggle('hidden', !pl);
            $('dl-names').classList.toggle('hidden', !album && !pl);
            $('dl-album-name').placeholder = dlPreviewTitle || 'Leave empty to use the playlist title';
            $('dl-pl-name').placeholder = dlPreviewTitle || 'Leave empty to use the playlist title';
            $('dl-series').placeholder = dlSaveAs === 'series' ? (dlPreviewTitle || 'Leave empty to use the playlist title') : 'Groups episodes together';
            $('dl-where-wrap').classList.toggle('hidden', !video);
            const priv = $('dl-private').checked && !!token;
            $('dl-where').innerHTML = `<button class="chip !rounded-xl !py-2.5 text-left ${priv ? '' : 'on'}" onclick="setDlWhere(false)"><i class="fas fa-film mr-2"></i><span class="font-bold">Library</span><small>Cinema: Collections, Series and All videos</small></button>`
                + `<button class="chip !rounded-xl !py-2.5 text-left ${priv ? 'on' : ''}" onclick="setDlWhere(true)"><i class="fas ${token ? 'fa-user-lock' : 'fa-lock'} mr-2"></i><span class="font-bold">Private</span><small>${token ? 'Behind your password' : 'Unlock it first'}</small></button>`;
        }
        function currentScope() { return $('dl-private') && $('dl-private').checked && token ? 'private' : 'public'; }
        function fillDlGenres() {
            const list = genreData[currentScope()] || [];
            $('dl-genres').innerHTML = list.map(g => `<option value="${esc(g.name)}">`).join('');
            fillDlSeries();
        }
        function fillDlSeries() {
            const g = (genreData[currentScope()] || []).find(x => x.name.toLowerCase() === $('dl-genre').value.trim().toLowerCase());
            $('dl-series-list').innerHTML = g ? g.items.filter(x => x.kind === 'series').map(x => `<option value="${esc(x.folder)}">`).join('') : '';
        }
        async function refreshYtStatus() {
            try { dlStatus = await api('/api/ytdlp/status'); } catch (e) { return; }
            const st = dlStatus, ok = !!st.ytdlp;
            const el = $('set-yt-status');
            if (el) el.innerHTML = ok
                ? `<span class="text-green-400"><i class="fas fa-circle-check mr-1"></i>yt-dlp ${esc(st.version)}</span> &middot; ffmpeg ${st.ffmpeg ? '<i class="fas fa-check text-green-400"></i>' : '<i class="fas fa-xmark text-red-400"></i>'} &middot; ffprobe ${st.ffprobe ? '<i class="fas fa-check text-green-400"></i>' : '<i class="fas fa-xmark text-red-400"></i>'}`
                : `<span class="text-yellow-300"><i class="fas fa-triangle-exclamation mr-1"></i>yt-dlp not found${st.searched.length ? ' in ' + esc(st.searched.join(', ')) : ''}</span>`;
            if (!dlBuilt) return;
            $('dl-ver').textContent = ok ? 'yt-dlp ' + st.version : '';
            const w = $('dl-warn');
            if (!ok) { w.innerHTML = `<i class="fas fa-triangle-exclamation mr-2"></i>yt-dlp was not found. Open <b>Settings &gt; Downloader</b> and set the folder that has yt-dlp.exe in it. <button class="underline font-semibold ml-1" onclick="openSettings()">Open settings</button>`; w.classList.remove('hidden'); }
            else if (!st.ffmpeg) { w.innerHTML = `<i class="fas fa-triangle-exclamation mr-2"></i>ffmpeg was not found next to yt-dlp. Merging video, MP3/FLAC conversion and cover art will fail without it. <button class="underline font-semibold ml-1" onclick="openSettings()">Open settings</button>`; w.classList.remove('hidden'); }
            else w.classList.add('hidden');
        }
        async function setYtdlpDir(v) { await setPref({ ytdlp_dir: v.trim() }); refreshYtStatus(); }
        async function browseYtdlp() {
            const bridge = window.pywebview && window.pywebview.api;
            if (!bridge || !bridge.pick_folder) { toast('Folder browsing needs the desktop app. Type the path instead.', 3500); return; }
            const p = await bridge.pick_folder();
            if (p) setYtdlpDir(p);
        }
        async function importVars() {
            try {
                const r = await post('/api/ytdlp/import-vars');
                applyPrefs(r); paintSettings();
                toast('Imported ' + r.imported.length + ' settings from VARS.txt', 4000);
            } catch (e) { toast(errMsg(e), 4500); }
        }
        async function updateYtdlp() {
            const b = $('set-yt-update'); b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Updating...';
            try { const r = await post('/api/ytdlp/update'); toast(r.ok ? 'yt-dlp is now ' + r.version : (r.output || 'Update failed.'), 6000); }
            catch (e) { toast(errMsg(e), 5000); }
            b.disabled = false; b.innerHTML = '<i class="fas fa-cloud-arrow-down mr-1"></i>Update yt-dlp';
            refreshYtStatus();
        }

        // ---- link preview ----
        const dlLines = () => $('dl-url').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        function onDlUrlInput() {
            clearTimeout(dlInfoTimer);
            const lines = dlLines();
            if (lines.length !== 1 || !/^(https?:\/\/|www\.)\S+$/i.test(lines[0])) { dlInfoKey = ''; $('dl-preview').classList.add('hidden'); if (dlPreviewTitle) { dlPreviewTitle = ''; syncDlAuto(); } return; }
            dlInfoTimer = setTimeout(fetchDlInfo, 650);
        }
        async function fetchDlInfo() {
            const lines = dlLines();
            if (lines.length !== 1) return;
            const url = lines[0], playlist = $('dl-playlist').checked, key = url + '|' + playlist;
            if (key === dlInfoKey) return;
            dlInfoKey = key;
            const box = $('dl-preview');
            box.classList.remove('hidden');
            box.innerHTML = '<div class="flex gap-4"><div class="skeleton w-48 aspect-video rounded-lg flex-none"></div><div class="flex-1 space-y-3 py-1"><div class="skeleton h-5 w-3/4 rounded"></div><div class="skeleton h-4 w-1/3 rounded"></div></div></div>';
            try {
                const r = await post('/api/ytdlp/info', { url, playlist });
                if (dlInfoKey !== key) return;
                const mins = r.duration ? fmtClock(r.duration) : '';
                dlPreviewTitle = r.playlist ? (r.title || '') : ''; syncDlAuto();
                box.innerHTML = `<div class="flex gap-4 items-start">
                    ${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="" referrerpolicy="no-referrer" class="w-48 aspect-video object-cover rounded-lg flex-none bg-lm-card" onerror="this.style.display='none'">` : ''}
                    <div class="min-w-0"><div class="font-bold text-lg leading-snug line-clamp-2">${esc(r.title || url)}</div>
                    <div class="text-sm text-gray-400 mt-1">${esc(r.uploader)}${mins ? ' &middot; ' + mins : ''}</div>
                    <div class="flex flex-wrap gap-2 mt-3 text-xs">${r.playlist ? `<span class="rounded-full bg-accent/20 text-red-300 font-bold px-3 py-1"><i class="fas fa-list mr-1"></i>Playlist${r.count ? ': ' + r.count + ' videos' : ''}</span>` : ''}${r.max_height ? `<span class="rounded-full bg-white/10 px-3 py-1">up to ${r.max_height}p</span>` : ''}</div></div></div>`;
            } catch (e) {
                if (dlInfoKey !== key) return;
                box.innerHTML = `<div class="text-sm text-gray-500"><i class="fas fa-circle-info mr-1"></i>${esc(errMsg(e))} You can still press Download.</div>`;
            }
        }

        // ---- queue ----
        async function submitDl() {
            if (dlSending) return;
            const urls = dlLines();
            if (!urls.length) { toast('Paste a link first.'); $('dl-url').focus(); return; }
            dlSending = true; $('dl-go').disabled = true;
            try {
                const video = dlKind === 'video', series = $('dl-series').value.trim(), asSeries = video && dlSaveAs === 'series';
                if (asSeries && !$('dl-genre').value.trim()) { toast('Pick a genre first: the playlist becomes a series inside it.', 4200); $('dl-genre').focus(); dlSending = false; $('dl-go').disabled = false; return; }
                const r = await post('/api/downloads', {
                    kind: dlKind, urls, res: $('dl-res').value, genre: $('dl-genre').value.trim(), series: video ? series : '',
                    folder: $('dl-folder').value.trim(), playlist: $('dl-playlist').checked || asSeries || (!video && dlSaveAs !== 'songs'),
                    auto_series: asSeries && !series, private: video && $('dl-private').checked && !!token,
                    save_as: video ? 'songs' : dlSaveAs, album_name: $('dl-album-name').value.trim(), album_artist: $('dl-album-artist').value.trim(), playlist_name: $('dl-pl-name').value.trim() });
                $('dl-url').value = ''; $('dl-album-name').value = ''; $('dl-album-artist').value = ''; $('dl-pl-name').value = ''; dlInfoKey = ''; dlPreviewTitle = ''; $('dl-preview').classList.add('hidden'); syncDlAuto();
                toast(r.jobs.length === 1 ? 'Added to the queue' : r.jobs.length + ' links added to the queue', 2500);
                await pollDl();
            } catch (e) { toast(errMsg(e), 5000); }
            dlSending = false; $('dl-go').disabled = false;
        }
        function dlChip(st) {
            const m = { queued: ['Queued', 'bg-white/10 text-gray-300'], running: ['Downloading', 'bg-accent/20 text-red-400'], done: ['Done', 'bg-green-500/15 text-green-400'],
                        error: ['Failed', 'bg-red-500/20 text-red-400'], cancelled: ['Cancelled', 'bg-white/10 text-gray-400'] }[st] || ['', ''];
            return `<span class="text-[11px] font-bold rounded-full px-2.5 py-0.5 ${m[1]}">${m[0]}</span>`;
        }
        function dlJobHtml(j) {
            const k = DL_KIND[j.kind] || DL_KIND.video, act = j.status === 'queued' || j.status === 'running';
            const pct = j.status === 'done' ? 100 : Math.round(j.progress || 0);
            const text = j.status === 'error' ? (j.error || j.message) : j.message;
            const info = [j.item ? 'Item ' + j.item : '', text, j.status === 'running' ? j.speed : '', j.status === 'running' && j.eta ? 'ETA ' + j.eta : ''].filter(Boolean).join(' \u00b7 ');
            const btn = (cls, click, icon, t) => `<button class="${cls} text-xs font-semibold rounded-full px-3 py-1.5 transition-colors" onclick="${click}"><i class="fas ${icon} mr-1"></i>${t}</button>`;
            const grey = 'bg-white/10 hover:bg-white/20';
            const buttons = act ? btn(grey, `cancelDl('${j.id}')`, 'fa-stop', 'Cancel')
                : j.status === 'done' ? btn('bg-white text-black hover:bg-white/80', `showDlResult('${j.id}')`, 'fa-play', 'Show in library') + btn(grey, `removeDl('${j.id}')`, 'fa-xmark', 'Remove')
                : btn(grey, `retryDl('${j.id}')`, 'fa-rotate-right', 'Retry') + btn(grey, `removeDl('${j.id}')`, 'fa-xmark', 'Remove');
            const logOpen = dlLogOpen.has(j.id);
            const plan = j.status === 'done' && j.made && j.made.length ? j.made.map(m => [m.startsWith('Album') ? 'fa-compact-disc' : 'fa-list', m])
                : [j.mk_album ? ['fa-compact-disc', 'Album' + (j.album_name ? ': ' + j.album_name : '')] : null, j.mk_playlist ? ['fa-list', 'Playlist' + (j.playlist_name ? ': ' + j.playlist_name : '')] : null,
                   j.kind === 'video' && (j.auto_series || j.series) && j.playlist ? ['fa-layer-group', 'Series' + (j.series ? ': ' + j.series : '')] : null,
                   j.private ? ['fa-user-lock', 'Private'] : null].filter(Boolean);
            const planHtml = plan.length ? `<div class="flex flex-wrap gap-1.5 mt-2">${plan.map(c => `<span class="text-[11px] rounded-full bg-white/10 text-gray-200 px-2.5 py-0.5"><i class="fas ${c[0]} mr-1 opacity-70"></i>${esc(c[1])}</span>`).join('')}</div>` : '';
            return `<div class="bg-[#1a1a1a] border border-white/10 rounded-xl p-4">
                <div class="flex items-start gap-4">
                    <div class="h-11 w-11 flex-none rounded-lg bg-white/5 flex items-center justify-center text-accent"><i class="fas ${k[0]}"></i></div>
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-3"><div class="font-semibold truncate">${esc(j.title || j.url)}</div>${dlChip(j.status)}</div>
                        <div class="text-xs text-gray-500 truncate mt-0.5">${esc(j.dest)}</div>
                        ${planHtml}
                        ${act || j.status === 'done' ? `<div class="h-1.5 rounded-full bg-white/10 overflow-hidden mt-3"><div class="h-full rounded-full ${j.status === 'done' ? 'bg-green-500' : 'bg-accent'} transition-all duration-500" style="width:${pct}%;${j.status === 'running' ? 'box-shadow:0 0 10px rgba(255,255,255,.7)' : ''}"></div></div>` : ''}
                        <div class="text-xs mt-2 ${j.status === 'error' ? 'text-red-400' : 'text-gray-400'}">${esc(info)}${j.status === 'running' && j.progress ? ' \u00b7 ' + pct + '%' : ''}${j.status === 'done' && j.files.length ? ` \u00b7 ${j.files.length} file${j.files.length === 1 ? '' : 's'}` : ''}</div>
                    </div>
                    <div class="flex flex-col items-end gap-2 flex-none">${buttons}<button class="text-[11px] text-gray-500 hover:text-white" onclick="toggleDlLog('${j.id}')">${logOpen ? 'Hide' : 'Show'} details</button></div>
                </div>
                ${logOpen ? `<pre class="mt-3 max-h-44 overflow-auto thin-scroll bg-black rounded-lg p-3 text-[11px] leading-relaxed text-gray-400 whitespace-pre-wrap break-all">${esc((j.log || []).join('\n') || 'No output yet.')}</pre>` : ''}
            </div>`;
        }
        async function pollDl() {
            let jobs;
            try { jobs = (await api('/api/downloads')).jobs; } catch (e) { return; }
            dlJobsById = {}; jobs.forEach(j => { dlJobsById[j.id] = j; });
            dlActive = jobs.filter(j => j.status === 'queued' || j.status === 'running').length;
            const badge = $('dl-badge');
            badge.textContent = dlActive; badge.classList.toggle('hidden', !dlActive);
            jobs.forEach(j => {
                if (dlPrev[j.id] && dlPrev[j.id] !== 'done' && j.status === 'done') dlFinished(j);
                else if (dlPrev[j.id] === 'running' && j.status === 'error') toast('Download failed: ' + (j.error || j.message), 6000);
                dlPrev[j.id] = j.status;
            });
            if (!dlBuilt) return;
            const sig = JSON.stringify(jobs) + [...dlLogOpen].join();
            if (sig === dlSig) return;
            dlSig = sig;
            $('dl-list').innerHTML = jobs.length ? jobs.slice().reverse().map(dlJobHtml).join('')
                : '<div class="border border-dashed border-white/10 rounded-xl px-6 py-10 text-center text-gray-500 text-sm"><i class="fas fa-cloud-arrow-down text-2xl mb-3 block opacity-40"></i>Nothing queued. Paste a link above and press Download.</div>';
        }
        function dlFinished(j) {
            toast('Download finished: ' + (j.title || 'done'), 4500);
            if (j.kind === 'video') { loadVideos(j.private ? 'private' : 'public').then(refreshSeries); }
            else { setTimeout(() => { loadMusicFilters(); loadPlaylists(); loadRecent(); loadAlbums(); fillDlPlaylists(); }, 800); }
        }
        async function cancelDl(id) { try { await post(`/api/downloads/${id}/cancel`); pollDl(); } catch (e) { toast(errMsg(e)); } }
        async function retryDl(id) { try { await post(`/api/downloads/${id}/retry`); pollDl(); } catch (e) { toast(errMsg(e)); } }
        async function removeDl(id) { try { await post('/api/downloads/clear', { id }); pollDl(); } catch (e) { toast(errMsg(e)); } }
        async function clearDl() { try { await post('/api/downloads/clear', {}); pollDl(); } catch (e) { toast(errMsg(e)); } }
        function toggleDlLog(id) { if (dlLogOpen.has(id)) dlLogOpen.delete(id); else dlLogOpen.add(id); dlSig = ''; pollDl(); }
        // scroll to the new things and pulse them so you can see where they landed
        function flashEls(els) {
            if (!els.length) return false;
            els[0].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
            els.slice(0, 8).forEach(el => {
                el.classList.remove('flash-new'); void el.offsetWidth; el.classList.add('flash-new');
                setTimeout(() => el.classList.remove('flash-new'), 3800);
            });
            return true;
        }
        async function revealVideo(job) {
            const scope = job.private && token ? 'private' : 'public';
            switchTab(scope === 'private' ? 'private-view' : 'video-view', scope === 'private' ? 'tab-private' : 'tab-video');
            await loadVideos(scope);
            const root = $(scope + '-view'), q = sel => [...root.querySelectorAll(sel)];
            let els = (job.ids || []).flatMap(id => q(`#${scope}-recent .video-card[data-id="${id}"]`));
            if (!els.length && job.series_id) els = q(`#${scope}-recent .video-card[data-sid="${job.series_id}"]`);
            if (!els.length) els = (job.ids || []).flatMap(id => q(`.video-card[data-id="${id}"]`));
            if (!els.length && job.series_id) els = q(`.video-card[data-sid="${job.series_id}"]`);
            setTimeout(() => { if (!flashEls(els)) toast('Added, but it is not showing yet. Press the refresh button.', 4000); }, 250);
        }
        async function revealMusic(job, tries) {
            tries = tries || 0;
            if (!tries && (job.album_key || (job.mk_playlist && job.playlist_id))) {          // grouped downloads open the album / playlist itself
                switchTab('music-view', 'tab-music');
                await Promise.all([loadMusicFilters(), loadAlbums(), loadPlaylists()]);
                const al = job.album_key && (albumsData || []).find(a => a.key === job.album_key);
                if (al) { openSource(albumSrc(al)); return; }
                if (job.playlist_id) { openPlaylist(job.playlist_id); return; }
            }
            if (!tries) { switchTab('music-view', 'tab-music'); showHome(); }
            await Promise.all([loadMusicFilters(), loadRecent()]);
            const ids = new Set(job.ids || []);
            const all = [...document.querySelectorAll('#mv-home [data-tid]')];
            const els = ids.size ? all.filter(e => ids.has(e.dataset.tid)) : all.slice(0, 3);
            if (els.length) { setTimeout(() => flashEls(els), 250); return; }
            if (tries < 6) setTimeout(() => revealMusic(job, tries + 1), 1500);
            else toast('Added, but it is not in your music index yet. Press the refresh button.', 4000);
        }
        function showDlResult(id) {
            const job = dlJobsById[id];
            if (!job) return;
            if (job.kind === 'video') revealVideo(job); else revealMusic(job);
        }
        setInterval(() => { dlTick++; if (currentView === 'dl-view' || dlActive || dlTick % 8 === 0) pollDl(); }, 1000);


        // ======================= sidebar rail + Home dashboard =======================
        function toggleRail(force) {
            musicAutoRail = false;
            const on = force == null ? !document.body.classList.contains('rail') : force;
            document.body.classList.toggle('rail', on);
            document.body.classList.toggle('rail-off', !on);
            store.set('lmp_rail', on ? '1' : '0');
            setTimeout(() => { shelfIds.forEach(updateArrows); window.dispatchEvent(new Event('resize')); }, 300);
        }
        if (store.get('lmp_rail') === '1') document.body.classList.add('rail');
        else if (store.get('lmp_rail') === '0') document.body.classList.add('rail-off');

        // Home tabs: one quiet row. "All" is the whole home; the others show just that kind of thing.
        const HOME_TABS = [['all', 'All'], ['videos', 'Videos'], ['photos', 'Photos'], ['music', 'Music']];
        let HOME_TAB = (() => { const t = store.get('lmp_home_tab'); return HOME_TABS.some(x => x[0] === t) ? t : 'all'; })();
        function paintHomeTabs() {
            const el = $('dh-tabs'); if (!el) return;
            el.innerHTML = HOME_TABS.map(([k, label]) => `<button class="pv-tab ${k === HOME_TAB ? 'on' : ''}" role="tab" aria-selected="${k === HOME_TAB}" onclick="homeTab('${k}')">${label}</button>`).join('');
        }
        function homeTab(k) {
            if (k === HOME_TAB) return;
            HOME_TAB = k; store.set('lmp_home_tab', k);
            $('home-view').dataset.tab = k; paintHomeTabs();
            renderDashboard();
            document.body.scrollTo({ top: 0, behavior: 'instant' });
        }
        const dashCache = {};
        function dashPaint(id, html) { const el = $(id); if (!el || dashCache[id] === html) return false; dashCache[id] = html; el.innerHTML = html; tickAnalog(); return true; }
        function buildHome() {
            $('home-view').innerHTML = `
                <div class="px-6 md:px-10 pt-8 pb-16 max-w-[110rem] mx-auto">
                    <div id="dh-top"></div>
                    <div id="dh-tabs" role="tablist"></div>
                    <div class="dash-top mb-6">
                        <div id="dh-hero" class="min-w-0"></div>
                        <div id="dh-music" class="min-w-0"></div>
                    </div>
                    <div id="dh-stats" class="grid gap-3 mb-10" style="grid-template-columns: repeat(auto-fit, minmax(10.5rem, 1fr))"></div>
                    <div id="dh-cont"></div>
                    <div id="dh-recent"></div>
                    <div class="grid gap-5 mb-10" style="grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr))">
                        <div id="dh-dl" class="min-w-0"></div>
                        <div id="dh-pl" class="min-w-0"></div>
                    </div>
                    <div id="dh-newmusic"></div>
                    <div id="dh-favs"></div>
                    <div id="dh-photos"></div>
                    <div id="dh-priv"></div>
                    <div id="dh-privfavs"></div>
                    <div id="dh-privphotos"></div>
                    <div id="dh-genres"></div>
                    <div id="dh-empty"></div>
                </div>`;
            $('home-view').dataset.tab = HOME_TAB; paintHomeTabs();
            Object.keys(dashCache).forEach(k => delete dashCache[k]);
            renderDashboard();
        }
        let dashTimer = 0;
        function dashSoon() { if (currentView !== 'home-view' || dashTimer) return; dashTimer = setTimeout(() => { dashTimer = 0; renderDashboard(); }, 120); }
        function goPlaylist(id) {
            switchTab('music-view', 'tab-music');
            const pl = playlists.find(p => p.id === id);
            if (pl) setTimeout(() => openSrc(reg(plSrc(pl))), 60);
        }
        function goGenre(i) { switchTab('video-view', 'tab-video'); setTimeout(() => jumpGenre('public', i), 120); }
        function shuffleAllMusic() { switchTab('music-view', 'tab-music'); setTimeout(() => playSrc(reg(allSrc()), true), 60); }
        function dashSection(id, title, cards, more) {
            if (!cards.length) return '';
            return sectionHtml(id, title, more || '', false, cards);
        }
        function renderDashboard() {
            if (!$('dh-top')) return;
            const d = vdata.public, f = filtersData, hr = new Date().getHours();
            const greet = greetNow(hr);
            const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
            const nVideos = d ? d.total || 0 : 0, series = d ? (d.all_series || []) : [], genres = d ? (d.genres || []) : [];
            const nSongs = f ? f.total || 0 : 0, pls = playlists.filter(p => !p.liked);
            const jobs = Object.values(dlJobsById || {}), active = jobs.filter(j => j.status === 'queued' || j.status === 'running');

            dashPaint('dh-top', `
                <div class="flex flex-wrap items-end justify-between gap-4 mb-6">
                    ${prefs.home_clock ? `<div class="hc">
                        <div class="hc-clock" onclick="switchTab('time-view','tab-time')" title="Open Time" role="button">${clockSVG({ style: prefs.clock_style || 'logo', size: 'full', bare: true, id: 'khome' })}</div>
                        <div class="hc-meta"><div class="hc-greet"><i id="hc-icon" class="fas ${greetIcon(hr)}"></i><span id="hc-greet">${greet}</span></div>
                        <div id="hc-date" class="hc-date">${esc(today)}</div></div>
                    </div>` : `<div><div class="text-[11px] font-medium tracking-[0.18em] uppercase text-gray-600 mb-1">${esc(today)}</div>
                        <h1 class="text-4xl font-black leading-tight">${greet}</h1></div>`}
                    <div class="flex flex-wrap gap-2">
                        <button class="qa-btn" onclick="openPalette()"><i class="fas fa-magnifying-glass"></i>Search <kbd>Ctrl K</kbd></button>
                        <button class="qa-btn primary" onclick="surprise('public')"><i class="fas fa-dice"></i>Surprise me</button>
                        <button class="qa-btn" onclick="shuffleAllMusic()"><i class="fas fa-shuffle"></i>Shuffle music</button>
                        <button class="qa-btn" onclick="openGenreModal('public')"><i class="fas fa-folder-plus"></i>New genre</button>
                        <button class="qa-btn" onclick="openNameModal('create')"><i class="fas fa-list"></i>New playlist</button>
                        <button class="qa-btn" onclick="switchTab('dl-view','tab-dl')"><i class="fas fa-cloud-arrow-down"></i>Download</button>
                    </div>
                </div>`);

            tickClock();

            // ---- hero: resume whatever you were watching ----
            let h = '';
            const pick = d && ((d.continue || [])[0] || d.featured);
            if (pick) {
                const isSeries = pick.kind === 'series';
                const label = (d.continue || [])[0] ? 'Pick up where you left off' : 'Start something new';
                const playId = isSeries ? pick.resume : pick.id;
                const sub = isSeries ? `${pick.episodes} episodes \u00b7 ${pick.watched} watched` : (pick.series ? esc(pick.series) : (pick.view_count ? pick.view_count + 'x viewed' : 'Not watched yet'));
                const pct = Math.round((pick.progress || 0) * 100);
                h = `<div class="dash-hero relative rounded-2xl overflow-hidden min-h-[19rem] h-full flex items-end cursor-pointer ring-1 ring-white/10" onclick="playVideo('${playId}')">
                        <div class="dash-hero-bg absolute inset-0 bg-cover bg-center scale-125 blur-2xl opacity-70" style="background-image:url('${pick.poster}')"></div>
                        ${pick.backdrop ? `<img src="${pick.backdrop}" alt="" class="dash-hero-bg absolute inset-0 h-full w-full object-cover" onerror="this.remove()">` : ''}
                        <div class="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/30"></div>
                        <div class="absolute inset-0 bg-gradient-to-r from-black/85 via-black/30 to-transparent"></div>
                        <div class="relative z-10 w-full p-7 flex items-end justify-between gap-6">
                            <div class="min-w-0 max-w-[34rem]">
                                <div class="flex items-center gap-2 text-[11px] font-bold tracking-[0.25em] uppercase text-accent mb-3"><span class="h-px w-8 bg-accent"></span>${label}</div>
                                <div class="font-black leading-[1.05] mb-2 line-clamp-2 break-words drop-shadow-lg" style="font-size:clamp(1.6rem,2.6vw,3rem)">${esc(pick.title)}</div>
                                <div class="text-sm text-gray-300 mb-4">${sub}</div>
                                ${pct ? `<div class="h-1.5 w-64 max-w-full rounded-full bg-white/20 overflow-hidden mb-5"><div class="h-full bg-accent" style="width:${pct}%;box-shadow:0 0 12px rgba(255,255,255,.8)"></div></div>` : '<div class="mb-5"></div>'}
                                <div class="flex gap-3">
                                    <button class="bg-white text-black font-bold py-2.5 px-7 rounded-md flex items-center gap-2 hover:bg-white/80 transition-colors" onclick="event.stopPropagation();playVideo('${playId}')"><i class="fas fa-play"></i>${pct ? 'Resume' : 'Play'}</button>
                                    ${isSeries ? `<button class="bg-white/15 hover:bg-white/25 backdrop-blur font-bold py-2.5 px-5 rounded-md transition-colors" onclick="event.stopPropagation();openSeries('${pick.id}','public')"><i class="fas fa-list mr-2"></i>Episodes</button>` : ''}
                                </div>
                            </div>
                            <img src="${pick.poster}" alt="" class="hidden xl:block h-52 aspect-[2/3] object-cover rounded-lg shadow-2xl ring-1 ring-white/15">
                        </div>
                    </div>`;
            } else {
                h = `<div class="dash-card h-full min-h-[19rem] flex flex-col items-center justify-center text-center p-8 text-gray-400"><i class="fas fa-film text-4xl opacity-40 mb-4"></i>
                        <div class="font-bold text-white text-lg mb-1">${d ? 'No videos yet' : 'Loading your library...'}</div>
                        <div class="text-sm max-w-sm">${d ? 'Make a genre, drop files in your videos folder and press the refresh button in the sidebar, or grab something in Downloads.' : ''}</div></div>`;
            }
            const heroChanged = dashPaint('dh-hero', h);

            // ---- music card ----
            const rt = recentTracks[0];
            dashPaint('dh-music', `
                <div class="dash-card h-full min-h-[19rem] p-5 flex flex-col">
                    <div class="flex items-center justify-between mb-4"><div class="text-xs font-bold tracking-[0.25em] uppercase text-gray-400"><i class="fas fa-music text-accent mr-2"></i>Music</div>
                        <button class="text-xs font-bold text-gray-400 hover:text-white" onclick="switchTab('music-view','tab-music')">Open</button></div>
                    ${nSongs ? `<div class="flex items-center gap-4 mb-5">
                            <div class="h-24 w-24 flex-none rounded-lg overflow-hidden shadow-xl">${rt ? coverBox([rt.id], 'h-24 w-24') : tintBox('All songs', 'fa-shuffle', 'h-24 w-24')}</div>
                            <div class="min-w-0"><div class="text-[11px] font-bold uppercase tracking-widest text-gray-500 mb-1">${rt ? 'Latest addition' : 'Your library'}</div>
                                <div class="font-bold truncate">${rt ? esc(rt.title) : nSongs + ' songs'}</div><div class="text-sm text-gray-400 truncate">${rt ? esc(rt.artist) : ''}</div></div>
                        </div>
                        <div class="flex flex-wrap gap-2 mt-auto">
                            <button class="qa-btn primary" onclick="shuffleAllMusic()"><i class="fas fa-shuffle"></i>Shuffle all</button>
                            ${rt ? `<button class="qa-btn" onclick="playRecent(0)"><i class="fas fa-play"></i>Play latest</button>` : ''}
                        </div>`
                    : `<div class="flex-1 flex flex-col items-center justify-center text-center text-gray-500 text-sm"><i class="fas fa-compact-disc text-3xl opacity-40 mb-3"></i>${f ? 'No music found yet. Put files in media/music or download some.' : 'Loading...'}</div>`}
                </div>`);

            // ---- stats ----
            const tile = (n, label, icon, click) => `<button class="dash-card stat-tile" onclick="${click}"><i class="fas ${icon} bgico"></i><div class="big">${n}</div><div class="text-xs font-semibold uppercase tracking-widest text-gray-400 mt-2">${label}</div></button>`;
            dashPaint('dh-stats', tile(nVideos, 'Videos', 'fa-film', "switchTab('videos-view','tab-videos')") + tile(series.length, 'Series', 'fa-layer-group', "switchTab('series-view','tab-series')")
                + tile(genres.length, 'Genres', 'fa-tags', "switchTab('video-view','tab-video')") + tile(nSongs, 'Songs', 'fa-music', "switchTab('music-view','tab-music')")
                + tile(pls.length, 'Playlists', 'fa-list', "switchTab('music-view','tab-music')") + tile(active.length, 'Downloading', 'fa-cloud-arrow-down', "switchTab('dl-view','tab-dl')"));

            // ---- video rows ----
            const rows = [];
            if (dashPaint('dh-cont', dashSection('dh-cont-row', 'Continue Watching', d ? cardsHtml(d.continue || [], 'public') : '', ''))) rows.push('dh-cont-row');
            if (dashPaint('dh-recent', dashSection('dh-recent-row', 'Recently Added', d ? cardsHtml(d.recent || [], 'public') : '', ''))) rows.push('dh-recent-row');

            // ---- downloads panel ----
            const shown = (active.length ? active : jobs.filter(j => j.status === 'done').slice(-3).reverse()).slice(0, 4);
            const dlRow = j => { const pct = j.status === 'done' ? 100 : Math.round(j.progress || 0); const k = DL_KIND[j.kind] || DL_KIND.video;
                return `<div class="flex items-center gap-3 py-2"><div class="h-9 w-9 flex-none rounded-lg bg-white/5 flex items-center justify-center text-accent"><i class="fas ${k[0]} text-sm"></i></div>
                    <div class="min-w-0 flex-1"><div class="text-sm font-semibold truncate">${esc(j.title || j.url)}</div>
                    <div class="h-1 rounded-full bg-white/10 overflow-hidden mt-1.5"><div class="h-full rounded-full ${j.status === 'done' ? 'bg-green-500' : 'bg-accent'}" style="width:${pct}%"></div></div></div>
                    <div class="text-xs text-gray-400 w-10 text-right">${pct}%</div></div>`; };
            dashPaint('dh-dl', `<div class="dash-card p-5 h-full"><div class="flex items-center justify-between mb-2"><div class="text-xs font-bold tracking-[0.25em] uppercase text-gray-400"><i class="fas fa-cloud-arrow-down text-accent mr-2"></i>${active.length ? 'Downloading now' : 'Downloads'}</div>
                <button class="text-xs font-bold text-gray-400 hover:text-white" onclick="switchTab('dl-view','tab-dl')">${active.length ? 'Details' : 'Open'}</button></div>
                ${shown.length ? shown.map(dlRow).join('') : `<div class="py-6 text-center text-sm text-gray-500"><i class="fas fa-link text-2xl opacity-40 mb-3 block"></i>Nothing downloading. Paste a link in Downloads to grab a video, song or whole playlist.</div>`}</div>`);

            // ---- playlists ----
            const plTile = p => `<div class="pl-tile flex items-center gap-3 p-2 rounded-lg cursor-pointer" onclick="goPlaylist(${p.id})"><div class="h-12 w-12 flex-none rounded-md overflow-hidden">${plCover(p, 'h-12 w-12')}</div>
                <div class="min-w-0"><div class="font-semibold truncate text-sm">${esc(p.name)}</div><div class="text-xs text-gray-500">${p.count} song${p.count === 1 ? '' : 's'}</div></div></div>`;
            dashPaint('dh-pl', `<div class="dash-card p-5 h-full"><div class="flex items-center justify-between mb-2"><div class="text-xs font-bold tracking-[0.25em] uppercase text-gray-400"><i class="fas fa-list text-accent mr-2"></i>Your playlists</div>
                <button class="text-xs font-bold text-gray-400 hover:text-white" onclick="openNameModal('create')">Create new</button></div>
                ${pls.length ? `<div class="grid gap-1" style="grid-template-columns:repeat(auto-fill,minmax(13rem,1fr))">${pls.slice(0, 6).map(plTile).join('')}</div>`
                    : `<div class="py-6 text-center text-sm text-gray-500"><i class="fas fa-list text-2xl opacity-40 mb-3 block"></i>No playlists yet.</div>`}</div>`);

            // ---- new music + genre chips ----
            if (dashPaint('dh-newmusic', recentTracks.length ? `<section class="mb-10"><div class="flex items-baseline gap-5 mb-2 px-1"><h2 class="text-xl md:text-2xl font-bold text-lm-text">Music</h2><button class="home-link" onclick="shuffleAllMusic()">Shuffle</button><button class="home-link" onclick="switchTab('music-view','tab-music')">Open</button></div>
                <div id="dh-newmusic-row" class="hscroll flex overflow-x-auto hide-scrollbar -mx-1">${recentTracks.slice(0, 20).map((t, i) => trackCard(t, i)).join('')}</div></section>` : '')) rows.push('dh-newmusic-row');
            dashPaint('dh-genres', genres.length ? `<section class="mb-4"><h2 class="text-xl md:text-2xl font-bold text-lm-text mb-3">Jump to a genre</h2><div class="flex flex-wrap gap-2">${genres.map((g, i) => `<button class="chip" onclick="goGenre(${i})">${esc(g.name)} <span class="text-gray-400 ml-1">${g.count}</span></button>`).join('')}</div></section>` : '');

            // ---- photos (public) and the private shelf (only while the library is unlocked) ----
            ensureHomePhotos();
            const lim = HOME_TAB === 'photos' ? 40 : 14;
            const hpTile = (p, k, i, favs) => `<button class="hp-tile${p.fav && favOn(k === 'pub') ? ' is-fav' : ''}" style="width:${(9.5 * clamp((p.w || 4) / (p.h || 3), .6, 2.4)).toFixed(2)}rem" onclick="openHomePhoto('${k}',${i},this,${favs ? 1 : 0})"><img src="${phThumb(p)}" loading="lazy" decoding="async" alt=""></button>`;
            const photoShelf = (id, title, k, more, favs) => { const l = favs ? HP[k].items.filter(p => p.fav) : HP[k].items; return l.length ? sectionHtml(id, title, more, false, l.slice(0, lim).map((p, i) => hpTile(p, k, i, favs)).join('')) : ''; };
            const inPhotos = HOME_TAB === 'photos';
            if (dashPaint('dh-favs', inPhotos && favOn(true) ? photoShelf('dh-favs-row', 'Favorites', 'pub', `<button class="home-link" onclick="openFavorites('pub')">Open</button>`, true) : '')) rows.push('dh-favs-row');
            if (dashPaint('dh-photos', photoShelf('dh-photos-row', 'Photos', 'pub', `<button class="home-link" onclick="switchTab('photos-view','tab-photos')">Open</button>`))) rows.push('dh-photos-row');
            const pr = token ? vdata.private : null;
            let pv = [];
            if (pr) { const seen = new Set(); pv = (pr.continue || []).concat(pr.recent || []).filter(c => !seen.has(c.id) && seen.add(c.id)); if (!pv.length) pv = (pr.loose || []).slice(0, 20); }
            if (dashPaint('dh-priv', pr && pv.length ? sectionHtml('dh-priv-row', 'Private', `<button class="home-link" onclick="switchTab('private-view','tab-private')">Open</button><button class="home-link" onclick="lockNow()">Lock</button>`, false, cardsHtml(pv, 'private')) : '')) rows.push('dh-priv-row');
            if (dashPaint('dh-privfavs', token && inPhotos && favOn(false) ? photoShelf('dh-privfavs-row', 'Private favorites', 'priv', `<button class="home-link" onclick="openFavorites('priv')">Open</button>`, true) : '')) rows.push('dh-privfavs-row');
            if (dashPaint('dh-privphotos', token ? photoShelf('dh-privphotos-row', 'Private photos', 'priv', `<button class="home-link" onclick="switchTab('private-view','tab-private');privateMode('photos')">Open</button>`) : '')) rows.push('dh-privphotos-row');
            // a tab with nothing in it says so, and says what to do
            let none = '';
            if (HOME_TAB === 'photos' && HP.pub.t && !HP.pub.busy && !HP.pub.items.length && !(token && HP.priv.items.length)) none = '<b>No photos yet</b>Put pictures in media/Photos and they show up here.';
            else if (HOME_TAB === 'music' && f && !recentTracks.length) none = '<b>No music yet</b>Put songs in media/music, then choose Rescan in the menu.';
            dashPaint('dh-empty', none);
            if (rows.length) requestAnimationFrame(() => rows.forEach(updateArrows));
        }
        // ---- time of day: greeting, colour, big home clock ----
        const TIME_KF = [[0,[58,66,150]],[4.5,[78,72,160]],[6.5,[238,138,122]],[9,[240,188,108]],[12,[110,176,232]],[15.5,[236,158,88]],[18,[240,108,98]],[19.8,[168,78,150]],[21.5,[66,70,160]],[24,[58,66,150]]];
        function timeRGB(d) {
            const h = d.getHours() + d.getMinutes() / 60;
            for (let i = 1; i < TIME_KF.length; i++) {
                const [h1, c1] = TIME_KF[i];
                if (h <= h1) { const [h0, c0] = TIME_KF[i - 1], t = (h - h0) / (h1 - h0); return c0.map((v, k) => Math.round(v + (c1[k] - v) * t)); }
            }
            return TIME_KF[0][1];
        }
        const greetNow = hr => (hr < 5 || hr >= 21) ? 'Good night' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
        const greetIcon = hr => (hr < 5 || hr >= 21) ? 'fa-moon' : hr < 12 ? 'fa-sun' : hr < 17 ? 'fa-cloud-sun' : 'fa-cloud-moon';
        function hcParts(d) { const h = d.getHours(); return { h: String(h % 12 || 12), m: String(d.getMinutes()).padStart(2, '0'), ap: h < 12 ? 'AM' : 'PM' }; }
        let hcKey = '';
        function tickHome() {
            const now = new Date(), key = now.getHours() + ':' + now.getMinutes() + ':' + (prefs.bg_mode || '') + ':' + (prefs.home_clock ? 1 : 0);
            if (key === hcKey) return;
            hcKey = key;
            document.documentElement.style.setProperty('--tc', (prefs.bg_mode === 'time' ? timeRGB(now) : [232, 196, 112]).join(','));
            const set = (id, v) => { const e = $(id); if (e && e.textContent !== v) e.textContent = v; };
            set('hc-date', now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
            set('hc-greet', greetNow(now.getHours()));
            const ic = $('hc-icon'); if (ic) ic.className = 'fas ' + greetIcon(now.getHours());
            paintTimeBg();
        }
        function tickClock() { tickHome(); }
        setInterval(tickClock, 1000);
        function applyClock() { const c = $('corner-clock'); if (!c) return; c.classList.toggle('on', !!prefs.show_clock); document.body.classList.toggle('clock-on', !!prefs.show_clock);
            if (prefs.show_clock) { if (!c.firstChild) c.innerHTML = clockSVG({ style: prefs.clock_style || 'logo', size: 'mini', bare: true, id: 'kcorner' }); } else c.innerHTML = ''; tickClock(); tickAnalog(); }
        ['loadVideos', 'loadMusicFilters', 'loadPlaylists', 'loadRecent', 'pollDl'].forEach(n => {
            const o = window[n];
            window[n] = async function () { const r = await o.apply(this, arguments); dashSoon(); return r; };
        });


        // ======================= tidy toolbars: library panel + Manage menu =======================
        let musicAutoRail = false;
        function toggleLib(force) {
            const g = $('music-grid'); if (!g) return;
            const off = force == null ? !g.classList.contains('lib-off') : force;
            g.classList.toggle('lib-off', off);
            store.set('lmp_lib', off ? '0' : '1');
            $('lib-toggle').classList.toggle('text-accent', off);
            setTimeout(() => shelfIds.forEach(updateArrows), 50);
        }
        if (store.get('lmp_lib') !== '1') toggleLib(true);
        function closeManage() { const m = $('manage-menu'); if (m) m.remove(); }
        function openManage(ev, scope) {
            ev.stopPropagation(); const had = $('manage-menu'); closeManage(); if (had) return;
            const items = [['fa-folder-plus', 'New genre', `openGenreModal('${scope}')`], ['fa-folder-tree', 'Organize videos', `openOrganize('${scope}', {})`],
                           ['fa-layer-group', 'New series', `openOrganize('${scope}', { title: 'New series', focus: 'series' })`], ['fa-folder-open', 'Open videos folder', `openFolder('${scope}')`]];
            const m = document.createElement('div'); m.id = 'manage-menu';
            m.innerHTML = items.map(i => `<button onclick="closeManage();${i[2]}"><i class="fas ${i[0]}"></i>${i[1]}</button>`).join('');
            document.body.appendChild(m);
            const r = ev.currentTarget.getBoundingClientRect();
            m.style.top = Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 8) + 'px';
            m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
        }
        document.addEventListener('click', e => { if (!e.target.closest('#manage-menu')) closeManage(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeManage(); });
        document.addEventListener('keydown', e => {            // Ctrl+B hides / shows the main sidebar (Ctrl+Shift+B the music library)
            if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B') && !playingId) { e.preventDefault(); if (e.shiftKey) toggleLib(); else { musicAutoRail = false; toggleRail(); } }
        });


        // ======================= FOUNDER EDITION: command palette + shortcuts =======================
        let palSel = 0, palRows = [], palSongs = [], palTimer = 0, palSeq = 0;
        const palOpenNow = () => !$('palette').classList.contains('hidden');
        function openPalette() {
            if (playingId && !miniMode) return;
            $('palette').classList.remove('hidden'); $('pal-q').value = ''; palSongs = []; palSel = 0; paintPalette(); setTimeout(() => $('pal-q').focus(), 10);
        }
        function closePalette() { $('palette').classList.add('hidden'); }
        function openShortcuts() {
            const g = [['Everywhere', [['Search everything', 'Ctrl + K'], ['Open / close menu', 'M or Ctrl + B'], ['Hide / show music library', 'Ctrl + Shift + B'], ['Lock private library', 'Ctrl + L'], ['This sheet', '?']]],
                       ['Video player', [['Play / pause', 'Space or K'], ['Skip 10s back / forward', 'J / L'], ['Skip 5s', '\u2190 / \u2192'], ['Volume', '\u2191 / \u2193'], ['Fullscreen', 'F (or double-click)'], ['Mute', 'M'], ['Mini player', 'I'], ['Subtitles', 'C'], ['Next / previous episode', 'N / P'], ['Speed', '< / >'], ['Jump to 0-90%', '0 - 9'], ['Back out', 'Esc']]],
                       ['Photos', [['Next / previous', '\u2192 / \u2190'], ['Favorite', 'F'], ['Fullscreen', 'Enter'], ['Close', 'Esc']]],
                       ['Music', [['Play / pause', 'Space'], ['Next / previous song', 'Shift + \u2192 / \u2190'], ['Volume', 'Shift + \u2191 / \u2193']]], ['Rows', [['Scroll a row sideways', 'Mouse wheel'], ['Scroll the page instead', 'Hold Alt']]]];
            $('sc-body').innerHTML = g.map(([h, rows]) => `<div class="text-[11px] font-extrabold tracking-[.2em] uppercase text-gray-500 mt-5 mb-1">${h}</div>` + rows.map(r => `<div class="sc-row"><span>${r[0]}</span><kbd>${r[1]}</kbd></div>`).join('')).join('');
            $('shortcuts').classList.remove('hidden');
        }
        function closeShortcuts() { $('shortcuts').classList.add('hidden'); }
        function palIcon(i) { return `<div class="pi"><i class="fas ${i}"></i></div>`; }
        function buildPalRows(q) {
            const out = [], has = t => !q || String(t).toLowerCase().includes(q), d = vdata.public;
            const go = [['fa-house', 'Home', () => switchTab('home-view', 'tab-home')], ['fa-clapperboard', 'Cinema', () => switchTab('video-view', 'tab-video')],
                        ['fa-layer-group', 'Series', () => switchTab('series-view', 'tab-series')], ['fa-film', 'Videos', () => switchTab('videos-view', 'tab-videos')],
                        ['fa-music', 'Music', () => switchTab('music-view', 'tab-music')], ['fa-clock', 'Time: clocks, alarms, stopwatch, timer', () => switchTab('time-view', 'tab-time')], ['fa-image', 'Photos', () => switchTab('photos-view', 'tab-photos')], ['fa-cloud-arrow-down', 'Downloads', () => switchTab('dl-view', 'tab-dl')]];
            if (token) go.push(['fa-lock-open', 'Private', () => switchTab('private-view', 'tab-private')]);
            const act = [['fa-dice', 'Surprise me (random video)', () => surprise('public')], ['fa-shuffle', 'Shuffle all music', shuffleAllMusic],
                         ['fa-folder-plus', 'New genre', () => openGenreModal('public')], ['fa-list', 'New playlist', () => openNameModal('create')],
                         ['fa-rotate', 'Rescan media folders', rescan], ['fa-gear', 'Settings', openSettings], ['fa-angles-left', 'Open / close menu', () => toggleRail()],
                         ['fa-palette', 'Change background', quickTheme], ['fa-keyboard', 'Keyboard shortcuts', openShortcuts]];
            const grp = (title, rows) => { if (rows.length) { out.push({ h: title }); rows.forEach(r => out.push(r)); } };
            grp('Go to', go.filter(g => has(g[1])).slice(0, q ? 6 : 7).map(g => ({ icon: palIcon(g[0]), label: g[1], run: g[2] })));
            if (q) {
                const vids = ((d && d.loose) || []).filter(v => has(v.title)).slice(0, 6).map(v => ({ icon: `<div class="pi"><img src="${v.poster}" alt="" loading="lazy" decoding="async"></div>`, label: v.title, sub: v.genre || 'Video', run: () => playVideo(v.id) }));
                const ser = ((d && d.all_series) || []).filter(v => has(v.title)).slice(0, 4).map(v => ({ icon: `<div class="pi"><img src="${v.poster}" alt="" loading="lazy" decoding="async"></div>`, label: v.title, sub: v.episodes + ' episodes', run: () => openSeries(v.id, 'public') }));
                const pls = playlists.filter(p => !p.liked && has(p.name)).slice(0, 4).map(p => ({ icon: `<div class="pi">${plCover(p, 'h-9 w-9')}</div>`, label: p.name, sub: p.count + ' songs', run: () => goPlaylist(p.id) }));
                const songs = palSongs.map((t, i) => ({ icon: `<div class="pi">${coverBox([t.id], 'h-9 w-9')}</div>`, label: t.title, sub: t.artist, run: () => playList(palSongs, i) }));
                grp('Videos', vids); grp('Series', ser); grp('Playlists', pls); grp('Songs', songs);
            }
            grp('Actions', act.filter(a => has(a[1])).slice(0, q ? 4 : 8).map(a => ({ icon: palIcon(a[0]), label: a[1], run: a[2] })));
            return out;
        }
        function paintPalette() {
            const q = $('pal-q').value.trim().toLowerCase();
            const rows = buildPalRows(q); palRows = rows.filter(r => !r.h);
            palSel = Math.min(palSel, Math.max(0, palRows.length - 1));
            let n = -1;
            $('pal-list').innerHTML = palRows.length ? rows.map(r => r.h ? `<div class="pal-h">${r.h}</div>` : (n++, `<div class="pal-row ${n === palSel ? 'sel' : ''}" data-i="${n}" onmousemove="palHover(${n})" onclick="palRun(${n})">${r.icon}<div class="min-w-0 flex-1"><div class="font-semibold truncate">${esc(r.label)}</div>${r.sub ? `<div class="text-xs text-gray-500 truncate">${esc(r.sub)}</div>` : ''}</div><i class="fas fa-turn-down fa-rotate-90 text-xs text-gray-600"></i></div>`)).join('')
                : '<div class="py-10 text-center text-gray-500 text-sm">Nothing matches. Try a title, a genre or an artist.</div>';
        }
        function palHover(i) { if (i === palSel) return; palSel = i; document.querySelectorAll('#pal-list .pal-row').forEach(r => r.classList.toggle('sel', Number(r.dataset.i) === i)); }
        function palRun(i) { const r = palRows[i]; if (!r) return; closePalette(); setTimeout(r.run, 30); }
        $('pal-q').addEventListener('input', () => {
            palSel = 0; paintPalette(); clearTimeout(palTimer);
            const q = $('pal-q').value.trim();
            if (q.length < 2) { palSongs = []; return; }
            const my = ++palSeq;
            palTimer = setTimeout(async () => {
                try { const r = await post('/api/playlist', { mode: 'all', q, language: 'any', genre: 'mix', limit: 6 }); if (my === palSeq) { palSongs = r.tracks || []; paintPalette(); } } catch (e) {}
            }, 220);
        });
        $('pal-q').addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.stopPropagation(); closePalette(); return; }
            const mv = d => { palSel = (palSel + d + palRows.length) % Math.max(1, palRows.length); paintPalette(); const el = document.querySelector('#pal-list .pal-row.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); };
            if (e.key === 'ArrowDown') { e.preventDefault(); mv(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); mv(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); palRun(palSel); }
        });
        document.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palOpenNow() ? closePalette() : openPalette(); return; }
            if (e.key === 'Escape' && !$('shortcuts').classList.contains('hidden')) { closeShortcuts(); return; }
            const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
            if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey && !(playingId && !miniMode)) { e.preventDefault(); openShortcuts(); }
        });


        // ======================= v8: theme, hover previews, Now Playing =======================
        // ======================= background: Dark / Light / Colorful (your image) / Sync with time =======================
        // One fixed layer behind everything. It never reacts to the tab you are on, so nothing fades or changes colour when you navigate.
        const BG_MODES = ['dark', 'light', 'colorful', 'time'];
        const BG_NAMES = { dark: 'Dark', light: 'Light', colorful: 'Colorful', time: 'Sync with time' };
        const BG_ICON = { dark: 'fa-moon', light: 'fa-sun', colorful: 'fa-palette', time: 'fa-clock' };
        const BG_PRESETS = {
            aurora: 'linear-gradient(135deg,#0f2027 0%,#1b6b74 36%,#4b3b8f 70%,#a24bb5 100%)',
            sunset: 'linear-gradient(160deg,#2b1055 0%,#7a2e7a 38%,#e4577a 70%,#f7a35c 100%)',
            ocean:  'linear-gradient(160deg,#021b3a 0%,#0b4f8a 45%,#1fa2c9 80%,#7be0d0 100%)',
            orchid: 'linear-gradient(135deg,#1a0b2e 0%,#5b2a86 45%,#c56cd6 100%)',
            ember:  'linear-gradient(150deg,#1a0a0a 0%,#7a1f1f 45%,#e8743b 85%,#ffc27a 100%)',
            forest: 'linear-gradient(150deg,#06140f 0%,#14532d 50%,#5fa86b 100%)'
        };
        function effectiveTheme() { return prefs.bg_mode === 'light' ? 'light' : 'dark'; }
        function paintTimeBg() {
            if (prefs.bg_mode !== 'time') return;
            const L = $('bg-layer'); if (!L) return;
            const c = timeRGB(new Date()), put = () => { L.style.setProperty('--bgr', c[0]); L.style.setProperty('--bgg', c[1]); L.style.setProperty('--bgb', c[2]); };
            if (!paintTimeBg.seeded) { L.style.transition = 'none'; put(); void L.offsetWidth; L.style.transition = ''; paintTimeBg.seeded = true; }
            else put();                                  // later minutes glide in slowly (see #bg-layer transition)
        }
        function applyBackground() {
            const mode = BG_MODES.includes(prefs.bg_mode) ? prefs.bg_mode : 'dark', de = document.documentElement;
            de.setAttribute('data-bg', mode); de.setAttribute('data-theme', mode === 'light' ? 'light' : 'dark');
            try { localStorage.setItem('lmp_bg', mode); } catch (e) {}
            const L = $('bg-layer');
            if (L && mode === 'colorful') {
                const bi = prefs.bg_image || '';
                let v;
                if (bi === 'custom' && prefs.bg_custom_v) v = `url("/background-image?v=${prefs.bg_custom_v}")`;
                else v = BG_PRESETS[bi.startsWith('preset:') ? bi.slice(7) : 'aurora'] || BG_PRESETS.aurora;
                if (L.dataset.pic !== v) { L.dataset.pic = v; L.style.setProperty('--bg-pic', v); }
            }
            if (mode === 'time') paintTimeBg();
            const b = $('theme-btn'); if (b) { b.innerHTML = `<i class="fas ${BG_ICON[mode]}"></i>`; b.title = 'Background: ' + BG_NAMES[mode] + ' (click to change)'; }
            syncInPlayer();
        }
        function quickTheme() { const i = BG_MODES.indexOf(prefs.bg_mode || 'dark'); setPref({ bg_mode: BG_MODES[(i + 1) % BG_MODES.length] }); }
        function setClockStyle(k) { setPref({ clock_style: k }); }
        function paintClockStyles() { const b = $('set-clockstyle'); if (b && window.ckStyleTiles) b.innerHTML = ckStyleTiles(prefs.clock_style || 'logo', 'setClockStyle'); }
        function paintBgImages() {
            const box = $('set-bg-img'); if (!box) return;
            const on = prefs.bg_mode === 'colorful'; box.classList.toggle('hidden', !on); if (!on) return;
            const cur = prefs.bg_image || '', has = !!prefs.bg_custom_v;
            let h = '';
            if (has) h += `<button class="bg-thumb ${cur === 'custom' ? 'on' : ''}" style="background-image:url('/background-image?v=${prefs.bg_custom_v}')" title="Your image" onclick="setPref({bg_image:'custom'})"></button>`;
            h += Object.keys(BG_PRESETS).map(k => `<button class="bg-thumb ${(cur === 'preset:' + k || ((!cur || (cur === 'custom' && !has)) && k === 'aurora')) ? 'on' : ''}" style="background-image:${BG_PRESETS[k]}" title="${k}" onclick="setPref({bg_image:'preset:${k}'})"></button>`).join('');
            h += `<button class="bg-add" onclick="$('bg-file').click()"><i class="fas fa-image"></i>Choose image</button>`;
            if (has) h += `<button class="bg-add" onclick="removeBgImage()">Remove mine</button>`;
            $('set-bg-pick').innerHTML = h;
        }
        async function pickBgImage(inp) {
            const f = inp.files && inp.files[0]; inp.value = ''; if (!f) return;
            if (f.size > 25 * 1024 * 1024) { toast('Choose a picture under 25 MB.'); return; }
            try { applyPrefs(await api('/api/background', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f })); paintSettings(); }
            catch (e) { toast((e.data && e.data.error) || 'Could not use that picture.'); }
        }
        async function removeBgImage() { try { applyPrefs(await api('/api/background', { method: 'DELETE' })); paintSettings(); } catch (e) {} }

        // ======================= analog clocks: several designs, any time zone =======================
        const CLOCK_STYLES = { logo: 'Logo', gold: 'Gold', light: 'Light', dark: 'Dark', emerald: 'Emerald', minimal: 'Minimal' };
        const CK = {
            logo:    { bezel: 'steelD', dial: ['#111114', '#000000'], num: '#ffffff', tick: '#ffffff', ring: 'rgba(255,255,255,.22)', hands: '#ffffff', sec: '#f5821f', fw: 700, photo: true },
            gold:    { bezel: 'gold',  dial: ['#2a2a2e', '#060607'], num: '#ecca78', tick: '#e3c06d', ring: 'rgba(227,192,109,.5)', hands: 'gold', lume: '#efe6c4', sec: '#f0d58c', fw: 500, deco: true },
            emerald: { bezel: 'gold',  dial: ['#15805a', '#04271a'], num: '#f0d58c', tick: '#e3c06d', ring: 'rgba(240,213,140,.5)', hands: 'gold', lume: '#efe6c4', sec: '#f0d58c', fw: 500, deco: true },
            light:   { bezel: 'steelL', dial: ['#ffffff', '#f0f0f3'], num: '#1d1d1f', tick: '#2b2b2e', ring: '#d9d9de', hands: '#17171a', sec: '#e5484d', fw: 600 },
            dark:    { bezel: 'steelD', dial: ['#26262b', '#0b0b0d'], num: '#f4f4f6', tick: '#e8e8ec', ring: 'rgba(255,255,255,.14)', hands: '#f4f4f6', sec: '#f5821f', fw: 600 },
            minimal: { bezel: 'none',  dial: ['rgba(255,255,255,.05)', 'rgba(255,255,255,.015)'], num: 'rgba(255,255,255,.92)', tick: 'rgba(255,255,255,.55)', ring: 'rgba(255,255,255,.38)', hands: '#ffffff', sec: '#ff5b4d', fw: 300 }
        };
        const _tzc = {}, _tzf = {};
        function tzOffsetMs(tz) {                          // offset of a time zone from UTC in ms ('' = this computer's zone)
            if (!tz) return -new Date().getTimezoneOffset() * 60000;
            const now = Date.now(), c = _tzc[tz];
            if (c && now - c.t < 20000) return c.v;
            try {
                const f = _tzf[tz] || (_tzf[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
                const p = {}; f.formatToParts(new Date(now)).forEach(x => { p[x.type] = +x.value; });
                const v = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(now / 1000) * 1000;
                _tzc[tz] = { t: now, v }; return v;
            } catch (e) { return -new Date().getTimezoneOffset() * 60000; }
        }
        function clockParts(tz) {                          // wall-clock parts in a zone; seconds advance in 1/8 steps like a quartz-free watch
            const d = new Date(Date.now() + tzOffsetMs(tz));
            return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() + Math.floor(d.getUTCMilliseconds() / 125) * 0.125, day: d.getUTCDate(), dow: d.getUTCDay(), t: d.getTime() };
        }
        function isDayAt(tz) { const h = clockParts(tz).h; return h >= 6 && h < 18; }
        function clockSVG(o) {
            o = o || {};
            let style = o.style || 'gold', auto = false;
            if (style === 'auto') style = 'logo';   // old day/night "Auto" setting now means the logo face
            const S = CK[style] || CK.gold, size = o.size || 'full', full = size === 'full', mini = size === 'mini';
            const id = o.id || ('k' + (clockSVG.n = (clockSVG.n || 0) + 1)), P = (r, a) => [200 + r * Math.sin(a), 200 - r * Math.cos(a)], f1 = n => n.toFixed(1);
            const gold = S.hands === 'gold', dialR = S.bezel === 'gold' ? 176 : S.bezel === 'none' ? 188 : 182, tr = dialR - 4;
            const at = o.at ? { h: o.at[0], m: o.at[1], s: o.at[2] } : o.bare ? { h: 0, m: 0, s: 0, day: '' } : clockParts(o.tz || '');
            const rot = a => `rotate(${a.toFixed(2)} 200 200)`;
            let bez = '';
            if (S.bezel === 'gold') bez = `<circle cx="200" cy="200" r="197" fill="url(#g${id})"/><circle cx="200" cy="200" r="190" fill="none" stroke="rgba(0,0,0,.34)" stroke-width="13" stroke-dasharray="2.6 4.03"/><circle cx="200" cy="200" r="182" fill="#140f04"/>`;
            else if (S.bezel === 'steelL') bez = `<circle cx="200" cy="200" r="197" fill="url(#b${id})"/><circle cx="200" cy="200" r="188" fill="#e9e9ed"/>`;
            else if (S.bezel === 'steelD') bez = `<circle cx="200" cy="200" r="197" fill="url(#b${id})"/><circle cx="200" cy="200" r="189" fill="#08080a"/>`;
            else bez = `<circle cx="200" cy="200" r="196" fill="none" stroke="${S.ring}" stroke-width="3"/>`;
            let ticks = '', nums = '', sun = '';
            for (let i = 0; i < 60; i++) {
                const big = i % 5 === 0; if (mini && !big) continue;
                const a = i * Math.PI / 30, p1 = P(tr, a), p2 = P(big ? tr - 16 : tr - 8, a);
                ticks += `M${f1(p1[0])} ${f1(p1[1])}L${f1(p2[0])} ${f1(p2[1])}`;
            }
            const nr = dialR * (full ? .72 : mini ? .66 : .7), fs = full ? (gold ? 42 : 46) : mini ? 70 : 54;
            for (let n = 1; n <= 12; n++) {
                if (mini && n % 3) continue;
                const p = P(nr, n * Math.PI / 6);
                nums += `<text x="${f1(p[0])}" y="${f1(p[1])}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" font-weight="${S.fw}" fill="${S.num}"${S.photo ? ' stroke="#000" stroke-opacity=".75" stroke-width="5" stroke-linejoin="round" paint-order="stroke"' : ''} font-family="Inter,'Segoe UI',Arial,sans-serif">${n}</text>`;
            }
            if (full && S.deco) for (let i = 0; i < 180; i++) { const a = i * Math.PI / 90, p1 = P(26, a), p2 = P(tr, a); sun += `M${f1(p1[0])} ${f1(p1[1])}L${f1(p2[0])} ${f1(p2[1])}`; }
            const hubC = gold ? `url(#g${id})` : S.hands;
            const hands = gold
                ? `<g class="rx-h" transform="${rot(((at.h % 12) + at.m / 60 + at.s / 3600) * 30)}"><path d="M195.5 222L204.5 222L203 140L197 140Z" fill="url(#g${id})" stroke="#4a3510"/><circle cx="200" cy="122" r="17" fill="#0b0b0c" stroke="url(#g${id})" stroke-width="5"/><circle cx="200" cy="122" r="10.5" fill="${S.lume}"/><path d="M200 122V107M200 122L187 129.5M200 122L213 129.5" stroke="#0b0b0c" stroke-width="2.4"/></g>
                   <g class="rx-m" transform="${rot((at.m + at.s / 60) * 6)}"><path d="M194.5 224L205.5 224L203.2 52L200 34L196.8 52Z" fill="url(#g${id})" stroke="#4a3510"/><path d="M198.2 214L201.8 214L201.3 62L198.7 62Z" fill="${S.lume}"/></g>`
                : `<g class="rx-h" transform="${rot(((at.h % 12) + at.m / 60 + at.s / 3600) * 30)}"><rect x="191.5" y="${mini ? 104 : 112}" width="17" height="${mini ? 126 : 118}" rx="8.5" fill="${S.hands}"${S.photo ? ' stroke="#000" stroke-opacity=".7" stroke-width="3"' : ''}/></g>
                   <g class="rx-m" transform="${rot((at.m + at.s / 60) * 6)}"><rect x="194.5" y="${mini ? 52 : 50}" width="11" height="${mini ? 178 : 180}" rx="5.5" fill="${S.hands}"${S.photo ? ' stroke="#000" stroke-opacity=".7" stroke-width="3"' : ''}/></g>`;
            const sec = `<g class="rx-s" transform="${rot(at.s * 6)}"><rect x="198.2" y="${mini ? 36 : 34}" width="3.6" height="${mini ? 228 : 230}" rx="1.8" fill="${S.sec}"/>${gold ? `<circle cx="200" cy="90" r="6.5" fill="${S.lume}" stroke="${S.sec}" stroke-width="2"/>` : ''}</g>`;
            const o2 = JSON.stringify({ style: o.style || 'gold', size, tz: o.tz || '' }).replace(/"/g, '&quot;');
            return `<svg class="rx${S.photo ? ' rx-logo' : ''}${mini ? ' mini' : ''}${o.at ? ' rx-static' : ''}" viewBox="0 0 400 400" role="img" aria-label="Clock" data-tz="${esc(o.tz || '')}" data-o="${o2}"${auto ? ` data-auto="1" data-day="${style === 'light' ? 1 : 0}"` : ''}><defs>
                <linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff1bf"/><stop offset=".28" stop-color="#d9ab45"/><stop offset=".55" stop-color="#8a5f17"/><stop offset=".78" stop-color="#e8c36a"/><stop offset="1" stop-color="#7a5212"/></linearGradient>
                <linearGradient id="b${id}" x1="0" y1="0" x2="1" y2="1">${S.bezel === 'steelL' ? '<stop offset="0" stop-color="#fafafa"/><stop offset=".5" stop-color="#a9a9b2"/><stop offset="1" stop-color="#f1f1f4"/>' : '<stop offset="0" stop-color="#5a5a62"/><stop offset=".5" stop-color="#17171b"/><stop offset="1" stop-color="#4a4a52"/>'}</linearGradient>
                <radialGradient id="d${id}" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="${S.dial[0]}"/><stop offset="1" stop-color="${S.dial[1]}"/></radialGradient>
                <linearGradient id="s${id}" x1="0" y1="0" x2=".5" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${style === 'light' ? .5 : .15}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
                <radialGradient id="v${id}" cx=".5" cy=".5" r=".5"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>
                <clipPath id="c${id}"><circle cx="200" cy="200" r="${dialR}"/></clipPath></defs>
                ${bez}<circle cx="200" cy="200" r="${dialR}" fill="url(#d${id})"/>
                ${S.photo ? `<image href="/logo.png" x="${200 - dialR}" y="${200 - dialR}" width="${dialR * 2}" height="${dialR * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c${id})"/><circle cx="200" cy="200" r="${dialR}" fill="url(#v${id})"/>` : ''}
                ${sun ? `<path d="${sun}" stroke="#fff" stroke-opacity=".04" stroke-width=".7" fill="none"/>` : ''}
                ${gold || style === 'minimal' ? '' : ''}<circle cx="200" cy="200" r="${tr - 2}" fill="none" stroke="${S.ring}" stroke-width="1"/>
                ${S.photo ? `<path d="${ticks}" stroke="#000" stroke-opacity=".7" stroke-width="${mini ? 8 : 6.2}" fill="none" stroke-linecap="round"/>` : ''}<path d="${ticks}" stroke="${S.tick}" stroke-width="${mini ? 5 : 3.2}" fill="none" stroke-linecap="round"/>${nums}
                ${full && gold ? `<text x="200" y="154" text-anchor="middle" font-size="10.5" letter-spacing="3.6" fill="#d9b562" fill-opacity=".85" font-family="Inter,'Segoe UI',sans-serif" font-weight="600">LOCAL MEDIA</text>
                <rect x="177" y="256" width="46" height="29" rx="3" fill="#f4efe0" stroke="#d9ab45" stroke-width="3"/><text class="rx-d" x="200" y="271" text-anchor="middle" dominant-baseline="central" font-size="19" font-weight="700" fill="#141414" font-family="Inter,'Segoe UI',sans-serif">${at.day || ''}</text>` : ''}
                ${hands}${sec}
                <circle cx="200" cy="200" r="${gold ? 10 : 11}" fill="${hubC}"/><circle cx="200" cy="200" r="${gold ? 3.6 : 5}" fill="${gold ? '#0b0b0c' : S.sec}"/>
                <ellipse cx="148" cy="98" rx="122" ry="64" transform="rotate(-30 148 98)" fill="url(#s${id})" clip-path="url(#c${id})"/></svg>`;
        }
        function tickAnalog() {
            const els = document.querySelectorAll('svg.rx:not(.rx-static)'); if (!els.length) return;
            const cache = {}, rot = a => `rotate(${a.toFixed(2)} 200 200)`;
            els.forEach(el => {
                const tz = el.dataset.tz || '', p = cache[tz] || (cache[tz] = clockParts(tz));
                if (el.dataset.auto === '1' && (p.h >= 6 && p.h < 18) !== (el.dataset.day === '1')) {      // day <-> night: swap the dial
                    try { const t = document.createElement('template'); t.innerHTML = clockSVG(JSON.parse(el.dataset.o)); el.replaceWith(t.content.firstElementChild); return; } catch (e) {}
                }
                const h = el.querySelector('.rx-h'), m = el.querySelector('.rx-m'), s = el.querySelector('.rx-s'); if (!h || !m || !s) return;
                h.setAttribute('transform', rot(((p.h % 12) + p.m / 60 + p.s / 3600) * 30));
                m.setAttribute('transform', rot((p.m + p.s / 60) * 6));
                s.setAttribute('transform', rot(p.s * 6));
                const d = el.querySelector('.rx-d'); if (d && d.textContent !== String(p.day)) d.textContent = p.day;
            });
        }
        setInterval(() => { if (!document.hidden) tickAnalog(); }, 125);     // no clock redraws while the window is minimised
        function syncInPlayer() { document.documentElement.classList.toggle('in-player', !!(playingId && !miniMode && !pm.classList.contains('hidden'))); }
        function applyTheme() { applyBackground(); }
        new MutationObserver(syncInPlayer).observe(pm, { attributes: true, attributeFilter: ['class'] });

        // ---- hover previews ----
        let hpTimer = 0, hpCard = null, hpVideo = null;
        function hpStop() { clearTimeout(hpTimer); hpTimer = 0; if (hpVideo) { hpVideo.pause(); hpVideo.removeAttribute('src'); hpVideo.remove(); hpVideo = null; } hpCard = null; }
        function hpResolve(card) {
            if (card.dataset.id) return { id: card.dataset.id, scope: scopeOf(card.dataset.id) };
            if (card.dataset.coll != null) { const f = window.ubhCollFirst && window.ubhCollFirst(card.dataset.coll); return f ? { id: f, scope: 'public' } : null; }
            const sid = card.dataset.sid;
            for (const scope of ['public', 'private']) { const d = vdata[scope], s = d && (d.all_series || []).find(x => x.id === sid); if (s && s.resume) return { id: s.resume, scope }; }
            return null;
        }
        function hpStart(card) {
            if (hpCard !== card || playingId || prefs.hover_preview === false) return;
            if (card.classList.contains('utile') && !prefs.tile_motion) return;   // square tiles only move when Settings > Moving picture on tile hover is on
            const r = hpResolve(card), img = card.querySelector('img'), host = card.querySelector('.ut-cover');
            if (!r || (!img && !host)) return;
            const v = document.createElement('video');
            v.className = 'hp-video'; v.muted = true; v.playsInline = true; v.preload = 'auto';
            const url = `/media/video/${r.id}`; v.src = r.scope === 'private' ? withToken(url) : url;
            v.addEventListener('loadedmetadata', () => { const d = v.duration; if (d > 45) v.currentTime = Math.min(d * 0.22, d - 30); v.play().catch(() => {}); });
            v.addEventListener('playing', () => v.classList.add('on'));
            if (host) host.appendChild(v); else img.after(v);
            hpVideo = v;
            setTimeout(() => { if (hpVideo === v) { v.classList.remove('on'); v.pause(); } }, 15000);
        }
        document.addEventListener('mouseover', e => {
            if (playingId) return;
            const card = e.target.closest && e.target.closest('.video-card, .ubh-coll.utile');
            if (card === hpCard) return;
            hpStop();
            if (card && (card.classList.contains('utile') ? !prefs.tile_motion : prefs.hover_preview === false)) return;
            if (card) { hpCard = card; hpTimer = setTimeout(() => hpStart(card), 800); }
        });
        document.addEventListener('mouseout', e => { if (hpCard && (!e.relatedTarget || !hpCard.contains(e.relatedTarget))) hpStop(); });
        window.addEventListener('wheel', hpStop, { passive: true });

        // ---- Now Playing (full screen) ----
        const npOpen = () => !$('nowplaying').classList.contains('hidden');
        let npSeeking = false, npLastId = null;
        function openNowPlaying() { if (!nowId || (playingId && !miniMode)) return; $('nowplaying').classList.remove('hidden'); npLastId = null; paintNowPlaying(); }
        function closeNowPlaying() { $('nowplaying').classList.add('hidden'); }
        function npColor(img) {
            try {
                const c = document.createElement('canvas'); c.width = c.height = 24; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 24, 24);
                const d = g.getImageData(0, 0, 24, 24).data; let R = 0, G = 0, B = 0, W = 0;
                for (let i = 0; i < d.length; i += 4) { const r = d[i], gg = d[i + 1], b = d[i + 2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), sat = mx ? (mx - mn) / mx : 0, w = 0.05 + sat * sat * (mx / 255); R += r * w; G += gg * w; B += b * w; W += w; }
                let r = R / W, g2 = G / W, b = B / W; const m = Math.max(r, g2, b) || 1, k = Math.min(1.8, 215 / m);   // lift dark covers so the accent stays visible
                return [Math.round(r * k), Math.round(g2 * k), Math.round(b * k)];
            } catch (e) { return [228, 30, 43]; }
        }
        function npApplyColor() {
            const [r, g, b] = npColor($('npg-cover'));
            const n = $('nowplaying'); n.style.setProperty('--npc', `rgb(${r},${g},${b})`); n.style.setProperty('--npc-glow', `rgba(${r},${g},${b},.55)`);
            $('npg-glow').style.background = `radial-gradient(60% 70% at 28% 40%, rgba(${r},${g},${b},.50), transparent 70%), radial-gradient(50% 50% at 85% 90%, rgba(${r},${g},${b},.25), transparent 70%)`;
            paintRange($('npg-seek')); paintRange($('npg-vol'));
        }
        function paintNPModes() {
            if (!npOpen()) return;
            $('npg-shuffle').classList.toggle('on', shuffleOn);
            const r = $('npg-repeat'); r.classList.toggle('on', repeatMode !== 'off');
            r.innerHTML = repeatMode === 'one' ? '<i class="fas fa-repeat"></i><span class="absolute -mt-5 ml-4 text-[9px] font-black">1</span>' : '<i class="fas fa-repeat"></i>';
        }
        function paintNowPlaying() {
            const t = curTrack(); if (!t || !npOpen()) return;
            if (npLastId !== t.id) {
                npLastId = t.id;
                $('npg-title').textContent = t.title; $('npg-artist').textContent = t.artist || ''; $('npg-album').textContent = t.album || '';
                $('npg-cover').src = t.cover; $('npg-bgimg').src = t.cover;
                $('npg-heart').innerHTML = heartHtml(t.id);
                const up = order.slice(pos + 1, pos + 4).map(i => queue[i]).filter(Boolean);
                $('npg-up').innerHTML = up.length ? '<div class="text-[11px] font-bold tracking-[.25em] uppercase text-white/45 mb-1">Up next</div>' + up.map((u, i) => `<div class="npg-up" onclick="jumpTo(${pos + 1 + i})"><div class="min-w-0"><div class="text-sm font-semibold truncate">${esc(u.title)}</div><div class="text-xs text-white/50 truncate">${esc(u.artist || '')}</div></div></div>`).join('') : '';
            }
            $('npg-play-icon').className = 'fas ml-0 ' + (audio.paused ? 'fa-play ml-1' : 'fa-pause');
            paintNPModes(); npTime(); $('npg-vol').value = Math.round((audio.muted ? 0 : audio.volume) * 100); paintRange($('npg-vol'));
        }
        function npTime() {
            if (!npOpen()) return;
            $('npg-cur').textContent = fmtTime(audio.currentTime); $('npg-dur').textContent = fmtTime(audio.duration || 0);
            if (!npSeeking && audio.duration) { $('npg-seek').value = Math.round(audio.currentTime / audio.duration * 1000); paintRange($('npg-seek')); }
        }
        $('npg-cover').addEventListener('load', npApplyColor);
        $('npg-seek').addEventListener('input', () => { npSeeking = true; userSeek = true; paintRange($('npg-seek')); $('npg-cur').textContent = fmtTime($('npg-seek').value / 1000 * (audio.duration || 0)); });
        $('npg-seek').addEventListener('change', () => { if (audio.duration) userSeekTo($('npg-seek').value / 1000 * audio.duration); npSeeking = false; });
        $('npg-vol').addEventListener('input', () => { audio.volume = $('npg-vol').value / 100; audio.muted = false; paintAudioVol(); paintRange($('npg-vol')); });
        ['play', 'pause', 'loadedmetadata'].forEach(ev => audio.addEventListener(ev, paintNowPlaying));
        audio.addEventListener('timeupdate', npTime);
        audio.addEventListener('volumechange', () => { if (npOpen()) { $('npg-vol').value = Math.round((audio.muted ? 0 : audio.volume) * 100); paintRange($('npg-vol')); } });
        ['startCurrent', 'paintModes', 'playVideo'].forEach(n => {
            const o = window[n];
            window[n] = function () { const r = o.apply(this, arguments); if (n === 'playVideo') closeNowPlaying(); else setTimeout(paintNowPlaying, 0); return r; };
        });
        document.addEventListener('keydown', e => {
            if (!npOpen()) return;
            if (e.key === 'Escape') { closeNowPlaying(); return; }
            if (e.key === ' ' && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) { e.preventDefault(); togglePlay(); }
        });

        // ======================= start =======================
        window.onload = async () => {
            syncWheelBtn(); paintModes(); paintAudioVol();
            try { applyPrefs(await api('/api/prefs')); applyVolumes(); } catch (e) {}
            buildView('public'); buildSections(); buildHome();
            loadVideos('public'); loadMusicFilters(); loadPlaylists(); loadRecent(); pollDl();
            let unlocked = false;
            try {
                const s = await api('/api/lock/status');
                hasPassword = s.has_password;
                unlocked = !!(token && s.unlocked);
                if (token && !unlocked) setToken(null);
            } catch (e) { console.error(e); }
            if (unlocked) await enterPrivate(token, true);
            const tab = prefs.start_tab === 'video' ? 'video-view' : prefs.start_tab === 'music' ? 'music-view' : prefs.start_tab === 'home' ? 'home-view' : (store.get(TAB_KEY) || 'home-view');
            if (tab === 'home-view') switchTab('home-view', 'tab-home');
            else if (tab === 'video-view') switchTab('video-view', 'tab-video');
            else if (tab === 'music-view') switchTab('music-view', 'tab-music');
            else if (tab === 'dl-view') switchTab('dl-view', 'tab-dl');
            else if (tab === 'time-view') switchTab('time-view', 'tab-time');
            else if (tab === 'photos-view') switchTab('photos-view', 'tab-photos');
            else if (tab === 'series-view') switchTab('series-view', 'tab-series');
            else if (tab === 'videos-view') switchTab('videos-view', 'tab-videos');
            else if (tab === 'private-view' && unlocked) switchTab('private-view', 'tab-private');
        };
    
