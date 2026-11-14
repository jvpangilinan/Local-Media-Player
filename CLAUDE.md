# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ULTRON / ZENO: an offline Windows desktop player for local videos, music and photos. It's a Flask backend (`app.py`) serving a single-page frontend inside a pywebview window, with libmpv for playback. The user docs are `README.md` (feature notes for each version), `SETUP.txt` (dependencies) and `TODO.md` (audit and known debt).

## Commands

Use Python 3.12 (64-bit). Newer versions often lack wheels.

```
py -3.12 -m pip install -r requirements.txt
py -3.12 app.py                                  # desktop window
py -3.12 app.py --browser                        # normal browser tab (easiest for debugging the frontend)
py -3.12 app.py --videos "D:\Videos" --music "E:\Music"
py -3.12 tests/test_backup.py                    # tests are plain scripts with asserts, no pytest
py -3.12 tests/test_data_home.py
build_exe.bat                                    # PyInstaller one-file build -> ULTRON.exe
```

- Run one test by running its file directly. Each test copies every `*.py` into a temp folder, sets `ZENO_DATA_DIR` to it, imports `app`, and drives it through `app.app.test_client()`. Real user data is never touched. New tests should follow the same pattern.
- After editing CSS or JS, open `/?nobundle=1` (or set `ZENO_NO_BUNDLE=1`). At serve time the server merges the stylesheets and scripts into chunks, so a syntax error in one script breaks its whole chunk and the error's line numbers point into the merged file.
- Rebuild Tailwind only when `templates/index.html` gets new classes: `npx tailwindcss -c tailwind.config.js -i tailwind.input.css -o vendor/tailwind.css --minify` (tailwindcss@3.4.17).
- The sandbox usually has no libmpv, Qt or ffmpeg. Playback, the native player and the packaged exe can only be checked on the real desktop app.

## Architecture

**Process model.** `app.py` is the entry point for everything:
- A normal start runs the Flask server, the scanner, SQLite, the tray icon and the pywebview window. A single-instance lock on `127.0.0.1:47399` makes a second launch focus the running window and quit.
- `ULTRON.exe --player ...` / `app.py --player` is handled at the very top of `app.py` (before the server start-up). It hands off to `native_player.run()`, a separate Qt process (`native_ui.py`: PySide6 widgets over an OpenGL surface that mpv renders into). This process talks back to the server over localhost (resume point, views, subtitles, next episode). Exit code 3 means it failed, and the app then falls back to the web player.
- `mpv_backend.py` holds the libmpv engines, options and DLL lookup. It's imported lazily, so the app still runs without python-mpv or the DLL. The in-window player is driven from `assets/js/mpv-player.js` through `/api/player/*`, and that script makes `<video id="player">` behave as if it were a normal video element.

**Backend (`app.py`, about 7,500 lines and about 150 routes, in one file on purpose).** It holds global state, routes, the scanner, the DB and the window. `TODO.md` warns that splitting it can duplicate global state or break the PyInstaller build. If you split it anyway, keep one owner for globals (`WINDOW`, `DATA_DIR`, settings) and add every new module to the `--hidden-import` list in `build_exe.bat`. Helper modules: `autosubs.py` (faster-whisper and NLLB subtitles, models in `models/`, fetched by `download_models.py`), `autogenre.py` (TMDB / MusicBrainz / Last.fm genre lookups), `moviesort.py`.

**CSRF guard.** Every POST/PUT/PATCH/DELETE must send the header `X-LMP: 1`, or it gets a 403. Frontend fetch helpers in `app.js` add it. Tests send it explicitly.

**Data location** (resolved in `app.py`, see the docstring near `ZENO_DATA_DIR`), in this order:
1. `ZENO_DATA_DIR`
2. the app folder's own `data/` if it already has data
3. `%APPDATA%\ZENO\data`, filled once by copying from the newest sibling ZENO folder

It holds SQLite (WAL, synchronous=NORMAL), `settings.json`, posters, thumbnails and backups. Media folders (`media/videos|music|private|Photos`) stay next to the app. Library layout: `media/videos/<Genre>/<video>` is a stand-alone video, and `media/videos/<Genre>/<Series>/<episodes>` is a series.

**Frontend.** `templates/index.html` holds only markup. `assets/css/*.css` and `assets/js/*.js` load in the order `index.html` lists them, and later files override earlier ones. The bundler keeps that order. `vendor/` holds Tailwind, Font Awesome 6.4.0 and Inter, so the app works offline (no CDNs). `app.js` (about 280 KB) is the main script, and feature scripts sit beside it.

**Private library.** It's password-locked, and the unlock is held only in memory with an idle auto-lock. Private content must never appear in the main search (Ctrl+K), and `private-search.js` must never show public items. The trimmer and clips are disabled for private videos.

**Background work is throttled on purpose.** At most 2 ffmpeg/ffprobe processes and 1 clip export run at a time, all at low CPU and disk priority. Files written in the last 2 minutes or with partial-download extensions are skipped. The folder watcher polls (every 30 s while the page is open, every 5 min when hidden or playing) and rescans only after the folders go quiet. It polls on purpose: change notifications hold folders open and block safely removing a USB drive. Keep these limits when you touch the scanner or thumbnail code.

## Known debt (from TODO.md)

- CSS: `darkroom-6.css` (now holding what was left of darkroom-1..5), `minimalist.css`, `ui-fix.css` and `zeno-fix.css` override each other with `!important` (darkroom-6 has ~600 !important declarations). This causes the fade, clipping and highlight bugs. The plan is to merge them into one base file plus one theme file. Check every CSS change with `tools/css_snapshot.py` (snap before and after, then diff; see its docstring) and find overridden declarations with `py -3.12 tools/css_dead.py report`. There is no light theme anymore.
- Some JS function names are defined globally in more than one file: `paintSettings` (app.js, mpv-player.js, photos-lock.js) and `openMenu`/`closeMenu` (app.js, tiles.js). Check for global overwrites before renaming or moving them.
- `except Exception: pass` around Windows priority calls, tray, window restore and logging shutdown is deliberate (best-effort).
- There are no tests for the lock and sort logic yet.
