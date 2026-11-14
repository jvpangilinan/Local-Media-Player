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
2. CSS stack (speed part solved by the bundler; the cleanup is still open): 28 stylesheets, ~340 KB. darkroom-1..6 + ui-fix + zeno-fix fight each other with !important (darkroom-6 alone has 208). This is where the fade / clipping / off-by-one highlight bugs come from. Merge into base + one theme file, delete rules that are overridden later.
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
