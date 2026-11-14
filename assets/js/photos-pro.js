/* ULTRON photos: make albums, select + sort photos, zoom/pan in the viewer, and a full photo editor
   (crop, rotate, flip, resize, sliders, filters). Loaded after app.js and uses its globals ($, api, post, PH, LB, ...). */
(function () {
    'use strict';

    const scopeBase = pub => pub ? '/api/pphotos' : '/api/photos';
    const inGallery = () => (typeof currentView !== 'undefined') && (currentView === 'photos-view' || currentView === 'private-view') && !!phBox();
    const isRealAlbum = () => !!PH.album && PH.album !== 'all' && PH.album !== '__fav';
    const mk = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

    // ====================================================================== album modal (new / add to / rename)
    let modal = null, modalCfg = null;
    function buildModal() {
        modal = mk('div'); modal.id = 'px-album-modal';
        modal.innerHTML = `<div class="px-card"><h3 id="pxm-t"></h3><p id="pxm-s"></p>
            <label for="pxm-in">Album name</label>
            <input id="pxm-in" class="px-input" maxlength="80" autocomplete="off" spellcheck="false">
            <div class="px-chips" id="pxm-chips"></div><div class="px-err" id="pxm-err"></div>
            <div class="px-row"><button class="px-pill" id="pxm-x">Cancel</button><button class="px-pill hot" id="pxm-ok">Save</button></div></div>`;
        document.body.appendChild(modal);
        modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });
        $('pxm-x').onclick = closeModal;
        $('pxm-ok').onclick = submitModal;
    }
    function openModal(cfg) {
        if (!modal) buildModal();
        modalCfg = cfg;
        const n = (cfg.ids || []).length;
        $('pxm-t').textContent = cfg.mode === 'rename' ? 'Rename album' : n ? `Add ${n} photo${n === 1 ? '' : 's'} to an album` : 'New album';
        $('pxm-s').textContent = cfg.mode === 'rename' ? 'Only the album name changes. Your photos are not touched.'
            : n ? 'Type a new name to make an album, or pick one you already have.' : 'Makes an empty album. Fill it later with Select > Add to album.';
        $('pxm-ok').textContent = cfg.mode === 'rename' ? 'Rename' : n ? 'Add' : 'Create';
        const inp = $('pxm-in'); inp.value = cfg.mode === 'rename' ? cfg.name : ''; $('pxm-err').textContent = '';
        const names = (cfg.mode !== 'rename' && PH.loaded && PH.pub === cfg.pub ? (PH.albums || []) : []).map(a => a.name);
        $('pxm-chips').innerHTML = n ? names.map(x => `<button type="button" class="px-chip">${esc(x)}</button>`).join('') : '';
        $('pxm-chips').querySelectorAll('.px-chip').forEach(b => b.onclick = () => { inp.value = b.textContent; submitModal(); });
        modal.classList.add('on');
        window.__pxEd = e => {                                   // owns the keyboard while the box is open
            if (e.key === 'Escape') closeModal(); else if (e.key === 'Enter') submitModal();
        };
        setTimeout(() => { inp.focus(); inp.select(); }, 30);
    }
    function closeModal() { if (modal) modal.classList.remove('on'); if (!E.on) window.__pxEd = null; modalCfg = null; }
    async function submitModal() {
        if (!modalCfg) return;
        const cfg = modalCfg, name = $('pxm-in').value.trim();
        if (!name) { $('pxm-err').textContent = 'Give the album a name.'; return; }
        const btn = $('pxm-ok'); btn.disabled = true;
        try {
            if (cfg.mode === 'rename') {
                const r = await post(scopeBase(cfg.pub) + '/albums/rename', { name: cfg.name, new: name });
                PH.album = r.name; closeModal(); toast('Renamed to "' + r.name + '"');
            } else {
                const r = await post(scopeBase(cfg.pub) + '/albums/create', { name, ids: cfg.ids || [] });
                closeModal();
                toast(cfg.ids && cfg.ids.length ? `Added ${r.moved} photo${r.moved === 1 ? '' : 's'} to "${r.name}"` : `Album "${r.name}" is ready`);
                if (!(cfg.ids && cfg.ids.length)) PH.album = null;       // stay on the albums screen so the new one shows up
            }
            if (cfg.after) cfg.after();
            if (inGallery()) await loadPhotos(); else dashSoon();
        } catch (e) { $('pxm-err').textContent = errMsg(e); }
        btn.disabled = false;
    }
    window.pxNewAlbum = () => openModal({ mode: 'create', pub: PH.pub, ids: [] });
    window.pxRenameAlbum = () => { if (isRealAlbum()) openModal({ mode: 'rename', pub: PH.pub, name: PH.album }); };
    window.pxUngroupAlbum = async () => {
        if (!isRealAlbum()) return;
        if (!confirm(`Ungroup the album "${PH.album}"? The photos go back to the main gallery. Nothing is deleted.`)) return;
        try {
            const r = await post(scopeBase(PH.pub) + '/albums/ungroup', { name: PH.album });
            toast(r.kept_folder ? 'Photos moved out. The folder still has other files, so it was kept.' : 'Album ungrouped');
            PH.album = null; await loadPhotos();
        } catch (e) { toast(errMsg(e)); }
    };

    // ====================================================================== select mode
    const S = { on: false, ids: new Set(), bar: null };
    function buildBar() {
        const b = mk('div'); b.id = 'px-selbar';
        b.innerHTML = `<b id="px-selcount">0 selected</b>
            <button class="px-pill" id="px-sel-all">Select all</button>
            <button class="px-pill hot" id="px-sel-add" disabled><i class="fas fa-folder-plus"></i> Add to album</button>
            <button class="px-pill" id="px-sel-out" disabled hidden>Move out of album</button>
            <button class="px-pill" id="px-sel-x">Done</button>`;
        document.body.appendChild(b); S.bar = b;
        $('px-sel-x').onclick = selEnd;
        $('px-sel-all').onclick = () => { const all = PH.view.length && S.ids.size === PH.view.length; S.ids.clear(); if (!all) PH.view.forEach(p => S.ids.add(p.id)); selMark(); };
        $('px-sel-add').onclick = () => openModal({ mode: 'add', pub: PH.pub, ids: [...S.ids], after: selEnd });
        $('px-sel-out').onclick = async () => {
            try { const r = await post(scopeBase(PH.pub) + '/albums/move', { ids: [...S.ids], album: '' }); toast(`Moved ${r.moved} photo${r.moved === 1 ? '' : 's'} out of the album`); selEnd(); await loadPhotos(); }
            catch (e) { toast(errMsg(e)); }
        };
    }
    function selMark() {
        document.querySelectorAll('.ph-tile').forEach(t => { const p = PH.view[+t.dataset.i]; t.classList.toggle('px-sel', !!p && S.ids.has(p.id)); });
        const n = S.ids.size;
        $('px-selcount').textContent = n ? `${n} selected` : 'Tap photos to select';
        $('px-sel-add').disabled = !n; $('px-sel-out').disabled = !n; $('px-sel-out').hidden = !isRealAlbum();
        $('px-sel-all').textContent = n && n === PH.view.length ? 'Select none' : 'Select all';
    }
    window.pxSelStart = () => {
        if (!$('ph-grid')) return;
        if (!S.bar) buildBar();
        S.on = true; S.ids.clear(); document.body.classList.add('px-selecting'); S.bar.classList.add('on'); selMark();
    };
    function selEnd() { S.on = false; S.ids.clear(); document.body.classList.remove('px-selecting'); if (S.bar) { S.bar.classList.remove('on'); selMark(); } }

    const _openPhoto = window.openPhoto;
    window.openPhoto = function (i, el) {
        if (S.on) { const p = PH.view[i]; if (p) { S.ids.has(p.id) ? S.ids.delete(p.id) : S.ids.add(p.id); selMark(); } return; }
        zReset(); return _openPhoto.apply(this, arguments);
    };
    const _layout = window.layoutPhotos;
    window.layoutPhotos = function () { const r = _layout.apply(this, arguments); if (S.on) selMark(); return r; };
    const _render = window.renderPhotos;
    window.renderPhotos = function () { const r = _render.apply(this, arguments); if (S.on && !$('ph-grid')) selEnd(); return r; };
    const _switch = window.switchTab;
    if (typeof _switch === 'function') window.switchTab = function () { if (S.on) selEnd(); return _switch.apply(this, arguments); };

    // ====================================================================== viewer: zoom + pan + buttons
    const Z = { s: 1, x: 0, y: 0, max: 10 };
    let chip = null;
    function zApply() {
        const img = $('lb-img');
        img.style.transform = (Z.s === 1 && !Z.x && !Z.y) ? '' : `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`;
        $('lightbox').classList.toggle('px-zoomed', Z.s > 1.001);
        if (chip) chip.textContent = Math.round(Z.s * 100) + '%';
    }
    function zReset() { Z.s = 1; Z.x = 0; Z.y = 0; const img = $('lb-img'); if (img) { img.style.transform = ''; $('lightbox').classList.remove('px-zoomed', 'px-drag'); } }
    function zPan() {
        const img = $('lb-img'), w = img.offsetWidth * Z.s, h = img.offsetHeight * Z.s;
        const mx = Math.max(0, (w - innerWidth) / 2), my = Math.max(0, (h - innerHeight) / 2);
        Z.x = clamp(Z.x, -mx, mx); Z.y = clamp(Z.y, -my, my);
    }
    function zoomTo(s2, qx, qy) {
        s2 = clamp(s2, 1, Z.max);
        const img = $('lb-img');
        const cx = parseFloat(img.style.left) + img.offsetWidth / 2, cy = parseFloat(img.style.top) + img.offsetHeight / 2;
        if (qx == null) { qx = innerWidth / 2; qy = innerHeight / 2; }
        const rx = qx - cx, ry = qy - cy, k = s2 / Z.s;
        Z.x = rx - (rx - Z.x) * k; Z.y = ry - (ry - Z.y) * k; Z.s = s2;
        if (s2 < 1.001) { Z.s = 1; Z.x = 0; Z.y = 0; }
        zPan(); zApply();
    }
    window.pxZoom = dir => zoomTo(dir === 0 ? 1 : Z.s * (dir > 0 ? 1.4 : 1 / 1.4));
    window.__pxWheel = e => {
        if (!LB.open || E.on || !e.target.closest || !e.target.closest('#lightbox') || $('lightbox').classList.contains('sx-show')) return false;
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        zoomTo(Z.s * Math.exp(-dy * 0.0018), e.clientX, e.clientY);
        return true;
    };
    function initViewer() {
        const lb = $('lightbox'), img = $('lb-img'), acts = lb.querySelector('.lb-acts');
        chip = mk('button', null, '100%'); chip.id = 'px-zoomchip'; chip.title = 'Back to fit (0)'; chip.onclick = () => zoomTo(1);
        lb.querySelector('#lb-top').insertBefore(chip, acts);
        const btn = (icon, title, fn, id) => { const b = mk('button', 'lb-btn', `<i class="fas ${icon}"></i>`); b.title = title; b.setAttribute('aria-label', title); b.onclick = fn; if (id) b.id = id; return b; };
        const first = acts.firstChild;
        [btn('fa-magnifying-glass-minus', 'Zoom out (-)', () => pxZoom(-1)),
         btn('fa-magnifying-glass-plus', 'Zoom in (+, or scroll)', () => pxZoom(1)),
         btn('fa-sliders', 'Edit photo (E)', () => pxEdit(), 'px-lb-edit'),
         btn('fa-folder-plus', 'Add to album', () => { const p = PH.view[LB.i]; if (p) openModal({ mode: 'add', pub: !!p.pub, ids: [p.id] }); }, 'px-lb-album')
        ].forEach(b => acts.insertBefore(b, first));

        img.removeEventListener('dblclick', lbToggleFS);           // double-click now zooms (Enter / the expand button still do fullscreen)
        img.addEventListener('dblclick', e => { Z.s > 1.001 ? zoomTo(1) : zoomTo(2.6, e.clientX, e.clientY); });

        const ptr = new Map(); let pinch = null;
        img.addEventListener('pointerdown', e => {
            ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (ptr.size === 2) { const [a, b] = [...ptr.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: Z.s }; }
            if (Z.s > 1.001 || ptr.size === 2) { try { img.setPointerCapture(e.pointerId); } catch (x) {} lb.classList.add('px-drag'); }
        });
        img.addEventListener('pointermove', e => {
            const o = ptr.get(e.pointerId); if (!o) return;
            const dx = e.clientX - o.x, dy = e.clientY - o.y; o.x = e.clientX; o.y = e.clientY;
            if (ptr.size === 2 && pinch) { const [a, b] = [...ptr.values()]; zoomTo(pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2); }
            else if (ptr.size === 1 && Z.s > 1.001) { Z.x += dx; Z.y += dy; zPan(); zApply(); }
        });
        const up = e => { ptr.delete(e.pointerId); pinch = null; if (!ptr.size) lb.classList.remove('px-drag'); };
        img.addEventListener('pointerup', up); img.addEventListener('pointercancel', up);

        const _go = window.lbGo; window.lbGo = function () { zReset(); return _go.apply(this, arguments); };
        const _close = window.closePhoto; window.closePhoto = function () { zReset(); return _close.apply(this, arguments); };
        const _now = window.closePhotoNow; window.closePhotoNow = function () { edClose(true); zReset(); return _now.apply(this, arguments); };

        window.addEventListener('keydown', e => {
            if (!LB.open || E.on || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ''))) return;
            if (e.key === '+' || e.key === '=') { e.preventDefault(); pxZoom(1); }
            else if (e.key === '-' || e.key === '_') { e.preventDefault(); pxZoom(-1); }
            else if (e.key === '0') { e.preventDefault(); pxZoom(0); }
            else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); pxEdit(); }
        }, true);
    }

    // ====================================================================== editor
    const DEF = { exposure: 0, contrast: 0, fade: 0, saturation: 0, hue: 0, warmth: 0, tint: 0, sharpen: 0, blur: 0, grain: 0, vignette: 0, gray: 0, sepia: 0 };
    const SLIDERS = [
        ['Light', [['exposure', 'Exposure', -100, 100], ['contrast', 'Contrast', -100, 100], ['fade', 'Fade', 0, 100]]],
        ['Color', [['saturation', 'Saturation', -100, 100], ['hue', 'Hue', -180, 180], ['warmth', 'Warmth', -100, 100], ['tint', 'Tint', -100, 100]]],
        ['Detail', [['sharpen', 'Sharpen', 0, 100], ['blur', 'Blur', 0, 100], ['grain', 'Grain', 0, 100]]],
        ['Effects', [['vignette', 'Vignette', -100, 100], ['gray', 'Black & white', 0, 100], ['sepia', 'Sepia', 0, 100]]]
    ];
    const FILTERS = [
        ['Original', {}], ['Vivid', { saturation: 35, contrast: 15 }], ['Warm', { warmth: 40, saturation: 10, fade: 6 }],
        ['Cool', { warmth: -40, saturation: 5, contrast: 6 }], ['Noir', { gray: 100, contrast: 35, vignette: 35 }], ['Mono', { gray: 100, contrast: 10 }],
        ['Sepia', { sepia: 85, contrast: 8, vignette: 20 }], ['Fade', { fade: 45, contrast: -10, saturation: -15 }], ['Matte', { fade: 30, contrast: 12, saturation: -10, warmth: 8 }],
        ['Dramatic', { contrast: 45, saturation: -10, exposure: -8, vignette: 40, sharpen: 30 }], ['Cinema', { warmth: 12, tint: -8, contrast: 18, saturation: -8, vignette: 30, fade: 12 }],
        ['Dream', { exposure: 10, blur: 8, saturation: 15, warmth: 15, fade: 15 }]
    ];
    const RATIOS = [['Free', null], ['Original', 'orig'], ['1:1', 1], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9], ['3:4', 3 / 4], ['2:3', 2 / 3], ['9:16', 9 / 16]];
    const REPLACEABLE = ['.jpg', '.jpeg', '.png', '.webp'];
    const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }, EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };
    const MAX_SIDE = 12000, MAX_PIXELS = 100e6;
    const FILTER_OK = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

    const E = { on: false, p: null, base: null, prev: null, adj: Object.assign({}, DEF), hist: [], hi: -1, out: { w: 1, h: 1, lock: true }, tab: 'crop',
                crop: null, ratio: null, ratioKey: 'Free', fmt: 'jpeg', q: 92, dw: 0, dh: 0, raf: 0, compare: false, busy: false, thumbSrc: null, thumbsDirty: true, root: null };
    const cvNew = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

    // ---- the picture pipeline: used for the live preview, the filter thumbnails and the final export
    function renderTo(dst, src, W, H, adj, bg) {
        if (dst.width !== W || dst.height !== H) { dst.width = W; dst.height = H; }
        const c = dst.getContext('2d', { willReadFrequently: true });
        c.setTransform(1, 0, 0, 1, 0, 0); c.filter = 'none'; c.clearRect(0, 0, W, H);
        c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
        if (bg) { c.fillStyle = bg; c.fillRect(0, 0, W, H); }
        if (FILTER_OK) {
            const f = [];
            if (adj.exposure) f.push(`brightness(${(1 + adj.exposure / 100).toFixed(3)})`);
            if (adj.contrast) f.push(`contrast(${(1 + adj.contrast / 100).toFixed(3)})`);
            if (adj.saturation) f.push(`saturate(${(1 + adj.saturation / 100).toFixed(3)})`);
            if (adj.hue) f.push(`hue-rotate(${adj.hue}deg)`);
            if (adj.gray) f.push(`grayscale(${(adj.gray / 100).toFixed(3)})`);
            if (adj.sepia) f.push(`sepia(${(adj.sepia / 100).toFixed(3)})`);
            if (adj.blur) f.push(`blur(${(adj.blur / 100 * W * 0.012).toFixed(2)}px)`);
            c.filter = f.length ? f.join(' ') : 'none';
        }
        c.drawImage(src, 0, 0, W, H);
        c.filter = 'none';
        if (adj.warmth || adj.tint || adj.fade || adj.sharpen || adj.grain) {
            const id = c.getImageData(0, 0, W, H), d = id.data;
            if (adj.sharpen) sharpen(d, W, H, adj.sharpen / 100 * 1.5);
            const wr = adj.warmth * 0.30, wb = -adj.warmth * 0.30, tr = adj.tint * 0.10, tg = -adj.tint * 0.22, tb = adj.tint * 0.10;
            const fade = adj.fade / 100, keep = 1 - fade * 0.35, lift = 255 * 0.18 * fade, gr = adj.grain / 100 * 42;
            let seed = 1234567;
            const tweak = wr || wb || tr || tg || tb;
            for (let i = 0; i < d.length; i += 4) {
                let r = d[i], g = d[i + 1], b = d[i + 2];
                if (tweak) { r += wr + tr; g += tg; b += wb + tb; }
                if (fade) { r = r * keep + lift; g = g * keep + lift; b = b * keep + lift; }
                if (gr) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; const n = (((seed >>> 0) % 2000) / 1000 - 1) * gr; r += n; g += n; b += n; }
                d[i] = r; d[i + 1] = g; d[i + 2] = b;
            }
            c.putImageData(id, 0, 0);
        }
        if (adj.vignette) {
            const v = adj.vignette / 100, g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.22, W / 2, H / 2, Math.hypot(W, H) / 2);
            const col = v > 0 ? '0,0,0' : '255,255,255';
            g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(1, `rgba(${col},${Math.min(0.9, Math.abs(v) * 0.9).toFixed(3)})`);
            c.fillStyle = g; c.fillRect(0, 0, W, H);
        }
    }
    function sharpen(d, W, H, amt) {
        const s = new Uint8ClampedArray(d), row = W * 4;
        for (let y = 1; y < H - 1; y++) {
            for (let x = 1, i = (y * W + 1) * 4; x < W - 1; x++, i += 4) {
                for (let k = 0; k < 3; k++) { const j = i + k; d[j] = s[j] + amt * (4 * s[j] - s[j - 4] - s[j + 4] - s[j - row] - s[j + row]); }
            }
        }
    }

    // ---- building the editor
    function build() {
        const root = mk('div'); root.id = 'px-ed'; E.root = root;
        const sliderHtml = SLIDERS.map(([g, list]) => `<div class="pxe-h">${g}</div>` + list.map(([k, n, mn, mx]) =>
            `<div class="pxs" data-k="${k}"><div class="pxs-top"><span title="Double-click to reset">${n}</span><span>0</span></div><input type="range" min="${mn}" max="${mx}" step="1" value="0"></div>`).join('')).join('');
        root.innerHTML = `
        <div class="pxe-top">
            <button class="pxe-ico" id="pxe-close" title="Close (Esc)"><i class="fas fa-xmark"></i></button>
            <span class="pxe-title" id="pxe-name">Edit photo</span><span class="grow"></span>
            <button class="pxe-ico" id="pxe-undo" title="Undo (Ctrl+Z)"><i class="fas fa-rotate-left"></i></button>
            <button class="pxe-ico" id="pxe-redo" title="Redo (Ctrl+Y)"><i class="fas fa-rotate-right"></i></button>
            <button class="px-pill" id="pxe-cmp" title="Hold to see the original">Hold to compare</button>
            <button class="px-pill" id="pxe-reset">Reset all</button>
        </div>
        <div class="pxe-body">
            <div id="pxe-stage"><div id="pxe-wrap"><canvas id="pxe-cv"></canvas>
                <div id="pxe-crop"><div id="pxe-box">${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(h => `<span class="pxh" data-h="${h}"></span>`).join('')}</div></div></div>
                <div id="pxe-dim"></div><div id="pxe-busy">Working...</div></div>
            <div class="pxe-side">
                <div class="pxe-tabs">
                    <button class="pxe-tab on" data-t="crop"><i class="fas fa-crop-simple"></i>Crop</button>
                    <button class="pxe-tab" data-t="adjust"><i class="fas fa-sliders"></i>Adjust</button>
                    <button class="pxe-tab" data-t="filters"><i class="fas fa-wand-magic-sparkles"></i>Filters</button>
                    <button class="pxe-tab" data-t="resize"><i class="fas fa-up-right-and-down-left-from-center"></i>Resize</button>
                </div>
                <div class="pxe-pane on" data-p="crop">
                    <div class="pxe-h">Shape</div><div class="pxe-grid" id="pxe-ratios">${RATIOS.map(([n]) => `<button class="pxe-btn${n === 'Free' ? ' on' : ''}" data-r="${n}">${n}</button>`).join('')}</div>
                    <div class="pxe-h">Rotate &amp; flip</div>
                    <div class="pxe-grid four">
                        <button class="pxe-btn" data-g="rl" title="Rotate left"><i class="fas fa-rotate-left" style="margin:0"></i></button>
                        <button class="pxe-btn" data-g="rr" title="Rotate right"><i class="fas fa-rotate-right" style="margin:0"></i></button>
                        <button class="pxe-btn" data-g="fh" title="Flip horizontally"><i class="fas fa-left-right" style="margin:0"></i></button>
                        <button class="pxe-btn" data-g="fv" title="Flip vertically"><i class="fas fa-up-down" style="margin:0"></i></button></div>
                    <button class="pxe-primary" id="pxe-apply">Apply crop</button>
                    <p class="pxe-hint">Drag the corners or edges of the box, drag inside it to move it. The crop is also applied when you switch tab or save.</p>
                </div>
                <div class="pxe-pane" data-p="adjust">${sliderHtml}</div>
                <div class="pxe-pane" data-p="filters"><div class="pxe-filters" id="pxe-filters"></div><p class="pxe-hint">A filter sets the sliders for you. Fine-tune it in Adjust afterwards.</p></div>
                <div class="pxe-pane" data-p="resize">
                    <div class="pxe-h">Size in pixels</div>
                    <div class="pxe-num"><input class="px-input" id="pxe-w" type="number" min="1" max="${MAX_SIDE}" inputmode="numeric"><button class="pxe-lock on" id="pxe-lock" title="Keep the shape"><i class="fas fa-link"></i></button><input class="px-input" id="pxe-h" type="number" min="1" max="${MAX_SIDE}" inputmode="numeric"></div>
                    <div class="pxe-h">Scale</div><div class="pxe-grid" id="pxe-pcts">${[25, 50, 75, 100, 150, 200].map(p => `<button class="pxe-btn" data-pc="${p}">${p}%</button>`).join('')}</div>
                    <div class="pxe-h">Save as</div>
                    <select class="pxe-sel" id="pxe-fmt"><option value="jpeg">JPG (smaller)</option><option value="png">PNG (lossless)</option><option value="webp">WebP (small + sharp)</option></select>
                    <div class="pxs" id="pxe-qwrap" style="margin-top:1rem"><div class="pxs-top"><span>Quality</span><span id="pxe-qv">92</span></div><input type="range" id="pxe-q" min="50" max="100" step="1" value="92"></div>
                </div>
                <div class="pxe-save"><div class="pxe-size" id="pxe-size"></div>
                    <button class="px-pill hot" id="pxe-copy"><i class="fas fa-copy"></i> Save as a copy</button>
                    <button class="px-pill" id="pxe-repl" title="Overwrites the photo. A backup of the original is kept in data/photo_originals.">Replace original</button></div>
            </div>
        </div>`;
        document.body.appendChild(root);
        const q = s => root.querySelector(s);

        root.querySelectorAll('.pxe-tab').forEach(b => b.onclick = () => setTab(b.dataset.t));
        $('pxe-close').onclick = () => edClose(false);
        $('pxe-undo').onclick = undo; $('pxe-redo').onclick = redo;
        $('pxe-reset').onclick = resetAll; $('pxe-apply').onclick = () => { if (!applyCrop()) toast('Drag the crop box first'); };
        const cmp = $('pxe-cmp'); const cm = v => () => { E.compare = v; paint(); };
        cmp.addEventListener('pointerdown', cm(true)); cmp.addEventListener('pointerup', cm(false)); cmp.addEventListener('pointerleave', cm(false));
        $('pxe-copy').onclick = () => save('copy'); $('pxe-repl').onclick = () => save('replace');

        $('pxe-ratios').querySelectorAll('.pxe-btn').forEach(b => b.onclick = () => setRatio(b.dataset.r));
        root.querySelectorAll('[data-g]').forEach(b => b.onclick = () => geom(b.dataset.g));

        root.querySelectorAll('.pxs[data-k]').forEach(row => {
            const k = row.dataset.k, inp = row.querySelector('input');
            inp.addEventListener('input', () => { E.adj[k] = +inp.value; paintSlider(row); markFilter(); schedule(); });
            inp.addEventListener('change', () => pushHist());
            row.querySelector('.pxs-top span').addEventListener('dblclick', () => { E.adj[k] = 0; syncUI(); schedule(); pushHist(); });
        });
        $('pxe-filters').addEventListener('click', e => { const b = e.target.closest('.pxf'); if (!b) return; E.adj = Object.assign({}, DEF, FILTERS[+b.dataset.f][1]); syncUI(); schedule(); pushHist(); });

        const setW = () => sizeFrom('w', +$('pxe-w').value), setH = () => sizeFrom('h', +$('pxe-h').value);
        $('pxe-w').addEventListener('change', () => { setW(); pushHist(); }); $('pxe-h').addEventListener('change', () => { setH(); pushHist(); });
        $('pxe-w').addEventListener('input', setW); $('pxe-h').addEventListener('input', setH);
        $('pxe-lock').onclick = () => { E.out.lock = !E.out.lock; if (E.out.lock) sizeFrom('w', E.out.w); syncUI(); };
        $('pxe-pcts').querySelectorAll('.pxe-btn').forEach(b => b.onclick = () => { const f = +b.dataset.pc / 100; E.out.w = Math.max(1, Math.round(E.base.width * f)); E.out.h = Math.max(1, Math.round(E.base.height * f)); fixPixels(); syncUI(); pushHist(); });
        $('pxe-fmt').onchange = () => { E.fmt = $('pxe-fmt').value; syncUI(); };
        $('pxe-q').oninput = () => { E.q = +$('pxe-q').value; $('pxe-qv').textContent = E.q; };

        cropEvents();
        new ResizeObserver(() => { if (E.on) layout(); }).observe($('pxe-stage'));
    }

    // ---- open / close
    window.pxEdit = async function () {
        if (E.on || !LB.open) return;
        const p = PH.view[LB.i]; if (!p) return;
        if (p.ext === '.gif') { toast('Animated GIFs cannot be edited here.'); return; }
        const play = $('sx-lb-play'); if ($('lightbox').classList.contains('sx-show') && play) play.click();   // stop a running slideshow
        if (!E.root) build();
        E.on = true; E.p = p; LB.busy = true; zReset();
        E.root.classList.add('on'); $('pxe-busy').classList.add('on'); $('pxe-busy').textContent = 'Loading photo...';
        $('pxe-name').textContent = p.name || 'Edit photo';
        window.__pxEd = edKeys;
        E.adj = Object.assign({}, DEF); E.hist = []; E.hi = -1; E.ratio = null; E.compare = false; E.thumbsDirty = true;
        E.fmt = p.ext === '.png' ? 'png' : p.ext === '.webp' ? 'webp' : 'jpeg';
        try {
            const im = new Image(); im.decoding = 'async'; im.src = phFull(p); await im.decode();
            let w = im.naturalWidth, h = im.naturalHeight; const k = Math.min(1, MAX_SIDE / Math.max(w, h));
            w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
            const base = cvNew(w, h); base.getContext('2d').drawImage(im, 0, 0, w, h);
            E.base = base; E.out = { w, h, lock: true };
        } catch (e) { console.error(e); toast('This picture could not be opened for editing.'); edClose(true); return; }
        $('pxe-busy').classList.remove('on');
        if (!FILTER_OK) toast('This window cannot preview most effects. Crop, rotate and resize still work.', 6000);
        setTab('crop', true); layout(); pushHist(); syncUI();
    };
    function edClose(force) {
        if (!E.on) return;
        if (!force && E.hist.length > 1 && E.hi > 0 && !confirm('Close the editor and discard your changes?')) return;
        E.on = false; E.root.classList.remove('on'); window.__pxEd = null; LB.busy = false;
        E.base = E.prev = E.thumbSrc = null; E.hist = []; E.p = null;
        $('pxe-cv').width = $('pxe-cv').height = 1;
    }

    // ---- layout: fit the picture into the stage, build a small preview copy so the sliders stay smooth
    function layout() {
        if (!E.on || !E.base) return;
        const st = $('pxe-stage'), aw = Math.max(80, st.clientWidth - 40), ah = Math.max(80, st.clientHeight - 40);
        const s = Math.min(aw / E.base.width, ah / E.base.height, 3);
        const oldDw = E.dw;
        E.dw = Math.max(20, Math.round(E.base.width * s)); E.dh = Math.max(20, Math.round(E.base.height * s));
        const pw = Math.min(E.base.width, 2200, Math.max(500, Math.round(E.dw * (devicePixelRatio || 1)))), ph = Math.max(1, Math.round(pw * E.base.height / E.base.width));
        if (!E.prev || E.prev.width !== pw || E.prev.height !== ph || E.prevOf !== E.base) { E.prev = cvNew(pw, ph); const c = E.prev.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(E.base, 0, 0, pw, ph); E.prevOf = E.base; E.thumbsDirty = true; E.thumbSrc = null; }
        const cv = $('pxe-cv'); cv.style.width = E.dw + 'px'; cv.style.height = E.dh + 'px';
        if (E.crop && oldDw) { const f = E.dw / oldDw; E.crop = { x: E.crop.x * f, y: E.crop.y * f, w: E.crop.w * f, h: E.crop.h * f }; } else E.crop = { x: 0, y: 0, w: E.dw, h: E.dh };
        paint(); drawBox(); sizeLabel();
        if (E.tab === 'filters') thumbs();
    }
    function schedule() { if (!E.raf) E.raf = requestAnimationFrame(() => { E.raf = 0; paint(); }); }
    function paint() { if (!E.on || !E.prev) return; renderTo($('pxe-cv'), E.prev, E.prev.width, E.prev.height, E.compare ? DEF : E.adj); }

    // ---- tabs
    function setTab(t, silent) {
        if (E.tab === 'crop' && t !== 'crop' && !silent) applyCrop();
        E.tab = t;
        E.root.querySelectorAll('.pxe-tab').forEach(b => b.classList.toggle('on', b.dataset.t === t));
        E.root.querySelectorAll('.pxe-pane').forEach(b => b.classList.toggle('on', b.dataset.p === t));
        $('pxe-crop').classList.toggle('on', t === 'crop');
        if (t === 'filters') thumbs();
        sizeLabel();
    }
    function sizeLabel() {
        const l = $('pxe-dim');
        if (E.tab === 'crop' && E.crop) { const s = E.base.width / E.dw; l.textContent = `${Math.max(1, Math.round(E.crop.w * s))} \u00d7 ${Math.max(1, Math.round(E.crop.h * s))} px`; }
        else l.textContent = `${E.out.w} \u00d7 ${E.out.h} px`;
    }

    // ---- crop
    const MINC = 24;
    function drawBox() {
        const b = $('pxe-box'), c = E.crop; if (!c) return;
        b.style.left = c.x + 'px'; b.style.top = c.y + 'px'; b.style.width = c.w + 'px'; b.style.height = c.h + 'px';
        sizeLabel();
    }
    function dragRect(h, r, dx, dy) {
        const W = E.dw, H = E.dh, R = E.ratio;
        if (h === 'move') return { x: clamp(r.x + dx, 0, W - r.w), y: clamp(r.y + dy, 0, H - r.h), w: r.w, h: r.h };
        let l = r.x, t = r.y, rt = r.x + r.w, b = r.y + r.h;
        if (h.includes('w')) l = clamp(r.x + dx, 0, rt - MINC);
        if (h.includes('e')) rt = clamp(r.x + r.w + dx, l + MINC, W);
        if (h.includes('n')) t = clamp(r.y + dy, 0, b - MINC);
        if (h.includes('s')) b = clamp(r.y + r.h + dy, t + MINC, H);
        if (!R) return { x: l, y: t, w: rt - l, h: b - t };
        let w = rt - l, hh = b - t;
        if (h === 'n' || h === 's') w = hh * R; else if (h === 'e' || h === 'w') hh = w / R; else { w = Math.max(w, hh * R); hh = w / R; }
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const maxW = h.includes('w') ? rt : h.includes('e') ? W - l : 2 * Math.min(cx, W - cx);
        const maxH = h.includes('n') ? b : h.includes('s') ? H - t : 2 * Math.min(cy, H - cy);
        if (w > maxW) { w = maxW; hh = w / R; } if (hh > maxH) { hh = maxH; w = hh * R; }
        w = Math.max(w, MINC); hh = Math.max(hh, MINC / R > MINC ? MINC / R : MINC);
        const x = h.includes('w') ? rt - w : h.includes('e') ? l : cx - w / 2, y = h.includes('n') ? b - hh : h.includes('s') ? t : cy - hh / 2;
        return { x: clamp(x, 0, W - w), y: clamp(y, 0, H - hh), w, h: hh };
    }
    function cropEvents() {
        const box = $('pxe-box'); let drag = null;
        box.addEventListener('pointerdown', e => { drag = { h: e.target.dataset.h || 'move', sx: e.clientX, sy: e.clientY, r: Object.assign({}, E.crop) }; box.setPointerCapture(e.pointerId); e.preventDefault(); });
        box.addEventListener('pointermove', e => { if (!drag) return; E.crop = dragRect(drag.h, drag.r, e.clientX - drag.sx, e.clientY - drag.sy); drawBox(); });
        const end = () => { drag = null; };
        box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    }
    function setRatio(name) {
        const R = RATIOS.find(r => r[0] === name)[1];
        E.ratioKey = name; E.ratio = R === 'orig' ? E.base.width / E.base.height : R;
        $('pxe-ratios').querySelectorAll('.pxe-btn').forEach(b => b.classList.toggle('on', b.dataset.r === name));
        if (!E.ratio) return;
        const c = E.crop, cx = c.x + c.w / 2, cy = c.y + c.h / 2;
        let w = Math.min(c.w, c.h * E.ratio), h = w / E.ratio;
        w = Math.min(w, E.dw); h = Math.min(h, E.dh); if (w / h > E.ratio) w = h * E.ratio; else h = w / E.ratio;
        E.crop = { x: clamp(cx - w / 2, 0, E.dw - w), y: clamp(cy - h / 2, 0, E.dh - h), w, h };
        drawBox();
    }
    function applyCrop() {
        const c = E.crop; if (!c || !E.base) return false;
        if (c.x < 1 && c.y < 1 && c.w > E.dw - 2 && c.h > E.dh - 2) return false;
        const s = E.base.width / E.dw;
        const x = Math.round(c.x * s), y = Math.round(c.y * s), w = Math.max(1, Math.min(E.base.width - x, Math.round(c.w * s))), h = Math.max(1, Math.min(E.base.height - y, Math.round(c.h * s)));
        const nb = cvNew(w, h); nb.getContext('2d').drawImage(E.base, x, y, w, h, 0, 0, w, h);
        setBase(nb); E.crop = null; layout(); pushHist(); syncUI();
        return true;
    }
    function setBase(nb) {
        const old = E.base; E.base = nb;
        if (old) { E.out.w = Math.max(1, Math.round(E.out.w * nb.width / old.width)); E.out.h = Math.max(1, Math.round(E.out.h * nb.height / old.height)); fixPixels(); }
        E.crop = null;
    }
    function geom(kind) {
        const b = E.base; let nb;
        if (kind === 'rl' || kind === 'rr') {
            nb = cvNew(b.height, b.width); const c = nb.getContext('2d');
            if (kind === 'rr') { c.translate(b.height, 0); c.rotate(Math.PI / 2); } else { c.translate(0, b.width); c.rotate(-Math.PI / 2); }
            c.drawImage(b, 0, 0);
        } else {
            nb = cvNew(b.width, b.height); const c = nb.getContext('2d');
            if (kind === 'fh') { c.translate(b.width, 0); c.scale(-1, 1); } else { c.translate(0, b.height); c.scale(1, -1); }
            c.drawImage(b, 0, 0);
        }
        setBase(nb); E.ratio = null; E.ratioKey = 'Free'; $('pxe-ratios').querySelectorAll('.pxe-btn').forEach(x => x.classList.toggle('on', x.dataset.r === 'Free'));
        layout(); pushHist(); syncUI();
    }

    // ---- size
    function fixPixels() {
        E.out.w = clamp(Math.round(E.out.w) || 1, 1, MAX_SIDE * 2); E.out.h = clamp(Math.round(E.out.h) || 1, 1, MAX_SIDE * 2);
        const px = E.out.w * E.out.h; if (px > MAX_PIXELS) { const k = Math.sqrt(MAX_PIXELS / px); E.out.w = Math.floor(E.out.w * k); E.out.h = Math.floor(E.out.h * k); }
    }
    function sizeFrom(axis, v) {
        if (!(v > 0)) return;
        const ar = E.base.height / E.base.width;
        if (axis === 'w') { E.out.w = v; if (E.out.lock) E.out.h = v * ar; } else { E.out.h = v; if (E.out.lock) E.out.w = v / ar; }
        fixPixels(); syncUI(true); sizeLabel();
    }

    // ---- history (undo / redo)
    function snap() { return { base: E.base, adj: Object.assign({}, E.adj), out: Object.assign({}, E.out) }; }
    function pushHist() {
        const s = snap(), last = E.hist[E.hi];
        if (last && last.base === s.base && JSON.stringify(last.adj) === JSON.stringify(s.adj) && last.out.w === s.out.w && last.out.h === s.out.h) return;
        E.hist = E.hist.slice(0, E.hi + 1); E.hist.push(s); if (E.hist.length > 25) E.hist.shift(); E.hi = E.hist.length - 1; syncUI(true);
    }
    function restore(i) {
        const s = E.hist[i]; if (!s) return;
        E.hi = i; const sameBase = E.base === s.base; E.base = s.base; E.adj = Object.assign({}, s.adj); E.out = Object.assign({}, s.out);
        if (!sameBase) E.crop = null;
        layout(); syncUI();
    }
    function undo() { if (E.hi > 0) restore(E.hi - 1); }
    function redo() { if (E.hi < E.hist.length - 1) restore(E.hi + 1); }
    function resetAll() { if (E.hist.length) restore(0); E.hist = [E.hist[0]]; E.hi = 0; E.crop = null; layout(); syncUI(); }

    // ---- keeping the controls in step with the state
    function paintSlider(row) {
        const inp = row.querySelector('input'), mn = +inp.min, mx = +inp.max, v = +inp.value, zero = mn < 0 ? 50 : 0, pv = (v - mn) / (mx - mn) * 100;
        inp.style.setProperty('--a', Math.min(zero, pv) + '%'); inp.style.setProperty('--b', Math.max(zero, pv) + '%');
        row.querySelector('.pxs-top span:last-child').textContent = v; row.classList.toggle('chg', v !== 0);
    }
    function markFilter() {
        const same = i => Object.keys(DEF).every(k => (E.adj[k] || 0) === (FILTERS[i][1][k] || 0));
        $('pxe-filters').querySelectorAll('.pxf').forEach((b, i) => b.classList.toggle('on', same(i)));
    }
    function syncUI(light) {
        if (!E.on) return;
        E.root.querySelectorAll('.pxs[data-k]').forEach(row => { row.querySelector('input').value = E.adj[row.dataset.k]; paintSlider(row); });
        if (!light || document.activeElement !== $('pxe-w')) $('pxe-w').value = E.out.w;
        if (!light || document.activeElement !== $('pxe-h')) $('pxe-h').value = E.out.h;
        $('pxe-lock').classList.toggle('on', E.out.lock);
        $('pxe-fmt').value = E.fmt; $('pxe-qwrap').style.display = E.fmt === 'png' ? 'none' : '';
        $('pxe-undo').disabled = E.hi <= 0; $('pxe-redo').disabled = E.hi >= E.hist.length - 1;
        const rep = REPLACEABLE.includes(E.p.ext); $('pxe-repl').disabled = !rep; $('pxe-repl').title = rep ? 'Overwrites the photo. A backup of the original is kept in data/photo_originals.' : 'Only JPG, PNG and WebP photos can be replaced. Save a copy instead.';
        $('pxe-size').textContent = `${E.out.w} \u00d7 ${E.out.h} px \u00b7 ${E.fmt === 'jpeg' ? 'JPG' : E.fmt.toUpperCase()}`;
        markFilter(); schedule(); sizeLabel();
    }
    function thumbs() {
        const box = $('pxe-filters');
        if (!E.thumbsDirty && box.children.length) return markFilter();
        if (!E.thumbSrc) {
            const t = 132, s = cvNew(t, t), c = s.getContext('2d'), side = Math.min(E.prev.width, E.prev.height);
            c.imageSmoothingQuality = 'high'; c.drawImage(E.prev, (E.prev.width - side) / 2, (E.prev.height - side) / 2, side, side, 0, 0, t, t); E.thumbSrc = s;
        }
        box.innerHTML = FILTERS.map(([n], i) => `<button class="pxf" data-f="${i}"><canvas width="132" height="132"></canvas><span>${n}</span></button>`).join('');
        box.querySelectorAll('canvas').forEach((cv, i) => renderTo(cv, E.thumbSrc, 132, 132, Object.assign({}, DEF, FILTERS[i][1])));
        E.thumbsDirty = false; markFilter();
    }

    // ---- keyboard while the editor is open
    function edKeys(e) {
        const k = e.key, ctrl = e.ctrlKey || e.metaKey, typing = /INPUT|SELECT|TEXTAREA/.test((e.target.tagName || ''));
        if (k === 'Escape') { if (typing && e.target.type !== 'range') e.target.blur(); else edClose(false); }
        else if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
        else if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); }
        else if (k === 'Enter' && !typing && E.tab === 'crop') { e.preventDefault(); applyCrop(); }
        else if (k === 'Enter' && typing && e.target.type === 'number') e.target.blur();
    }

    // ---- saving
    async function save(mode) {
        if (E.busy || !E.on) return;
        const p = E.p; applyCrop();
        let fmt = E.fmt;
        if (mode === 'replace') {
            if (!REPLACEABLE.includes(p.ext)) { toast('Only JPG, PNG and WebP photos can be replaced. Save a copy instead.'); return; }
            const keep = p.ext === '.png' ? 'png' : p.ext === '.webp' ? 'webp' : 'jpeg';
            if (!confirm(`Replace the original photo? A backup of the original is kept in data/photo_originals.${fmt !== keep ? '\n\nIt will be saved as ' + (keep === 'jpeg' ? 'JPG' : keep.toUpperCase()) + ' like the original.' : ''}`)) return;
            fmt = keep;
        }
        E.busy = true; $('pxe-busy').textContent = 'Saving...'; $('pxe-busy').classList.add('on');
        try {
            await new Promise(r => setTimeout(r, 30));
            const W = E.out.w, H = E.out.h, cv = cvNew(W, H);
            renderTo(cv, E.base, W, H, E.adj, fmt === 'jpeg' ? '#ffffff' : null);
            const blob = await new Promise(r => cv.toBlob(r, MIME[fmt], E.q / 100));
            cv.width = cv.height = 1;
            if (!blob) throw new Error('The browser could not encode the picture.');
            const fd = new FormData(); fd.append('id', p.id); fd.append('mode', mode); fd.append('file', blob, 'edit.' + EXT[fmt]);
            const r = await api(scopeBase(!!p.pub) + '/edit', { method: 'POST', body: fd });
            toast(r.mode === 'replace' ? 'Photo replaced' : `Saved a copy: ${r.name}`);
            const wasHome = !!PH.bak, pub = !!p.pub;
            edClose(true);
            try { HP.pub.t = 0; HP.priv.t = 0; } catch (x) {}
            if (wasHome || !inGallery() || PH.pub !== pub) { closePhoto(); dashSoon(); }
            else {
                await loadPhotos();
                const i = PH.view.findIndex(x => x.id === r.id);
                if (i >= 0) openPhoto(i, null); else closePhoto();
            }
        } catch (e) { console.error(e); toast(errMsg(e)); }
        E.busy = false; if (E.on) $('pxe-busy').classList.remove('on');
    }

    initViewer();
})();
