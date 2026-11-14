    // ============ ULTRON: the menu ============
    (function () {
        function menuOpen() { return document.body.classList.contains('menu-open'); }
        window.toggleMenu = function (force) {
            var on = force == null ? !menuOpen() : !!force;
            if (on && document.body.classList.contains('np-open')) return;
            document.body.classList.toggle('menu-open', on);
            var t = document.getElementById('menu-trigger'); if (t) t.setAttribute('aria-expanded', on ? 'true' : 'false');
        };
        // the old sidebar-collapse shortcut (Ctrl+B) now opens / closes the menu
        window.toggleRail = function () { window.toggleMenu(); };
        // picking anything in the menu closes it, except the quick toggles (theme / mouse)
        document.addEventListener('click', function (e) {
            var b = e.target.closest && e.target.closest('#sidebar button');
            if (!b || !menuOpen()) return;
            if (b.id === 'theme-btn' || b.id === 'wheel-btn' || b.id === 'tab-exit') return;
            if (b.id === 'lock-btn') return;
            setTimeout(function () { window.toggleMenu(false); }, 60);
        });
        document.addEventListener('keydown', function (e) {
            var tag = (e.target && e.target.tagName) || '';
            if (e.key === 'Escape' && menuOpen()) { window.toggleMenu(false); return; }
            if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test(tag) && !e.target.isContentEditable) {
                if (document.documentElement.classList.contains('in-player')) return;
                window.toggleMenu();
            }
        });
        // the menu icon steps aside while Now Playing is open, so only one control sits top-left
        var np = document.getElementById('nowplaying');
        if (np) new MutationObserver(function () { document.body.classList.toggle('np-open', !np.classList.contains('hidden')); }).observe(np, { attributes: true, attributeFilter: ['class'] });

        // Exit: first press arms it, second press closes the app
        var exitArm = 0;
        window.exitApp = function () {
            var b = document.getElementById('tab-exit'), l = b.querySelector('.sb-label');
            if (!exitArm) {
                b.classList.add('armed'); l.textContent = 'Press again';
                exitArm = setTimeout(function () { exitArm = 0; b.classList.remove('armed'); l.textContent = 'Exit'; }, 3000);
                return;
            }
            clearTimeout(exitArm); exitArm = 0;
            try { if (typeof playingId !== 'undefined' && playingId) closePlayer(true); } catch (e) {}
            try { document.getElementById('audio').pause(); } catch (e) {}
            var bridge = window.pywebview && window.pywebview.api;
            if (bridge && bridge.quit_app) { bridge.quit_app(); return; }
            fetch('/api/quit', { method: 'POST', headers: { 'X-LMP': '1' } }).catch(function () {});
            var d = document.createElement('div');
            d.style.cssText = 'position:fixed;inset:0;z-index:calc(var(--z-fx) + 999);display:flex;align-items:center;justify-content:center;background:#0b0b0c;color:#86868b;font:500 1rem Inter,system-ui,sans-serif';
            d.textContent = 'Closed. You can close this tab.';
            document.body.appendChild(d);
            try { window.close(); } catch (e) {}
        };
    })();
    
