# ZENO V5 - dev manager list (static audit, not profiled: the sandbox has no libmpv / Qt / ffmpeg)

## Done in V5
- Data folder moved out of the app folder (per-user, fixed), one-time copy from the newest older version next to it; existing installs keep their `data/`. Tested: `python tests/test_data_home.py`.
- Restore keeps the current password when the backup has none.
- Settings tab "Backup" is now "Your data" (path, open folder, export / import database).
- Private-library search (`assets/js/private-search.js`), isolated from Ctrl+K. Checked in headless Chromium with mocked private data: results, photo lightbox, lock wipes it. NOT yet checked against a real private library in the desktop window: unlock once and try it.
- Still open: media folders are not copied between versions (by design, they can be huge). A "move my media" helper could be added if wanted.
- Note: a plain relaunch still asks for the password again (the unlock is held in memory and auto-locks after the idle time). That is deliberate; a "stay unlocked after restart" option is possible if you want it.

## Done in V4
- Page bundler: stylesheets and scripts are merged at serve time with automatic fallback (see README). Checked in headless Chromium: same computed styles and layout, no JS errors, DCL 575 -> 287 ms. NOT yet checked in the real desktop window (pywebview / Qt) or the packaged exe: launch once and look. If anything looks off, open /?nobundle=1.
- `?` no longer opens two shortcut sheets.
- Clock redraw timer no longer runs while the window is minimised (app.js).
- Backup / restore + weekly auto backup (see README).
- Start-up: the first video scan now runs in the background, so the window opens at once. Video lists wait for that scan (up to 3 min) instead of showing half a library, and poster pre-generation waits for it too.
- Search-palette thumbnails load lazily.

## Fix next (high value)
1. Start-up scan (done, see above): check on your real library that the first Cinema paint shows everything after the short wait.
2. CSS stack (speed part solved by the bundler; cleanup in progress). Safety net: `tools/css_snapshot.py` (computed-style + box snapshot of every view, diff before/after) and `tools/css_dead.py` (finds declarations a later rule always overrides).
   - Done: darkroom-1..5 merged into darkroom-6 (~490 dead declarations removed first), minimalist.css menu-panel mode removed, light theme removed (CSS, Settings option, backend). Snapshot diff: no change except the Settings swatch.
   - Done: every same-selector declaration that a later rule always overrides is removed (232 cuts over 10 files; `css_dead.py report` shows 0 dead). Snapshot diff: no change.
   - Done: ui-fix, special, zeno-fix and minimalist folded in (shell parts -> base.css, clocks -> time.css, music page -> booth.css, player overlays -> player.css). 20 -> 16 stylesheets, one 257 KB bundle. `css_dead.py order-check` flagged 59 order flips, all checked as different elements; snapshot diff: no change.
   - Done: layout tokens in base.css. --page-gutter is used by every tab (content now starts 43.5 px in at 1280 wide, 65 px at 1920, on Home, Cinema, Music, Time, Photos, Downloads and Private; Downloads is no longer a centred box). z-index ladder (--z-below ... --z-intro): every global value is a layer + offset with the same number as before, Tailwind z-* classes are restated from CSS. Breakpoints cut from 10 widths to 4 + 1 height (899 / 900, 1050, 1250, height 700).
   - Done (first pass): `tools/css_unimportant.py` removed every !important and every leading `html body` / `html` that provably changes nothing (864 -> 782 !important, darkroom-6's `html body` 504 -> 282). Proof: each selector is matched against the live DOM of all views (runtime state relaxed away) plus JS-built markup, shorthands are expanded, and no pair of rules that can hit the same element may change winner. Snapshot diff: no change.
   - Done (6b, sidebar): `css_snapshot.py winners "#sidebar"` asks Chrome for the real cascade of every sidebar element in every view / palette / mode, with :hover forced on each button; `css_unimportant.py usage` lists declarations that never win (148: mostly the old minimalist/special sidebar rules in base.css and darkroom-6's own `#sidebar .sb-item` duplicates of `#sidebar #sb-scroll .sb-item`). Deleting them freed more !important: sidebar 105 -> 28, all files 782 -> 655. Snapshot diff (now with hover states): no change.
   - Found while doing it: the ULTRON STAR (chrome) palette's sidebar item colours and logo-glyph overrides never applied (darkroom-6 / base out-ranked them), so they were dead and are gone; if the chrome palette should restyle the sidebar, that needs writing fresh.
   - Left in the sidebar (28): Plain / Minimal UI modes (plain.css) and the Colorful background deliberately override with !important; item / tool colours still fight `html body .text-accent { color: ... !important }` (a global utility, fix it once for the whole app); a few `display` rules guard against JS inline styles.
   - Done (.text-accent): it is now the one deliberate !important colour utility (comment in darkroom-6.css). Colour rules that were !important only to beat it lost it (`css_unimportant.py --let-win .text-accent`), so the class wins where JS sets it. Visible fix: the sidebar's mouse button now shows the accent colour while "wheel scrolls rows" is on (it never did: `#sidebar .sb-tools .sb-tool` out-ranked it). Hover on a sidebar tool keeps !important so an "on" tool does not vanish on its accent background.
   - Next: same treatment for the next most-fought groups (#videos-view, #series-view, #home-view, #video-view, #photos-view).
   - Spotted, not changed yet: the sidebar search icon sits left of centre (minimalist.css `.sb-search { justify-content: flex-start }`), and minimalist's `* { text-shadow: none !important }` cancels every text-shadow in the app (e.g. zeno-fix's player flash).
3. JS load: mostly solved by the bundler (21 requests -> 3). Minifying and lazy-loading tab-only scripts would still save parse time; needs a build step (esbuild), not worth it yet.
4. Idle work (checked, low value): most of the 15 timers only start while something is playing, ringing or open, and the rest are light (1 s polls). Not worth the risk. The always-on clock timer was the one worth fixing, and is.

## Fix when touching the code
5. app.py is one 7,300-line file (148 routes) and app.js is 284 KB. Splitting is risky: the app starts from app.py, and a split can duplicate its global state or break the packaged exe. Only do it with the real desktop app in front of you.
6. The `except Exception: pass` spots are fine: Windows priority calls, tray label, window restore and logging shutdown are best-effort on purpose. (Page-settings restore now logs.)
7. 32 JS function names are defined in more than one file (say, esc, clamp, paint...). Most are private helpers inside their own wrapper and harmless. Check that paintSettings (app.js, mpv-player.js, photos-lock.js) and openMenu / closeMenu (app.js, tiles.js) do not overwrite each other globally.
8. (done) Search-palette thumbnails now lazy.
9. Tests: `python tests/test_backup.py` covers backup / restore (runs on a temp copy, never your data). Lock and sort logic still have none.

## Checked and clean
- No duplicate Python functions, no duplicate method+route pairs, no unlinked CSS/JS files.
