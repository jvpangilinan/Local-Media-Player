#!/usr/bin/env python3
"""
ULTRON - desktop app
Flask backend + pywebview window (a real desktop window, not a browser tab).

Folders (created on first run, next to this script):
    media/videos   your videos      (scanned recursively)
                   media/videos/<Genre>/<video>              -> a standalone video in that genre
                   media/videos/<Genre>/<Series>/<episodes>  -> one series card with its episodes inside
                   (make genres inside the app with "New genre", or just create the folder yourself)
    media/private  videos kept behind the password lock (media/private/Photos = the private photo gallery)
    media/Photos   the public photo gallery. Every subfolder of media/Photos (and media/private/Photos) is an album,
                   so you make an album by making a folder. Hearted photos are remembered in data/media_stats.db
    media/music    your music       (scanned recursively)
    data/          SQLite (stats, progress, titles, music index), cached posters
    templates/index.html           the frontend
    logo.png                       optional logo (PNG, shown at max 40px tall)
    artist_rules.txt               artist names that must not be split into collaborators (made on first run)
    playlists/                     only used if the "Save as" dialog is unavailable when exporting a .m3u

Subtitles: put  <video name>.srt / .vtt  (or  <video name>.en.srt, .es.vtt ...)  next to the video.
Auto subtitles: press CC in the player > "Generate subtitles". Whisper writes the text, NLLB translates it, all on this PC.
    models/        the speech + translation models (download_models.py, build_exe.bat or Settings > Subtitles fills it)
    data/autosubs  the generated .vtt files and the transcripts (so a second language only needs the translation step)

Run:   python app.py
Other: python app.py --videos "D:\\Videos" --music "E:\\Music"
       python app.py --browser      (opens in your normal browser instead - handy for debugging)
"""
import argparse
import base64
import hashlib
import hmac
import json
import logging
import math
import mimetypes
import os
import queue
import random
import re
import secrets
import shlex
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

if len(sys.argv) > 1 and sys.argv[1] == "--player":      # the native player is its own small process (see native_player.py): skip the whole server start-up
    import native_player
    sys.exit(native_player.run(sys.argv[2:]))

from flask import Flask, Response, abort, jsonify, render_template, request, send_file, send_from_directory
from mutagen import File as MutagenFile
from moviesort import clean_movie_title, clean_junk, group_franchises, parse_episode
import remote                                        # Phone remote: a separate LAN-only server (off by default), see remote.py
import autogenre                                     # Smart genres: TMDB / MusicBrainz / Last.fm lookups, cached locally
import mpv_backend                                  # libmpv playback engine (needs python-mpv + libmpv-2.dll at run time, never at import time)
from mutagen.flac import Picture

try:                                   # used for video posters; ffmpeg is the fallback
    import cv2
    import numpy as np
except ImportError:
    cv2 = np = None

try:                                   # photo sizes and thumbnails
    from PIL import Image as PILImage, ImageOps
except Exception:
    PILImage = ImageOps = None

try:                                   # used to detect the language of song lyrics
    from langdetect import detect_langs, DetectorFactory
    DetectorFactory.seed = 0
except Exception:
    detect_langs = None

try:                                   # local auto subtitles (Whisper + NLLB); the app still starts without the AI packages
    import autosubs
except Exception:
    autosubs = None

# ----------------------------------------------------------------------------- settings
FROZEN = getattr(sys, "frozen", False)
APP_DIR = Path(sys.executable).parent if FROZEN else Path(__file__).resolve().parent
RES_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))          # where templates + vendor/ live when bundled

# ----------------------------------------------------------------------------- logging
# Errors that used to be swallowed by a bare "except: pass" are written to app.log next to the app.
LOG_PATH = APP_DIR / "app.log"
log = logging.getLogger("lmp")
log.setLevel(logging.INFO)
if not log.handlers:
    try:
        from logging.handlers import RotatingFileHandler
        _h = RotatingFileHandler(LOG_PATH, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
        _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(funcName)s: %(message)s"))
        log.addHandler(_h)
    except OSError:                     # read-only folder: logging must never stop the app
        log.addHandler(logging.NullHandler())
log.propagate = False

CFG = {
    "video_dir": Path(os.environ.get("MEDIA_VIDEO_DIR", APP_DIR / "media" / "videos")),
    "music_dir": Path(os.environ.get("MEDIA_MUSIC_DIR", APP_DIR / "media" / "music")),
    "private_dir": Path(os.environ.get("MEDIA_PRIVATE_DIR", APP_DIR / "media" / "private")),
    "photo_dir": Path(os.environ.get("MEDIA_PHOTO_DIR", APP_DIR / "media" / "Photos")),   # public pictures (no password unless you set a Photos password in Settings)
}
CFG["clips_dir"] = None                           # None = "Clips" inside the video folder (see effective_dir)
CFG["shots_dir"] = Path.home() / "Pictures" / "ULTRON"     # screenshots taken in the player
DEFAULT_CFG = dict(CFG)                           # built-in folder locations, for "reset to default"


def effective_dir(key):
    """The folder really in use for a CFG key (clips default to <videos>/Clips)."""
    if key == "clips_dir":
        return CFG["clips_dir"] or (CFG["video_dir"] / "Clips")
    return CFG[key]
def _has_user_data(d):
    """True when folder d already holds a ZENO database or settings file."""
    try:
        return (d / "settings.json").is_file() or (d / "media_stats.db").is_file()
    except OSError:
        return False


def _stable_data_home():
    """Where your data lives when the app folder has none: it stays put when you unzip a newer version."""
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    return base / "ZENO" / "data"


def _import_older_data(dest):
    """First run of a new version: copy the data of the newest older ZENO folder that sits next to this one.
    Copies, never moves, so the old version keeps working. Returns the folder it took the data from, or None."""
    try:
        cands = []
        for sib in APP_DIR.parent.iterdir():
            d = sib / "data"
            if sib != APP_DIR and sib.is_dir() and _has_user_data(d):
                stamp = max((f.stat().st_mtime for f in (d / "settings.json", d / "media_stats.db") if f.exists()), default=0)
                cands.append((stamp, sib, d))
        if not cands:
            return None
        cands.sort(key=lambda c: c[0], reverse=True)
        src = cands[0][2]
        dest.mkdir(parents=True, exist_ok=True)
        skip = {"webview", "tmp", "backups", "downloads"}
        for item in src.iterdir():
            if item.name in skip or item.name == "media_stats.db" or item.name.endswith((".db-wal", ".db-shm")):
                continue
            target = dest / item.name
            if item.is_dir():
                shutil.copytree(item, target, dirs_exist_ok=True)
            else:
                shutil.copy2(item, target)
        # sqlite's own copy keeps the database consistent even if the old copy of ZENO is still open
        if (src / "media_stats.db").is_file():
            with closing(sqlite3.connect(src / "media_stats.db", timeout=15)) as a, closing(sqlite3.connect(dest / "media_stats.db")) as b:
                a.backup(b)
        return src.parent
    except Exception:
        log.warning("could not bring over data from an older version", exc_info=True)
        return None


def resolve_data_dir():
    """1) ZENO_DATA_DIR if set  2) the app folder's own data/ when it already has data (existing install)
    3) otherwise a fixed per-user folder, filled once from the newest older version found next to this one."""
    env = os.environ.get("ZENO_DATA_DIR")
    if env:
        return Path(env).expanduser(), "custom", None
    local = APP_DIR / "data"
    if _has_user_data(local):
        return local, "app-folder", None
    home = _stable_data_home()
    if _has_user_data(home):
        return home, "user-folder", None
    try:
        home.mkdir(parents=True, exist_ok=True)
    except OSError:
        return local, "app-folder", None                         # cannot write there: keep the old behaviour
    return home, "user-folder", _import_older_data(home)


DATA_DIR, DATA_WHERE, DATA_IMPORTED_FROM = resolve_data_dir()
POSTER_DIR = DATA_DIR / "posters"
THUMB_DIR = DATA_DIR / "thumbs"             # gallery thumbnails
BACKDROP_DIR = DATA_DIR / "backdrops"        # wide stills for the hero banner
TILE_DIR = DATA_DIR / "tiles"                # clean square thumbnails for the Cinema tiles
CUSTOM_TILE_DIR = DATA_DIR / "custom_tiles"  # thumbnails you set yourself (movie / series / collection)
DB_PATH = DATA_DIR / "media_stats.db"
MUSIC_CACHE = DATA_DIR / "music_cache.json"      # legacy: imported into SQLite once, then renamed
SETTINGS_PATH = DATA_DIR / "settings.json"
RULES_PATH = APP_DIR / "artist_rules.txt"        # artist names that must NOT be split into collaborators
EXPORT_DIR = APP_DIR / "playlists"               # fallback folder when no save dialog is available
WINDOW = None                                    # the pywebview window (None in --browser mode)

PROFILE = "default"          # ratings are stored per profile; the average is taken across profiles
SESSION_HOURS = 8           # a private-library unlock lasts at most this long
ROW_LIMIT = 30               # max cards per carousel
NEW_DAYS = 7                 # "NEW" badge on anything added in the last week
RECENT_DAYS = 14             # "Recently Added" row shows things added in the last two weeks
POSTER_SIZE = (400, 600)     # 2:3 poster, matches the frontend cards
CONTINUE_MIN = 0.02          # "Continue Watching" = watched more than 2% ...
CONTINUE_MAX = 0.95          # ... and less than 95%

VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".wmv", ".flv"}
MUSIC_EXTS = {".mp3", ".flac", ".ogg", ".m4a", ".wav", ".opus"}
SUB_EXTS = {".srt", ".vtt"}
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")
SIDE_IMAGE_EXTS = set(IMAGE_EXTS)                     # images noted next to videos during a scan (posters, series art)
PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"}   # the private photo gallery
PHOTO_FOLDER = "Photos"      # media/private/Photos is the gallery's own folder (made for you)
PHOTO_SKIP = {"poster", "cover", "folder", "thumb", "thumbnail", "backdrop", "fanart", "banner", "series"}   # artwork, not photos
THUMB_W = 760                # gallery thumbnails are this wide at most
NO_WINDOW = 0x08000000 if os.name == "nt" else 0   # hide ffmpeg console windows on Windows
LOW_PRIORITY = 0x00004000 if os.name == "nt" else 0    # ffmpeg/ffprobe run below normal priority so playback and the UI never stutter
FF_SHORT = threading.BoundedSemaphore(2)             # thumbnails, probes, crop detection, preview strips: at most 2 ffmpeg/ffprobe processes at once
FF_LONG = threading.BoundedSemaphore(1)              # clip exports: one at a time


def _very_low_io(proc):
    """Windows: put a child process's disk priority at 'very low', so a torrent client (or anything else) always gets the disk first."""
    if os.name != "nt":
        return
    try:
        import ctypes
        k = ctypes.windll.kernel32
        k.OpenProcess.restype = ctypes.c_void_p
        h = k.OpenProcess(0x0200, False, proc.pid)           # PROCESS_SET_INFORMATION
        if h:
            level = ctypes.c_ulong(0)                         # 0 = very low, 1 = low, 2 = normal
            ctypes.windll.ntdll.NtSetInformationProcess(ctypes.c_void_p(h), 33, ctypes.byref(level), 4)     # 33 = ProcessIoPriority
            k.CloseHandle(ctypes.c_void_p(h))
    except Exception:
        pass


def ff_run(cmd, timeout=90, long=False, **kw):
    """subprocess.run for ffmpeg/ffprobe: waits for a free slot first (a page full of thumbnails can never start dozens of
    processes), runs at below-normal CPU priority and very low disk priority."""
    if kw.pop("capture_output", True):
        kw.setdefault("stdout", subprocess.PIPE)
        kw.setdefault("stderr", subprocess.PIPE)
    kw["creationflags"] = kw.get("creationflags", NO_WINDOW) | LOW_PRIORITY
    with (FF_LONG if long else FF_SHORT):
        proc = subprocess.Popen(cmd, **kw)
        _very_low_io(proc)
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise
        return subprocess.CompletedProcess(cmd, proc.returncode, out, err)


def background_io(on=True):
    """Windows: this thread's disk and CPU priority goes to 'background' (and back). Used by indexing / thumbnail threads."""
    if os.name != "nt":
        return
    try:
        import ctypes
        k = ctypes.windll.kernel32
        k.GetCurrentThread.restype = ctypes.c_void_p
        k.SetThreadPriority(ctypes.c_void_p(k.GetCurrentThread()), 0x00010000 if on else 0x00020000)   # THREAD_MODE_BACKGROUND_BEGIN / END
    except Exception:
        pass


SETTLE_SECS = 120                                    # a file written to within the last 2 minutes is still downloading: leave it alone
PARTIAL_EXTS = {".part", ".!qb", ".!ut", ".crdownload", ".aria2", ".td", ".bc!", ".downloading", ".tmp", ".temp"}


def unsettled(path):
    """True while a file is still being written (a torrent or download in progress). Thumbnails and probes of half a file are
    wasted disk reads and would be cached wrong, so they wait until the file has been quiet for a couple of minutes."""
    try:
        p = Path(path)
        return p.suffix.lower() in PARTIAL_EXTS or time.time() - p.stat().st_mtime < SETTLE_SECS
    except OSError:
        return False
LYR_V = 4                    # bump to force every song's language to be re-detected
META_V = 2                   # bump to force every music file's tags to be re-read
LRCLIB_UA = {"User-Agent": "ULTRON/1.0 (personal library tool)"}

GENRE_TOKENS = {   # playlist generator genre -> words looked for in the genre tag and folder names
    "edm": {"edm", "electronic", "electronica", "house", "techno", "trance", "dance", "dubstep", "electro", "dnb"},
    "pop": {"pop", "kpop", "jpop", "synthpop"},
    "rock": {"rock", "metal", "punk", "grunge", "emo"},
    "hiphop": {"hiphop", "hip", "hop", "rap", "trap", "drill"},
    "chill": {"chill", "chillout", "lofi", "ambient", "downtempo", "mellow", "relax", "relaxing", "study"},
}
GENRE_NAMES = {"edm": "EDM", "pop": "Pop", "rock": "Rock", "hiphop": "Hip Hop", "chill": "Chill / Lo-Fi"}
LANG_CODES = {"en": "en", "eng": "en", "english": "en", "es": "es", "spa": "es", "spanish": "es",
              "ko": "kr", "kor": "kr", "korean": "kr", "kr": "kr", "ja": "jp", "jpn": "jp", "japanese": "jp", "jp": "jp"}
LANG_FOLDERS = {"english": "en", "spanish": "es", "korean": "kr", "kpop": "kr", "japanese": "jp", "jpop": "jp"}
SUB_LANGS = {"en": "English", "eng": "English", "es": "Spanish", "spa": "Spanish", "ko": "Korean", "kor": "Korean",
             "ja": "Japanese", "jpn": "Japanese", "fr": "French", "fre": "French", "fra": "French",
             "de": "German", "ger": "German", "deu": "German", "pt": "Portuguese", "por": "Portuguese",
             "zh": "Chinese", "chi": "Chinese", "zho": "Chinese", "tl": "Filipino", "fil": "Filipino"}

PLACEHOLDER_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="100%" height="100%" '
                   'fill="#2b2b2b"/><text x="50%" y="50%" fill="#777" font-family="sans-serif" font-size="28" '
                   'text-anchor="middle">No poster</text></svg>')


COVER_PLACEHOLDER_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
                         '<stop offset="0" stop-color="#2a2a33"/><stop offset="1" stop-color="#14141a"/></linearGradient></defs>'
                         '<rect width="400" height="400" fill="url(#g)"/><g fill="none" stroke="#6b6b78" stroke-width="14" stroke-linecap="round" stroke-linejoin="round">'
                         '<path d="M250 110v150"/><path d="M250 110l-80 22v128"/><circle cx="145" cy="262" r="26"/><circle cx="225" cy="262" r="26"/></g></svg>')


def _template_dir():
    for d in (RES_DIR / "templates", RES_DIR):          # index.html may also sit right next to app.py
        if (d / "index.html").is_file():
            return d
    return RES_DIR / "templates"


app = Flask(__name__, template_folder=str(_template_dir()))
try:
    app.json.ensure_ascii = False
except AttributeError:
    pass

LIB = {"videos": {}, "tracks": {}, "series": {}}   # in-memory index (files are the source of truth)
LIB_LOCK = threading.RLock()
STATUS = {"music_scanning": False}
POSTER_LOCK = threading.Lock()
POSTER_FAILED = set()
BACKDROP_FAILED = set()
TILE_FAILED = set()

TRACK_COLS = ("title", "artist", "album", "genre", "lang", "duration", "genre_text", "meta_v", "added_at")
TRACK_SQL = ("INSERT OR REPLACE INTO tracks (rel_path, mtime, size, " + ", ".join(TRACK_COLS) + ") VALUES (?,?,?,"
             + ",".join("?" * len(TRACK_COLS)) + ")")


# ----------------------------------------------------------------------------- database
def db():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA synchronous=NORMAL")          # safe with WAL; skips an fsync on every commit
    con.execute("PRAGMA temp_store=MEMORY")
    con.execute("PRAGMA cache_size=-16000")           # ~16 MB of page cache: fewer re-reads of the database file
    return con


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with closing(db()) as con, con:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("""CREATE TABLE IF NOT EXISTS videos (
            id TEXT PRIMARY KEY, rel_path TEXT, added_at REAL, mtime REAL,
            view_count INTEGER NOT NULL DEFAULT 0, last_viewed REAL, missing INTEGER NOT NULL DEFAULT 0)""")
        con.execute("""CREATE TABLE IF NOT EXISTS ratings (
            video_id TEXT NOT NULL, profile TEXT NOT NULL,
            stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5), updated_at REAL,
            PRIMARY KEY (video_id, profile))""")
        con.execute("""CREATE TABLE IF NOT EXISTS tracks (
            rel_path TEXT PRIMARY KEY, mtime REAL, size INTEGER,
            title TEXT, artist TEXT, album TEXT, genre TEXT, lang TEXT, duration INTEGER, genre_text TEXT)""")
        # language detected from lyrics (kept apart from `tracks`, so a rescan never wipes it)
        con.execute("""CREATE TABLE IF NOT EXISTS lang_info (
            rel_path TEXT PRIMARY KEY, lyr_lang TEXT, lang_mix TEXT, lang_src TEXT,
            lyr_v INTEGER NOT NULL DEFAULT 0, lang_manual TEXT)""")
        con.execute("""CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at REAL, updated_at REAL)""")
        con.execute("""CREATE TABLE IF NOT EXISTS playlist_tracks (
            playlist_id INTEGER NOT NULL, rel_path TEXT NOT NULL, position INTEGER NOT NULL,
            PRIMARY KEY (playlist_id, rel_path))""")
        # every song play (how long it was heard) - feeds the recommendations
        con.execute("""CREATE TABLE IF NOT EXISTS plays (
            id INTEGER PRIMARY KEY AUTOINCREMENT, rel_path TEXT NOT NULL, at REAL NOT NULL,
            listened REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0)""")
        # favourite photos, kept apart from every scan so a rescan never forgets a heart (scope = public | private)
        con.execute("""CREATE TABLE IF NOT EXISTS photo_favs (
            scope TEXT NOT NULL, rel TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY (scope, rel))""")
        # photo width/height, so opening the gallery does not open every image again after a restart (key = scope:rel)
        con.execute("""CREATE TABLE IF NOT EXISTS photo_dims (
            key TEXT PRIMARY KEY, mtime REAL NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL)""")
        # albums made by hand ("Make into album"): kept apart from `tracks`, so a rescan never forgets them and the files' tags stay untouched
        con.execute("""CREATE TABLE IF NOT EXISTS album_overrides (
            rel_path TEXT PRIMARY KEY, album TEXT NOT NULL, album_artist TEXT NOT NULL DEFAULT '',
            track_no INTEGER NOT NULL DEFAULT 0, created_at REAL)""")
        # movies put into (or kept out of) a collection by hand ("Add movies" in Cinema): the auto-sorter still runs, these win.
        # name = '' means "keep this movie out of every automatic collection"
        con.execute("""CREATE TABLE IF NOT EXISTS collection_overrides (
            video_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', created_at REAL)""")
        # hearts on Cinema tiles (movie id, series id or collection name); kept apart from every scan
        con.execute("""CREATE TABLE IF NOT EXISTS cinema_favs (
            kind TEXT NOT NULL, key TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY (kind, key))""")
        autogenre.init_db(con)
        con.execute("CREATE INDEX IF NOT EXISTS plays_rel ON plays(rel_path)")
        con.execute("CREATE INDEX IF NOT EXISTS plays_at ON plays(at)")
        # upgrade older databases in place: watch progress + custom titles
        have = {r["name"] for r in con.execute("PRAGMA table_info(videos)")}
        for name, ddl in (("custom_title", "TEXT"), ("size", "INTEGER NOT NULL DEFAULT 0"), ("position", "REAL NOT NULL DEFAULT 0"),
                          ("duration", "REAL NOT NULL DEFAULT 0"), ("progress_at", "REAL")):
            if name not in have:
                con.execute(f"ALTER TABLE videos ADD COLUMN {name} {ddl}")
        have = {r["name"] for r in con.execute("PRAGMA table_info(tracks)")}
        if "meta_v" not in have:                 # old rows get re-read once (better artist detection)
            con.execute("ALTER TABLE tracks ADD COLUMN meta_v INTEGER NOT NULL DEFAULT 0")
        if "added_at" not in have:               # when a song first showed up (for "New arrivals")
            con.execute("ALTER TABLE tracks ADD COLUMN added_at REAL NOT NULL DEFAULT 0")


def track_row(rel, mtime, size, m):
    return (rel, mtime, size, *[m.get(c) or (0 if c in ("duration", "meta_v", "added_at") else "") for c in TRACK_COLS])


def migrate_music_cache():
    """One-time import of the old music_cache.json into SQLite."""
    if not MUSIC_CACHE.is_file():
        return
    try:
        old = json.loads(MUSIC_CACHE.read_text(encoding="utf-8"))
        rows = []
        for rel, m in old.items():
            sig = m.get("sig") or [0, 0]
            rows.append(track_row(rel, sig[0], sig[1], m))
        with closing(db()) as con, con:
            con.executemany(TRACK_SQL.replace("OR REPLACE", "OR IGNORE"), rows)
        MUSIC_CACHE.replace(MUSIC_CACHE.with_name(MUSIC_CACHE.name + ".migrated"))
    except Exception:
        log.warning("migrate_music_cache: Exception ignored", exc_info=True)


# ----------------------------------------------------------------------------- scanning
def pretty(stem):
    return re.sub(r"\s+", " ", re.sub(r"[_.]+", " ", stem)).strip() or stem


def item_id(rel):
    return hashlib.sha1(rel.encode("utf-8")).hexdigest()[:12]


def dir_key(path):
    """Key for a folder in the `side` maps of walk_entries (case- and slash-insensitive, like Windows paths)."""
    return os.path.normcase(os.path.normpath(str(path)))


def walk_entries(root, exts, side_exts=None, side=None):
    """Yield (Path, os.DirEntry) for every file under root with one of exts, skipping dot-files and dot-folders.
    Same order as os.walk (a folder's files first, then its subfolders), symlinked folders are not followed.
    Call entry.stat() for the file's size / mtime: on Windows it comes from the folder listing itself, so a scan
    costs one disk call per folder instead of one per file (it matters on a big library on a separate HDD).
    With side_exts and a side dict, files with those extensions are also noted (no extra disk calls):
    side[dir_key(folder)] = {lowercase file name: Path}. The scanner uses it for posters and series art."""
    if not root.is_dir():
        return
    stack = [str(root)]
    while stack:
        d = stack.pop()
        subdirs = []
        try:
            with os.scandir(d) as it:
                entries = list(it)
        except OSError:
            continue                                 # unreadable folder: skip it, like os.walk does
        for e in entries:
            name = e.name
            if name.startswith("."):
                continue
            try:
                if e.is_dir():
                    if not e.is_symlink():
                        subdirs.append(e.path)
                    continue
            except OSError:
                continue
            ext = Path(name).suffix.lower()
            if side_exts and ext in side_exts:
                side.setdefault(dir_key(d), {})[name.lower()] = Path(e.path)
            if ext in exts:
                yield Path(e.path), e
        stack.extend(reversed(subdirs))              # keep the listing order when popping


def natkey(s):
    """Natural sort key: 'Episode 2' sorts before 'Episode 10'."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", str(s))]


def clean_folder(v):
    v = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", str(v or ""))
    return re.sub(r"\s+", " ", v).strip(" .")[:60]


SCAN_LOCK = threading.Lock()
STARTUP_SCAN = threading.Event()                  # cleared by main() while the first video scan runs, set when it is done
STARTUP_SCAN.set()
SCAN_STATE = {"running": False, "again": False}
SCAN_GUARD = threading.Lock()
MUSIC_SCAN_LOCK = threading.Lock()               # one music scan at a time; a second caller waits, then rescans
MUSIC_STATE = {"running": False, "again": False}  # the background music scan (Rescan button, folder watcher)
SCAN_VER = {"v": 0}                 # bumps every time the video library was re-indexed (the page polls it)
OFFLINE = {}                        # library -> folder, for media folders that were not there at the last scan (drive unplugged)


def folder_online(root):
    """True when a media folder can be read. False when it (or its whole drive) is gone, e.g. an unplugged HDD."""
    try:
        return Path(root).is_dir()
    except OSError:
        return False


def drive_present(path):
    """True when the drive (or network share) a path lives on is connected, whether or not the folder itself exists."""
    anchor = Path(path).anchor
    if not anchor:
        return True
    try:
        return os.path.exists(anchor)
    except OSError:
        return False


def set_offline(name, root, online):
    """Remember (and log once) that a media folder went away or came back."""
    was = name in OFFLINE
    if online:
        OFFLINE.pop(name, None)
        if was:
            log.info("%s folder is back: %s", name, root)
    else:
        OFFLINE[name] = str(root)
        if not was:
            log.warning("%s folder is not available (drive not connected?): %s. Its library is kept and comes back with it.", name, root)


def offline_json():
    """Offline media folders for the page. The private folder's location is never sent, only that it is offline."""
    return [{"lib": n, "path": "" if n == "private" else p} for n, p in sorted(OFFLINE.items())]


def probe_duration(path):
    """Length in seconds via OpenCV (0 when unknown). Only used to tell look-alike files apart."""
    if cv2 is None:
        return 0.0
    try:
        cap = cv2.VideoCapture(str(path))
        fps, n = cap.get(cv2.CAP_PROP_FPS) or 0, cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        cap.release()
        return n / fps if fps > 0 and n > 0 else 0.0
    except Exception:
        log.warning("probe_duration failed for %s", path, exc_info=True)
        return 0.0


def relink_orphans(new, orphans):
    """A file that vanished from one place and a new file of the same size elsewhere are the same video when the
    mtime matches (a move keeps it) or the duration matches. Returns [(old_rel, new_rel)]."""
    by_size = defaultdict(list)
    for o in orphans:
        by_size[o["size"]].append(o)
    pairs, used = [], set()
    for v in sorted(new, key=lambda x: x["mtime"]):
        cands = [o for o in by_size.get(v["size"], []) if o["id"] not in used]
        if not cands:
            continue
        close = [o for o in cands if o["mtime"] and abs(o["mtime"] - v["mtime"]) <= 2.0]
        pick = close[0] if len(close) == 1 else None
        if pick is None:
            dur = None
            for o in (close or cands):
                if (o["duration"] or 0) <= 0:
                    continue
                if dur is None:
                    dur = probe_duration(v["path"])
                if dur > 0 and abs(dur - o["duration"]) <= 1.5:
                    pick = o
                    break
        if pick is not None:
            used.add(pick["id"])
            pairs.append((pick["rel_path"], v["rel"]))
            log.info("relinked moved video %s -> %s", pick["rel_path"], v["rel"])
    return pairs


def scan_videos():
    with SCAN_LOCK:
        return _scan_videos()


def schedule_scan():
    """Rescan in the background so uploads / moves return at once. Overlapping requests are merged into one rerun."""
    with SCAN_GUARD:
        if SCAN_STATE["running"]:
            SCAN_STATE["again"] = True
            return
        SCAN_STATE["running"] = True

    def work():
        try:
            while True:
                try:
                    scan_videos()
                except Exception:
                    log.exception("background scan_videos failed")
                with SCAN_GUARD:
                    if SCAN_STATE["again"]:
                        SCAN_STATE["again"] = False
                        continue
                    SCAN_STATE["running"] = False
                    break
            pregenerate_posters()
        except Exception:
            log.exception("background scan worker failed")
            with SCAN_GUARD:
                SCAN_STATE["running"] = False
    threading.Thread(target=work, daemon=True).start()


def _scan_videos():
    """Public videos live in media/videos, private ones in media/private (hidden until unlocked)."""
    found = {}
    side = {}                                                       # image files per folder, noted during the same walk
    offline = set()                                                 # False = public root, True = private root
    for root, private in ((CFG["video_dir"], False), (CFG["private_dir"], True)):
        online = folder_online(root)
        set_offline("private" if private else "videos", root, online)
        if not online:                                              # unplugged drive: do not treat every video as deleted
            offline.add(private)
            continue
        for p, entry in walk_entries(root, VIDEO_EXTS, SIDE_IMAGE_EXTS, side):
            parts = p.relative_to(root).parts
            rel = "/".join(parts)
            prefix = "private/" if private else ""
            key = prefix + rel
            try:
                st = entry.stat()
                mtime = st.st_mtime
            except OSError:
                log.debug("scan_videos: OSError ignored", exc_info=True)
                continue
            vid = item_id(key)
            genre = parts[0] if len(parts) >= 2 else ""                 # first folder = genre
            series = parts[1] if len(parts) >= 3 else ""                # folder inside a genre = series
            season = " / ".join(parts[2:-1]) if len(parts) >= 4 else ""
            stem = re.sub(r"^\d{3} - ", "", p.stem) if series else p.stem          # "003 - Title" -> "Title" inside a series
            found[vid] = {"id": vid, "path": p, "rel": key, "title": pretty(stem), "mtime": mtime, "size": st.st_size, "private": private,
                          "genre": genre, "series": series, "season": season,
                          "series_id": item_id(prefix + genre + "/" + series) if series else ""}
    try:
        _prefs = get_prefs()
        _auto, _clean = _prefs.get("auto_sort", True), _prefs.get("clean_titles", True)
    except Exception:
        _auto = _clean = True
    for v in found.values():
        if v["private"]:
            continue
        v["root"] = not v["genre"]                              # loose in the video folder: the auto-sorter may group it
        if v["series"]:
            if _clean and not v.get("virtual"):
                v["title"] = clean_junk(re.sub(r"^\d{3} - ", "", v["path"].stem))     # episodes: junk goes, numbers and years stay
            continue
        if v["root"] and _auto:
            ep = parse_episode(v["path"].stem)
            if ep:
                show, sn, en = ep
                v.update(series=show, season=f"Season {sn}", series_id=item_id("auto/" + re.sub(r"\W+", " ", show.lower()).strip()),
                         title=f"S{sn:02d}E{en:02d}", ep=(sn, en), virtual=True)
                continue
        if _clean:
            t, y = clean_movie_title(v["path"].stem)
            v["title"] = t
            if y:
                v["year"] = y
    now = time.time()
    is_off = lambda rel: (rel or "").startswith("private/") in offline     # a row whose folder is offline: leave it alone
    # moved outside the app? carry views / ratings / progress / title over to the file's new place
    try:
        with closing(db()) as con:
            known = {r["id"]: r for r in con.execute("SELECT id, rel_path, mtime, size, duration FROM videos")}
        new = [v for v in found.values() if v["id"] not in known]
        orphans = [r for r in known.values() if r["id"] not in found and (r["size"] or 0) > 0 and not is_off(r["rel_path"])]
        if new and orphans:
            pairs = relink_orphans(new, orphans)
            if pairs:
                rekey_videos(pairs)
    except Exception:
        log.exception("relinking moved videos failed")
    with closing(db()) as con, con:                           # only rows that really changed are written (a rescan used to rewrite every row)
        cur = {r["id"]: r for r in con.execute("SELECT id, rel_path, mtime, size, missing FROM videos")}
        con.executemany("INSERT OR IGNORE INTO videos (id, rel_path, added_at) VALUES (?,?,?)",
                        [(v["id"], v["rel"], now) for v in found.values() if v["id"] not in cur])
        con.executemany("UPDATE videos SET missing = 1 WHERE id = ?",         # stats are kept for files that disappear
                        [(i,) for i, r in cur.items() if i not in found and not r["missing"] and not is_off(r["rel_path"])])
        con.executemany("UPDATE videos SET missing = 0, rel_path = ?, mtime = ?, size = ? WHERE id = ?",
                        [(v["rel"], v["mtime"], v["size"], v["id"]) for v in found.values()
                         if v["id"] not in cur or cur[v["id"]]["missing"] or cur[v["id"]]["rel_path"] != v["rel"]
                         or cur[v["id"]]["mtime"] != v["mtime"] or cur[v["id"]]["size"] != v["size"]])
    series = {}
    for v in found.values():
        if not v["series_id"]:
            continue
        root = CFG["private_dir"] if v["private"] else CFG["video_dir"]
        virt = bool(v.get("virtual"))
        s = series.setdefault(v["series_id"], {"id": v["series_id"], "name": v["series"] if virt else (clean_junk(v["series"]) if (_clean and not v["private"]) else pretty(v["series"])), "genre": v["genre"],
                                                "private": v["private"], "folder": root if virt else root / v["genre"] / v["series"],
                                                "virtual": virt, "episodes": []})
        s["episodes"].append(v)
    for s in series.values():
        s["episodes"].sort(key=(lambda e: e.get("ep") or (0, 0)) if s.get("virtual") else (lambda e: (natkey(e["season"]), natkey(e["path"].name))))
        s["episodes"] = [e["id"] for e in s["episodes"]]
        s["art"] = pick_image(side.get(dir_key(s["folder"])), series_art_names(s))
    for v in found.values():                                  # your own poster next to the video, found without touching the disk again
        v["side_poster"] = pick_image(side.get(dir_key(v["path"].parent)), sidecar_names(v["path"]))
    with LIB_LOCK:
        LIB["videos"] = found
        LIB["series"] = series
    SCAN_VER["v"] += 1
    return len(found)


def script_language(text):
    if re.search(r"[\u3040-\u30ff]", text):
        return "jp"
    if re.search(r"[\uac00-\ud7af\u1100-\u11ff]", text):
        return "kr"
    return ""


def read_track(path, rel):
    meta = {"title": pretty(path.stem), "artist": "", "album": "", "genre": "", "lang": "", "duration": 0,
            "meta_v": META_V}
    try:
        f = MutagenFile(path, easy=True)
        if f is not None:
            if f.tags:
                g = lambda k: (str((f.tags.get(k) or [""])[0])).strip()
                meta["title"] = g("title") or meta["title"]
                meta["artist"] = g("artist") or g("albumartist")
                meta["album"], meta["genre"] = g("album"), g("genre")
                meta["lang"] = LANG_CODES.get(g("language").lower(), "")
            if getattr(f, "info", None) is not None:
                meta["duration"] = int(getattr(f.info, "length", 0) or 0)
    except Exception:
        log.warning("read_track: Exception ignored", exc_info=True)
    if not meta["artist"]:                       # no tag: try an "Artist - Title" file name
        parts = [x.strip() for x in path.stem.split(" - ")]
        if len(parts) > 2 and parts[0].isdigit():
            parts = parts[1:]
        if len(parts) > 1:
            meta["artist"] = parts[0]
    folders = " ".join(Path(rel).parts[:-1]).lower()
    if not meta["lang"]:
        tokens = set(re.findall(r"[a-z]+", folders.replace("-", "")))
        meta["lang"] = next((LANG_FOLDERS[t] for t in tokens if t in LANG_FOLDERS), "")
    if not meta["lang"]:
        meta["lang"] = script_language(" ".join((meta["title"], meta["artist"], meta["album"])))
    meta["genre_text"] = (meta["genre"] + " " + folders).lower().replace("lo-fi", "lofi").replace("lo fi", "lofi")
    return meta


def scan_music():
    """Index lives in SQLite (table `tracks`). Only new or changed files are re-read.
    Scans never overlap: a call made while one runs waits for it, then scans again (so its new files are seen)."""
    with MUSIC_SCAN_LOCK:
        return _scan_music()


def schedule_music_scan():
    """Rescan the music in the background so the caller returns at once. Requests made while it runs are merged into
    one rerun."""
    with SCAN_GUARD:
        if MUSIC_STATE["running"]:
            MUSIC_STATE["again"] = True
            return
        MUSIC_STATE["running"] = True

    def work():
        background_io(True)
        while True:
            try:
                scan_music()
            except Exception:
                log.exception("background scan_music failed")
            with SCAN_GUARD:
                if MUSIC_STATE["again"]:
                    MUSIC_STATE["again"] = False
                    continue
                MUSIC_STATE["running"] = False
                break
    threading.Thread(target=work, daemon=True).start()


def music_busy():
    return bool(MUSIC_STATE["running"] or STATUS["music_scanning"])


def _scan_music():
    STATUS["music_scanning"] = True
    try:
        root = CFG["music_dir"]
        set_offline("music", root, folder_online(root))
        with closing(db()) as con:
            cached = {r["rel_path"]: r for r in con.execute("SELECT * FROM tracks")}
        tracks, to_save, seen = {}, [], set()
        first_scan = not cached                  # very first index: use file dates, so nothing is "new" yet
        for p, entry in walk_entries(root, MUSIC_EXTS):
            rel = p.relative_to(root).as_posix()
            try:
                st = entry.stat()
            except OSError:
                log.debug("scan_music: OSError ignored", exc_info=True)
                continue
            seen.add(rel)
            row = cached.get(rel)
            prev = (row["added_at"] or 0) if row else 0
            if row and row["mtime"] == st.st_mtime and row["size"] == st.st_size and (row["meta_v"] or 0) >= META_V:
                meta = {c: row[c] for c in TRACK_COLS}
                meta["added_at"] = prev or st.st_mtime
            else:
                meta = read_track(p, rel)
                meta["added_at"] = prev or (st.st_mtime if (row or first_scan) else time.time())
                to_save.append(track_row(rel, st.st_mtime, st.st_size, meta))
            tid = item_id(rel)
            tracks[tid] = dict(meta, id=tid, path=p, rel=rel, mtime=st.st_mtime)
        try:
            with closing(db()) as con, con:
                con.executemany(TRACK_SQL, to_save)
                if folder_online(root):      # don't wipe the index just because a drive is unplugged
                    con.executemany("DELETE FROM tracks WHERE rel_path = ?", [(r,) for r in set(cached) - seen])
        except sqlite3.Error:
            log.warning("scan_music: sqlite3.Error ignored", exc_info=True)
        with LIB_LOCK:
            LIB["tracks"] = tracks
        try:
            rebuild_music()
        except Exception:
            log.warning("scan_music: Exception ignored", exc_info=True)
        return len(tracks)
    finally:
        STATUS["music_scanning"] = False


# ----------------------------------------------------------------------------- artists (from Music Sorter)
MASK = {",": "\x00", "&": "\x01", "/": "\x02", "+": "\x03", "-": "\x04", ";": "\x05"}
UNMASK = {v: k for k, v in MASK.items()}
SEP = re.compile(r"\s*(?:;|,|&|/|\+|\s[x×]\s|\s[-–—]\s|\s(?:feat\.?|ft\.?|featuring|with|vs\.?)\s)\s*", re.I)
DEFAULT_PROTECTED = ["Tyler, The Creator", "Earth, Wind & Fire", "Simon & Garfunkel", "Hall & Oates",
                     "Mumford & Sons", "Florence + the Machine", "Kool & the Gang", "Years & Years",
                     "Brooks & Dunn", "AC/DC", "Gang of Youths"]


def norm_key(s):
    if all(ord(c) < 0x250 for c in s):
        s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    return re.sub(r"[\W_]+", "", s.lower())


def load_protected():
    """Names in artist_rules.txt are never split into collaborators. The file is created on first run."""
    if not RULES_PATH.exists():
        try:
            RULES_PATH.write_text("# Artist names that must NOT be split into collaborators. One per line.\n"
                                  + "\n".join(DEFAULT_PROTECTED) + "\n", encoding="utf-8")
        except OSError:
            log.warning("load_protected: OSError ignored", exc_info=True)
            return list(DEFAULT_PROTECTED)
    try:
        return [l.strip() for l in RULES_PATH.read_text(encoding="utf-8-sig").splitlines()
                if l.strip() and not l.startswith("#")]
    except OSError:
        log.warning("load_protected: OSError ignored", exc_info=True)
        return list(DEFAULT_PROTECTED)


def protected_patterns(protected):
    pats = []
    for p in protected:
        toks = re.split(r"(\s*[,&/+\-]\s*)", p)
        pat = "".join((r"\s*" + re.escape(t.strip()) + r"\s*") if t.strip() in MASK else re.escape(t) for t in toks)
        try:
            pats.append(re.compile(pat, re.I))
        except re.error:
            pass
    return pats


def split_artists(s, pats):
    s = re.sub(r"[()\[\]]", ";", s or "")
    for pat in pats:
        s = pat.sub(lambda m: "".join(MASK.get(c, c) for c in m.group(0)), s)
    parts = [p.strip() for p in SEP.split(s) if p and p.strip()]
    return ["".join(UNMASK.get(c, c) for c in p).strip() for p in parts]


def group_artists(raw_by_id, pats):
    """ONE primary artist per song: the credited name that repeats most across the library
    (the first-listed name gets +1 so it wins ties). 'BrentFayaz' and 'Brent Fayaz' count as the same name."""
    cands, count, spell = {}, Counter(), defaultdict(Counter)
    for tid, raw in raw_by_id.items():
        names = split_artists(raw or "", pats)
        cs = [(norm_key(n), n) for n in names if norm_key(n)] or [("unknown", "Unknown")]
        cands[tid] = cs
        seen = set()
        for k, n in cs:
            if k not in seen:
                count[k] += 1
                spell[k][n] += 1
                seen.add(k)
    out = {}
    for tid, cs in cands.items():
        i, (k, _) = max(enumerate(cs), key=lambda t: (count[t[1][0]] + (1 if t[0] == 0 else 0), -t[0]))
        out[tid] = max(spell[k].items(), key=lambda kv: (kv[1], " " in kv[0]))[0]
    return out


# ----------------------------------------------------------------------------- language (from Music Sorter)
LANGNAME = {"en": "English", "es": "Spanish", "pt": "Portuguese", "fr": "French", "tl": "Filipino", "de": "German",
            "it": "Italian", "id": "Indonesian", "ms": "Malay", "nl": "Dutch", "sv": "Swedish", "no": "Norwegian",
            "da": "Danish", "fi": "Finnish", "pl": "Polish", "tr": "Turkish", "ro": "Romanian", "ca": "Catalan",
            "vi": "Vietnamese", "hi": "Hindi", "ja": "Japanese", "ko": "Korean", "zh-cn": "Chinese", "zh-tw": "Chinese",
            "ru": "Russian", "ar": "Arabic", "th": "Thai", "sw": "Swahili", "cy": "Welsh", "af": "Afrikaans",
            "so": "Somali"}
CODE_NAMES = {"en": "English", "es": "Spanish", "kr": "Korean", "jp": "Japanese"}   # codes stored in tracks.lang
LANG_ALIASES = {"tagalog": "Filipino", "pilipino": "Filipino", "kpop": "Korean", "jpop": "Japanese"}
FILLER = set("oh ooh oooh ohh yeah yea la na ah aah hey woah whoa mm mmm hmm uh huh ha da doo ay eh ey ha-ha".split())
ROMAJI = set("kimi boku anata nai kara koto desu itsumo mou sora kokoro shite omoi sayonara arigatou hikari yume kaze "
             "namida aishiteru daisuki mata ashita kyou watashi dakara shinjite mukou naka".split())


def script_lang(text):
    c = Counter()
    for ch in text:
        o = ord(ch)
        if 0x3040 <= o <= 0x30ff: c["Japanese"] += 1
        elif 0xac00 <= o <= 0xd7af or 0x1100 <= o <= 0x11ff: c["Korean"] += 1
        elif 0x4e00 <= o <= 0x9fff: c["CJK"] += 1
        elif 0x0400 <= o <= 0x04ff: c["Russian"] += 1
        elif 0x0600 <= o <= 0x06ff: c["Arabic"] += 1
        elif 0x0e00 <= o <= 0x0e7f: c["Thai"] += 1
    if not c:
        return ""
    if c["Japanese"]:
        return "Japanese"
    top, n = c.most_common(1)[0]
    if n < 2:
        return ""
    return "Chinese" if top == "CJK" else top


def _script_counts(text):
    c = Counter()
    for ch in text:
        if not ch.isalpha():
            continue
        o = ord(ch)
        if 0x3040 <= o <= 0x30ff: c["Japanese"] += 1
        elif 0xac00 <= o <= 0xd7af or 0x1100 <= o <= 0x11ff: c["Korean"] += 1
        elif 0x4e00 <= o <= 0x9fff: c["CJK"] += 1
        elif 0x0400 <= o <= 0x04ff: c["Russian"] += 1
        elif 0x0600 <= o <= 0x06ff: c["Arabic"] += 1
        elif 0x0e00 <= o <= 0x0e7f: c["Thai"] += 1
        else: c["Latin"] += 1
    return c


def chunk_lang(chunk):
    """Language of a couple of lyric lines. A non-Latin script only counts if it is a big share of the letters."""
    c = _script_counts(chunk)
    tot = sum(c.values())
    if not tot:
        return None
    for name in ("Japanese", "Korean", "Russian", "Arabic", "Thai"):
        if c[name] / tot >= 0.4:
            return name
    if (c["CJK"] + c["Japanese"]) / tot >= 0.4:
        return "Chinese"
    if c["Latin"] / tot < 0.5:
        return None
    words = re.findall(r"[^\W\d_]+", chunk.lower())
    hits = [w for w in words if w in ROMAJI]
    if len(set(hits)) >= 2 and len(hits) / max(len(words), 1) >= 0.1:
        return "Japanese"                                   # romanized Japanese
    if detect_langs is None:
        return None
    try:
        top = detect_langs(chunk)[0]
    except Exception:
        log.warning("chunk_lang: Exception ignored", exc_info=True)
        return None
    if top.prob < 0.6:
        return None
    return LANGNAME.get(top.lang, top.lang.upper())


def analyze_lyrics(text):
    """Returns (main language, {language: share}). Votes line by line so mixed songs (e.g. Taglish) show both."""
    text = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", text)
    votes, buf = Counter(), []

    def flush():
        chunk = " ".join(buf)
        buf.clear()
        w = sum(ch.isalpha() for ch in chunk)
        if w >= 10:
            l = chunk_lang(chunk)
            if l:
                votes[l] += w

    for line in text.splitlines():
        words = [w for w in re.findall(r"[^\W\d_]+(?:['’][^\W\d_]+)?", line) if w.lower() not in FILLER]
        if not words:
            continue
        line = " ".join(words)
        c = _script_counts(line)
        tot = sum(c.values())
        if tot and c["Latin"] / tot < 0.6:                   # Japanese / Korean / Russian ... line: decide on its own
            flush()
            l = chunk_lang(line)
            if l:
                votes[l] += tot * (3 if l in ("Japanese", "Korean", "Chinese") else 1)
        else:
            buf.append(line)
            if len(buf) == 2:
                flush()
    if buf:
        flush()
    if not votes:
        l = chunk_lang(text)
        if l:
            votes[l] = 1
    if not votes:
        return "", {}
    tot = sum(votes.values())
    mix = {l: round(v / tot, 2) for l, v in votes.most_common() if v / tot >= 0.1}
    return votes.most_common(1)[0][0], mix


# ---- lyrics lookup (LRCLIB: free, no account)
def clean_title(t):
    t = re.sub(r"\s*[\(\[].*?[\)\]]", "", t)
    t = re.sub(r"\s+-\s+.*(remaster|version|edit|mix|live).*$", "", t, flags=re.I)
    return t.strip()


def http_json(url, timeout=12):
    req = urllib.request.Request(url, headers=LRCLIB_UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def lrclib(artist, title, album="", dur=None):
    q = {"artist_name": artist, "track_name": title}
    if album:
        q["album_name"] = album
    if dur:
        q["duration"] = int(dur)
    d = None
    try:
        d = http_json("https://lrclib.net/api/get?" + urllib.parse.urlencode(q))
    except urllib.error.HTTPError as e:
        if e.code != 404:
            return "", "HTTP %s" % e.code
    except Exception as e:
        return "", str(e)[:80]
    if not d:
        try:
            res = http_json("https://lrclib.net/api/search?" + urllib.parse.urlencode(
                {"artist_name": artist, "track_name": title}))
            d = res[0] if isinstance(res, list) and res else None
        except Exception:
            d = None
    if not d:
        return "", ""
    text = d.get("plainLyrics") or re.sub(r"\[[^\]]*\]", " ", d.get("syncedLyrics") or "")
    return text or "", ""


def lrclib_q(q):
    try:
        res = http_json("https://lrclib.net/api/search?" + urllib.parse.urlencode({"q": q}))
    except urllib.error.HTTPError as e:
        return "", "HTTP %s" % e.code
    except Exception as e:
        return "", str(e)[:80]
    for d in (res if isinstance(res, list) else []):
        t = d.get("plainLyrics") or re.sub(r"\[[^\]]*\]", " ", d.get("syncedLyrics") or "")
        if t:
            return t, ""
    return "", ""


def title_variants(title):
    junk = r"\b(nightcore|sped up|slowed|reverb|8d audio|lyrics|official|audio|video|visualizer)\b"
    out = []
    for t in (title.split("|")[0], title):
        c = re.sub(junk, "", clean_title(t), flags=re.I)
        c = re.sub(r"\s{2,}", " ", c).strip(" -|")
        if c and c not in out:
            out.append(c)
    return out[:2]


def lookup_lyrics(r, pats):
    names = [n for n in (split_artists(r["artist_raw"], pats) or []) if n and n != "Unknown"][:2] or [r["artist_raw"]]
    titles = title_variants(r["title"]) or [r["title"]]
    first = True
    for t in titles:
        for a in names:
            text, err = lrclib(a, t, r.get("album", "") if first else "", r.get("dur") if first else None)
            first = False
            if err or text:
                return text, err
    return lrclib_q("%s %s" % (titles[0], names[0]))


def embedded_lyrics(path):
    """Lyrics saved inside the file's tags, or in a .lrc / .txt file with the same name."""
    text = ""
    try:
        f = MutagenFile(path)
        if f is not None and f.tags is not None:
            for k in f.tags.keys():
                kl = str(k).lower()
                if kl.startswith("uslt") or kl in ("lyrics", "unsyncedlyrics"):
                    v = f.tags[k]
                    text += " ".join(str(x) for x in (v if isinstance(v, list) else [v])) + " "
    except Exception:
        log.warning("embedded_lyrics: Exception ignored", exc_info=True)
    if not text:
        base = os.path.splitext(path)[0]
        for ext in (".lrc", ".txt"):
            if os.path.exists(base + ext):
                try:
                    text = open(base + ext, encoding="utf-8", errors="ignore").read()
                except Exception:
                    log.warning("embedded_lyrics: Exception ignored", exc_info=True)
                break
    return re.sub(r"\[[^\]]*\]", " ", text)


# ----------------------------------------------------------------------------- music index (artist + language per song)
MUSIC = {"items": [], "by_id": {}, "artists": [], "languages": [], "genres": [], "albums": [], "from_lyrics": 0, "unknown": 0}
MUSIC_LOCK = threading.RLock()
LANG_JOB = {"running": False, "done": 0, "total": 0, "message": "", "cancel": False}


def lang_rows():
    with closing(db()) as con:
        return {r["rel_path"]: dict(r) for r in con.execute("SELECT * FROM lang_info")}


def tag_language(t):
    """Language from the tags / folder names / title script (the older, cruder guess)."""
    code = t.get("lang") or ""
    if code:
        return CODE_NAMES.get(code, code), "tags/folder"
    s = script_lang(" ".join((t.get("title") or "", t.get("artist") or "", t.get("album") or "")))
    return (s, "title/artist text") if s else ("", "")


def resolve_languages(tracks, rows, prim):
    """manual > lyrics > tags/folder/script > artist guess (artist has >=2 known songs and >=75% agree) > Unknown.
    Returns id -> (language, source, [other languages that make up >=25% of the lyrics])."""
    base, known = {}, defaultdict(Counter)
    for t in tracks:
        tid, row = t["id"], rows.get(t["rel"]) or {}
        mix = {}
        if row.get("lang_manual"):
            l, src = row["lang_manual"], "manual"
        elif (row.get("lyr_v") or 0) >= LYR_V or row.get("lang_src") == "title/artist text":
            l, src = row.get("lyr_lang") or "", row.get("lang_src") or "lyrics"
            try:
                mix = json.loads(row.get("lang_mix") or "{}")
            except ValueError:
                mix = {}
        else:
            l, src = "", ""
        if not l:
            l, src = tag_language(t)
        base[tid] = (l, src, mix)
        a = prim.get(tid, "Unknown")
        if l and src in ("manual", "lyrics") and a != "Unknown":
            known[a][l] += 1
    out = {}
    for t in tracks:
        tid = t["id"]
        l, src, mix = base[tid]
        if not l:
            c = known.get(prim.get(tid, "Unknown"))
            if c:
                tot = sum(c.values())
                top, n = c.most_common(1)[0]
                if tot >= 2 and n / tot >= 0.75:
                    out[tid] = (top, "artist guess", [])
                    continue
            out[tid] = ("Unknown", "", [])
        else:
            out[tid] = (l, src, [k for k, v in mix.items() if k != l and v >= 0.25])
    return out


def album_overrides():
    """{rel_path: {album, album_artist, track_no}} for every song put into an album by hand."""
    try:
        with closing(db()) as con:
            return {r["rel_path"]: {"album": r["album"], "album_artist": r["album_artist"], "track_no": r["track_no"]}
                    for r in con.execute("SELECT rel_path, album, album_artist, track_no FROM album_overrides")}
    except sqlite3.Error:
        log.warning("album_overrides: sqlite3.Error ignored", exc_info=True)
        return {}


def album_order(i):
    """Songs of an album in play order: hand-made albums by their track number, tagged albums by file name."""
    return (i["ovr_no"] or 10 ** 6, natkey(i["t"]["rel"]))


def rebuild_music():
    """Recomputes the primary artist + language of every song. Cheap; called after scans and language changes."""
    with LIB_LOCK:
        tracks = list(LIB["tracks"].values())
    pats = protected_patterns(load_protected())
    cred = {t["id"]: t.get("artist") or "" for t in tracks}
    prim = group_artists(cred, pats)
    langs = resolve_languages(tracks, lang_rows(), prim)
    ovr = album_overrides()
    ag_track = autogenre.load_map(db, "track")
    items, by_id = [], {}
    for t in tracks:
        tid = t["id"]
        lang, src, also = langs[tid]
        ag = ag_track.get(t["rel"])
        if ag:                                                           # Smart genres: copy, never edit the scanned record
            t = dict(t, ag=ag, genre_text=(t.get("genre_text") or "") + " " + " ".join(ag).lower().replace("lo-fi", "lofi"))
        o = ovr.get(t["rel"])
        alb = o["album"] if o else (t.get("album") or "").strip()          # a hand-made album wins over the file's own tag
        alb_artist = (o["album_artist"] or prim[tid]) if o else prim[tid]
        it = {"id": tid, "t": t, "primary": prim[tid], "credited": cred[tid], "language": lang, "lang_src": src,
              "album": alb, "album_artist": alb_artist, "custom": bool(o), "ovr_no": o["track_no"] if o else 0,
              "albumkey": (norm_key(alb) + "|" + norm_key(alb_artist)) if norm_key(alb) else "",
              "also": also, "langset": {lang, *also},
              "artnorm": norm_key(prim[tid] + " " + cred[tid]),
              "blob": ("%s %s %s %s" % (prim[tid], cred[tid], t["title"], alb)).lower()}
        items.append(it)
        by_id[tid] = it
    art = Counter(i["primary"] for i in items)
    lang = Counter()
    for i in items:
        for l in i["langset"]:
            lang[l] += 1
    sample = {}
    for i in items:
        sample.setdefault(i["primary"], i["id"])          # a song whose cover stands in for the artist's picture
    genres = []
    for k in GENRE_TOKENS:
        n = sum(1 for i in items if genre_ok(i["t"], k))
        if n:
            genres.append({"key": k, "name": GENRE_NAMES.get(k, k), "count": n})
    extra = Counter(g for i in items for g in (i["t"].get("ag") or []) if g not in autogenre.LEGACY_MUSIC)
    for g, n in sorted(extra.items(), key=lambda kv: (-kv[1], kv[0])):
        genres.append({"key": "g:" + g, "name": g, "count": n})
    groups = defaultdict(list)
    for i in items:
        if i["albumkey"]:
            groups[i["albumkey"]].append(i)
    albums = []
    for k, g in groups.items():
        g.sort(key=album_order)
        albums.append({"key": k, "name": g[0]["album"], "artist": g[0]["album_artist"], "count": len(g),
                       "sample": g[0]["id"], "duration": sum(i["t"]["duration"] or 0 for i in g),
                       "custom": any(i["custom"] for i in g)})
    albums.sort(key=lambda a: (a["count"] < 2, a["artist"].lower(), a["name"].lower()))   # real albums first, singles last
    with MUSIC_LOCK:
        MUSIC["items"], MUSIC["by_id"] = items, by_id
        MUSIC["albums"] = albums
        MUSIC["genres"] = genres
        MUSIC["artists"] = [{"name": a, "count": n, "sample": sample[a]}
                            for a, n in sorted(art.items(), key=lambda kv: (-kv[1], kv[0].lower()))]
        MUSIC["languages"] = ([{"name": l, "count": n} for l, n in sorted(lang.items(), key=lambda kv: (-kv[1], kv[0]))
                               if l != "Unknown"] + ([{"name": "Unknown", "count": lang["Unknown"]}] if lang["Unknown"] else []))
        MUSIC["from_lyrics"] = sum(1 for i in items if i["lang_src"] in ("lyrics", "manual"))
        MUSIC["unknown"] = lang["Unknown"]


def lang_needs_lookup(t, rows):
    row = rows.get(t["rel"]) or {}
    return not row.get("lang_manual") and (row.get("lyr_v") or 0) < LYR_V


def detect_one(t, online, pats, state):
    """Language of one song -> row for lang_info, or None when nothing could be decided (or the lookup failed)."""
    if state["cancel"] or state["dead"]:
        return None
    credited = t.get("artist") or "Unknown"
    r = {"artist_raw": credited, "title": t["title"], "album": t.get("album") or "", "dur": t.get("duration") or None}
    meta = script_lang(r["title"] + credited + r["album"])
    text = embedded_lyrics(str(t["path"]))
    if not text:
        if not online:
            if meta:                                       # not final (lyr_v stays 0): redone when online lookup is on
                return (t["rel"], meta, "{}", "title/artist text", 0)
            return None
        time.sleep(0.1)
        text, err = lookup_lyrics(r, pats)
        if err:
            with state["lock"]:
                state["fail"] += 1
                if state["fail"] >= 8:
                    state["dead"] = "Could not reach lrclib.net (%s). Check your internet connection and try again." % err
            return None
        state["fail"] = 0
    lang, mix = analyze_lyrics(text) if text else ("", {})
    if lang:
        return (t["rel"], lang, json.dumps(mix), "lyrics", LYR_V)
    return (t["rel"], meta, "{}", "title/artist text" if meta else "", LYR_V)


LANG_UPSERT = """INSERT INTO lang_info (rel_path, lyr_lang, lang_mix, lang_src, lyr_v) VALUES (?,?,?,?,?)
                 ON CONFLICT(rel_path) DO UPDATE SET lyr_lang = excluded.lyr_lang, lang_mix = excluded.lang_mix,
                 lang_src = excluded.lang_src, lyr_v = excluded.lyr_v"""


def run_language_detection(online):
    state = {"cancel": False, "dead": "", "fail": 0, "lock": threading.Lock()}
    LANG_JOB.update(running=True, done=0, total=0, message="Starting...", cancel=False)
    try:
        with LIB_LOCK:
            tracks = list(LIB["tracks"].values())
        pats = protected_patterns(load_protected())
        rows = lang_rows()
        todo = [t for t in tracks if lang_needs_lookup(t, rows)]
        LANG_JOB["total"] = len(todo)
        batch = []

        def flush():
            if batch:
                with closing(db()) as con, con:
                    con.executemany(LANG_UPSERT, batch)
                batch.clear()

        with ThreadPoolExecutor(max_workers=2) as ex:
            for n, res in enumerate(ex.map(lambda t: detect_one(t, online, pats, state), todo), 1):
                if res:
                    batch.append(res)
                LANG_JOB["done"] = n
                LANG_JOB["message"] = "Detecting languages %d / %d ..." % (n, len(todo))
                state["cancel"] = LANG_JOB["cancel"]
                if len(batch) >= 25:
                    flush()
                if n % 100 == 0:
                    rebuild_music()
                if state["dead"]:
                    state["cancel"] = True
        flush()
        rebuild_music()
        if state["dead"]:
            LANG_JOB["message"] = state["dead"]
        elif LANG_JOB["cancel"]:
            LANG_JOB["message"] = "Stopped. Songs already done are kept."
        else:
            LANG_JOB["message"] = "Done." if todo else "Every song is already checked."
    except Exception as e:
        LANG_JOB["message"] = "Language detection failed: %s" % e
    finally:
        LANG_JOB["running"] = False


# ----------------------------------------------------------------------------- video posters
def sidecar_names(video):
    """File names a poster you supplied may have, best first: <video name>.jpg/.png/.webp or <video name>-poster.jpg ..."""
    return [video.stem + suffix + ext for suffix in ("", "-poster", ".poster", "_poster") for ext in IMAGE_EXTS]


def pick_image(names_in_dir, wanted):
    """The first of `wanted` file names present in a folder listing ({lowercase name: Path} from walk_entries), else None.
    Case-insensitive, like Windows."""
    if not names_in_dir:
        return None
    for n in wanted:
        p = names_in_dir.get(n.lower())
        if p is not None:
            return p
    return None


def find_sidecar_poster(v):
    """Your own poster for a library video (dict from LIB["videos"]). It was found by the scan, so this costs no disk work
    for the many videos without one; for those with one, a single check that the file is still there."""
    p = v.get("side_poster")
    if p is not None:
        try:
            if p.is_file():
                return p
        except OSError:
            pass
    return None


def frame_via_opencv(path):
    cap = cv2.VideoCapture(str(path))
    try:
        if not cap.isOpened():
            return None
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if total <= 0:
            return None
        best = None
        for frac in (0.5, 0.35, 0.65):                 # middle first; try nearby if the frame is black
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * frac))
            ok, frame = cap.read()
            if ok and frame is not None:
                best = frame
                if frame.mean() > 12:
                    break
        return best
    finally:
        cap.release()


def frame_via_ffmpeg(path, tmp):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    seconds = 60.0
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        try:
            out = ff_run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of",
                                  "default=nw=1:nk=1", str(path)], capture_output=True, text=True, timeout=30,
                                 creationflags=NO_WINDOW).stdout.strip()
            seconds = float(out) / 2
        except Exception:
            log.warning("frame_via_ffmpeg: Exception ignored", exc_info=True)
    try:
        ff_run([ffmpeg, "-v", "error", "-y", "-ss", f"{seconds:.2f}", "-i", str(path),
                        "-frames:v", "1", "-q:v", "2", str(tmp)], capture_output=True, timeout=90,
                       creationflags=NO_WINDOW)
    except Exception:
        log.warning("frame_via_ffmpeg: Exception ignored", exc_info=True)
        return None
    return tmp if tmp.exists() and tmp.stat().st_size > 0 else None


def compose_poster(frame):
    """Landscape frame -> 2:3 poster: sharp frame centred over a blurred, darkened copy of itself."""
    W, H = POSTER_SIZE
    h, w = frame.shape[:2]
    cover = max(W / w, H / h)
    bg = cv2.resize(frame, (int(w * cover) + 1, int(h * cover) + 1))
    y0, x0 = (bg.shape[0] - H) // 2, (bg.shape[1] - W) // 2
    bg = cv2.GaussianBlur(bg[y0:y0 + H, x0:x0 + W], (0, 0), 18)
    bg = (bg * 0.55).astype(np.uint8)
    fit = min(W / w, H / h)
    fw, fh = max(1, int(w * fit)), max(1, int(h * fit))
    fg = cv2.resize(frame, (fw, fh), interpolation=cv2.INTER_AREA)
    y, x = (H - fh) // 2, (W - fw) // 2
    bg[y:y + fh, x:x + fw] = fg
    return bg


def make_poster(video, out):
    tmp_jpg = POSTER_DIR / f"_tmp_{threading.get_ident()}.jpg"
    tmp_out = POSTER_DIR / f"_out_{threading.get_ident()}.jpg"
    try:
        frame = frame_via_opencv(video) if cv2 is not None else None
        if frame is None:                                      # e.g. odd codecs or non-ASCII paths on Windows
            grabbed = frame_via_ffmpeg(video, tmp_jpg)
            if grabbed is None:
                return False
            if cv2 is None:
                os.replace(grabbed, out)
                return True
            frame = cv2.imread(str(grabbed))
        if frame is None:
            return False
        if cv2 is None:
            return False
        ok = cv2.imwrite(str(tmp_out), compose_poster(frame), [cv2.IMWRITE_JPEG_QUALITY, 88])
        if ok:
            os.replace(tmp_out, out)
        return ok
    finally:
        for t in (tmp_jpg, tmp_out):
            try:
                t.unlink()
            except OSError:
                log.warning("make_poster: OSError ignored", exc_info=True)


def ensure_poster(vid, video):
    out = POSTER_DIR / f"{vid}.jpg"
    if out.exists():
        return True
    if unsettled(video):                                    # still downloading: try again later, do not remember a failure
        return False
    if vid in POSTER_FAILED:
        return False
    with POSTER_LOCK:
        if out.exists():
            return True
        try:
            ok = make_poster(video, out)
        except Exception:
            ok = False
        if not ok:
            POSTER_FAILED.add(vid)
        return ok


def make_backdrop(video, out):
    """A wide still from the video (no cropping) for the hero banner."""
    BACKDROP_DIR.mkdir(parents=True, exist_ok=True)
    tmp_jpg = BACKDROP_DIR / f"_tmp_{threading.get_ident()}.jpg"
    try:
        frame = frame_via_opencv(video) if cv2 is not None else None
        if frame is None:
            grabbed = frame_via_ffmpeg(video, tmp_jpg)
            if grabbed is None:
                return False
            if cv2 is None:
                os.replace(grabbed, out)
                return True
            frame = cv2.imread(str(grabbed))
        if frame is None or cv2 is None:
            return False
        h, w = frame.shape[:2]
        if w > 1600:
            frame = cv2.resize(frame, (1600, max(1, int(h * 1600 / w))), interpolation=cv2.INTER_AREA)
        return bool(cv2.imwrite(str(out), frame, [cv2.IMWRITE_JPEG_QUALITY, 85]))
    finally:
        try:
            tmp_jpg.unlink()
        except OSError:
            log.warning("make_backdrop: OSError ignored", exc_info=True)


def ensure_backdrop(vid, video):
    out = BACKDROP_DIR / f"{vid}.jpg"
    if out.exists():
        return True
    if unsettled(video):                                    # still downloading: try again later, do not remember a failure
        return False
    if vid in BACKDROP_FAILED:
        return False
    with POSTER_LOCK:
        if out.exists():
            return True
        try:
            ok = make_backdrop(video, out)
        except Exception:
            ok = False
        if not ok:
            BACKDROP_FAILED.add(vid)
        return ok


TILE_SIZE = 480              # square tile thumbnails (px)


def trim_black_bars(frame):
    """Cuts the letterbox / pillarbox bars off a frame (rows and columns that are almost pure black).
    Falls back to the untouched frame when nothing sensible is left."""
    try:
        gray = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape[:2]
        rows = np.where(gray.max(axis=1) > 40)[0]          # a bar row never holds a bright pixel
        cols = np.where(gray.max(axis=0) > 40)[0]
        if rows.size < 8 or cols.size < 8:
            return frame
        y0, y1, x0, x1 = int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1
        if (y1 - y0) < h * 0.4 or (x1 - x0) < w * 0.4:     # too little left: the frame is just dark, not barred
            return frame
        return frame[y0:y1, x0:x1]
    except Exception:
        log.warning("trim_black_bars: Exception ignored", exc_info=True)
        return frame


def compose_tile(frame):
    """Frame -> clean square: black bars trimmed, centre-cropped, sharp (no blur, no background fill)."""
    frame = trim_black_bars(frame)
    h, w = frame.shape[:2]
    side = min(h, w)
    y0, x0 = (h - side) // 2, (w - side) // 2
    sq = frame[y0:y0 + side, x0:x0 + side]
    interp = cv2.INTER_AREA if side > TILE_SIZE else cv2.INTER_CUBIC
    return cv2.resize(sq, (TILE_SIZE, TILE_SIZE), interpolation=interp)


def make_tile(video, out):
    TILE_DIR.mkdir(parents=True, exist_ok=True)
    tmp_jpg = TILE_DIR / f"_tmp_{threading.get_ident()}.jpg"
    tmp_out = TILE_DIR / f"_out_{threading.get_ident()}.jpg"
    try:
        if cv2 is None:
            return False
        frame = frame_via_opencv(video)
        if frame is None:                                      # odd codecs / non-ASCII paths on Windows
            grabbed = frame_via_ffmpeg(video, tmp_jpg)
            frame = cv2.imread(str(grabbed)) if grabbed else None
        if frame is None:
            return False
        ok = cv2.imwrite(str(tmp_out), compose_tile(frame), [cv2.IMWRITE_JPEG_QUALITY, 90])
        if ok:
            os.replace(tmp_out, out)
        return bool(ok)
    finally:
        for t in (tmp_jpg, tmp_out):
            try:
                t.unlink()
            except OSError:
                pass


def ensure_tile(vid, video):
    out = TILE_DIR / f"{vid}.jpg"
    if out.exists():
        return True
    if unsettled(video):                                    # still downloading: try again later, do not remember a failure
        return False
    if vid in TILE_FAILED:
        return False
    with POSTER_LOCK:
        if out.exists():
            return True
        try:
            ok = make_tile(video, out)
        except Exception:
            log.warning("ensure_tile: Exception ignored", exc_info=True)
            ok = False
        if not ok:
            TILE_FAILED.add(vid)
        return ok


def pregenerate_posters():
    with LIB_LOCK:
        todo = [(v["id"], v["path"], v.get("side_poster") is not None) for v in LIB["videos"].values()]
    background_io(True)                                       # low disk priority: torrents and playback come first
    try:
        for vid, path, has_side in todo:
            if has_side:
                continue                                      # your own poster is used instead (the scan found it)
            if (POSTER_DIR / f"{vid}.jpg").exists() and (TILE_DIR / f"{vid}.jpg").exists():
                continue                                      # already made: no disk work at all
            ensure_poster(vid, path)
            ensure_tile(vid, path)
            time.sleep(0.25)                                  # a breather between files
    finally:
        background_io(False)


# ----------------------------------------------------------------------------- subtitles
def find_subtitles(video):
    """Subtitle files next to the video: 'name.srt', 'name.vtt', 'name.en.srt', 'name.es.forced.vtt' ..."""
    out = []
    try:
        names = sorted(os.listdir(video.parent))
    except OSError:
        log.warning("find_subtitles: OSError ignored", exc_info=True)
        return out
    stem = video.stem.lower()
    for name in names:
        low = name.lower()
        ext = Path(low).suffix
        if ext not in SUB_EXTS:
            continue
        base = low[:-len(ext)]
        if base != stem and not base.startswith(stem + "."):
            continue
        p = video.parent / name
        if not p.is_file():
            continue
        tag = base[len(stem) + 1:] if base != stem else ""
        parts = [t for t in re.split(r"[._\- ]+", tag) if t]
        first = parts[0] if parts else ""
        label = SUB_LANGS.get(first) or (" ".join(parts).title() if parts else "Subtitles")
        if first in SUB_LANGS and len(parts) > 1:
            label += f" ({' '.join(parts[1:])})"
        out.append((p, label, first if first in SUB_LANGS else "und"))
    return out


def read_text(path):
    raw = path.read_bytes()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", errors="replace")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def srt_to_vtt(text):
    """Browsers only understand WebVTT in <track>, so .srt is converted on the fly."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(\d{1,2}:\d{2}:\d{2}),(\d{1,3})", r"\1.\2", text)
    return "WEBVTT\n\n" + text.strip() + "\n"


# ----------------------------------------------------------------------------- video stats
def display_title(custom, auto):
    return custom or auto


def collection_overrides():
    """{video id: collection name}; '' = kept out of the automatic collections."""
    try:
        with closing(db()) as con:
            return {r["video_id"]: r["name"] for r in con.execute("SELECT video_id, name FROM collection_overrides")}
    except sqlite3.Error:
        log.warning("collection_overrides: sqlite3.Error ignored", exc_info=True)
        return {}


def clean_coll_name(v):
    return re.sub(r"\s+", " ", str(v or "")).strip()[:80]


def video_cards(private=False):
    STARTUP_SCAN.wait(180)                                # first start-up scan runs in the background; lists wait for it, never show half a library
    now = time.time()
    clean_on = (not private) and get_prefs().get("clean_titles", True)
    ag_video = {} if private else autogenre.load_map(db, "video")        # Smart genres (never for the private library)
    ag_series = {} if private else autogenre.load_map(db, "series")
    with closing(db()) as con:
        rows = con.execute("""
            SELECT v.id, v.view_count, v.last_viewed, v.added_at, v.mtime,
                   v.custom_title, v.position, v.duration, v.progress_at,
                   (SELECT AVG(stars) FROM ratings r WHERE r.video_id = v.id) AS avg_rating,
                   (SELECT COUNT(*)   FROM ratings r WHERE r.video_id = v.id) AS rating_count,
                   (SELECT stars      FROM ratings r WHERE r.video_id = v.id AND r.profile = ?) AS mine
            FROM videos v WHERE v.missing = 0""", (PROFILE,)).fetchall()
    with LIB_LOCK:
        known = LIB["videos"]
        series_map = LIB["series"]
        rows = [r for r in rows if r["id"] in known and known[r["id"]]["private"] == private]
    by_id = {r["id"]: r for r in rows}

    def isnew(r):
        return (now - (r["added_at"] or 0)) < NEW_DAYS * 86400

    def frac(r):
        d = r["duration"] or 0
        return (r["position"] or 0) / d if d > 0 else 0

    coll_of, collections = {}, []
    ovr = {} if private else collection_overrides()
    if not private and get_prefs().get("auto_sort", True):
        # movies you placed by hand are not offered to the auto-sorter, so they can neither pull others in nor be pulled out
        cand = [r for r in rows if known[r["id"]].get("root") and not known[r["id"]]["series_id"] and r["id"] not in ovr]
        cand.sort(key=lambda r: natkey(display_title(r["custom_title"], known[r["id"]]["title"])))
        groups = group_franchises([display_title(r["custom_title"], known[r["id"]]["title"]) for r in cand])
        for gname, idxs in groups.items():
            for i in idxs:
                coll_of[cand[i]["id"]] = gname
            collections.append((gname, [cand[i]["id"] for i in idxs]))
    if ovr:
        # a hand-made name that matches an automatic one (any capitals) joins it instead of making a twin
        canon = {norm_key(n): n for n, _ in collections}
        extra = {}
        for r in rows:
            nm = ovr.get(r["id"])
            if not nm or known[r["id"]]["series_id"]:
                continue
            nm = canon.get(norm_key(nm)) or extra.setdefault(norm_key(nm) + "|", nm)
            coll_of[r["id"]] = nm
        merged = {}
        for vid, nm in coll_of.items():
            merged.setdefault(nm, []).append(vid)
        collections = list(merged.items())
    collections.sort(key=lambda c: natkey(c[0]))

    def card(r):
        f = frac(r)
        k = known[r["id"]]
        return {"kind": "video", "id": r["id"], "title": display_title(r["custom_title"], k["title"]),
                "year": k.get("year"), "collection": coll_of.get(r["id"], ""),
                "series": (clean_junk(k["series"]) if clean_on else pretty(k["series"])) if k["series"] else "", "genre": k["genre"],
                "agenres": ag_video.get(r["id"], []),
                "is_new": isnew(r), "custom_title": bool(r["custom_title"]), "view_count": r["view_count"],
                "avg_rating": round(r["avg_rating"], 1) if r["avg_rating"] is not None else None,
                "rating_count": r["rating_count"], "user_rating": r["mine"] or 0,
                "progress": round(f, 3) if CONTINUE_MIN < f < CONTINUE_MAX else 0,
                "poster": f"/poster/{r['id']}?v={int(r['mtime'] or 0)}",
                "backdrop": f"/backdrop/{r['id']}?v={int(r['mtime'] or 0)}", "added": int(r["mtime"] or 0)}

    def series_card(s):
        eps = [by_id[e] for e in s["episodes"] if e in by_id]
        if not eps:
            return None
        watched = sum(1 for r in eps if r["view_count"] > 0)
        cont = [r for r in eps if CONTINUE_MIN < frac(r) < CONTINUE_MAX]
        if cont:
            resume = max(cont, key=lambda r: r["progress_at"] or 0)
        else:
            resume = next((r for r in eps if r["view_count"] == 0), eps[0])
        return {"kind": "series", "id": s["id"], "title": s["name"], "genre": s["genre"], "agenres": ag_series.get(s["id"], []), "episodes": len(eps),
                "is_new": any(isnew(r) for r in eps), "watched": watched, "progress": round(watched / len(eps), 3), "resume": resume["id"],
                "folder": s["folder"].name, "auto": bool(s.get("virtual")),
                "poster": f"/seriesart/{s['id']}?v={int(max(r['mtime'] or 0 for r in eps))}",
                "added": int(max(r["mtime"] or 0 for r in eps))}

    cont = sorted((r for r in rows if CONTINUE_MIN < frac(r) < CONTINUE_MAX), key=lambda r: -(r["progress_at"] or 0))
    most = sorted((r for r in rows if r["view_count"] > 0),
                  key=lambda r: (-r["view_count"], -(r["last_viewed"] or 0)))
    unwatched = sorted((r for r in rows if r["view_count"] == 0), key=lambda r: -(r["mtime"] or 0))

    # "Haven't watched yet": loose videos one by one, but a series only once (as a single card)
    def collapse(rs):
        out, seen_series = [], set()
        for r in rs:
            sid = known[r["id"]]["series_id"]
            if not sid:
                out.append(card(r))
            elif sid not in seen_series:
                seen_series.add(sid)
                c = series_card(series_map[sid])
                if c:
                    out.append(c)
        return out

    fresh = collapse(unwatched)
    recent = collapse(sorted((r for r in rows if now - (r["added_at"] or 0) < RECENT_DAYS * 86400),
                             key=lambda r: -(r["added_at"] or 0)))

    featured = None
    if rows:
        pick = random.choice(unwatched[:12] or most[:12] or rows)       # hero banner: a random fresh pick
        featured = card(pick)

    root = CFG["private_dir"] if private else CFG["video_dir"]
    try:
        names = sorted((d.name for d in root.iterdir() if d.is_dir() and not d.name.startswith(".")
                        and not (private and d.name.lower() == PHOTO_FOLDER.lower())), key=natkey)
    except OSError:
        names = []
    genres = []
    for g in names:
        items = []
        for sr in series_map.values():
            if sr["private"] == private and sr["genre"] == g:
                c = series_card(sr)
                if c:
                    items.append(c)
        for r in rows:
            k = known[r["id"]]
            if k["genre"] == g and not k["series_id"]:
                items.append(card(r))
        items.sort(key=lambda c: natkey(c["title"]))
        genres.append({"name": g, "count": len(items), "items": items[:200]})

    loose = sorted((card(r) for r in rows if not known[r["id"]]["series_id"]), key=lambda c: natkey(c["title"]))
    all_series = sorted((c for c in (series_card(sr) for sr in series_map.values() if sr["private"] == private) if c),
                        key=lambda c: natkey(c["title"]))
    colls = []
    for gname, ids in collections:
        items = [card(by_id[i]) for i in ids if i in by_id]
        items.sort(key=lambda c: (c["year"] or 9999, natkey(c["title"])))
        colls.append({"name": gname, "count": len(items), "items": items})
    return {"featured": featured, "pool": [r["id"] for r in rows], "loose": loose[:2000], "all_series": all_series,
            "collections": colls, "overrides": len(ovr),
            "recent": recent[:ROW_LIMIT],
            "continue": [card(r) for r in cont[:ROW_LIMIT]],
            "most_watched": [card(r) for r in most[:ROW_LIMIT]],
            "unwatched": fresh[:ROW_LIMIT], "genres": genres,
            "total": len(rows)}


def video_stats(vid):
    with closing(db()) as con:
        r = con.execute("""
            SELECT v.view_count,
                   (SELECT AVG(stars) FROM ratings WHERE video_id = v.id) AS avg_rating,
                   (SELECT COUNT(*)   FROM ratings WHERE video_id = v.id) AS rating_count,
                   (SELECT stars      FROM ratings WHERE video_id = v.id AND profile = ?) AS mine
            FROM videos v WHERE v.id = ?""", (PROFILE, vid)).fetchone()
    return {"view_count": r["view_count"], "avg_rating": round(r["avg_rating"], 1) if r["avg_rating"] is not None else None,
            "rating_count": r["rating_count"], "user_rating": r["mine"] or 0}


# ----------------------------------------------------------------------------- playlist generator
def genre_ok(t, genre):
    if genre.startswith("g:"):                                           # a genre found by Smart genres
        return genre[2:] in (t.get("ag") or [])
    if genre == "mix":
        return True
    wanted = GENRE_TOKENS.get(genre)
    return bool(wanted and set(re.findall(r"[a-z0-9]+", t["genre_text"].replace("-", ""))) & wanted)


def track_json(it):
    t = it["t"]
    return {"id": t["id"], "title": t["title"], "artist": it["credited"] or it["primary"], "primary": it["primary"],
            "album": it["album"], "custom_album": it["custom"], "duration": t["duration"], "url": f"/media/music/{t['id']}",
            "cover": f"/cover/{t['id']}", "language": it["language"], "also": ", ".join(it["also"]),
            "lang_src": it["lang_src"], "added": int(t.get("added_at") or t.get("mtime") or 0)}


def filter_music(d):
    """Songs matching the language / artist / genre / search filters in request body `d`."""
    language = str(d.get("language") or "any").strip()
    language = CODE_NAMES.get(language.lower(), language)          # old codes: en / es / kr / jp
    genre = str(d.get("genre") or "mix")
    artist = str(d.get("artist") or "")
    album = str(d.get("album") or "")
    sub = norm_key(str(d.get("artist_text") or ""))
    q = str(d.get("q") or "").lower().strip()
    out = []
    with MUSIC_LOCK:
        items = MUSIC["items"]
    for it in items:
        if language.lower() != "any" and language not in it["langset"]:
            continue
        if artist and it["primary"] != artist:
            continue
        if album and it["albumkey"] != album:
            continue
        if sub and sub not in it["artnorm"]:
            continue
        if q and q not in it["blob"]:
            continue
        if not genre_ok(it["t"], genre):
            continue
        out.append(it)
    return out


COVER_CACHE = {}


def extract_cover(path):
    """Embedded album art as (bytes, mime), or None."""
    try:
        f = MutagenFile(path)
    except Exception:
        log.warning("extract_cover: Exception ignored", exc_info=True)
        return None
    if f is None:
        return None
    try:
        pics = getattr(f, "pictures", None)                        # FLAC
        if pics:
            return pics[0].data, pics[0].mime or "image/jpeg"
        tags = f.tags
        if tags is None:
            return None
        for k in list(tags.keys()):                               # MP3 (ID3 APIC)
            if str(k).startswith("APIC"):
                return tags[k].data, tags[k].mime or "image/jpeg"
        if "covr" in tags and tags["covr"]:                       # M4A
            c = tags["covr"][0]
            return bytes(c), "image/png" if getattr(c, "imageformat", 0) == 14 else "image/jpeg"
        mbp = tags.get("metadata_block_picture")                  # OGG / Opus
        if mbp:
            pic = Picture(base64.b64decode(mbp[0]))
            return pic.data, pic.mime or "image/jpeg"
    except Exception:
        log.warning("extract_cover: Exception ignored", exc_info=True)
        return None
    return None


# ----------------------------------------------------------------------------- private library lock
# A convenience lock: private videos stay out of every API response and stream until the password is entered.
# It is NOT encryption - the files are still ordinary files in media/private.
SESSIONS = {}                                  # token -> expiry
LOCKOUT = {"fails": 0, "until": 0.0}
SETTINGS_LOCK = threading.Lock()
PBKDF2_ROUNDS = 200_000
SESSION_COOKIE = "lmp_session"


def load_settings():
    try:
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        log.warning("load_settings: settings.json unreadable", exc_info=True)
        return {}


def hash_password(password, salt=None):
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return {"salt": salt.hex(), "hash": digest.hex(), "rounds": PBKDF2_ROUNDS}


def password_ok(password):
    saved = load_settings().get("password")
    if not saved:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(saved["salt"]), saved["rounds"])
    return hmac.compare_digest(digest.hex(), saved["hash"])


def save_password(password):
    with SETTINGS_LOCK:
        settings = load_settings()
        settings["password"] = hash_password(password)
        SETTINGS_PATH.write_text(json.dumps(settings), encoding="utf-8")


def start_session():
    SESSIONS.clear()                           # one unlocked session at a time
    HP_ACK.clear()
    token = secrets.token_urlsafe(24)
    SESSIONS[token] = time.time() + SESSION_HOURS * 3600
    return token


def token_from_request():
    """Header for API calls, HttpOnly cookie for media (<video>, <img>, subtitles). Never the URL."""
    return request.headers.get("X-Private-Token") or request.cookies.get(SESSION_COOKIE, "")


def session_response(token):
    resp = jsonify({"token": token})
    resp.set_cookie(SESSION_COOKIE, token, max_age=SESSION_HOURS * 3600, httponly=True, samesite="Strict", path="/")
    return grant_photos(resp)                  # one password: unlocking the private library opens Photos too


def valid_token(token):
    expiry = SESSIONS.get(token or "")
    if expiry and expiry > time.time():
        return True
    SESSIONS.pop(token or "", None)
    return False


def get_video_checked(vid):
    v = get_video(vid)
    if not v:
        abort(404)
    if v["private"] and not valid_token(token_from_request()):
        abort(403)
    return v


# ----------------------------------------------------------------------------- routes
def get_video(vid):
    with LIB_LOCK:
        return LIB["videos"].get(vid)


@app.get("/api/lock/status")
def lock_status():
    return jsonify({"has_password": bool(load_settings().get("password")),
                    "unlocked": valid_token(token_from_request())})


@app.post("/api/lock/setup")
def lock_setup():
    if load_settings().get("password"):
        abort(409)
    pw = str((request.get_json(silent=True) or {}).get("password", ""))
    if len(pw) < 4:
        return jsonify({"error": "Use at least 4 characters."}), 400
    save_password(pw)
    return session_response(start_session())


@app.post("/api/lock/unlock")
def lock_unlock():
    wait = LOCKOUT["until"] - time.time()
    if wait > 0:
        return jsonify({"error": "Too many attempts.", "retry_after": int(wait) + 1}), 429
    pw = str((request.get_json(silent=True) or {}).get("password", ""))
    if password_ok(pw):
        LOCKOUT["fails"] = 0
        return session_response(start_session())
    LOCKOUT["fails"] += 1
    if LOCKOUT["fails"] >= 5:                  # 5 wrong tries -> 30 second pause
        LOCKOUT["fails"], LOCKOUT["until"] = 0, time.time() + 30
    return jsonify({"error": "Wrong password."}), 401


HP_ACK = set()                                   # unlock sessions (tokens) that already answered the headphones prompt; gone with the lock


def headphones_needed(token):
    """Should a private video ask about headphones first? once = the first one after each unlock, always = every video, off = never."""
    mode = get_prefs().get("private_headphones", "once")
    if mode == "off":
        return False
    return mode == "always" or (token or "") not in HP_ACK


@app.get("/api/private/headphones")
def api_headphones_state():
    token = token_from_request()
    if not valid_token(token):
        abort(403)
    return jsonify({"prompt": headphones_needed(token)})


@app.post("/api/private/headphones/ack")
def api_headphones_ack():
    token = token_from_request()
    if not valid_token(token):
        abort(403)
    HP_ACK.add(token)
    return jsonify({"ok": True})


NATIVE_BEAT = {"t": 0.0}                         # when the native player last reported a private video playing


@app.post("/api/native/heartbeat")
def api_native_heartbeat():
    if not valid_token(token_from_request()):
        abort(403)
    NATIVE_BEAT["t"] = time.time()
    return jsonify({"ok": True})


@app.get("/api/native/busy")
def api_native_busy():
    """Is a private video playing in the native window right now? (the page's auto-lock waits while it is)"""
    if not valid_token(token_from_request()):
        abort(403)
    return jsonify({"busy": time.time() - NATIVE_BEAT["t"] < 25.0})


@app.post("/api/lock/lock")
def lock_lock():
    NATIVE_BEAT["t"] = 0.0
    HP_ACK.discard(token_from_request())
    SESSIONS.pop(token_from_request(), None)
    resp = jsonify({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


@app.post("/api/lock/change")
def lock_change():
    if not valid_token(token_from_request()):
        abort(403)
    d = request.get_json(silent=True) or {}
    if not password_ok(str(d.get("old", ""))):
        return jsonify({"error": "Current password is wrong."}), 401
    new = str(d.get("new", ""))
    if len(new) < 4:
        return jsonify({"error": "Use at least 4 characters."}), 400
    save_password(new)
    return jsonify({"ok": True})


# ----------------------------------------------------------------------------- photos lock
# Optional lock for the public Photos section. It uses the SAME password as the private library (one password for
# everything): settings["photos_lock"] only says whether Photos asks for it. Entering the password in either place
# opens both. A locked gallery answers 423 (not 403) so the private library is never locked by accident.
# Like the private lock it is a convenience lock, not encryption.
PHOTO_SESSIONS = {}                            # token -> expiry
PHOTO_COOKIE = "lmp_photos"


def photos_lock_on():
    """True when Photos asks for the password. Also folds in the short-lived separate Photos password of an earlier build."""
    st = load_settings()
    if "photos_password" in st:
        with SETTINGS_LOCK:
            st = load_settings()
            legacy = st.pop("photos_password", None)
            if legacy:
                st.setdefault("password", legacy)          # nothing set for the private library yet: keep what they chose
                st["photos_lock"] = True
            SETTINGS_PATH.write_text(json.dumps(st), encoding="utf-8")
    return bool(st.get("photos_lock")) and bool(st.get("password"))


def set_photos_lock(on):
    with SETTINGS_LOCK:
        st = load_settings()
        if on:
            st["photos_lock"] = True
        else:
            st.pop("photos_lock", None)
        SETTINGS_PATH.write_text(json.dumps(st), encoding="utf-8")


def photos_token():
    return request.headers.get("X-Photos-Token") or request.cookies.get(PHOTO_COOKIE, "")


def photos_valid(token):
    expiry = PHOTO_SESSIONS.get(token or "")
    if expiry and expiry > time.time():
        return True
    PHOTO_SESSIONS.pop(token or "", None)
    return False


def photos_locked():
    return photos_lock_on() and not photos_valid(photos_token())


def photos_gate():
    if photos_locked():
        abort(423)


def grant_photos(resp):
    """Open a Photos session on this response (a no-op while Photos has no lock)."""
    if photos_lock_on():
        PHOTO_SESSIONS.clear()
        token = secrets.token_urlsafe(24)
        PHOTO_SESSIONS[token] = time.time() + SESSION_HOURS * 3600
        resp.set_cookie(PHOTO_COOKIE, token, max_age=SESSION_HOURS * 3600, httponly=True, samesite="Strict", path="/")
    return resp


@app.get("/api/plock/status")
def plock_status():
    on = photos_lock_on()
    return jsonify({"enabled": on, "has_password": bool(load_settings().get("password")),
                    "unlocked": (not on) or photos_valid(photos_token())})


@app.post("/api/plock/enable")
def plock_enable():
    """Turn the Photos lock on. With no password yet, the one sent here becomes the password for everything."""
    d = request.get_json(silent=True) or {}
    if not load_settings().get("password"):
        pw = str(d.get("password", ""))
        if len(pw) < 4:
            return jsonify({"error": "Use at least 4 characters."}), 400
        save_password(pw)
    set_photos_lock(True)
    return grant_photos(jsonify({"ok": True}))


@app.post("/api/plock/disable")
def plock_disable():
    wait = LOCKOUT["until"] - time.time()
    if wait > 0:
        return jsonify({"error": "Too many attempts.", "retry_after": int(wait) + 1}), 429
    if not password_ok(str((request.get_json(silent=True) or {}).get("password", ""))):
        LOCKOUT["fails"] += 1
        if LOCKOUT["fails"] >= 5:
            LOCKOUT["fails"], LOCKOUT["until"] = 0, time.time() + 30
        return jsonify({"error": "Wrong password."}), 401
    LOCKOUT["fails"] = 0
    set_photos_lock(False)
    PHOTO_SESSIONS.clear()
    resp = jsonify({"ok": True})
    resp.delete_cookie(PHOTO_COOKIE, path="/")
    return resp


@app.post("/api/plock/unlock")
def plock_unlock():
    """Same password as the private library: unlocks Photos, and the private library too."""
    wait = LOCKOUT["until"] - time.time()
    if wait > 0:
        return jsonify({"error": "Too many attempts.", "retry_after": int(wait) + 1}), 429
    pw = str((request.get_json(silent=True) or {}).get("password", ""))
    if password_ok(pw):
        LOCKOUT["fails"] = 0
        return session_response(start_session())       # also opens Photos (see session_response)
    LOCKOUT["fails"] += 1
    if LOCKOUT["fails"] >= 5:                  # 5 wrong tries -> 30 second pause
        LOCKOUT["fails"], LOCKOUT["until"] = 0, time.time() + 30
    return jsonify({"error": "Wrong password."}), 401


@app.post("/api/plock/lock")
def plock_lock():
    PHOTO_SESSIONS.pop(photos_token(), None)
    resp = jsonify({"ok": True})
    resp.delete_cookie(PHOTO_COOKIE, path="/")
    return resp


# ----------------------------------------------------------------------------- page bundler
# index.html pulls in ~25 stylesheets and ~21 scripts as separate requests, one after another. At request time they are
# glued, in the SAME order, into one stylesheet and a few scripts (about 40% faster page load, measured). The files on
# disk stay as they are, and an edit to any of them is picked up by itself. If anything about the page looks unusual the
# original page is served instead. To debug with real file names and line numbers open  /?nobundle=1  (or set the
# environment variable ZENO_NO_BUNDLE=1).
BUNDLE = {"sig": None, "parts": {}}
BUNDLE_LOCK = threading.Lock()
_TAG_ATTRS = re.compile(r'([a-zA-Z_:-]+)\s*=\s*"([^"]*)"')
_LINK_TAG = re.compile(r"<link\b[^>]*>", re.I)
_SCRIPT_TAG = re.compile(r"<script\b[^>]*>\s*</script>", re.I)
_GAP_OK = re.compile(r"^(?:\s|<!--.*?-->)*$", re.S)


def _bundle_path(url):
    path = (RES_DIR / "assets" / url[len("/assets/"):]).resolve()
    if RES_DIR.resolve() not in path.parents or not path.is_file():
        raise ValueError("not a bundle file: " + url)
    return path


def _asset_ref(tag, kind):
    """(url) when the tag is a plain local stylesheet / script that is safe to merge, otherwise None."""
    attrs = {k.lower(): v for k, v in _TAG_ATTRS.findall(tag)}
    if kind == "css":
        if attrs.get("rel", "").lower() != "stylesheet" or not attrs.get("href", "").startswith("/assets/css/"):
            return None
        if set(attrs) - {"rel", "href", "id", "type"}:
            return None
        url = attrs["href"]
    else:
        if not attrs.get("src", "").startswith("/assets/js/"):
            return None
        if set(attrs) - {"src", "id", "type"} or attrs.get("type", "text/javascript").lower() not in ("text/javascript", "application/javascript"):
            return None
        url = attrs["src"]
    return re.split(r"[?#]", url)[0]


def bundle_page(html):
    """Return html with its local stylesheets and scripts merged. Raises on anything unexpected (caller falls back)."""
    css_hits = [(m.start(), m.end(), _asset_ref(m.group(0), "css")) for m in _LINK_TAG.finditer(html)]
    css_hits = [h for h in css_hits if h[2]]
    js_hits = [(m.start(), m.end(), _asset_ref(m.group(0), "js")) for m in _SCRIPT_TAG.finditer(html)]
    js_hits = [h for h in js_hits if h[2]]
    if not css_hits and not js_hits:
        return html
    # scripts that follow each other (only whitespace / comments / removed stylesheet tags between them) become one run
    css_spans = [(a, b) for a, b, _ in css_hits]
    runs = []
    for a, b, url in js_hits:
        if runs:
            gap = html[runs[-1]["end"]:a]
            for ca, cb in css_spans:
                if runs[-1]["end"] <= ca and cb <= a:
                    gap = gap.replace(html[ca:cb], "")
            if _GAP_OK.match(gap):
                runs[-1]["end"] = b
                runs[-1]["urls"].append(url)
                continue
        runs.append({"start": a, "end": b, "urls": [url]})
    files = sorted({h[2] for h in css_hits} | {u for r in runs for u in r["urls"]})
    sig_src = []
    for u in files:
        st = _bundle_path(u).stat()
        sig_src.append("%s:%d:%d" % (u, st.st_mtime_ns, st.st_size))
    sig = hashlib.sha1(("|".join(sig_src) + "|%d|%d" % (len(runs), len(css_hits))).encode()).hexdigest()[:12]
    with BUNDLE_LOCK:
        if BUNDLE["sig"] != sig:
            parts = {}
            css_text = []
            for _, _, u in css_hits:
                t = _bundle_path(u).read_text(encoding="utf-8")
                if re.search(r"@import|@charset", t, re.I):
                    raise ValueError("css with @import cannot be merged: " + u)
                css_text.append("/* %s */\n%s" % (u, t))
            if css_hits:
                parts["%s.css" % sig] = ("\n".join(css_text), "text/css; charset=utf-8")
            for i, r in enumerate(runs):
                parts["%s-%d.js" % (sig, i)] = ("\n;\n".join("/* %s */\n%s" % (u, _bundle_path(u).read_text(encoding="utf-8")) for u in r["urls"]),
                                                "application/javascript; charset=utf-8")
            BUNDLE["sig"], BUNDLE["parts"] = sig, parts
    link = '<link rel="stylesheet" href="/assets/bundle/%s.css">' % sig
    edits = []                                                   # (start, end, replacement), never overlapping
    def in_run(pos):
        return next((r for r in runs if r["start"] <= pos < r["end"]), None)
    first_css = css_hits[0][0] if css_hits else None
    link_in_run = in_run(first_css) if first_css is not None else None
    for i, r in enumerate(runs):
        tag = '<script src="/assets/bundle/%s-%d.js"></script>' % (sig, i)
        edits.append((r["start"], r["end"], (link if r is link_in_run else "") + tag))
    for a, b, _ in css_hits:
        if in_run(a) is None:
            edits.append((a, b, link if a == first_css else ""))
    for a, b, rep in sorted(edits, key=lambda e: -e[0]):
        html = html[:a] + rep + html[b:]
    return html


@app.get("/assets/bundle/<name>")
def asset_bundle(name):
    part = BUNDLE["parts"].get(name)
    if part is None:
        abort(404)
    return Response(part[0], mimetype=part[1].split(";")[0], headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/")
def index():
    html = render_template("index.html")
    if request.args.get("nobundle") or os.environ.get("ZENO_NO_BUNDLE"):
        return html
    try:
        return bundle_page(html)
    except Exception:
        log.warning("page bundling skipped, serving the original page", exc_info=True)
        return html


@app.get("/logo.png")
def logo():
    for d in (APP_DIR, APP_DIR / "templates", APP_DIR / "static", RES_DIR, RES_DIR / "templates"):
        p = d / "logo.png"
        if p.is_file():
            return send_file(p, mimetype="image/png", max_age=3600)
    abort(404)


@app.get("/api/videos")
def api_videos():
    private = request.args.get("private") == "1"
    if private and not valid_token(token_from_request()):
        abort(403)
    return jsonify(video_cards(private))


@app.get("/api/videos/<vid>/info")
def api_video_info(vid):
    """Everything the player needs right before playing: title, resume point, subtitle tracks."""
    v = get_video_checked(vid)
    with closing(db()) as con:
        r = con.execute("SELECT custom_title, position, duration FROM videos WHERE id = ?", (vid,)).fetchone()
    pos, dur = (r["position"] or 0), (r["duration"] or 0)
    frac = pos / dur if dur > 0 else 0
    subs = [{"label": label, "lang": lang, "url": f"/subtitle/{vid}/{i}"}
            for i, (_, label, lang) in enumerate(find_subtitles(v["path"]))]
    nav = {"series": "", "series_id": "", "next": None, "prev": None, "next_title": "", "index": 0, "total": 0}
    with LIB_LOCK:
        sr = LIB["series"].get(v.get("series_id") or "")
        eps = list(sr["episodes"]) if sr else []
    if sr and vid in eps:
        i = eps.index(vid)
        nav.update(series=sr["name"], series_id=sr["id"], index=i + 1, total=len(eps),
                   prev=eps[i - 1] if i > 0 else None, next=eps[i + 1] if i + 1 < len(eps) else None)
        if nav["next"]:
            with closing(db()) as con:
                nr = con.execute("SELECT custom_title FROM videos WHERE id = ?", (nav["next"],)).fetchone()
            nxt = get_video(nav["next"])
            nav["next_title"] = display_title(nr["custom_title"] if nr else None, nxt["title"] if nxt else "")
    return jsonify(dict({"title": display_title(r["custom_title"], v["title"]),
                         "resume": pos if CONTINUE_MIN < frac < CONTINUE_MAX else 0,
                         "subtitles": subs}, **nav))


@app.get("/api/native/session/<vid>")
def api_native_session(vid):
    """Everything the native player process needs for one video (it runs outside this process and reads the file itself)."""
    v = get_video_checked(vid)
    info = api_video_info(vid).get_json()
    with closing(db()) as con:
        r = con.execute("SELECT duration FROM videos WHERE id = ?", (vid,)).fetchone()
    p = get_prefs()
    keys = ("default_volume", "default_speed", "subs_size", "subs_color", "subs_outline", "subs_pos", "subs_auto", "asub_lang", "asub_mode", "asub_enabled", "mpv_hwdec", "mpv_sync",
            "mpv_interpolation", "mpv_stereo", "mpv_exclusive", "mpv_audio_device", "mpv_extra", "next_countdown", "default_fit", "remember_size", "hover_preview", "native_hints", "private_start_muted", "private_headphones")
    return jsonify(dict(info, id=vid, path=str(v["path"]), duration=(r["duration"] if r and r["duration"] else 0),
                        user_rating=video_stats(vid).get("user_rating", 0),
                        data_dir=str(DATA_DIR), private=bool(v["private"]), hp_prompt=bool(v["private"]) and headphones_needed(token_from_request()),
                        shots_dir=str(CFG["shots_dir"]), prefs={k: p.get(k) for k in keys}))


@app.post("/api/videos/<vid>/progress")
def api_progress(vid):
    get_video_checked(vid)
    d = request.get_json(silent=True) or {}
    try:
        pos, dur = float(d.get("position", 0)), float(d.get("duration", 0))
    except (TypeError, ValueError):
        abort(400)
    if not save_video_progress(vid, pos, dur):
        abort(400)
    return jsonify({"ok": True})


def save_video_progress(vid, pos, dur):
    """Resume point of a video. False when the numbers make no sense."""
    if not (math.isfinite(pos) and math.isfinite(dur)) or dur <= 0 or pos < 0:
        return False
    with closing(db()) as con, con:
        con.execute("UPDATE videos SET position = ?, duration = ?, progress_at = ? WHERE id = ?",
                    (min(pos, dur), dur, time.time(), vid))
    return True


@app.post("/api/videos/<vid>/title")
def api_title(vid):
    v = get_video_checked(vid)
    title = re.sub(r"\s+", " ", str((request.get_json(silent=True) or {}).get("title", ""))).strip()[:120]
    with closing(db()) as con, con:
        con.execute("UPDATE videos SET custom_title = ? WHERE id = ?", (title or None, vid))   # empty = reset
    return jsonify({"title": title or v["title"], "custom": bool(title)})


# ----------------------------------------------------------------------------- series + genres
def get_series_checked(sid):
    with LIB_LOCK:
        s = LIB["series"].get(sid)
    if not s:
        abort(404)
    if s["private"] and not valid_token(token_from_request()):
        abort(403)
    return s


def series_art_names(s):
    """File names your own series image may have, best first: poster / cover / folder / thumb / <series name> (.jpg .png .webp)."""
    return [n + ext for n in ("poster", "cover", "folder", "thumb", s["folder"].name, s["name"]) for ext in IMAGE_EXTS]


def find_series_art(s):
    """Your own series image inside the series folder. Found by the scan (see _scan_videos), so no disk search here."""
    p = s.get("art")
    if p is not None:
        try:
            if p.is_file():
                return p
        except OSError:
            pass
    return None


@app.get("/api/series/<sid>")
def api_series(sid):
    s = get_series_checked(sid)
    with LIB_LOCK:
        known = LIB["videos"]
        eps = [known[e] for e in s["episodes"] if e in known]
    marks = ",".join("?" * len(eps)) or "''"
    with closing(db()) as con:
        rows = {r["id"]: r for r in con.execute(f"""
            SELECT v.id, v.custom_title, v.view_count, v.position, v.duration, v.progress_at, v.mtime,
                   (SELECT stars FROM ratings r WHERE r.video_id = v.id AND r.profile = ?) AS mine
            FROM videos v WHERE v.id IN ({marks})""", [PROFILE] + [e["id"] for e in eps])}
    out, resume, newest = [], None, 0
    for e in eps:
        r = rows.get(e["id"])
        if not r:
            continue
        f = (r["position"] or 0) / r["duration"] if (r["duration"] or 0) > 0 else 0
        mid = CONTINUE_MIN < f < CONTINUE_MAX
        out.append({"id": e["id"], "title": display_title(r["custom_title"], e["title"]), "season": e["season"],
                    "view_count": r["view_count"], "user_rating": r["mine"] or 0, "progress": round(f, 3) if mid else 0,
                    "poster": f"/poster/{e['id']}?v={int(r['mtime'] or 0)}"})
        if mid and (r["progress_at"] or 0) >= newest:
            resume, newest = e["id"], r["progress_at"] or 0
    if resume is None:
        resume = next((o["id"] for o in out if o["view_count"] == 0), out[0]["id"] if out else None)
    first = out[0]["id"] if out else None
    return jsonify({"id": s["id"], "name": s["name"], "folder": s["folder"].name, "genre": s["genre"],
                    "episodes": out, "resume": resume,
                    "poster": f"/seriesart/{s['id']}", "backdrop": f"/backdrop/{first}" if first else ""})


@app.get("/seriesart/<sid>")
def series_art(sid):
    s = get_series_checked(sid)
    art = find_series_art(s)
    if art:
        return send_file(art, max_age=3600)
    with LIB_LOCK:
        first = LIB["videos"].get(s["episodes"][0]) if s["episodes"] else None
    if first:
        side = find_sidecar_poster(first)
        if side:
            return send_file(side, max_age=3600)
        if ensure_poster(first["id"], first["path"]):
            return send_file(POSTER_DIR / f"{first['id']}.jpg", mimetype="image/jpeg", max_age=3600)
    return Response(PLACEHOLDER_SVG, mimetype="image/svg+xml")


def genre_root(private):
    if private and not valid_token(token_from_request()):
        abort(403)
    return CFG["private_dir"] if private else CFG["video_dir"]


@app.post("/api/genres")
def api_genre_create():
    d = request.get_json(silent=True) or {}
    root = genre_root(bool(d.get("private")))
    name = clean_folder(d.get("name"))
    if not name:
        return jsonify({"error": "Give the genre a name."}), 400
    path = root / name
    if path.exists():
        return jsonify({"error": "A genre folder with that name already exists."}), 409
    try:
        path.mkdir(parents=True)
    except OSError as e:
        return jsonify({"error": "Could not create the folder: %s" % e}), 500
    return jsonify({"name": name, "path": str(path)})


@app.post("/api/genres/<genre>/delete")
def api_genre_delete(genre):
    """Removes a genre folder - only when nothing is inside it (move the videos out first)."""
    root = genre_root(bool((request.get_json(silent=True) or {}).get("private")))
    g = clean_folder(genre)
    gdir = root / g
    if not g or not gdir.is_dir():
        return jsonify({"error": "That genre folder does not exist."}), 404
    try:
        if any(gdir.iterdir()):
            return jsonify({"error": "This genre still has videos or series in it. Move them to another genre first."}), 409
        gdir.rmdir()
    except OSError as e:
        log.warning("genre delete failed: %s", gdir, exc_info=True)
        return jsonify({"error": "Could not delete the folder: %s" % e}), 500
    schedule_scan()
    return jsonify({"ok": True, "name": g})


@app.post("/api/genres/<genre>/upload")
def api_genre_upload(genre):
    """Copies the chosen files into media/videos/<genre>[/<series>]. Videos, subtitles and images are accepted."""
    root = genre_root(request.form.get("private") == "1")
    g = clean_folder(genre)
    gdir = root / g
    if not g or not gdir.is_dir():
        return jsonify({"error": "That genre folder does not exist."}), 404
    series = clean_folder(request.form.get("series"))
    dest = gdir / series if series else gdir
    try:
        dest.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return jsonify({"error": "Could not create the folder: %s" % e}), 500
    allowed = VIDEO_EXTS | SUB_EXTS | set(IMAGE_EXTS)
    saved = skipped = 0
    for f in request.files.getlist("files"):
        raw = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", Path(f.filename or "").name).strip(" .")
        ext = Path(raw).suffix.lower()
        if not raw or ext not in allowed:
            skipped += 1
            continue
        stem = Path(raw).stem[:150]
        target, n = dest / (stem + ext), 1
        while target.exists():
            target = dest / ("%s (%d)%s" % (stem, n, ext))
            n += 1
        try:
            f.save(target)
            saved += 1
        except OSError:
            skipped += 1
    schedule_scan()                                       # background: the upload request returns at once
    return jsonify({"saved": saved, "skipped": skipped, "series": series})


# ----------------------------------------------------------------------------- yt-dlp downloader
# Runs YOUR yt-dlp.exe / ffmpeg.exe (the folder is set in Settings). Same commands as the old run.bat:
#   Video -> MP4 (best quality, or capped), Audio -> MP3, Music -> FLAC with tags + square cover art.
# Every download goes into a private staging folder first, then the finished files are moved into the library.
DL_DIR = DATA_DIR / "downloads"
DL_LOG = APP_DIR / "download_log.txt"
DL_JOBS = {}
DL_ORDER = []
DL_LOCK = threading.Lock()
DL_QUEUE = queue.Queue()
DL_STATE = {"worker": False}
EXE_SUFFIX = ".exe" if os.name == "nt" else ""
DL_KINDS = {"video": "Video", "audio": "Audio", "music": "Music"}
# Extra yt-dlp arguments typed in Settings are checked against an exact allow-list (anything else is dropped).
DL_FLAGS = {"--embed-chapters", "--embed-metadata", "--embed-thumbnail", "--embed-subs", "--embed-info-json",
            "--write-subs", "--write-auto-subs", "--write-thumbnail", "--write-description", "--write-info-json",
            "--no-embed-chapters", "--no-embed-metadata", "--no-embed-thumbnail", "--no-embed-subs",
            "--restrict-filenames", "--windows-filenames", "--no-overwrites", "--ignore-errors", "--no-abort-on-error",
            "--no-mtime", "--prefer-free-formats", "--xattrs", "--no-warnings", "--geo-bypass", "--no-check-certificates",
            "--sponsorblock-mark-all", "--no-sponsorblock", "--split-chapters", "--clean-info-json"}
DL_VALUE_OPTS = {"--sub-langs", "--sub-format", "--convert-subs", "--convert-thumbnails", "--limit-rate", "--retries",
                 "--fragment-retries", "--concurrent-fragments", "--sleep-interval", "--min-sleep-interval",
                 "--max-sleep-interval", "--playlist-items", "--sponsorblock-mark", "--sponsorblock-remove",
                 "--cookies-from-browser", "--socket-timeout", "--age-limit", "--match-filters", "--extractor-args",
                 "-r", "-R", "-N"}
DL_VALUE_RE = re.compile(r"[\w.,:+*/@%\[\]=~<>! -]{1,120}")
FORMAT_ANY = ("bv*[height>=4320]+ba/b[height>=4320] / bv*[height>=2160]+ba/b[height>=2160] / "
              "bv*[height>=1440]+ba/b[height>=1440] / bv*[height>=1080]+ba/b[height>=1080] / bv+ba/b")
MUSIC_COVER_CROP = "ffmpeg:-c:v mjpeg -vf crop=\"'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'\""
RES_CHOICES = ("best", "4320", "2160", "1440", "1080", "720", "480")
_VERSION_CACHE = {}


def tool_env():
    return dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")


def ytdlp_search_dirs():
    raw = get_prefs().get("ytdlp_dir", "")
    return [Path(raw).expanduser()] if raw else [APP_DIR / "ytdlp", APP_DIR / "EXE", APP_DIR / "yt-dlp"]


def ff_extra_dirs():
    """Where ffmpeg + ffprobe may live besides the yt-dlp folder: the folder picked on the setup screen,
    the one the automatic download fills (data/ffmpeg), and the app folder."""
    raw = get_prefs().get("ffmpeg_dir", "")
    return ([Path(raw).expanduser()] if raw else []) + [DATA_DIR / "ffmpeg", APP_DIR / "ffmpeg", APP_DIR]


def ytdlp_tools():
    dirs = ytdlp_search_dirs()
    extra = ff_extra_dirs()

    def find(name):
        for d in (dirs + extra if name in ("ffmpeg", "ffprobe") else dirs):
            for sub in (d, d / "bin"):
                p = sub / (name + EXE_SUFFIX)
                if p.is_file():
                    return p
        w = shutil.which(name)
        return Path(w) if w else None
    return {"ytdlp": find("yt-dlp"), "ffmpeg": find("ffmpeg"), "ffprobe": find("ffprobe")}


def run_tool(args, timeout=30):
    kw = dict(capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
              creationflags=NO_WINDOW, env=tool_env(), stdin=subprocess.DEVNULL)
    if Path(str(args[0])).stem.lower() in ("ffmpeg", "ffprobe"):         # same two-at-a-time limit as every other ffmpeg call
        return ff_run(args, **kw)
    return subprocess.run(args, **kw)


def ytdlp_version(path):
    try:
        key = (str(path), path.stat().st_mtime)
    except OSError:
        log.warning("ytdlp_version: OSError ignored", exc_info=True)
        return ""
    if key not in _VERSION_CACHE:
        try:
            _VERSION_CACHE[key] = run_tool([str(path), "--version"], 15).stdout.strip()
        except Exception:
            log.warning("ytdlp_version: Exception ignored", exc_info=True)
            return ""
    return _VERSION_CACHE[key]


def split_args(text, notes=None):
    """Keeps only allow-listed yt-dlp options (and a safe value for those that take one)."""
    try:
        parts = shlex.split(str(text or ""))
    except ValueError:
        parts = str(text or "").split()
    out, i = [], 0

    def refuse(tok):
        if notes is not None:
            notes.append("Ignored the extra argument %s (not allowed)." % tok)

    while i < len(parts):
        tok = parts[i]
        name, eq, val = tok.partition("=")
        i += 1
        if tok in DL_FLAGS:
            out.append(tok)
        elif name in DL_VALUE_OPTS:
            if eq:
                value = val
            elif i < len(parts) and not parts[i].startswith("-"):
                value, i = parts[i], i + 1
            else:
                refuse(tok)
                continue
            if DL_VALUE_RE.fullmatch(value):
                out += [name, value]
            else:
                refuse(tok)
        else:
            refuse(tok)
    return out


def clean_url(raw):
    u = str(raw or "").strip().strip('"')
    if u.lower().startswith("www."):
        u = "https://" + u
    if not re.match(r"https?://\S+$", u, re.I):
        return ""
    return u


@app.get("/api/ytdlp/status")
def api_ytdlp_status():
    t = ytdlp_tools()
    return jsonify({"dir": get_prefs()["ytdlp_dir"], "searched": [str(d) for d in ytdlp_search_dirs()],
                    "ytdlp": str(t["ytdlp"] or ""), "ffmpeg": str(t["ffmpeg"] or ""), "ffprobe": str(t["ffprobe"] or ""),
                    "version": ytdlp_version(t["ytdlp"]) if t["ytdlp"] else ""})


@app.post("/api/ytdlp/info")
def api_ytdlp_info():
    """Title / thumbnail / length of a link, so you can see what you are about to download."""
    d = request.get_json(silent=True) or {}
    url = clean_url(d.get("url"))
    if not url:
        return jsonify({"error": "That does not look like a link."}), 400
    t = ytdlp_tools()
    if not t["ytdlp"]:
        return jsonify({"error": "yt-dlp was not found. Set its folder in Settings."}), 400
    cmd = [str(t["ytdlp"]), "--dump-single-json", "--skip-download", "--no-warnings", "--flat-playlist", "--socket-timeout", "15"]
    if not d.get("playlist"):
        cmd.append("--no-playlist")
    try:
        r = run_tool(cmd + [url], 50)
        info = json.loads(r.stdout)
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Timed out while reading that link."}), 504
    except Exception:
        msg = (r.stderr.strip().splitlines()[-1] if "r" in locals() and r.stderr.strip() else "Could not read that link.")
        return jsonify({"error": msg[:300]}), 502
    entries = info.get("entries") or []
    heights = [f.get("height") for f in (info.get("formats") or []) if f.get("height")]
    thumb = info.get("thumbnail") or next((x.get("url") for x in reversed(info.get("thumbnails") or []) if x.get("url")), "")
    return jsonify({"title": info.get("title") or "", "uploader": info.get("uploader") or info.get("channel") or "",
                    "duration": info.get("duration") or 0, "thumbnail": thumb,
                    "playlist": info.get("_type") == "playlist", "count": info.get("playlist_count") or len(entries),
                    "max_height": max(heights) if heights else 0})


@app.post("/api/ytdlp/update")
def api_ytdlp_update():
    t = ytdlp_tools()
    if not t["ytdlp"]:
        return jsonify({"error": "yt-dlp was not found."}), 400
    with DL_LOCK:
        if any(j["status"] == "running" for j in DL_JOBS.values()):
            return jsonify({"error": "Wait for the running download to finish first."}), 409
    try:
        r = run_tool([str(t["ytdlp"]), "-U"], 180)
    except Exception as e:
        return jsonify({"error": "Update failed: %s" % e}), 500
    _VERSION_CACHE.clear()
    out = (r.stdout + r.stderr).strip()
    return jsonify({"output": out[-600:], "version": ytdlp_version(t["ytdlp"]), "ok": r.returncode == 0})


@app.post("/api/ytdlp/import-vars")
def api_ytdlp_import_vars():
    """Reads the codecs and extra arguments from the VARS.txt next to your old run.bat setup."""
    t = ytdlp_tools()
    cands = [d / "VARS.txt" for d in ytdlp_search_dirs()] + ([t["ytdlp"].parent / "VARS.txt"] if t["ytdlp"] else [])
    path = next((p for p in cands if p.is_file()), None)
    if not path:
        return jsonify({"error": "VARS.txt was not found in the yt-dlp folder."}), 404
    keymap = {"vcodec": "dl_vcodec", "acodec": "dl_acodec", "mcodec": "dl_mcodec",
              "vargs": "dl_vargs", "aargs": "dl_aargs", "margs": "dl_margs"}
    patch = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.upper().startswith("REM") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        if k.strip() in keymap:
            patch[keymap[k.strip()]] = v.strip()
    save_prefs(patch)
    return jsonify(dict(prefs_payload(), imported=sorted(patch), source=str(path)))


# ---- jobs
DL_OPT_KEYS = ("mk_album", "album_name", "album_artist", "mk_playlist", "playlist_name")     # "save as album / playlist" choices of a music download


def job_public(j, with_log=True):
    keys = ("id", "url", "kind", "res", "genre", "series", "folder", "playlist", "private", "status", "progress",
            "speed", "eta", "item", "title", "message", "error", "dest", "files", "created", "ids", "series_id", "auto_series",
            "album_key", "playlist_id", "made") + DL_OPT_KEYS
    out = {k: j.get(k) for k in keys}
    if with_log:
        out["log"] = list(j["log"])[-25:]
    return out


def make_job(url, kind, res, genre, series, folder, playlist, private, dest, auto_series=False, opts=None):
    jid = secrets.token_hex(5)
    job = {"id": jid, "url": url, "kind": kind, "res": res, "genre": genre, "series": series, "folder": folder,
           "playlist": playlist, "private": private, "auto_series": auto_series, "status": "queued", "progress": 0, "speed": "", "eta": "",
           "item": "", "title": "", "message": "Waiting in the queue...", "error": "", "dest": str(dest), "files": [],
           "created": time.time(), "cancel": False, "proc": None, "log": [], "ids": [], "series_id": "",
           "mk_album": False, "album_name": "", "album_artist": "", "mk_playlist": False, "playlist_name": "", "pl_title": "", "order": [],
           "album_key": "", "playlist_id": 0, "made": []}
    job.update(opts or {})
    with DL_LOCK:
        DL_JOBS[jid] = job
        DL_ORDER.append(jid)
        if not DL_STATE["worker"]:
            DL_STATE["worker"] = True
            threading.Thread(target=dl_worker, daemon=True).start()
    DL_QUEUE.put(jid)
    return job


def dl_destination(kind, genre, series, folder, private, album=""):
    """Where finished files go. Returns (path, error)."""
    if kind == "video":
        root = genre_root(private)
        g, sr = clean_folder(genre), clean_folder(series)
        if sr and not g:
            return None, "Pick a genre for the series."
        return root / g / sr if g else root, ""
    prefs = get_prefs()
    sub = clean_folder(folder) if folder is not None and str(folder).strip() else prefs["dl_audio_sub" if kind == "audio" else "dl_music_sub"]
    base = CFG["music_dir"] / sub if sub else CFG["music_dir"]
    return (base / clean_folder(album) if clean_folder(album) else base), ""


@app.post("/api/downloads")
def api_downloads_add():
    d = request.get_json(silent=True) or {}
    kind = d.get("kind")
    if kind not in DL_KINDS:
        return jsonify({"error": "Choose Video, Audio or Music."}), 400
    urls = [clean_url(u) for u in (d.get("urls") or [d.get("url")])]
    urls = [u for u in urls if u]
    if not urls:
        return jsonify({"error": "Paste a link that starts with http:// or https://"}), 400
    if not ytdlp_tools()["ytdlp"]:
        return jsonify({"error": "yt-dlp was not found. Set its folder in Settings > Downloader."}), 400
    res = str(d.get("res") or "best")
    res = res if res in RES_CHOICES else "best"
    private = bool(d.get("private")) and kind == "video"
    save_as = str(d.get("save_as") or "songs")                  # music only: songs | album | playlist | both
    opts = {}
    if kind != "video" and save_as in ("album", "playlist", "both"):
        opts = {"mk_album": save_as in ("album", "both"), "mk_playlist": save_as in ("playlist", "both"),
                "album_name": clean_album_name(d.get("album_name")) if save_as in ("album", "both") else "",
                "album_artist": clean_album_name(d.get("album_artist")) if save_as in ("album", "both") else "",
                "playlist_name": clean_name(d.get("playlist_name")) if save_as in ("playlist", "both") else ""}
    dest, err = dl_destination(kind, d.get("genre"), d.get("series"), d.get("folder"), private, opts.get("album_name", ""))
    if err:
        return jsonify({"error": err}), 400
    g, sr = (clean_folder(d.get("genre")), clean_folder(d.get("series"))) if kind == "video" else ("", "")
    auto = kind == "video" and bool(d.get("playlist")) and bool(d.get("auto_series")) and not sr
    if auto and not g:
        return jsonify({"error": "Pick a genre first - the playlist becomes a series inside it."}), 400
    jobs = [make_job(u, kind, res, g, sr, str(d.get("folder") or ""), bool(d.get("playlist")), private, dest, auto, opts) for u in urls]
    return jsonify({"jobs": [job_public(j) for j in jobs]})


@app.get("/api/downloads")
def api_downloads_list():
    with DL_LOCK:
        jobs = [job_public(DL_JOBS[i]) for i in DL_ORDER if i in DL_JOBS]
    return jsonify({"jobs": jobs})


def kill_job_process(job):
    proc = job.get("proc")
    if not proc or proc.poll() is not None:
        return
    try:
        if os.name == "nt":                      # also stops ffmpeg, which yt-dlp starts as a child
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, creationflags=NO_WINDOW)
        else:
            proc.terminate()
    except Exception:
        log.warning("kill_job_process: Exception ignored", exc_info=True)


@app.post("/api/downloads/<jid>/cancel")
def api_downloads_cancel(jid):
    job = DL_JOBS.get(jid)
    if not job:
        abort(404)
    job["cancel"] = True
    if job["status"] == "queued":
        job.update(status="cancelled", message="Cancelled.")
    else:
        kill_job_process(job)
    return jsonify({"ok": True})


@app.post("/api/downloads/<jid>/retry")
def api_downloads_retry(jid):
    old = DL_JOBS.get(jid)
    if not old or old["status"] not in ("error", "cancelled"):
        abort(404)
    dest, err = dl_destination(old["kind"], old["genre"], old["series"], old["folder"] or None, old["private"], old.get("album_name", ""))
    if err:
        return jsonify({"error": err}), 400
    job = make_job(old["url"], old["kind"], old["res"], old["genre"], old["series"], old["folder"], old["playlist"], old["private"], dest,
                   old.get("auto_series", False), {k: old.get(k) for k in DL_OPT_KEYS})
    with DL_LOCK:
        DL_JOBS.pop(jid, None)
        if jid in DL_ORDER:
            DL_ORDER.remove(jid)
    return jsonify(job_public(job))


@app.post("/api/downloads/clear")
def api_downloads_clear():
    """Removes finished / failed / cancelled entries from the list (the files stay)."""
    d = request.get_json(silent=True) or {}
    only = d.get("id")
    with DL_LOCK:
        for i in list(DL_ORDER):
            j = DL_JOBS.get(i)
            if j and j["status"] in ("done", "error", "cancelled") and (not only or only == i):
                DL_JOBS.pop(i, None)
                DL_ORDER.remove(i)
    return jsonify({"ok": True})


def build_download_cmd(job, tools, stage, notes):
    p = get_prefs()
    kind, vc, ac, mc = job["kind"], p["dl_vcodec"], p["dl_acodec"], p["dl_mcodec"]
    cmd = [str(tools["ytdlp"]), "--newline", "--no-colors", "--no-mtime", "--trim-filenames", "120",
           "--progress-template", "download:[PROG] %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s",
           "-P", str(stage), "-w", "--yes-playlist" if job["playlist"] else "--no-playlist"]
    out_tmpl = "%(title)s.%(ext)s"
    if kind == "video" and job["playlist"] and (job.get("auto_series") or job["series"]):
        # numbered files keep the playlist order; an auto series gets a folder named after the playlist
        out_tmpl = ("%(playlist_title|Series)s/" if job.get("auto_series") and not job["series"] else "") + "%(playlist_index|0)03d - %(title)s.%(ext)s"
    # "make an album" without a name: the playlist's title becomes the folder (and the album) - like playlist -> series for videos
    pre = "%(playlist_title|Album)s/" if kind != "video" and job.get("mk_album") and not job.get("album_name") else ""
    if tools["ffmpeg"]:
        cmd += ["--ffmpeg-location", str(tools["ffmpeg"].parent)]
    if kind == "video":
        h = job["res"]
        fmt = FORMAT_ANY if h == "best" else "bv*[height<=%s]+ba/b[height<=%s]" % (h, h)
        cmd += split_args(p["dl_vargs"], notes) + ["-f", fmt, "--merge-output-format", "mp4", "-S", "vcodec:" + vc,
                                                   "-S", "acodec:" + ac, "-o", out_tmpl]
    elif kind == "audio":
        cmd += split_args(p["dl_aargs"], notes) + ["-f", "ba/b", "-x", "--audio-format", "mp3", "-S", "acodec:" + ac,
                                                   "-o", pre + "%(title)s.%(ext)s"]
    else:
        cmd += split_args(p["dl_margs"], notes) + [
            "--ppa", MUSIC_COVER_CROP, "-f", "ba/b", "-x", "--audio-format", "flac", "-S", "acodec:" + mc, "--embed-metadata",
            "--parse-metadata", "%(title)s:%(title)s",
            "--parse-metadata", "%(uploader,channel,creator,artist|null)s:%(uploader)s",
            "--parse-metadata", "artist:(?P<meta_album_artist>[^,]+)",
            "--parse-metadata", "%(album_artist,meta_album_artist,uploader)s:%(album_artist)s",
            "--parse-metadata", "%(release_year,release_date>%Y,upload_date>%Y)s:%(meta_date)s",
            "--parse-metadata", "%(album,title)s:%(meta_album)s",
            "--embed-thumbnail", "--convert-thumbnails", "jpg", "--ppa", "thumbnailsconvertor:-qmin 1 -q:v 1",
            "-o", pre + "%(uploader)s - %(title)s.%(ext)s"]
    return cmd + [job["url"]]


PROG_RE = re.compile(r"\[PROG\]\s+(\S+)\s+(\S+)\s+(\S+)")


def handle_dl_line(job, line):
    if not line:
        return
    job["log"].append(line[:300])
    if len(job["log"]) > 300:
        del job["log"][:100]
    m = PROG_RE.search(line)
    if m:
        try:
            job["progress"] = max(0.0, min(100.0, float(m.group(1).strip("%"))))
        except ValueError:
            log.warning("handle_dl_line: ValueError ignored", exc_info=True)
        job["speed"] = "" if m.group(2) in ("N/A", "Unknown") else m.group(2)
        job["eta"] = "" if m.group(3) in ("N/A", "Unknown") else m.group(3)
        job["message"] = "Downloading..."
        return
    if line.startswith("ERROR:"):
        job["error"] = line[6:].strip()[:300]
        return
    m = re.match(r"\[download\] Destination: (.+)", line)
    if m and not job["title"]:
        job["title"] = re.sub(r"\.f\d+$", "", Path(m.group(1)).stem)
    m = re.match(r"\[download\] Downloading playlist: (.+)", line)
    if m:
        job["pl_title"] = m.group(1).strip()[:120]
    m = re.match(r"\[ExtractAudio\] (?:Destination: (.+)|Not converting audio (.+?); file is already in target format)", line)
    if m:                                         # the finished songs, in playlist order, so an album / playlist keeps that order
        job["order"].append(Path(m.group(1) or m.group(2)).name)
    m = re.match(r"\[download\] Downloading item (\d+) of (\d+)", line)
    if m:
        job["item"] = "%s/%s" % m.groups()
        job["progress"] = 0
        return
    for tag, text in (("[Merger]", "Merging video and audio..."), ("[ExtractAudio]", "Converting audio..."),
                      ("[EmbedThumbnail]", "Adding cover art..."), ("[Metadata]", "Writing tags..."),
                      ("[ThumbnailsConvertor]", "Preparing cover art..."), ("[SponsorBlock]", "Checking SponsorBlock..."),
                      ("[ModifyChapters]", "Cutting sections..."), ("[FixupM3u8]", "Fixing the stream..."),
                      ("[youtube]", "Reading the link..."), ("[info]", "Choosing the best format...")):
        if line.startswith(tag):
            if tag in ("[Merger]", "[ExtractAudio]"):
                job["progress"] = 100
                job["speed"] = job["eta"] = ""
            job["message"] = text
            return


def unique_target(dest, name):
    target, n = dest / name, 1
    while target.exists():
        target = dest / ("%s (%d)%s" % (Path(name).stem, n, Path(name).suffix))
        n += 1
    return target


def organize_music(job, rels, auto_album):
    """After a music download: group the new songs into an album and / or a playlist, as chosen when the link was queued."""
    ids = [item_id(r) for r in rels]
    with MUSIC_LOCK:
        items = [MUSIC["by_id"][i] for i in ids if i in MUSIC["by_id"]]
    made = []
    name = job.get("album_name") or auto_album
    if job.get("mk_album") and name and (len(rels) >= 2 or job.get("album_name")):
        set_album(rels, name, job.get("album_artist") or pick_album_artist(items))
        made.append("Album: " + name)
    if job.get("mk_playlist"):
        pname = job.get("playlist_name") or job.get("pl_title") or auto_album or name or "New playlist"
        job["playlist_id"], pname, _n = playlist_add_rels(pname, rels)
        made.append("Playlist: " + pname)
    job["made"] = made
    rebuild_music()
    if job.get("mk_album") and made and made[0].startswith("Album: "):
        with MUSIC_LOCK:
            it = MUSIC["by_id"].get(ids[0])
        job["album_key"] = it["albumkey"] if it else ""


def finish_download(job, stage, rc):
    media = VIDEO_EXTS | MUSIC_EXTS
    files = [f for f in sorted(stage.rglob("*")) if f.is_file() and (f.suffix.lower() in media or
             (f.suffix.lower() in SUB_EXTS and job["kind"] == "video"))]
    if not any(f.suffix.lower() in media for f in files):
        job.update(status="error", message="Nothing was downloaded.",
                   error=job["error"] or ("yt-dlp stopped with code %s." % rc))
        return
    dest = Path(job["dest"])
    is_video = job["kind"] == "video"
    root = CFG["private_dir"] if job["private"] else CFG["video_dir"]
    prefix = "private/" if job["private"] else ""
    ids = []
    vfiles = [f for f in files if f.suffix.lower() in VIDEO_EXTS]
    auto = bool(is_video and job.get("auto_series") and not job["series"] and len(vfiles) >= 2)
    afiles = [f for f in files if f.suffix.lower() in MUSIC_EXTS]
    auto_alb = bool(not is_video and job.get("mk_album") and not job.get("album_name") and len(afiles) >= 2)
    rels, auto_album, rank_of = [], "", {n: i for i, n in enumerate(job.get("order") or [])}
    try:
        dest.mkdir(parents=True, exist_ok=True)
        names = []
        for f in files:
            out_dir, name = dest, f.name
            if auto:                                  # playlist -> series: the first folder yt-dlp made is the series
                parts = f.relative_to(stage).parts
                if len(parts) > 1:
                    out_dir = dest / (clean_folder(parts[0]) or "Series")
                    job["series"] = job["series"] or out_dir.name
                    out_dir.mkdir(parents=True, exist_ok=True)
            elif auto_alb and f.suffix.lower() in MUSIC_EXTS:     # playlist -> album: the folder yt-dlp made is the album
                parts = f.relative_to(stage).parts
                if len(parts) > 1:
                    out_dir = dest / (clean_folder(parts[0]) or "Album")
                    auto_album = auto_album or out_dir.name
                    out_dir.mkdir(parents=True, exist_ok=True)
            elif is_video and job.get("auto_series") and not job["series"]:
                name = re.sub(r"^\d{3} - ", "", name)   # a single video: no episode number
            target = unique_target(out_dir, name)
            shutil.move(str(f), str(target))
            if f.suffix.lower() in media:
                names.append(target.name)
                try:                              # the library ids of the new files, so the UI can point at them
                    if is_video and f.suffix.lower() in VIDEO_EXTS:
                        ids.append(item_id(prefix + target.relative_to(root).as_posix()))
                    elif not is_video and f.suffix.lower() in MUSIC_EXTS:
                        rel = target.relative_to(CFG["music_dir"]).as_posix()
                        ids.append(item_id(rel))
                        rels.append((rank_of.get(f.name, 10 ** 6 + len(rels)), rel))
                except ValueError:
                    log.warning("finish_download: ValueError ignored", exc_info=True)
    except OSError as e:
        job.update(status="error", message="Could not move the files into your library.", error=str(e))
        return
    job["message"] = "Adding to your library..."
    try:                                          # index BEFORE reporting done, so "Show in library" always finds it
        if is_video:
            scan_videos()
        else:
            scan_music()                          # waits for a scan already running, then picks up the new songs
    except Exception:
        log.warning("finish_download: Exception ignored", exc_info=True)
    if not is_video and rels and (job.get("mk_album") or job.get("mk_playlist")):
        try:                                      # the songs are indexed now: group them the way the person asked
            organize_music(job, [r for _, r in sorted(rels)], auto_album)
        except Exception:
            log.warning("finish_download: organize_music failed", exc_info=True)
    sid = item_id(prefix + job["genre"] + "/" + job["series"]) if is_video and job["genre"] and job["series"] else ""
    job.update(status="done", progress=100, speed="", eta="", files=names, ids=ids, series_id=sid,
               title=job["title"] or Path(names[0]).stem,
               message="Done" if rc == 0 else "Finished, but some items failed.")
    try:
        with open(DL_LOG, "a", encoding="utf-8") as fh:
            fh.write("%s: %s - %s in %s\n" % (time.strftime("%Y-%m-%d"), DL_KINDS[job["kind"]], job["url"], dest))
    except OSError:
        log.warning("finish_download: OSError ignored", exc_info=True)
    if is_video:
        threading.Thread(target=pregenerate_posters, daemon=True).start()


def run_download(job):
    tools = ytdlp_tools()
    if not tools["ytdlp"]:
        job.update(status="error", message="yt-dlp was not found.", error="Set the yt-dlp folder in Settings > Downloader.")
        return
    stage = DL_DIR / job["id"]
    stage.mkdir(parents=True, exist_ok=True)
    notes = []
    cmd = build_download_cmd(job, tools, stage, notes)
    job.update(status="running", message="Starting...")
    for n in notes:
        job["log"].append(n)
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True,
                                encoding="utf-8", errors="replace", bufsize=1, creationflags=NO_WINDOW, env=tool_env())
        job["proc"] = proc
        if job["cancel"]:
            kill_job_process(job)
        for line in proc.stdout:
            handle_dl_line(job, line.rstrip())
        rc = proc.wait()
    except Exception as e:
        job.update(status="error", message="Could not start yt-dlp.", error=str(e))
        shutil.rmtree(stage, ignore_errors=True)
        return
    finally:
        job["proc"] = None
    if job["cancel"]:
        job.update(status="cancelled", message="Cancelled.", speed="", eta="")
    else:
        finish_download(job, stage, rc)
    shutil.rmtree(stage, ignore_errors=True)


def dl_worker():
    while True:                                   # one download at a time, in the order they were added
        jid = DL_QUEUE.get()
        job = DL_JOBS.get(jid)
        if not job or job["status"] != "queued":
            continue
        try:
            run_download(job)
        except Exception as e:
            job.update(status="error", message="Unexpected error.", error=str(e))


@app.post("/api/folders/open")
def api_open_folder():
    d = request.get_json(silent=True) or {}
    root = genre_root(bool(d.get("private")))
    path = root
    for part in (clean_folder(d.get("genre")), clean_folder(d.get("series"))):
        if part:
            path = path / part
    if not path.is_dir():
        abort(404)
    try:
        if os.name == "nt":
            os.startfile(str(path))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception as e:
        return jsonify({"error": "Could not open the folder: %s" % e}), 500
    return jsonify({"ok": True})


# ----------------------------------------------------------------------------- user preferences
# Add a new setting in 3 places: here (default), clean_pref() (validation), and the Settings panel in index.html.
DISPLAY_MODES = ("windowed", "maximized", "fullscreen")
BG_MODES = ("dark", "colorful", "time")            # "light" was removed; a saved "light" falls back to dark
CLOCK_STYLES = ("logo", "auto", "gold", "light", "dark", "emerald", "minimal")
DISPLAY_KEYS = ("display_mode", "win_width", "win_height")
FOLDER_KEYS = {"video": "video_dir", "music": "music_dir", "private": "private_dir", "photos": "photo_dir", "clips": "clips_dir", "shots": "shots_dir"}   # kind -> CFG / prefs key
SPEEDS = (0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0)
PREF_DEFAULTS = {
    "wheel_rows": True,            # mouse wheel scrolls the video rows sideways
    "bg_mode": "dark",             # dark | colorful (your image) | time (colour follows the time of day)
    "clock_style": "logo",         # clock design on Home and in the corner: logo (your logo.png as the dial; old "auto" also means this) | gold | light | dark | emerald | minimal
    "bg_image": "",                # colorful mode: "" (default) | "preset:<name>" | "custom" (the uploaded picture)
    "hover_preview": True,         # home banner + private-library cards play a short muted preview when hovered
    "ag_online": False,            # Smart genres may look titles up online (TMDB / MusicBrainz / Last.fm)
    "tile_motion": False,          # Cinema square tiles play a moving picture inside the tile on hover (default off)
    "display_mode": "windowed",    # windowed | maximized | fullscreen
    "win_width": 1440,             # window size used in windowed mode
    "win_height": 900,
    "remember_size": True,         # save the window size when the app closes (windowed mode)
    "close_to_tray": True,         # closing the window hides ULTRON in the system tray instead of quitting (Windows)
    "idle_lock_minutes": 5,        # auto-lock the private library after this many idle minutes
    "next_countdown": 8,           # seconds before the next episode starts by itself
    "default_volume": 80,          # volume the players start at (0-100)
    "default_speed": 1.0,          # video speed when a video starts
    "default_fit": "fit",          # fit | fill
    "subs_auto": True,             # turn subtitles on by themselves when a video has them
    "subs_size": 115,              # subtitle size in percent of normal
    "native_hints": True,          # native player: show the "press ? for shortcuts" tip once
    "private_start_muted": True,   # private videos (native player, pop-out, in-window player) start muted; M turns the sound on
    "private_headphones": "once",  # headphones prompt before a private video: once (per unlock) | always (every video) | off
    "private_sort": "new",         # order of the loose videos in the Private tab: new (newest first) | old | az
    "private_blur_covers": True,   # private covers (posters and thumbnails) stay blurred until you hover them
    "subs_color": "#FFFFFF",       # subtitle colour (native player)
    "subs_outline": 3,             # subtitle outline thickness, 0 = none (native player)
    "subs_pos": 100,               # subtitle position: 100 = bottom, lower number = higher up (native player)
    "asub_auto": False,            # auto subtitles: start by themselves when a video has no subtitles at all (off: only when asked)
    "native_player": True,         # videos play in the native Qt player window (libmpv inside Qt); off = the web player
    "asub_enabled": True,          # auto subtitles: master switch (off = no pill, no CC entry, nothing runs)
    "asub_lang": "en",             # auto subtitles: language the generated subtitles are translated into
    "asub_mode": "accurate",       # auto subtitles: accurate (Whisper large-v3-turbo) | fast (Whisper small)
    "start_tab": "last",           # last | home | video | music
    "fav_public": True,            # hearts + a Favorites album in the public Photos gallery
    "show_clock": False,           # small clock in the top-right corner (Home keeps only the date)
    "home_clock": True,            # big clock + date + greeting on Home
    "music_ui": "prism",           # layout of the Music section (single look now; old values are migrated)
    "browse_bar": "auto",          # always | auto | hidden  (Movies / Series / All Videos bar)
    "auto_sort": True,             # files dropped in the video folder sort themselves into collections / series (nothing moves on disk)
    "clean_titles": True,          # hide 1080p / BluRay / x264 / YIFY junk in movie names
    "play_aspect": "smart",        # smart | fit | fill  (black bars stay black; smart also removes bars baked into the file)
    # --- native player (libmpv) ---
    "mpv_enabled": True,           # play every video with libmpv on the GPU (off = the built-in web player, MP4/WebM only)
    "mpv_overlay": True,           # the page's own controls sit over the picture (also in fullscreen). Off = old layout: picture between the bars, mpv's own controls in fullscreen
    "mpv_hwdec": "auto",           # auto (D3D11VA on the Radeon) | d3d11va | d3d11va-copy | no
    "mpv_sync": "display-resample",  # display-resample (monitor clock leads, audio is resampled a hair) | audio
    "mpv_interpolation": False,    # blend frames up to the monitor refresh rate (uses the GPU)
    "mpv_audio_device": "M-Audio Duo",  # part of the Windows audio device name; no match = the Windows default device
    "mpv_stereo": True,            # fold 5.1 / 7.1 down to stereo (headphones through the M-Audio Duo)
    "mpv_exclusive": False,        # WASAPI exclusive mode: bit-perfect to the interface, other apps are silent meanwhile
    "mpv_dir": "",                 # folder with libmpv-2.dll when it is not next to ULTRON.exe / in data\\mpv
    "mpv_extra": "",               # advanced mpv options, one key=value per line
    "fav_private": True,           # hearts + a Favorites album in the private Photos gallery (stay behind the lock)
    # --- downloader (yt-dlp) ---
    "ytdlp_dir": "",               # folder with yt-dlp.exe + ffmpeg.exe + ffprobe.exe ('' = look next to the app / on PATH)
    "ffmpeg_dir": "",              # folder with ffmpeg.exe + ffprobe.exe, if you keep them somewhere else ('' = data\\ffmpeg, next to the app, or PATH)
    "dl_vcodec": "h264",           # preferred video codec (-S vcodec:...)
    "dl_acodec": "mp3",            # preferred audio codec (-S acodec:...)
    "dl_mcodec": "flac",           # preferred codec for the Music (FLAC) mode
    "dl_vargs": "--embed-chapters --embed-metadata --embed-thumbnail",      # extra yt-dlp args, Video mode
    "dl_aargs": "--embed-chapters --embed-metadata --embed-thumbnail",      # extra yt-dlp args, Audio mode
    "dl_margs": '',                   # extra yt-dlp args, Music mode (leave empty: SponsorBlock cuts trim song starts)
    "dl_audio_sub": "Audio",       # folder inside the music library for MP3 downloads
    "dl_music_sub": "Music",       # folder inside the music library for FLAC downloads
}


def _int_in(value, lo, hi, default):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def clean_pref(key, value):
    """Return a safe value for a pref (falls back to the default if the value is junk)."""
    default = PREF_DEFAULTS[key]
    if key in ("wheel_rows", "remember_size", "close_to_tray", "subs_auto", "asub_auto", "asub_enabled", "native_player", "native_hints", "private_start_muted", "private_blur_covers", "hover_preview", "tile_motion", "ag_online", "fav_public", "fav_private", "show_clock", "home_clock", "auto_sort", "clean_titles",
               "mpv_enabled", "mpv_overlay", "mpv_interpolation", "mpv_stereo", "mpv_exclusive"):
        return bool(value)
    if key == "mpv_hwdec":
        return value if value in ("auto", "d3d11va", "d3d11va-copy", "no") else default
    if key == "mpv_sync":
        return value if value in ("display-resample", "audio") else default
    if key == "mpv_audio_device":
        return re.sub(r"[\r\n]+", " ", str(value or "")).strip()[:80]
    if key == "mpv_dir":
        return str(value or "").strip().strip('"')[:500]
    if key == "mpv_extra":
        return "\n".join(l.strip()[:200] for l in str(value or "").splitlines()[:30] if l.strip())[:3000]
    if key == "clock_style":
        if value == "auto":      # old day/night setting: now the logo face
            return "logo"
        return value if value in CLOCK_STYLES else default
    if key == "bg_mode":
        return value if value in BG_MODES else default
    if key == "bg_image":
        v = str(value or "")
        return v if (v == "custom" or re.fullmatch(r"preset:[a-z]{3,16}", v)) else ""
    if key == "display_mode":
        return value if value in DISPLAY_MODES else default
    if key == "music_ui":
        return "prism"   # old "spotify" / "apple" values from earlier settings.json files map here
    if key == "browse_bar":
        return value if value in ("always", "auto", "hidden") else default
    if key == "play_aspect":
        return value if value in ("smart", "fit", "fill") else default
    if key == "default_fit":
        return value if value in ("fit", "fill") else default
    if key == "asub_lang":
        return value if (autosubs and (value in autosubs.BY_CODE or value == "orig")) else default
    if key == "asub_mode":
        return value if value in ("accurate", "fast") else default
    if key == "start_tab":
        return value if value in ("last", "home", "video", "music") else default
    if key == "private_sort":
        return value if value in ("new", "old", "az") else default
    if key == "private_headphones":
        return value if value in ("once", "always", "off") else default
    if key in ("ytdlp_dir", "ffmpeg_dir"):
        return str(value or "").strip().strip('"')[:500]
    if key in ("dl_vcodec", "dl_acodec", "dl_mcodec"):
        v = str(value or "").strip()
        return v if re.fullmatch(r"[A-Za-z0-9_,:+.\-]{1,40}", v) else default
    if key in ("dl_vargs", "dl_aargs", "dl_margs"):
        return str(value or "").strip()[:600]
    if key in ("dl_audio_sub", "dl_music_sub"):
        return clean_folder(value)
    if key == "subs_color":
        v = str(value or "").strip()
        return v.upper() if re.fullmatch(r"#[0-9A-Fa-f]{6}", v) else default
    if key == "subs_outline":
        try:
            return max(0.0, min(8.0, float(value)))
        except (TypeError, ValueError):
            return default
    if key == "subs_pos":
        return _int_in(value, 50, 100, default)
    if key == "default_speed":
        try:
            f = round(float(value) * 4) / 4
        except (TypeError, ValueError):
            return default
        return f if f in SPEEDS else default
    ranges = {"win_width": (900, 7680), "win_height": (600, 4320), "idle_lock_minutes": (1, 120),
              "next_countdown": (3, 30), "default_volume": (0, 100), "subs_size": (60, 300)}
    if key in ranges:
        return _int_in(value, *ranges[key], default)
    return default


def get_prefs():
    saved = load_settings().get("prefs") or {}
    out = {k: clean_pref(k, saved.get(k, d)) for k, d in PREF_DEFAULTS.items()}
    if "sponsorblock-remove" in out.get("dl_margs", ""):      # old default silently trimmed the start of songs
        out["dl_margs"] = ""
    return out


def prefs_payload():
    out = get_prefs()
    bg = bg_file()
    out["bg_custom_v"] = int(bg.stat().st_mtime) if bg else 0     # lets the page cache-bust the picked image
    out["folders"] = {kind: str(effective_dir(key)) for kind, key in FOLDER_KEYS.items()}
    return out


def save_prefs(patch):
    """Validate and store the given prefs. Returns the full, cleaned prefs."""
    with SETTINGS_LOCK:
        settings = load_settings()
        prefs = settings.setdefault("prefs", {})
        for k in PREF_DEFAULTS:
            if k in patch:
                prefs[k] = clean_pref(k, patch[k])
        SETTINGS_PATH.write_text(json.dumps(settings), encoding="utf-8")
    return get_prefs()


def apply_display_async(now):
    threading.Thread(target=apply_display, args=(now["display_mode"], now["win_width"], now["win_height"]),
                     daemon=True).start()


def _int(v, lo, hi, d=0):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return d


def _str(v, n):
    return str(v)[:n] if isinstance(v, (str, int, float)) else ""


def clean_time(d):
    """Only known keys, bounded sizes: the Time section's cities, alarms, timers and stopwatch."""
    d = d if isinstance(d, dict) else {}
    out = {}
    if isinstance(d.get("cities"), list):
        out["cities"] = [_str(c, 50) for c in d["cities"][:40] if _str(c, 50)]
    if d.get("style") in CLOCK_STYLES:
        out["style"] = d["style"]
    if isinstance(d.get("alarms"), list):
        out["alarms"] = [{"id": _str(a.get("id"), 24), "h": _int(a.get("h"), 0, 23), "m": _int(a.get("m"), 0, 59),
                          "label": _str(a.get("label"), 80), "on": bool(a.get("on")),
                          "days": sorted({_int(x, 0, 6) for x in a.get("days", [])[:7]}) if isinstance(a.get("days"), list) else [],
                          "sound": _str(a.get("sound"), 16) or "classic", "snooze": _int(a.get("snooze"), 1, 60, 5),
                          "last": _str(a.get("last"), 20)} for a in d["alarms"][:60] if isinstance(a, dict)]
    if isinstance(d.get("timers"), list):
        out["timers"] = [{"id": _str(t.get("id"), 24), "label": _str(t.get("label"), 80),
                          "total": _int(t.get("total"), 1000, 359999000, 60000),
                          "state": t.get("state") if t.get("state") in ("idle", "run", "pause", "done") else "idle",
                          "end": _int(t.get("end"), 0, 10 ** 14), "left": _int(t.get("left"), 0, 359999000)}
                         for t in d["timers"][:30] if isinstance(t, dict)]
    sw = d.get("sw")
    if isinstance(sw, dict):
        out["sw"] = {"run": bool(sw.get("run")), "t0": _int(sw.get("t0"), 0, 10 ** 14), "acc": _int(sw.get("acc"), 0, 10 ** 12),
                     "laps": [_int(x, 0, 10 ** 12) for x in (sw.get("laps") or [])[:500]] if isinstance(sw.get("laps"), list) else []}
    return out


# ----------------------------------------------------------------------------- browser-side settings mirror
# The window's own storage was lost on every exit (private window + a new random port each launch), so every
# setting kept in the page (theme, palette, flair switches, DJ, layout...) is mirrored into data/localstore.json.
LS_PATH = DATA_DIR / "localstore.json"
LS_SKIP = ("lmp_private_token",)


@app.get("/api/ls")
def api_ls_get():
    with SETTINGS_LOCK:
        try:
            return jsonify(json.loads(LS_PATH.read_text(encoding="utf-8")))
        except Exception:
            return jsonify({})


@app.post("/api/ls")
def api_ls_set():
    d = request.get_json(silent=True, force=True)
    if not isinstance(d, dict):
        abort(400)
    clean = {str(k)[:120]: str(v)[:200000] for k, v in list(d.items())[:600] if str(k) not in LS_SKIP}
    with SETTINGS_LOCK:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        text = json.dumps(clean)
        try:
            if LS_PATH.read_text(encoding="utf-8") == text:
                return jsonify({"ok": True})                  # nothing changed: no disk write
        except OSError:
            pass
        tmp = LS_PATH.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(LS_PATH)
    return jsonify({"ok": True})



@app.get("/api/time")
def api_time_get():
    with SETTINGS_LOCK:
        return jsonify(load_settings().get("time", {}))


@app.post("/api/time")
def api_time_set():
    if request.content_length and request.content_length > 400_000:
        return jsonify({"error": "Too much data."}), 400
    data = clean_time(request.get_json(silent=True))
    with SETTINGS_LOCK:
        settings = load_settings()
        settings["time"] = {**settings.get("time", {}), **data}
        SETTINGS_PATH.write_text(json.dumps(settings), encoding="utf-8")
    return jsonify(settings["time"])


BG_MAX_BYTES = 25 * 1024 * 1024
BG_EXTS = (".jpg", ".png", ".webp")


def bg_file():
    """The picture chosen for the Colorful background, or None."""
    for ext in BG_EXTS:
        p = DATA_DIR / ("background" + ext)
        if p.is_file():
            return p
    return None


def bg_clear():
    for ext in BG_EXTS:
        try:
            (DATA_DIR / ("background" + ext)).unlink()
        except FileNotFoundError:
            pass
        except OSError:
            log.warning("bg_clear: OSError ignored", exc_info=True)


@app.post("/api/background")
def api_background_set():
    """Raw image bytes in the request body (jpg / png / webp). Large pictures are scaled down so the page stays fast."""
    data = request.get_data(cache=False)
    if not data or len(data) > BG_MAX_BYTES:
        return jsonify({"error": "Choose a picture under 25 MB."}), 400
    if data[:3] == b"\xff\xd8\xff":
        ext = ".jpg"
    elif data[:8] == b"\x89PNG\r\n\x1a\n":
        ext = ".png"
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ext = ".webp"
    else:
        return jsonify({"error": "That file is not a JPG, PNG or WEBP picture."}), 400
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DATA_DIR / ("background.tmp" + ext)
    try:
        if PILImage is not None:
            import io
            im = ImageOps.exif_transpose(PILImage.open(io.BytesIO(data)))
            im.thumbnail((2560, 1600))
            if ext == ".jpg" or im.mode not in ("RGBA", "LA", "P"):
                ext, im = ".jpg", im.convert("RGB")
                tmp = DATA_DIR / "background.tmp.jpg"
                im.save(tmp, "JPEG", quality=88, optimize=True)
            else:
                im.save(tmp, "PNG" if ext == ".png" else "WEBP")
        else:
            tmp.write_bytes(data)
    except Exception:
        log.warning("api_background_set: unreadable picture", exc_info=True)
        try:
            tmp.unlink()
        except OSError:
            pass
        return jsonify({"error": "That picture could not be read."}), 400
    bg_clear()
    os.replace(tmp, DATA_DIR / ("background" + ext))
    save_prefs({"bg_image": "custom", "bg_mode": "colorful"})
    return jsonify(prefs_payload())


@app.delete("/api/background")
def api_background_clear():
    bg_clear()
    save_prefs({"bg_image": ""})
    return jsonify(prefs_payload())


@app.get("/background-image")
def background_image():
    p = bg_file()
    if not p:
        abort(404)
    resp = send_file(p, max_age=0)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/api/prefs")
def api_prefs_get():
    return jsonify(prefs_payload())


@app.post("/api/prefs")
def api_prefs_set():
    d = request.get_json(silent=True) or {}
    now = save_prefs(d)
    if any(k in d for k in DISPLAY_KEYS):                 # apply window changes right away
        apply_display_async(now)
    return jsonify(prefs_payload())


@app.post("/api/prefs/reset")
def api_prefs_reset():
    """Back to the default settings (your folders are left alone)."""
    with SETTINGS_LOCK:
        settings = load_settings()
        prefs = settings.setdefault("prefs", {})
        for k in PREF_DEFAULTS:
            prefs.pop(k, None)
        SETTINGS_PATH.write_text(json.dumps(settings), encoding="utf-8")
    apply_display_async(get_prefs())
    return jsonify(prefs_payload())


@app.post("/api/folders/set")
def api_folder_set():
    """Point the video / music / private library at another folder ('' = the built-in default)."""
    d = request.get_json(silent=True) or {}
    kind = d.get("kind")
    if kind not in FOLDER_KEYS:
        abort(400)
    key = FOLDER_KEYS[kind]
    raw = str(d.get("path") or "").strip().strip('"')
    path = Path(raw).expanduser() if raw else DEFAULT_CFG[key]
    if path is None:                                      # default that follows another folder (clips)
        with SETTINGS_LOCK:
            settings = load_settings()
            settings.setdefault("prefs", {}).pop(key, None)
            SETTINGS_PATH.write_text(json.dumps(settings), encoding="utf-8")
        CFG[key] = None
        return jsonify(prefs_payload())
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return jsonify({"error": "Could not use that folder: %s" % e}), 400
    if not path.is_dir():
        return jsonify({"error": "That is not a folder."}), 400
    with SETTINGS_LOCK:
        settings = load_settings()
        prefs = settings.setdefault("prefs", {})
        if raw:
            prefs[key] = str(path)
        else:
            prefs.pop(key, None)
        SETTINGS_PATH.write_text(json.dumps(settings), encoding="utf-8")
    CFG[key] = path
    return jsonify(prefs_payload())


@app.post("/api/artist-rules/open")
def api_open_artist_rules():
    load_protected()                                      # makes sure the file exists
    try:
        if os.name == "nt":
            os.startfile(str(RULES_PATH))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(RULES_PATH)])
        else:
            subprocess.Popen(["xdg-open", str(RULES_PATH)])
    except Exception as e:
        return jsonify({"error": "Could not open the file: %s" % e}), 500
    return jsonify({"ok": True})


@app.get("/subtitle/<vid>/<int:idx>")
def subtitle(vid, idx):
    v = get_video_checked(vid)
    subs = find_subtitles(v["path"])
    if not 0 <= idx < len(subs):
        abort(404)
    path = subs[idx][0]
    try:
        text = read_text(path)
    except OSError:
        abort(404)
    if path.suffix.lower() == ".srt":
        text = srt_to_vtt(text)
    elif not text.lstrip().startswith("WEBVTT"):
        text = "WEBVTT\n\n" + text
    return Response(text, mimetype="text/vtt", headers={"Cache-Control": "no-store"})


# ----------------------------------------------------------------------------- private photo gallery
PHOTO_DIMS = {}              # "public:rel" / "private:rel" -> (mtime, width, height); mirrors the photo_dims table
PHOTO_DIMS_LOADED = []       # non-empty once the table has been read
PHOTO_LOCK = threading.Lock()


def photo_dims_load():
    if PHOTO_DIMS_LOADED:
        return
    try:
        with closing(db()) as con:
            for r in con.execute("SELECT key, mtime, w, h FROM photo_dims"):
                PHOTO_DIMS[r["key"]] = (r["mtime"], r["w"], r["h"])
    except sqlite3.Error:
        log.warning("photo_dims_load: sqlite3.Error ignored", exc_info=True)
    PHOTO_DIMS_LOADED.append(True)


def photo_dims_save(new, gone):
    """Write newly measured sizes, and forget photos that are no longer there."""
    if not new and not gone:
        return
    try:
        with closing(db()) as con, con:
            con.executemany("INSERT OR REPLACE INTO photo_dims (key, mtime, w, h) VALUES (?,?,?,?)",
                            [(k,) + PHOTO_DIMS[k] for k in new])
            con.executemany("DELETE FROM photo_dims WHERE key = ?", [(k,) for k in gone])
    except sqlite3.Error:
        log.warning("photo_dims_save: sqlite3.Error ignored", exc_info=True)


def photo_size(p, mtime):
    """(width, height) of an image file, read from the file itself (slow: opens the image)."""
    w = h = 0
    if PILImage is not None:
        try:
            with PILImage.open(p) as im:
                w, h = im.size
                try:                                   # phone photos: respect the rotation flag
                    if im.getexif().get(274, 1) in (5, 6, 7, 8):
                        w, h = h, w
                except Exception:
                    log.warning("photo_size: Exception ignored", exc_info=True)
        except Exception:
            log.warning("photo_size: Exception ignored", exc_info=True)
    if (not w or not h) and cv2 is not None and np is not None:
        try:
            img = cv2.imdecode(np.fromfile(str(p), dtype=np.uint8), cv2.IMREAD_REDUCED_COLOR_8)
            if img is not None:
                h, w = img.shape[:2]
                w, h = w * 8, h * 8
        except Exception:
            log.warning("photo_size: Exception ignored", exc_info=True)
    return (w or 4, h or 3)


def scan_photos(public=False):
    """Private: every image in the private folder that is not a video poster (media/private/Photos is the natural home).
    Public: everything inside media/Photos, no password needed."""
    root = CFG["photo_dir"] if public else CFG["private_dir"]
    if not root.is_dir():
        return []
    photo_dims_load()
    scope = "public:" if public else "private:"
    found = list(walk_entries(root, PHOTO_EXTS if public else PHOTO_EXTS | VIDEO_EXTS))     # one walk of the folder
    video_stems = set() if public else {(str(p.parent).lower(), p.stem.lower())
                                        for p, _ in found if p.suffix.lower() in VIDEO_EXTS}
    out, new, seen = [], [], set()
    for p, entry in found:
        if p.suffix.lower() not in PHOTO_EXTS:
            continue
        parts = p.relative_to(root).parts
        stem = p.stem.lower()
        if not public and not (len(parts) > 1 and parts[0].lower() == PHOTO_FOLDER.lower()):
            base = re.sub(r"(-poster|\.poster|_poster)$", "", stem)
            if (str(p.parent).lower(), base) in video_stems or base in PHOTO_SKIP:
                continue                                 # a video's poster or series art, not a photo
        try:
            mtime = entry.stat().st_mtime
        except OSError:
            log.debug("scan_photos: OSError ignored", exc_info=True)
            continue
        rel = "/".join(parts)
        key = scope + rel
        seen.add(key)
        known = PHOTO_DIMS.get(key)
        if known and known[0] == mtime:
            w, h = known[1], known[2]
        else:
            w, h = photo_size(p, mtime)
            PHOTO_DIMS[key] = (mtime, w, h)
            new.append(key)
        pid = item_id(("pphoto/" if public else "photo/") + rel)
        inner = parts[1:] if (not public and parts[0].lower() == PHOTO_FOLDER.lower()) else parts
        out.append({"id": pid, "path": p, "name": pretty(p.stem), "mtime": mtime, "w": w, "h": h, "rel": rel,
                    "folder": parts[-2] if len(parts) > 1 else "",
                    "album": inner[0] if len(inner) > 1 else ""})      # album = the first subfolder of the gallery
    gone = [k for k in PHOTO_DIMS if k.startswith(scope) and k not in seen]
    for k in gone:
        del PHOTO_DIMS[k]
    photo_dims_save(new, gone)
    out.sort(key=lambda x: -x["mtime"])
    return out


PHOTO_CACHE = {"t": 0.0, "map": {}}
PUB_PHOTO_CACHE = {"t": 0.0, "map": {}}


def photo_favs(scope):
    """The set of favourite photo paths (relative to the gallery root) for 'public' or 'private'."""
    with closing(db()) as con:
        return {r["rel"] for r in con.execute("SELECT rel FROM photo_favs WHERE scope=?", (scope,))}


def photo_json(items, scope):
    favs = photo_favs(scope)
    return [{"id": x["id"], "name": x["name"], "w": x["w"], "h": x["h"], "folder": x["folder"], "album": x["album"],
             "fav": x["rel"] in favs, "v": int(x["mtime"]), "ext": x["path"].suffix.lower()} for x in items]


def set_photo_fav(scope):
    """POST {id, on}: heart or un-heart one photo. The heart is stored by the photo's path, so it survives rescans."""
    pref = "fav_public" if scope == "public" else "fav_private"
    if not get_prefs()[pref]:
        return jsonify({"error": "Favorites are turned off for these photos in Settings."}), 409
    d = request.get_json(silent=True) or {}
    ph = find_photo(str(d.get("id") or ""), scope == "public")
    if not ph:
        abort(404)
    on = bool(d.get("on"))
    with closing(db()) as con, con:
        if on:
            con.execute("INSERT OR REPLACE INTO photo_favs (scope, rel, at) VALUES (?,?,?)", (scope, ph["rel"], time.time()))
        else:
            con.execute("DELETE FROM photo_favs WHERE scope=? AND rel=?", (scope, ph["rel"]))
    return jsonify({"ok": True, "id": ph["id"], "fav": on})


PHOTO_RESCAN_GAP = 3         # seconds: an unknown or vanished photo re-scans the folder at most this often


def find_photo(pid, public=False):
    """Look a photo up by id, from the list the last scan made (the grid asks for hundreds at once).
    The folder is scanned again only when the list was invalidated (a move / rename / edit here), or when the id is
    unknown or its file has gone, and then at most every few seconds, so a page asking for many stale ids cannot
    make the app walk the whole folder for each one."""
    cache = PUB_PHOTO_CACHE if public else PHOTO_CACHE
    with PHOTO_LOCK:
        ph = cache["map"].get(pid)
        stale = cache["t"] == 0 or ph is None or not ph["path"].is_file()
        if stale and (cache["t"] == 0 or time.time() - cache["t"] > PHOTO_RESCAN_GAP):
            cache["map"] = {x["id"]: x for x in scan_photos(public)}
            cache["t"] = time.time()
            ph = cache["map"].get(pid)
        return ph if ph is not None and ph["path"].is_file() else None


def photo_thumb(ph):
    """A small JPEG for the grid (cached). Returns the path, or None to fall back to the original file."""
    if PILImage is None:
        return None
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    out = THUMB_DIR / f"{ph['id']}_{int(ph['mtime'])}.jpg"
    if out.is_file():
        return out
    try:
        with PILImage.open(ph["path"]) as im:
            im = ImageOps.exif_transpose(im)
            if im.width > THUMB_W:
                im = im.resize((THUMB_W, max(1, round(im.height * THUMB_W / im.width))), PILImage.LANCZOS)
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.save(out, "JPEG", quality=84, optimize=True)
        return out
    except Exception:
        log.warning("photo_thumb: Exception ignored", exc_info=True)
        return None


@app.get("/api/photos")
def api_photos():
    if not valid_token(token_from_request()):
        abort(403)
    with PHOTO_LOCK:
        items = scan_photos()
        PHOTO_CACHE["map"] = {x["id"]: x for x in items}
        PHOTO_CACHE["t"] = time.time()
    return jsonify({"photos": photo_json(items, "private"), "folder": str(CFG["private_dir"] / PHOTO_FOLDER), "albums": photo_album_dirs(False)})


@app.get("/photo/<pid>/thumb")
def photo_thumb_route(pid):
    if not valid_token(token_from_request()):
        abort(403)
    ph = find_photo(pid)
    if not ph:
        abort(404)
    t = photo_thumb(ph)
    return send_file(t or ph["path"], max_age=86400)


@app.get("/photo/<pid>")
def photo_full(pid):
    if not valid_token(token_from_request()):
        abort(403)
    ph = find_photo(pid)
    if not ph:
        abort(404)
    return send_file(ph["path"], max_age=86400)


@app.get("/api/pphotos")
def api_public_photos():
    photos_gate()
    with PHOTO_LOCK:
        items = scan_photos(True)
        PUB_PHOTO_CACHE["map"] = {x["id"]: x for x in items}
        PUB_PHOTO_CACHE["t"] = time.time()
    return jsonify({"photos": photo_json(items, "public"), "folder": str(CFG["photo_dir"]), "albums": photo_album_dirs(True)})


@app.post("/api/photos/fav")
def api_photo_fav():
    if not valid_token(token_from_request()):
        abort(403)
    return set_photo_fav("private")


@app.post("/api/pphotos/fav")
def api_public_photo_fav():
    photos_gate()
    return set_photo_fav("public")


@app.get("/pphoto/<pid>/thumb")
def public_photo_thumb_route(pid):
    photos_gate()
    ph = find_photo(pid, True)
    if not ph:
        abort(404)
    t = photo_thumb(ph)
    return send_file(t or ph["path"], max_age=86400)


@app.get("/pphoto/<pid>")
def public_photo_full(pid):
    photos_gate()
    ph = find_photo(pid, True)
    if not ph:
        abort(404)
    return send_file(ph["path"], max_age=86400)


@app.post("/api/pphotos/open-folder")
def api_public_photos_open_folder():
    photos_gate()
    path = CFG["photo_dir"]
    path.mkdir(parents=True, exist_ok=True)
    try:
        if os.name == "nt":
            os.startfile(str(path))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception as e:
        return jsonify({"error": "Could not open the folder: %s" % e}), 500
    return jsonify({"ok": True})


@app.post("/api/quit")
def api_quit():
    """Browser mode only (the desktop window uses Api.quit_app). The custom header keeps other websites from calling it."""
    if request.headers.get("X-LMP") != "1":
        abort(403)
    threading.Thread(target=lambda: (time.sleep(0.4), os._exit(0)), daemon=True).start()
    return jsonify({"ok": True})


@app.post("/api/photos/open-folder")
def api_photos_open_folder():
    if not valid_token(token_from_request()):
        abort(403)
    path = CFG["private_dir"] / PHOTO_FOLDER
    path.mkdir(parents=True, exist_ok=True)
    try:
        if os.name == "nt":
            os.startfile(str(path))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception as e:
        return jsonify({"error": "Could not open the folder: %s" % e}), 500
    return jsonify({"ok": True})


# ----------------------------------------------------------------------------- photo albums (new / move / rename / ungroup) + saving edits
_ALBUM_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_WIN_RESERVED = {"con", "prn", "aux", "nul"} | {"com%d" % i for i in range(1, 10)} | {"lpt%d" % i for i in range(1, 10)}
EDIT_FORMATS = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}


def clean_photo_album_name(raw):
    name = re.sub(r"\s+", " ", str(raw or "")).strip().strip(".").strip()
    if not name:
        raise ValueError("Give the album a name.")
    if len(name) > 80:
        raise ValueError("That name is too long (80 characters at most).")
    if _ALBUM_BAD.search(name):
        raise ValueError('Album names cannot contain  \\ / : * ? " < > |')
    if name.lower() in _WIN_RESERVED or name.lower() in ("all", "__fav", "favorites"):
        raise ValueError("Pick a different name, that one is reserved.")
    return name


def photo_ctx(public):
    """(folder the scan starts from, the gallery's own folder, favourites scope)"""
    if public:
        return CFG["photo_dir"], CFG["photo_dir"], "public"
    return CFG["private_dir"], CFG["private_dir"] / PHOTO_FOLDER, "private"


def photo_auth(public):
    if public:
        photos_gate()
    elif not valid_token(token_from_request()):
        abort(403)


def photo_invalidate():
    PHOTO_CACHE["t"] = 0.0
    PUB_PHOTO_CACHE["t"] = 0.0


def photo_inside(child, root):
    try:
        child.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False


def photo_unique_path(folder, name):
    p = folder / name
    if not p.exists():
        return p
    stem, suf, n = Path(name).stem, Path(name).suffix, 2
    while (folder / f"{stem} ({n}){suf}").exists():
        n += 1
    return folder / f"{stem} ({n}){suf}"


def photo_album_dirs(public):
    """Every album folder, empty ones too (a brand new album has no photos yet)."""
    _, gal, _ = photo_ctx(public)
    try:
        return sorted((d.name for d in gal.iterdir() if d.is_dir() and not d.name.startswith((".", "$", "_"))), key=natkey)
    except OSError:
        return []


def move_photos(public, ids, album):
    scan_root, gal, scope = photo_ctx(public)
    dest = (gal / album) if album else gal
    if not photo_inside(dest, gal):
        raise ValueError("Bad album.")
    dest.mkdir(parents=True, exist_ok=True)
    moved = 0
    for pid in ids[:2000]:
        ph = find_photo(str(pid), public)
        if not ph:
            continue
        src = ph["path"]
        if not photo_inside(src, gal) or src.parent.resolve() == dest.resolve():
            continue
        target = photo_unique_path(dest, src.name)
        shutil.move(str(src), str(target))
        with closing(db()) as con, con:
            con.execute("UPDATE OR REPLACE photo_favs SET rel=? WHERE scope=? AND rel=?",
                        (target.relative_to(scan_root).as_posix(), scope, ph["rel"]))
        moved += 1
    photo_invalidate()
    return moved


def photo_album_create(public):
    photo_auth(public)
    d = request.get_json(silent=True) or {}
    try:
        name = clean_photo_album_name(d.get("name"))
        _, gal, _ = photo_ctx(public)
        folder = gal / name
        existing = next((x for x in photo_album_dirs(public) if x.lower() == name.lower()), None)
        if existing:
            if not d.get("ids"):
                return jsonify({"error": "You already have an album called \"%s\"." % existing}), 409
            name = existing                                   # adding the selection to an album you already have
        else:
            folder.mkdir(parents=True, exist_ok=True)
        moved = move_photos(public, list(d.get("ids") or []), name) if d.get("ids") else 0
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except OSError as e:
        return jsonify({"error": "Could not make the album: %s" % e}), 500
    return jsonify({"ok": True, "name": name, "moved": moved})


def photo_album_move(public):
    photo_auth(public)
    d = request.get_json(silent=True) or {}
    album = str(d.get("album") or "").strip()
    try:
        if album:
            album = next((x for x in photo_album_dirs(public) if x.lower() == album.lower()), None) or clean_photo_album_name(album)
        moved = move_photos(public, list(d.get("ids") or []), album)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except OSError as e:
        return jsonify({"error": "Could not move the photos: %s" % e}), 500
    return jsonify({"ok": True, "moved": moved, "album": album})


def photo_album_rename(public):
    photo_auth(public)
    d = request.get_json(silent=True) or {}
    scan_root, gal, scope = photo_ctx(public)
    old = str(d.get("name") or "").strip()
    try:
        new = clean_photo_album_name(d.get("new"))
        src = gal / old
        if not old or _ALBUM_BAD.search(old) or not src.is_dir() or not photo_inside(src, gal):
            return jsonify({"error": "That album was not found."}), 404
        dst = gal / new
        same_but_case = new.lower() == old.lower()
        if dst.exists() and not same_but_case:
            return jsonify({"error": "You already have an album called \"%s\"." % new}), 409
        if same_but_case:
            tmp = gal / (old + ".renaming")
            src.rename(tmp)
            tmp.rename(dst)
        else:
            src.rename(dst)
        op, np_ = src.relative_to(scan_root).as_posix() + "/", dst.relative_to(scan_root).as_posix() + "/"
        with closing(db()) as con, con:
            con.execute("UPDATE OR REPLACE photo_favs SET rel = ? || substr(rel, ?) WHERE scope=? AND substr(rel, 1, ?) = ?",
                        (np_, len(op) + 1, scope, len(op), op))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except OSError as e:
        return jsonify({"error": "Could not rename the album: %s" % e}), 500
    photo_invalidate()
    return jsonify({"ok": True, "name": new})


def photo_album_ungroup(public):
    """Take the photos out of the album (back to the main gallery) and remove the folder. No photo is ever deleted."""
    photo_auth(public)
    d = request.get_json(silent=True) or {}
    _, gal, _ = photo_ctx(public)
    name = str(d.get("name") or "").strip()
    src = gal / name
    if not name or _ALBUM_BAD.search(name) or not src.is_dir() or not photo_inside(src, gal):
        return jsonify({"error": "That album was not found."}), 404
    ids = [x["id"] for x in scan_photos(public) if x["album"] == name]
    try:
        with PHOTO_LOCK:
            items = scan_photos(public)
            (PUB_PHOTO_CACHE if public else PHOTO_CACHE)["map"] = {x["id"]: x for x in items}
            (PUB_PHOTO_CACHE if public else PHOTO_CACHE)["t"] = time.time()
        moved = move_photos(public, ids, "")
        try:
            src.rmdir()
            left = 0
        except OSError:
            left = 1                                           # other files are still in there: leave the folder alone
    except (ValueError, OSError) as e:
        return jsonify({"error": "Could not ungroup the album: %s" % e}), 500
    photo_invalidate()
    return jsonify({"ok": True, "moved": moved, "kept_folder": bool(left)})


def photo_save_edit(public):
    """multipart: id, mode (copy | replace), file (the edited picture, JPEG / PNG / WEBP). A copy never touches the original;
    'replace' first keeps the original in data/photo_originals."""
    photo_auth(public)
    import io
    scan_root, gal, scope = photo_ctx(public)
    ph = find_photo(str(request.form.get("id") or ""), public)
    up = request.files.get("file")
    if not ph or not up:
        return jsonify({"error": "Photo not found."}), 404
    if PILImage is None:
        return jsonify({"error": "Saving edits needs the Pillow package (pip install pillow)."}), 500
    data = up.read(80 * 1024 * 1024 + 1)
    if len(data) > 80 * 1024 * 1024:
        return jsonify({"error": "That picture is too large to save (80 MB limit)."}), 413
    try:
        with PILImage.open(io.BytesIO(data)) as im:
            fmt = (im.format or "").upper()
            im.verify()
    except Exception:
        return jsonify({"error": "The edited picture could not be read."}), 400
    ext = EDIT_FORMATS.get(fmt)
    if not ext:
        return jsonify({"error": "Pick JPG, PNG or WEBP."}), 400
    src = ph["path"]
    old_ext = src.suffix.lower().replace(".jpeg", ".jpg")
    mode = "replace" if request.form.get("mode") == "replace" and old_ext == ext and photo_inside(src, gal) else "copy"
    try:
        if mode == "replace":
            keep = DATA_DIR / "photo_originals"
            keep.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, keep / f"{src.stem}_{int(ph['mtime'])}{src.suffix}")
            tmp = src.with_name(src.name + ".saving")
            tmp.write_bytes(data)
            os.replace(tmp, src)
            target = src
        else:
            base = re.sub(r"-edited( \(\d+\))?$", "", src.stem)
            target = photo_unique_path(src.parent, f"{base}-edited{ext}")
            target.write_bytes(data)
    except OSError as e:
        return jsonify({"error": "Could not save the picture: %s" % e}), 500
    photo_invalidate()
    rel = target.relative_to(scan_root).as_posix()
    return jsonify({"ok": True, "mode": mode, "name": target.name,
                    "id": item_id(("pphoto/" if public else "photo/") + rel)})


@app.post("/api/photos/albums/create")
def api_photo_album_create():
    return photo_album_create(False)


@app.post("/api/pphotos/albums/create")
def api_pphoto_album_create():
    return photo_album_create(True)


@app.post("/api/photos/albums/move")
def api_photo_album_move():
    return photo_album_move(False)


@app.post("/api/pphotos/albums/move")
def api_pphoto_album_move():
    return photo_album_move(True)


@app.post("/api/photos/albums/rename")
def api_photo_album_rename():
    return photo_album_rename(False)


@app.post("/api/pphotos/albums/rename")
def api_pphoto_album_rename():
    return photo_album_rename(True)


@app.post("/api/photos/albums/ungroup")
def api_photo_album_ungroup():
    return photo_album_ungroup(False)


@app.post("/api/pphotos/albums/ungroup")
def api_pphoto_album_ungroup():
    return photo_album_ungroup(True)


@app.post("/api/photos/edit")
def api_photo_edit():
    return photo_save_edit(False)


@app.post("/api/pphotos/edit")
def api_pphoto_edit():
    return photo_save_edit(True)



@app.get("/poster/<vid>")
def poster(vid):
    v = get_video_checked(vid)
    side = find_sidecar_poster(v)
    if side:
        return send_file(side, max_age=86400)
    if ensure_poster(vid, v["path"]):
        return send_file(POSTER_DIR / f"{vid}.jpg", mimetype="image/jpeg", max_age=86400)
    return Response(PLACEHOLDER_SVG, mimetype="image/svg+xml")


CUSTOM_TILE_MAX = 15 * 1024 * 1024
CUSTOM_TILE_KINDS = {"video": "v", "series": "s", "collection": "c"}


def custom_tile_prefix(kind, key):
    """File-name stem of a custom thumbnail. Collections are known by name, so the name is hashed."""
    p = CUSTOM_TILE_KINDS.get(kind)
    key = str(key or "").strip()
    if not p or not key:
        return None
    if kind == "collection":
        key = hashlib.sha1(clean_coll_name(key).lower().encode("utf-8")).hexdigest()[:20]
    elif not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", key):
        return None
    return "%s_%s" % (p, key)


def custom_tile_files(kind, key):
    pre = custom_tile_prefix(kind, key)
    return list(CUSTOM_TILE_DIR.glob(pre + ".*")) if pre else []


def custom_tile(kind, key):
    """The picture you chose for a movie / series / collection, or None (then the automatic thumbnail is used)."""
    f = custom_tile_files(kind, key)
    return f[0] if f else None


def clear_custom_tile(kind, key):
    for f in custom_tile_files(kind, key):
        try:
            f.unlink()
        except OSError:
            log.warning("clear_custom_tile: OSError ignored", exc_info=True)


def save_custom_tile(kind, key, data):
    """Stores an uploaded picture as a clean square JPEG (centre crop). Returns an error text or None."""
    pre = custom_tile_prefix(kind, key)
    if not pre:
        return "Unknown item."
    if not data or len(data) > CUSTOM_TILE_MAX:
        return "Pick an image smaller than 15 MB."
    CUSTOM_TILE_DIR.mkdir(parents=True, exist_ok=True)
    if cv2 is None:
        ext = ".png" if data[:8] == b"\x89PNG\r\n\x1a\n" else ".webp" if data[:4] == b"RIFF" else ".jpg"
        out = CUSTOM_TILE_DIR / (pre + ext)
        clear_custom_tile(kind, key)
        out.write_bytes(data)
        return None
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None or not img.size:
        return "That file is not a picture I can read (use JPG, PNG or WEBP)."
    h, w = img.shape[:2]
    side = min(h, w)
    y0, x0 = (h - side) // 2, (w - side) // 2
    sq = img[y0:y0 + side, x0:x0 + side]
    px = min(side, 720)
    sq = cv2.resize(sq, (px, px), interpolation=cv2.INTER_AREA if side > px else cv2.INTER_CUBIC)
    tmp = CUSTOM_TILE_DIR / ("_tmp_%d.jpg" % threading.get_ident())
    if not cv2.imwrite(str(tmp), sq, [cv2.IMWRITE_JPEG_QUALITY, 92]):
        return "Could not save the picture."
    clear_custom_tile(kind, key)
    os.replace(tmp, CUSTOM_TILE_DIR / (pre + ".jpg"))
    return None


@app.get("/tile/<vid>")
def tile(vid):
    """Square thumbnail for the Cinema tiles: your own picture next to the video if there is one,
    otherwise a clean square cut from the video itself (black bars trimmed, no blur)."""
    v = get_video_checked(vid)
    mine = custom_tile("video", vid)
    if mine:
        return send_file(mine, max_age=0)
    side = find_sidecar_poster(v)
    if side:
        return send_file(side, max_age=86400)
    if ensure_tile(vid, v["path"]):
        return send_file(TILE_DIR / f"{vid}.jpg", mimetype="image/jpeg", max_age=86400)
    return Response(PLACEHOLDER_SVG, mimetype="image/svg+xml")


@app.get("/seriestile/<sid>")
def series_tile(sid):
    s = get_series_checked(sid)
    mine = custom_tile("series", sid)
    if mine:
        return send_file(mine, max_age=0)
    art = find_series_art(s)
    if art:
        return send_file(art, max_age=3600)
    with LIB_LOCK:
        first = LIB["videos"].get(s["episodes"][0]) if s["episodes"] else None
    if first:
        side = find_sidecar_poster(first)
        if side:
            return send_file(side, max_age=3600)
        if ensure_tile(first["id"], first["path"]):
            return send_file(TILE_DIR / f"{first['id']}.jpg", mimetype="image/jpeg", max_age=3600)
    return Response(PLACEHOLDER_SVG, mimetype="image/svg+xml")


@app.get("/colltile/<path:name>")
def collection_tile(name):
    mine = custom_tile("collection", name)
    if not mine:
        abort(404)
    return send_file(mine, max_age=0)


@app.post("/api/tile/custom")
def api_tile_custom():
    """Which movies / series / collections have a picture you chose. Body: {names: [collection names]}.
    Values are when the picture was set (the page uses it to refresh the tile)."""
    d = request.get_json(silent=True) or {}
    out = {"video": {}, "series": {}, "collection": {}}
    try:
        files = [f for f in CUSTOM_TILE_DIR.glob("*.*") if not f.name.startswith("_tmp_")]
    except OSError:
        files = []
    for f in files:
        kind = {"v": "video", "s": "series"}.get(f.name[:1])
        if kind:
            out[kind][f.stem[2:]] = int(f.stat().st_mtime)
    for n in [clean_coll_name(x) for x in (d.get("names") or [])[:1000]]:
        f = custom_tile("collection", n)
        if f:
            out["collection"][n] = int(f.stat().st_mtime)
    return jsonify(out)


@app.post("/api/tile/set")
def api_tile_set():
    """Form fields: kind (video | series | collection), key (id, or the collection's name), file (the picture)."""
    kind, key = request.form.get("kind", ""), request.form.get("key", "")
    if kind == "video":
        if get_video_checked(key)["private"]:
            return jsonify({"error": "Custom thumbnails are for the public library."}), 400
    elif kind == "series":
        if get_series_checked(key)["private"]:
            return jsonify({"error": "Custom thumbnails are for the public library."}), 400
    elif kind == "collection":
        key = clean_coll_name(key)
    else:
        return jsonify({"error": "Unknown item."}), 400
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "Pick an image first."}), 400
    err = save_custom_tile(kind, key, f.read(CUSTOM_TILE_MAX + 1))
    if err:
        return jsonify({"error": err}), 400
    mine = custom_tile(kind, key)
    return jsonify({"ok": True, "stamp": int(mine.stat().st_mtime) if mine else int(time.time())})


@app.get("/api/cinema/favs")
def api_cinema_favs():
    """Every hearted movie, series and collection."""
    out = {"video": [], "series": [], "collection": []}
    with closing(db()) as con:
        for r in con.execute("SELECT kind, key FROM cinema_favs ORDER BY at DESC"):
            if r["kind"] in out:
                out[r["kind"]].append(r["key"])
    return jsonify(out)


@app.post("/api/cinema/fav")
def api_cinema_fav():
    """Heart or un-heart a movie, series or collection: {kind, key, on}."""
    d = request.get_json(silent=True) or {}
    kind, key, on = d.get("kind", ""), str(d.get("key", "")), bool(d.get("on"))
    if kind == "collection":
        key = clean_coll_name(key)
    elif kind not in ("video", "series"):
        return jsonify({"error": "Unknown item."}), 400
    if not key:
        return jsonify({"error": "Unknown item."}), 400
    with closing(db()) as con:
        if on:
            con.execute("INSERT OR REPLACE INTO cinema_favs (kind, key, at) VALUES (?, ?, ?)", (kind, key, time.time()))
        else:
            con.execute("DELETE FROM cinema_favs WHERE kind = ? AND key = ?", (kind, key))
        con.commit()
    return jsonify({"ok": True})


@app.post("/api/tile/reset")
def api_tile_reset():
    """Back to the automatic thumbnail."""
    d = request.get_json(silent=True) or {}
    kind, key = d.get("kind", ""), d.get("key", "")
    if kind == "collection":
        key = clean_coll_name(key)
    elif kind not in ("video", "series"):
        return jsonify({"error": "Unknown item."}), 400
    clear_custom_tile(kind, key)
    return jsonify({"ok": True})


@app.get("/backdrop/<vid>")
def backdrop(vid):
    v = get_video_checked(vid)
    out = BACKDROP_DIR / f"{vid}.jpg"
    if ensure_backdrop(vid, v["path"]):
        return send_file(out, mimetype="image/jpeg", max_age=86400)
    abort(404)


STREAM_CHUNK = 1024 * 1024        # read 1 MB at a time (Flask's send_file reads 8 KB, which makes a big file on an HDD crawl)


def ranged_file_response(path, mimetype=None):
    """Serve a big media file with HTTP Range support (seeking), in large sequential reads.
    Only the bytes the player asks for are read, and reading stops the moment the player seeks away."""
    path = Path(path)
    try:
        size = path.stat().st_size
    except OSError:
        abort(404)
    mime = mimetype or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    start, end, status = 0, size - 1, 200
    m = re.match(r"^bytes=(\d*)-(\d*)$", request.headers.get("Range", "").strip())
    if m and (m.group(1) or m.group(2)):
        if m.group(1):
            start = int(m.group(1))
            end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
        else:                                          # "bytes=-500" means the last 500 bytes
            start = max(0, size - int(m.group(2)))
        if start >= size or start > end:
            return Response(status=416, headers={"Content-Range": f"bytes */{size}"})
        status = 206
    length = max(0, end - start + 1)

    def generate():
        with open(path, "rb", buffering=0) as f:
            f.seek(start)
            left = length
            while left > 0:
                data = f.read(min(STREAM_CHUNK, left))
                if not data:
                    break
                left -= len(data)
                yield data

    resp = Response(generate(), status=status, mimetype=mime, direct_passthrough=True)
    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Content-Length"] = str(length)
    resp.headers["Cache-Control"] = "no-cache"
    if status == 206:
        resp.headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return resp


@app.get("/media/video/<vid>")
def stream_video(vid):
    v = get_video_checked(vid)
    return ranged_file_response(v["path"])                 # the original file, as it is (Range requests for the web fallback player)


@app.get("/media/music/<tid>")
def stream_music(tid):
    with LIB_LOCK:
        t = LIB["tracks"].get(tid)
    if not t:
        abort(404)
    return send_file(t["path"], conditional=True)


@app.get("/cover/<tid>")
def cover(tid):
    with LIB_LOCK:
        t = LIB["tracks"].get(tid)
    if not t:
        abort(404)
    if tid not in COVER_CACHE:
        if len(COVER_CACHE) > 300:
            COVER_CACHE.clear()
        COVER_CACHE[tid] = extract_cover(t["path"])
    found = COVER_CACHE[tid]
    if not found:                                     # no embedded art: a neutral sleeve instead of a broken image
        return Response(COVER_PLACEHOLDER_SVG, mimetype="image/svg+xml", headers={"Cache-Control": "max-age=3600"})
    return Response(found[0], mimetype=found[1], headers={"Cache-Control": "max-age=86400"})


@app.post("/api/videos/<vid>/view")
def api_view(vid):
    get_video_checked(vid)
    with closing(db()) as con, con:
        con.execute("UPDATE videos SET view_count = view_count + 1, last_viewed = ? WHERE id = ?", (time.time(), vid))
    return jsonify(video_stats(vid))


@app.post("/api/videos/<vid>/rating")
def api_rating(vid):
    get_video_checked(vid)
    try:
        stars = int((request.get_json(silent=True) or {}).get("stars", 0))
    except (TypeError, ValueError):
        abort(400)
    if not 0 <= stars <= 5:
        abort(400)
    with closing(db()) as con, con:
        if stars == 0:                                       # 0 clears your rating
            con.execute("DELETE FROM ratings WHERE video_id = ? AND profile = ?", (vid, PROFILE))
        else:
            con.execute("""INSERT INTO ratings (video_id, profile, stars, updated_at) VALUES (?,?,?,?)
                           ON CONFLICT(video_id, profile) DO UPDATE SET stars = excluded.stars,
                           updated_at = excluded.updated_at""", (vid, PROFILE, stars, time.time()))
    return jsonify(video_stats(vid))


def clean_name(v):
    return re.sub(r"\s+", " ", str(v or "")).strip()[:60]


def playlist_info(con, pid):
    return con.execute("""SELECT p.id, p.name, (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) AS count
                          FROM playlists p WHERE p.id = ?""", (pid,)).fetchone()


@app.post("/api/playlist")
def api_playlist():
    """Mix generator / browser: filters by language, artist, genre and search text."""
    d = request.get_json(silent=True) or {}
    mode = "all" if d.get("mode") == "all" else "mix"
    try:
        limit = max(1, min(500, int(d.get("limit", 20))))
    except (TypeError, ValueError):
        limit = 20
    pool = filter_music(d)
    if mode == "all" and d.get("album"):                       # an album plays in file order (01 - ..., 02 - ...)
        chosen = sorted(pool, key=album_order)
    elif mode == "all":
        chosen = sorted(pool, key=lambda i: (i["primary"].lower(), i["album"].lower(), i["t"]["title"].lower()))[:2000]
    else:
        chosen = random.sample(pool, min(limit, len(pool)))
    with LIB_LOCK:
        size = len(LIB["tracks"])
    return jsonify({"total_matches": len(pool), "library_size": size, "scanning": STATUS["music_scanning"],
                    "mode": mode, "tracks": [track_json(i) for i in chosen]})


@app.get("/api/music/filters")
def api_music_filters():
    with MUSIC_LOCK:
        out = {"artists": MUSIC["artists"], "languages": MUSIC["languages"], "genres": MUSIC["genres"],
               "total": len(MUSIC["items"]),
               "from_lyrics": MUSIC["from_lyrics"], "unknown": MUSIC["unknown"]}
    out.update(scanning=STATUS["music_scanning"], langdetect=detect_langs is not None, job=dict(LANG_JOB))
    return jsonify(out)


@app.get("/api/music/recent")
def api_music_recent():
    """Newest songs first (by when they first appeared in the library)."""
    try:
        limit = max(1, min(500, int(request.args.get("limit", 30))))
    except ValueError:
        limit = 30
    with MUSIC_LOCK:
        items = list(MUSIC["items"])
    items.sort(key=lambda i: -(i["t"].get("added_at") or i["t"].get("mtime") or 0))
    return jsonify({"tracks": [track_json(i) for i in items[:limit]]})


@app.get("/api/music/random")
def api_music_random():
    """A handful of random songs for the Home shelf (the shuffle button asks again for a fresh set)."""
    import random
    try:
        limit = max(1, min(60, int(request.args.get("limit", 10))))
    except ValueError:
        limit = 10
    with MUSIC_LOCK:
        items = list(MUSIC["items"])
    picks = random.sample(items, min(limit, len(items)))
    return jsonify({"tracks": [track_json(i) for i in picks]})


@app.post("/api/music/lang/start")
def api_lang_start():
    if LANG_JOB["running"]:
        return jsonify({"error": "Already running."}), 409
    if STATUS["music_scanning"]:
        return jsonify({"error": "The music library is still being indexed. Try again in a moment."}), 409
    online = bool((request.get_json(silent=True) or {}).get("online", True))
    LANG_JOB.update(running=True, done=0, total=0, message="Starting...", cancel=False)
    threading.Thread(target=run_language_detection, args=(online,), daemon=True).start()
    return jsonify({"ok": True})


@app.post("/api/music/lang/cancel")
def api_lang_cancel():
    LANG_JOB["cancel"] = True
    return jsonify({"ok": True})


@app.post("/api/music/lang/test")
def api_lang_test():
    text, err = lrclib("Daft Punk", "One More Time")
    return jsonify({"ok": bool(text), "message": "Lyrics lookup works." if text else
                    "Lyrics lookup failed: " + (err or "nothing found") + ". Check your internet connection."})


@app.post("/api/music/language")
def api_set_language():
    """Manually set (or clear, when empty) the language of songs. Manual settings always win."""
    d = request.get_json(silent=True) or {}
    ids = [str(i) for i in (d.get("ids") or [])][:5000]
    lang = clean_name(d.get("language"))[:40]
    lang = LANG_ALIASES.get(lang.lower()) or (lang[:1].upper() + lang[1:])
    with LIB_LOCK:
        rels = [LIB["tracks"][i]["rel"] for i in ids if i in LIB["tracks"]]
    with closing(db()) as con, con:
        if lang:
            con.executemany("""INSERT INTO lang_info (rel_path, lang_manual) VALUES (?, ?)
                               ON CONFLICT(rel_path) DO UPDATE SET lang_manual = excluded.lang_manual""",
                            [(r, lang) for r in rels])
        else:
            con.executemany("UPDATE lang_info SET lang_manual = NULL WHERE rel_path = ?", [(r,) for r in rels])
    rebuild_music()
    with MUSIC_LOCK:
        changed = [track_json(MUSIC["by_id"][i]) for i in ids if i in MUSIC["by_id"]]
    return jsonify({"updated": len(rels), "tracks": changed})


# ----------------------------------------------------------------------------- saved playlists
LIKED_NAME = "Liked Songs"


def is_liked_name(name):
    return str(name or "").strip().lower() == LIKED_NAME.lower()


def liked_pid(con, create=False):
    r = con.execute("SELECT id FROM playlists WHERE LOWER(name) = LOWER(?)", (LIKED_NAME,)).fetchone()
    if r:
        return r["id"]
    if not create:
        return None
    now = time.time()
    return con.execute("INSERT INTO playlists (name, created_at, updated_at) VALUES (?,?,?)", (LIKED_NAME, now, now)).lastrowid


@app.get("/api/playlists")
def api_playlists():
    with LIB_LOCK:
        have = set(LIB["tracks"])
    out = []
    with closing(db()) as con:
        rows = con.execute("""SELECT p.id, p.name, (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) AS count
                              FROM playlists p""").fetchall()
        for r in rows:
            rels = [x["rel_path"] for x in con.execute(
                "SELECT rel_path FROM playlist_tracks WHERE playlist_id = ? ORDER BY position LIMIT 12", (r["id"],))]
            covers = [i for i in (item_id(x) for x in rels) if i in have][:4]
            out.append({"id": r["id"], "name": r["name"], "count": r["count"], "covers": covers,
                        "liked": is_liked_name(r["name"])})
    out.sort(key=lambda p: (not p["liked"], p["name"].lower()))
    return jsonify(out)


@app.get("/api/likes")
def api_likes_get():
    with closing(db()) as con:
        pid = liked_pid(con)
        rels = [r["rel_path"] for r in con.execute(
            "SELECT rel_path FROM playlist_tracks WHERE playlist_id = ?", (pid,))] if pid else []
    return jsonify({"ids": [item_id(r) for r in rels], "playlist_id": pid})


@app.post("/api/likes")
def api_likes_toggle():
    d = request.get_json(silent=True) or {}
    tid = str(d.get("id", ""))
    with LIB_LOCK:
        t = LIB["tracks"].get(tid)
    if not t:
        abort(404)
    with closing(db()) as con, con:
        pid = liked_pid(con, True)
        have = con.execute("SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND rel_path = ?", (pid, t["rel"])).fetchone()
        want = d.get("liked")
        want = (not have) if want is None else bool(want)
        if want and not have:       # newest like goes to the top
            pos = con.execute("SELECT COALESCE(MIN(position), 1) - 1 FROM playlist_tracks WHERE playlist_id = ?", (pid,)).fetchone()[0]
            con.execute("INSERT INTO playlist_tracks (playlist_id, rel_path, position) VALUES (?,?,?)", (pid, t["rel"], pos))
        elif not want and have:
            con.execute("DELETE FROM playlist_tracks WHERE playlist_id = ? AND rel_path = ?", (pid, t["rel"]))
        con.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (time.time(), pid))
        count = con.execute("SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?", (pid,)).fetchone()[0]
    return jsonify({"liked": want, "count": count})


@app.post("/api/playlists")
def api_playlist_create():
    name = clean_name((request.get_json(silent=True) or {}).get("name"))
    if not name:
        return jsonify({"error": "Give the playlist a name."}), 400
    with closing(db()) as con, con:
        if con.execute("SELECT 1 FROM playlists WHERE LOWER(name) = LOWER(?)", (name,)).fetchone():
            return jsonify({"error": "You already have a playlist with that name."}), 409
        now = time.time()
        pid = con.execute("INSERT INTO playlists (name, created_at, updated_at) VALUES (?,?,?)", (name, now, now)).lastrowid
        info = playlist_info(con, pid)
    return jsonify(dict(info))


@app.post("/api/playlists/<int:pid>/rename")
def api_playlist_rename(pid):
    name = clean_name((request.get_json(silent=True) or {}).get("name"))
    if not name:
        return jsonify({"error": "Give the playlist a name."}), 400
    with closing(db()) as con, con:
        cur = playlist_info(con, pid)
        if not cur:
            abort(404)
        if is_liked_name(cur["name"]) or is_liked_name(name):
            return jsonify({"error": "Liked Songs can't be renamed."}), 400
        if con.execute("SELECT 1 FROM playlists WHERE LOWER(name) = LOWER(?) AND id != ?", (name, pid)).fetchone():
            return jsonify({"error": "You already have a playlist with that name."}), 409
        con.execute("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?", (name, time.time(), pid))
        info = playlist_info(con, pid)
    return jsonify(dict(info))


@app.post("/api/playlists/<int:pid>/delete")
def api_playlist_delete(pid):
    with closing(db()) as con, con:
        cur = playlist_info(con, pid)
        if cur and is_liked_name(cur["name"]):
            return jsonify({"error": "Liked Songs can't be deleted."}), 400
        con.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", (pid,))
        con.execute("DELETE FROM playlists WHERE id = ?", (pid,))
    return jsonify({"ok": True})


@app.get("/api/playlists/<int:pid>")
def api_playlist_get(pid):
    with closing(db()) as con:
        info = playlist_info(con, pid)
        if not info:
            abort(404)
        rels = [r["rel_path"] for r in con.execute(
            "SELECT rel_path FROM playlist_tracks WHERE playlist_id = ? ORDER BY position", (pid,))]
    with MUSIC_LOCK:
        by_id = MUSIC["by_id"]
        items = [by_id[i] for i in (item_id(r) for r in rels) if i in by_id]
    return jsonify({"id": pid, "name": info["name"], "missing": len(rels) - len(items),
                    "tracks": [track_json(i) for i in items]})


@app.post("/api/playlists/<int:pid>/add")
def api_playlist_add(pid):
    ids = [str(i) for i in ((request.get_json(silent=True) or {}).get("ids") or [])][:5000]
    with LIB_LOCK:
        rels = [LIB["tracks"][i]["rel"] for i in ids if i in LIB["tracks"]]
    with closing(db()) as con, con:
        if not playlist_info(con, pid):
            abort(404)
        have = {r["rel_path"] for r in con.execute("SELECT rel_path FROM playlist_tracks WHERE playlist_id = ?", (pid,))}
        pos = con.execute("SELECT COALESCE(MAX(position), 0) FROM playlist_tracks WHERE playlist_id = ?", (pid,)).fetchone()[0]
        new = []
        for r in rels:
            if r not in have:
                have.add(r)
                pos += 1
                new.append((pid, r, pos))
        con.executemany("INSERT INTO playlist_tracks (playlist_id, rel_path, position) VALUES (?,?,?)", new)
        con.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (time.time(), pid))
        info = playlist_info(con, pid)
    return jsonify({"added": len(new), "already_in": len(rels) - len(new), "name": info["name"], "count": info["count"]})


def playlist_add_rels(name, rels):
    """Finds (or creates) the playlist called `name` and appends the songs. Returns (id, name, how many were new)."""
    name = clean_name(name) or "New playlist"
    with closing(db()) as con, con:
        now = time.time()
        row = con.execute("SELECT id, name FROM playlists WHERE LOWER(name) = LOWER(?)", (name,)).fetchone()
        pid = row["id"] if row else con.execute("INSERT INTO playlists (name, created_at, updated_at) VALUES (?,?,?)", (name, now, now)).lastrowid
        name = row["name"] if row else name
        have = {r["rel_path"] for r in con.execute("SELECT rel_path FROM playlist_tracks WHERE playlist_id = ?", (pid,))}
        pos = con.execute("SELECT COALESCE(MAX(position), 0) FROM playlist_tracks WHERE playlist_id = ?", (pid,)).fetchone()[0]
        new = []
        for r in dict.fromkeys(rels):
            if r not in have:
                pos += 1
                new.append((pid, r, pos))
        con.executemany("INSERT INTO playlist_tracks (playlist_id, rel_path, position) VALUES (?,?,?)", new)
        con.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (now, pid))
    return pid, name, len(new)


@app.post("/api/playlists/<int:pid>/remove")
def api_playlist_remove(pid):
    tid = str((request.get_json(silent=True) or {}).get("id", ""))
    with LIB_LOCK:
        t = LIB["tracks"].get(tid)
    if t:
        with closing(db()) as con, con:
            con.execute("DELETE FROM playlist_tracks WHERE playlist_id = ? AND rel_path = ?", (pid, t["rel"]))
    return jsonify({"ok": True})


@app.post("/api/playlists/<int:pid>/reorder")
def api_playlist_reorder(pid):
    """Drag-and-drop ordering: body {"ids": [track ids in the new order]}. Tracks not listed keep their relative order at the end."""
    ids = [str(i) for i in ((request.get_json(silent=True) or {}).get("ids") or [])][:20000]
    with LIB_LOCK:
        rels = [LIB["tracks"][i]["rel"] for i in ids if i in LIB["tracks"]]
    with closing(db()) as con, con:
        if not playlist_info(con, pid):
            abort(404)
        rest = [r["rel_path"] for r in con.execute(
            "SELECT rel_path FROM playlist_tracks WHERE playlist_id = ? ORDER BY position", (pid,))]
        order = list(dict.fromkeys([r for r in rels if r in set(rest)] + rest))
        con.executemany("UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND rel_path = ?",
                        [(n + 1, pid, r) for n, r in enumerate(order)])
        con.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (time.time(), pid))
    return jsonify({"ok": True, "count": len(order)})


# ----------------------------------------------------------------------------- export (.m3u)
def build_m3u(ids):
    lines = ["#EXTM3U"]
    count = 0
    with LIB_LOCK:
        tracks = LIB["tracks"]
        picked = [tracks[i] for i in ids if i in tracks]
    with MUSIC_LOCK:
        by_id = MUSIC["by_id"]
        creds = {t["id"]: (by_id[t["id"]]["credited"] if t["id"] in by_id else t["artist"]) for t in picked}
    for t in picked:
        who, title = creds[t["id"]], t["title"]
        if who and title.lower().startswith(who.lower() + " - "):      # untagged file: title already has the artist
            who = ""
        label = re.sub(r"[\r\n]+", " ", " - ".join(x for x in (who, title) if x))
        lines.append("#EXTINF:%d,%s" % (int(t["duration"] or 0) or -1, label))
        lines.append(str(t["path"]))
        count += 1
    return "\n".join(lines) + "\n", count


def pick_save_path(filename, file_types=("Playlist (*.m3u)",)):
    """Native 'Save as' dialog in the desktop window. Returns a path, '' if cancelled, None if unavailable."""
    if WINDOW is None:
        return None
    try:
        import webview
        kind = getattr(getattr(webview, "FileDialog", None), "SAVE", None)
        if kind is None:
            kind = webview.SAVE_DIALOG
        res = WINDOW.create_file_dialog(kind, save_filename=filename, file_types=file_types)
    except Exception:
        log.warning("pick_save_path: Exception ignored", exc_info=True)
        return None
    if not res:
        return ""
    return str(res[0] if isinstance(res, (list, tuple)) else res)


@app.post("/api/music/export")
def api_music_export():
    d = request.get_json(silent=True) or {}
    ids = [str(i) for i in (d.get("ids") or [])][:20000]
    text, count = build_m3u(ids)
    if not count:
        return jsonify({"error": "There are no songs to export."}), 400
    base = re.sub(r'[<>:"/\\|?*]', "_", clean_name(d.get("name")) or "Music Mix").strip(" .") or "Music Mix"
    filename = base + ".m3u"
    path = pick_save_path(filename)
    if path == "":
        return jsonify({"mode": "cancelled"})
    if path is None and WINDOW is not None:               # dialog failed: save next to the app instead
        EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        path = str(EXPORT_DIR / filename)
    if path:
        if not Path(path).suffix:
            path += ".m3u"
        try:
            Path(path).write_text(text, encoding="utf-8")
        except OSError as e:
            return jsonify({"error": "Could not save the file: %s" % e}), 500
        return jsonify({"mode": "saved", "path": path, "count": count})
    return jsonify({"mode": "download", "filename": filename, "content": text, "count": count})   # --browser mode


# ----------------------------------------------------------------------------- backup / restore
# One zip with everything that cannot be rebuilt by rescanning: the database (favorites, hearts, watch progress, ratings,
# playlists, plays, collection overrides), settings.json (preferences + password hash), localstore.json (page settings),
# artist_rules.txt, your own tile pictures and the small generated subtitle files. Posters, thumbnails and other caches
# are left out on purpose: they are rebuilt on their own.
BACKUP_DIR = DATA_DIR / "backups"
BACKUP_MAX_BYTES = 600 * 1024 * 1024
BACKUP_KEEP_AUTO = 5                                   # safety copies made before a restore: keep the newest few


def build_backup_zip(dest):
    """Write the backup zip to `dest` (a Path). Returns the number of files inside."""
    import zipfile
    import tempfile
    names = []
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        if DB_PATH.exists():                           # sqlite's own backup call gives a consistent copy even while the app runs
            snap = Path(tmp) / "media_stats.db"
            with closing(sqlite3.connect(DB_PATH, timeout=15)) as src, closing(sqlite3.connect(snap)) as dst:
                src.backup(dst)
            z.write(snap, "media_stats.db")
            names.append("media_stats.db")
        for fp, arc in ((SETTINGS_PATH, "settings.json"), (LS_PATH, "localstore.json"), (RULES_PATH, "artist_rules.txt")):
            if fp.exists():
                z.write(fp, arc)
                names.append(arc)
        if CUSTOM_TILE_DIR.is_dir():
            for fp in sorted(CUSTOM_TILE_DIR.iterdir()):
                if fp.is_file():
                    z.write(fp, "custom_tiles/" + fp.name)
                    names.append("custom_tiles/" + fp.name)
        if ASUB_DIR.is_dir():
            for fp in sorted(ASUB_DIR.iterdir()):
                if fp.is_file() and fp.suffix.lower() in (".vtt", ".srt", ".json", ".txt") and fp.stat().st_size < 3_000_000:
                    z.write(fp, "autosubs/" + fp.name)
                    names.append("autosubs/" + fp.name)
        z.writestr("manifest.json", json.dumps({"app": "zeno", "format": 1, "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                                                "files": names}, indent=1))
    return len(names)


@app.post("/api/backup/export")
def api_backup_export():
    stamp = time.strftime("%Y-%m-%d_%H%M")
    filename = "ZENO-backup-%s.zip" % stamp
    path = pick_save_path(filename, file_types=("ZENO backup (*.zip)",))
    if path == "":
        return jsonify({"mode": "cancelled"})
    if not path:                                         # no dialog (browser mode or it failed): save inside the app folder
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        path = str(BACKUP_DIR / filename)
    elif not Path(path).suffix:
        path += ".zip"
    try:
        n = build_backup_zip(Path(path))
    except Exception as e:
        log.warning("backup export failed", exc_info=True)
        return jsonify({"error": "Could not make the backup: %s" % e}), 500
    return jsonify({"mode": "saved", "path": path, "count": n})


@app.post("/api/backup/import")
def api_backup_import():
    """Raw zip bytes in the body. The current data is backed up to data/backups first, then replaced by the zip's data."""
    import io
    import zipfile
    import tempfile
    data = request.get_data(cache=False)
    if not data or len(data) > BACKUP_MAX_BYTES:
        return jsonify({"error": "Choose a ZENO backup .zip (under 600 MB)."}), 400
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        manifest = json.loads(z.read("manifest.json").decode("utf-8"))
    except Exception:
        return jsonify({"error": "That file is not a ZENO backup."}), 400
    if manifest.get("app") != "zeno":
        return jsonify({"error": "That file is not a ZENO backup."}), 400
    members = set(z.namelist())
    with tempfile.TemporaryDirectory() as tmp:
        snap = None
        if "media_stats.db" in members:                   # check the database before anything is touched
            snap = Path(tmp) / "media_stats.db"
            snap.write_bytes(z.read("media_stats.db"))
            try:
                with closing(sqlite3.connect(snap)) as c:
                    ok = c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            except Exception:
                ok, tables = False, set()
            if not ok or not {"videos", "playlists"} <= tables:
                return jsonify({"error": "The database inside that backup is damaged. Nothing was changed."}), 400
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)     # safety copy of what is there now
        safe = BACKUP_DIR / ("auto-before-restore-%s.zip" % time.strftime("%Y%m%d-%H%M%S"))
        try:
            build_backup_zip(safe)
        except Exception as e:
            return jsonify({"error": "Could not make a safety copy first (%s). Nothing was changed." % e}), 500
        for old in sorted(BACKUP_DIR.glob("auto-before-restore-*.zip"))[:-BACKUP_KEEP_AUTO]:
            try:
                old.unlink()
            except OSError:
                pass
        restored = []
        if snap is not None:                              # copy into the live database (it stays open and consistent)
            with closing(sqlite3.connect(snap)) as src, closing(sqlite3.connect(DB_PATH, timeout=30)) as dst:
                src.backup(dst)
            restored.append("database")
        if "settings.json" in members:
            try:
                new = json.loads(z.read("settings.json").decode("utf-8"))
                if not isinstance(new, dict):
                    raise ValueError("not an object")
            except Exception:
                new = None
            if new is not None:
                with SETTINGS_LOCK:                       # folder paths belong to this PC: keep the ones in use here
                    cur = load_settings()
                    new_prefs = new.setdefault("prefs", {}) if isinstance(new.get("prefs", {}), dict) else {}
                    for key in FOLDER_KEYS.values():
                        new_prefs.pop(key, None)
                        if key in (cur.get("prefs") or {}):
                            new_prefs[key] = cur["prefs"][key]
                    new["prefs"] = new_prefs
                    if not new.get("password") and cur.get("password"):      # a backup from before you set a password must not remove it
                        new["password"] = cur["password"]
                        if cur.get("photos_lock"):
                            new["photos_lock"] = True
                    SETTINGS_PATH.write_text(json.dumps(new), encoding="utf-8")
                restored.append("settings")
        if "localstore.json" in members:
            try:
                ls = json.loads(z.read("localstore.json").decode("utf-8"))
                if isinstance(ls, dict):
                    with SETTINGS_LOCK:
                        LS_PATH.write_text(json.dumps(ls), encoding="utf-8")
                    restored.append("page settings")
            except Exception:
                log.warning("restore: page settings not restored", exc_info=True)
        if "artist_rules.txt" in members:
            RULES_PATH.write_bytes(z.read("artist_rules.txt"))
        for kind, folder in (("custom_tiles/", CUSTOM_TILE_DIR), ("autosubs/", ASUB_DIR)):
            for name in members:
                base = name[len(kind):]
                if name.startswith(kind) and base and "/" not in base and "\\" not in base and base not in (".", ".."):
                    folder.mkdir(parents=True, exist_ok=True)
                    (folder / base).write_bytes(z.read(name))
    try:
        apply_display_async(get_prefs())
    except Exception:
        log.warning("restore: display refresh skipped", exc_info=True)
    return jsonify({"ok": True, "restored": restored, "safety_copy": str(safe), "created": manifest.get("created", "")})


@app.get("/api/data/info")
def api_data_info():
    """Where your data lives (shown in Settings). `imported_from` is given once, on the first run after data was brought over."""
    global DATA_IMPORTED_FROM
    note, DATA_IMPORTED_FROM = DATA_IMPORTED_FROM, None
    return jsonify({"path": str(DATA_DIR), "where": DATA_WHERE, "imported_from": str(note) if note else ""})


@app.post("/api/data/open")
def api_data_open():
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if hasattr(os, "startfile"):
            os.startfile(str(DATA_DIR))
        else:
            return jsonify({"error": "Open this folder yourself: %s" % DATA_DIR}), 400
    except Exception as e:
        return jsonify({"error": "Could not open the folder: %s" % e}), 500
    return jsonify({"ok": True})


def weekly_auto_backup():
    """Quiet safety net: at start-up, if the newest weekly backup is older than 7 days, make a new one (keeps the last 4)."""
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        old = sorted(BACKUP_DIR.glob("auto-weekly-*.zip"))
        if old and time.time() - old[-1].stat().st_mtime < 7 * 86400:
            return
        if not DB_PATH.exists() or DB_PATH.stat().st_size < 20000:      # nothing worth saving yet
            return
        build_backup_zip(BACKUP_DIR / ("auto-weekly-%s.zip" % time.strftime("%Y%m%d")))
        for o in sorted(BACKUP_DIR.glob("auto-weekly-*.zip"))[:-4]:
            o.unlink()
    except Exception:
        log.warning("weekly backup skipped", exc_info=True)


def _tree_signature(roots, exts, side_exts=()):
    """Cheap fingerprint of media folders: which roots are reachable, the folder names, the names of the media files that
    have finished being written (so a rename counts as a change), and the names of poster / series-art images (the scan
    is what finds those, so adding one must trigger a rescan).
    Files still being written are left out, so a torrent in progress does not keep re-triggering rescans; the signature
    changes once when each file settles. Returns (signature, unsettled): unsettled is True while some file is still being
    written, so the watcher keeps checking often until it lands. (os.scandir gives file times without extra disk calls
    on Windows.)"""
    sig, now, unsettled = [], time.time(), False
    for root in roots:
        online = folder_online(root)
        sig.append((str(root), online))
        if not online:
            continue
        stack = [str(root)]
        while stack:
            d = stack.pop()
            names, imgs = [], []
            try:
                with os.scandir(d) as it:
                    for e in it:
                        if e.name.startswith("."):
                            continue
                        if e.is_dir(follow_symlinks=False):
                            stack.append(e.path)
                            continue
                        ext = Path(e.name).suffix.lower()
                        if ext in exts:
                            if now - e.stat().st_mtime >= SETTLE_SECS:
                                names.append(e.name)
                            else:
                                unsettled = True
                        elif ext in side_exts:
                            imgs.append(e.name.lower())
            except OSError:
                continue
            sig.append((d, hash(frozenset(names)), hash(frozenset(imgs))))
    return hash(tuple(sorted(sig, key=repr))), unsettled


def _folder_signature():
    """Fingerprint of the video and private folders (see _tree_signature)."""
    return _tree_signature((CFG["video_dir"], CFG["private_dir"]), VIDEO_EXTS, SIDE_IMAGE_EXTS)[0]


WATCH_FAST, WATCH_SLOW = 30, 300      # seconds between folder checks: while the page is open / while idle or playing
WATCH = {"seen": 0.0}                 # when the page last asked for the library version
WATCH_WAKE = threading.Event()        # set to make the watcher check right away (the page came back after a long idle)


def page_seen():
    """The library page is open and visible (it polls /api/videos/version every 8 s, but not while a video plays)."""
    now = time.time()
    if now - WATCH["seen"] > 2 * WATCH_FAST:
        WATCH_WAKE.set()
    WATCH["seen"] = now


def folder_watcher():
    """New genre folder, new video or song, or a rename done by hand? Re-index by itself, no Rescan press needed.
    Rescans only after the folders have been quiet for one full check, so one torrent finishing (or ten) causes a single
    rescan, not dozens. Checks every 30 s while the library page is open (or a file is still landing) and every 5 min
    while the window is hidden or a video is playing, so an idle app does not keep reading the media drive. Polling on
    purpose: change notifications hold the folders open, and Windows then refuses to safely remove a USB drive."""
    background_io(True)
    trees = {
        "videos": (lambda: _tree_signature((CFG["video_dir"], CFG["private_dir"]), VIDEO_EXTS, SIDE_IMAGE_EXTS),
                   lambda: SCAN_STATE["running"], schedule_scan),
        "music": (lambda: _tree_signature((CFG["music_dir"],), MUSIC_EXTS),
                  lambda: music_busy(), lambda: schedule_music_scan()),
    }
    state = {k: {"last": None, "dirty": False, "unsettled": False} for k in trees}
    while True:
        busy = any(s["dirty"] or s["unsettled"] for s in state.values())
        active = time.time() - WATCH["seen"] < 2 * WATCH_FAST
        WATCH_WAKE.wait(WATCH_FAST if (active or busy) else WATCH_SLOW)
        WATCH_WAKE.clear()
        for name, (signature, running, rescan) in trees.items():
            s = state[name]
            try:
                cur, s["unsettled"] = signature()
                if s["last"] is None:
                    pass
                elif cur != s["last"]:
                    s["dirty"] = True                         # still changing: wait for the next check
                elif s["dirty"] and not running():
                    s["dirty"] = False
                    rescan()
                s["last"] = cur
            except Exception:
                log.warning("folder_watcher (%s): ignored", name, exc_info=True)


@app.get("/api/videos/version")
def api_videos_version():
    page_seen()
    return jsonify({"v": SCAN_VER["v"], "scanning": bool(SCAN_STATE["running"]), "offline": offline_json()})


@app.get("/api/scan/status")
def api_scan_status():
    return jsonify({"scanning": bool(SCAN_STATE["running"]), "music": music_busy(), "offline": offline_json()})


@app.post("/api/rescan")
def api_rescan():
    """Videos are re-indexed before answering (quick: unchanged files are not re-read), so the page can reload them.
    Music is re-indexed in the background, since reading new songs' tags can take minutes; the page polls
    /api/scan/status ("music") to know when it is done."""
    n_videos = scan_videos()
    schedule_music_scan()
    threading.Thread(target=pregenerate_posters, daemon=True).start()
    with LIB_LOCK:
        n_tracks = len(LIB["tracks"])
    return jsonify({"videos": n_videos, "tracks": n_tracks, "music_scanning": True, "offline": offline_json()})



# ----------------------------------------------------------------------------- video organizing (move / series)
def _sidecars(path):
    """Subtitles / poster images that sit next to a video and share its name."""
    out = []
    try:
        for e in os.scandir(path.parent):
            n = e.name
            if e.is_file() and n != path.name and n.startswith(path.stem + ".") and Path(n).suffix.lower() in (SUB_EXTS | set(IMAGE_EXTS)):
                out.append(Path(e.path))
    except OSError:
        log.warning("_sidecars: OSError ignored", exc_info=True)
    return out


def rekey_videos(pairs):
    """Video ids are hashes of the path, so moving a file would lose its views, ratings, progress and title.
    This carries all of that over to the new id (and the cached poster / backdrop)."""
    with closing(db()) as con, con:
        for old, new in pairs:
            o, n = item_id(old), item_id(new)
            if o == n:
                continue
            con.execute("DELETE FROM videos WHERE id = ?", (n,))
            con.execute("DELETE FROM ratings WHERE video_id = ?", (n,))
            con.execute("UPDATE videos SET id = ?, rel_path = ?, missing = 0 WHERE id = ?", (n, new, o))
            con.execute("UPDATE ratings SET video_id = ? WHERE video_id = ?", (n, o))
    for old, new in pairs:                                   # a moved file keeps the thumbnail you gave it
        for src in CUSTOM_TILE_DIR.glob("v_%s.*" % item_id(old)):
            try:
                os.replace(src, CUSTOM_TILE_DIR / ("v_%s%s" % (item_id(new), src.suffix)))
            except OSError:
                log.warning("rekey_videos: OSError ignored", exc_info=True)
    for folder in (POSTER_DIR, BACKDROP_DIR, TILE_DIR):
        for old, new in pairs:
            try:
                src = folder / (item_id(old) + ".jpg")
                if src.is_file():
                    os.replace(src, folder / (item_id(new) + ".jpg"))
            except OSError:
                log.warning("rekey_videos: OSError ignored", exc_info=True)


@app.get("/api/videos/all")
def api_videos_all():
    """Every video with where it lives now - the list the in-app 'organize' picker shows."""
    private = request.args.get("private") == "1"
    genre_root(private)                                   # 403 without the private token
    with LIB_LOCK:
        vids = [v for v in LIB["videos"].values() if v["private"] == private]
    with closing(db()) as con:
        titles = {r["id"]: r["custom_title"] for r in con.execute("SELECT id, custom_title FROM videos WHERE custom_title IS NOT NULL")}
    vids.sort(key=lambda v: (natkey(v["genre"]), natkey(v["series"]), natkey(v["path"].name)))
    return jsonify({"videos": [{"id": v["id"], "title": titles.get(v["id"]) or v["title"], "genre": v["genre"],
                                "series": (clean_junk(v["series"]) if (not private and get_prefs().get("clean_titles", True)) else pretty(v["series"])) if v["series"] else "",
                                "poster": f"/poster/{v['id']}?v={int(v['mtime'] or 0)}"} for v in vids]})


def collectable_ids(ids):
    """Public, stand-alone videos only: series episodes and private videos never go into a collection."""
    with LIB_LOCK:
        known = LIB["videos"]
        return [i for i in dict.fromkeys(str(x) for x in (ids or [])[:2000])
                if i in known and not known[i]["private"] and not known[i]["series_id"]]


@app.post("/api/collections/assign")
def api_collections_assign():
    """\"Add movies\": body {ids, name}. Puts the movies in the collection called name (made if new).
    The auto-sorter keeps working for every other movie; nothing is moved or renamed on disk."""
    d = request.get_json(silent=True) or {}
    name = clean_coll_name(d.get("name"))
    if not name:
        return jsonify({"error": "Give the collection a name."}), 400
    ids = collectable_ids(d.get("ids"))
    if not ids:
        return jsonify({"error": "Pick at least one movie."}), 400
    now = time.time()
    with closing(db()) as con, con:
        con.executemany("INSERT OR REPLACE INTO collection_overrides (video_id, name, created_at) VALUES (?,?,?)",
                        [(i, name, now) for i in ids])
    return jsonify({"ok": True, "name": name, "count": len(ids)})


@app.post("/api/collections/remove")
def api_collections_remove():
    """Takes movies out of their collection (automatic or not) and keeps them out: they show up under Singles."""
    ids = collectable_ids((request.get_json(silent=True) or {}).get("ids"))
    now = time.time()
    with closing(db()) as con, con:
        con.executemany("INSERT OR REPLACE INTO collection_overrides (video_id, name, created_at) VALUES (?,'',?)", [(i, now) for i in ids])
    return jsonify({"ok": True, "count": len(ids)})


@app.post("/api/collections/auto")
def api_collections_auto():
    """Gives movies back to the auto-sorter (forgets where you put them). Without ids: every hand-made change is forgotten."""
    d = request.get_json(silent=True) or {}
    with closing(db()) as con, con:
        if d.get("ids"):
            ids = [str(i) for i in d["ids"]][:2000]
            con.executemany("DELETE FROM collection_overrides WHERE video_id = ?", [(i,) for i in ids])
        else:
            con.execute("DELETE FROM collection_overrides")
    return jsonify({"ok": True})


@app.post("/api/videos/move")
def api_videos_move():
    """Moves videos (and their subtitles) into <genre>[/<series>] - creating the folders when needed.
    An empty series moves them out of any series; an empty genre puts them at the top level."""
    d = request.get_json(silent=True) or {}
    private = bool(d.get("private"))
    root = genre_root(private)
    g, sr = clean_folder(d.get("genre")), clean_folder(d.get("series"))
    if sr and not g:
        return jsonify({"error": "Pick a genre for the series."}), 400
    ids = [str(i) for i in (d.get("ids") or [])]
    if not ids:
        return jsonify({"error": "Pick at least one video."}), 400
    dest = root / g / sr if g else root
    try:
        dest.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return jsonify({"error": "Could not create the folder: %s" % e}), 500
    prefix = "private/" if private else ""
    with LIB_LOCK:
        vids = [LIB["videos"][i] for i in ids if i in LIB["videos"] and LIB["videos"][i]["private"] == private]
    pairs, old_dirs = [], set()
    for v in vids:
        src = v["path"]
        if src.parent == dest:
            continue
        side = _sidecars(src)
        target = unique_target(dest, src.name)
        try:
            shutil.move(str(src), str(target))
            for sc in side:
                shutil.move(str(sc), str(dest / (target.stem + sc.name[len(src.stem):])))
        except OSError:
            log.debug("api_videos_move: OSError ignored", exc_info=True)
            continue
        pairs.append((v["rel"], prefix + target.relative_to(root).as_posix()))
        old_dirs.add(src.parent)
    rekey_videos(pairs)
    for folder in old_dirs:                               # tidy: an emptied series folder goes away (genres never do)
        try:
            if folder.parent.parent == root and not any(folder.iterdir()):
                folder.rmdir()
        except OSError:
            log.warning("api_videos_move: OSError ignored", exc_info=True)
    schedule_scan()
    return jsonify({"moved": len(pairs), "genre": g, "series": sr, "series_id": item_id(prefix + g + "/" + sr) if sr else ""})


@app.post("/api/series/<sid>/rename")
def api_series_rename(sid):
    s = get_series_checked(sid)
    name = clean_folder((request.get_json(silent=True) or {}).get("name"))
    if not name:
        return jsonify({"error": "Give the series a name."}), 400
    if s.get("virtual"):
        return jsonify({"error": "This series was sorted automatically from the file names. Make a folder for it to rename it."}), 400
    old = s["folder"]
    new = old.parent / name
    if new == old:
        return jsonify({"id": sid, "name": name})
    if new.exists() and new.name.lower() != old.name.lower():
        return jsonify({"error": "A series with that name already exists in this genre."}), 409
    root = CFG["private_dir"] if s["private"] else CFG["video_dir"]
    prefix = "private/" if s["private"] else ""
    with LIB_LOCK:
        eps = [LIB["videos"][e] for e in s["episodes"] if e in LIB["videos"]]
    try:
        os.rename(old, new)
    except OSError as e:
        return jsonify({"error": "Could not rename the folder: %s" % e}), 500
    pairs = [(v["rel"], prefix + (new / v["path"].relative_to(old)).relative_to(root).as_posix()) for v in eps]
    rekey_videos(pairs)
    scan_videos()
    return jsonify({"id": item_id(prefix + s["genre"] + "/" + name), "name": name})


# ----------------------------------------------------------------------------- music: albums + recommendations
@app.get("/api/music/albums")
def api_music_albums():
    with MUSIC_LOCK:
        return jsonify({"albums": MUSIC["albums"]})


def clean_album_name(v):
    return re.sub(r"\s+", " ", str(v or "")).strip()[:80]


def pick_album_artist(items):
    """The album's artist: whoever owns most of the songs, or Various Artists for a mixed bag."""
    names = Counter(i["primary"] for i in items if i.get("primary") and i["primary"] != "Unknown")
    if not names:
        return ""
    top, n = names.most_common(1)[0]
    return top if n / sum(names.values()) >= 0.6 else "Various Artists"


def set_album(rels, name, artist):
    """Puts the songs (rel paths, in play order) into one album. Songs already in a hand-made album of
    the same name and artist keep their numbers and the new ones continue after them. Returns the album key."""
    key = norm_key(name) + "|" + norm_key(artist)
    with closing(db()) as con, con:
        last = max([r["track_no"] for r in con.execute("SELECT album, album_artist, track_no FROM album_overrides")
                    if norm_key(r["album"]) + "|" + norm_key(r["album_artist"]) == key] or [0])
        now = time.time()
        con.executemany("INSERT OR REPLACE INTO album_overrides (rel_path, album, album_artist, track_no, created_at) VALUES (?,?,?,?,?)",
                        [(r, name, artist, last + n + 1, now) for n, r in enumerate(dict.fromkeys(rels))])
    return key


def rels_of(ids):
    with LIB_LOCK:
        return [LIB["tracks"][i]["rel"] for i in dict.fromkeys(str(x) for x in ids) if i in LIB["tracks"]]


@app.post("/api/music/albums/create")
def api_album_create():
    """\"Make into album\": body {ids, name, artist?, order?: listed | title | file}. Tags in the files are never touched."""
    d = request.get_json(silent=True) or {}
    name = clean_album_name(d.get("name"))
    if not name:
        return jsonify({"error": "Give the album a name."}), 400
    ids = [str(i) for i in (d.get("ids") or [])][:5000]
    with MUSIC_LOCK:
        by_id = MUSIC["by_id"]
        items = [by_id[i] for i in dict.fromkeys(ids) if i in by_id]
    if not items:
        return jsonify({"error": "Pick at least one song."}), 400
    order = d.get("order")
    if order == "title":
        items.sort(key=lambda i: natkey(i["t"]["title"]))
    elif order == "file":
        items.sort(key=lambda i: natkey(i["t"]["rel"]))
    artist = clean_album_name(d.get("artist")) or pick_album_artist(items)
    key = set_album([i["t"]["rel"] for i in items], name, artist)
    rebuild_music()
    return jsonify({"key": key, "name": name, "artist": artist, "count": len(items)})


@app.post("/api/music/albums/remove")
def api_album_remove():
    """Takes songs out of their hand-made album (they fall back to the album tag in the file)."""
    rels = rels_of((request.get_json(silent=True) or {}).get("ids") or [])
    with closing(db()) as con, con:
        con.executemany("DELETE FROM album_overrides WHERE rel_path = ?", [(r,) for r in rels])
    rebuild_music()
    return jsonify({"ok": True, "removed": len(rels)})


def custom_rels(key):
    with MUSIC_LOCK:
        return [i["t"]["rel"] for i in MUSIC["items"] if i["custom"] and i["albumkey"] == key]


@app.post("/api/music/albums/rename")
def api_album_rename():
    d = request.get_json(silent=True) or {}
    name = clean_album_name(d.get("name"))
    rels = custom_rels(str(d.get("key") or ""))
    if not name:
        return jsonify({"error": "Give the album a name."}), 400
    if not rels:
        return jsonify({"error": "Only albums you made yourself can be renamed here."}), 404
    artist = clean_album_name(d.get("artist"))
    with closing(db()) as con, con:
        if not artist:
            artist = con.execute("SELECT album_artist FROM album_overrides WHERE rel_path = ?", (rels[0],)).fetchone()["album_artist"]
        con.executemany("UPDATE album_overrides SET album = ?, album_artist = ? WHERE rel_path = ?", [(name, artist, r) for r in rels])
    rebuild_music()
    return jsonify({"key": norm_key(name) + "|" + norm_key(artist), "name": name, "artist": artist})


@app.post("/api/music/albums/dissolve")
def api_album_dissolve():
    """Un-makes a hand-made album: the songs stay in your library, they just stop being grouped."""
    rels = custom_rels(str((request.get_json(silent=True) or {}).get("key") or ""))
    with closing(db()) as con, con:
        con.executemany("DELETE FROM album_overrides WHERE rel_path = ?", [(r,) for r in rels])
    rebuild_music()
    return jsonify({"ok": True, "removed": len(rels)})


@app.post("/api/music/played")
def api_music_played():
    """The player reports every song when it stops: how many seconds were actually heard."""
    d = request.get_json(silent=True) or {}
    with LIB_LOCK:
        t = LIB["tracks"].get(str(d.get("id") or ""))
    try:
        listened, dur = float(d.get("listened", 0)), float(d.get("duration", 0))
    except (TypeError, ValueError):
        abort(400)
    if not t or not (math.isfinite(listened) and math.isfinite(dur)) or listened < 0 or dur < 0:
        abort(400)
    dur = dur or float(t.get("duration") or 0)
    with closing(db()) as con, con:
        con.execute("INSERT INTO plays (rel_path, at, listened, duration) VALUES (?,?,?,?)",
                    (t["rel"], time.time(), min(listened, dur + 5 if dur else listened), dur))
    return jsonify({"ok": True})


REC_HALF_LIFE = 60 * 86400          # a play counts half as much after 60 days
REC_SESSION_GAP = 30 * 60           # songs heard within 30 minutes of each other = one listening session


def play_weight(listened, dur):
    """How much one play says about liking the song: finished = +1, skipped early = negative."""
    if dur <= 0:
        return 0.3
    f = listened / dur
    if f >= 0.8:
        return 1.0
    if f >= 0.4:
        return 0.4
    return -0.8 if (listened < 30 or f < 0.2) else -0.2


def item_genres(it, common):
    return {w for w in re.findall(r"[a-z0-9]+", (it["t"].get("genre_text") or "").lower().replace("-", "")) if w not in common}


def build_taste():
    """Learns from your own listening. The ingredients are play counts, skips, recency and artist affinity, minus the crowd:
       - implicit feedback: finished songs count for, early skips count against, recent plays count more
       - likes and playlists as strong 'I want this' signals
       - content similarity: artist, genre tags and language you gravitate to
       - co-listening: songs that keep showing up in the same sessions / playlists
       - exploration: a little randomness so it keeps surfacing new things instead of repeating itself"""
    now = time.time()
    with MUSIC_LOCK:
        items = list(MUSIC["items"])
    by_rel = {i["t"]["rel"]: i for i in items}
    df = Counter(w for i in items for w in item_genres(i, ()))
    common = {w for w, n in df.items() if n > 0.4 * max(1, len(items))}            # "music", "audio"... say nothing
    with closing(db()) as con:
        plays = con.execute("SELECT rel_path, at, listened, duration FROM plays ORDER BY at").fetchall()
        lp = liked_pid(con)
        pl_rows = con.execute("SELECT playlist_id, rel_path FROM playlist_tracks ORDER BY playlist_id, position").fetchall()
    aff, stats = defaultdict(float), {}
    sessions, cur, last_at = [], [], 0
    for r in plays:
        rel = r["rel_path"]
        if rel not in by_rel:
            continue
        w = play_weight(r["listened"], r["duration"])
        aff[rel] += w * 0.5 ** ((now - r["at"]) / REC_HALF_LIFE)
        st = stats.setdefault(rel, {"n": 0, "last": 0.0, "skips": 0, "full": 0})
        st["n"] += 1
        st["full"] += 1 if w >= 0.4 else 0
        st["last"] = max(st["last"], r["at"])
        st["skips"] += 1 if w < 0 else 0
        if r["at"] - last_at > REC_SESSION_GAP and cur:
            sessions.append(cur)
            cur = []
        if w >= 0.4:
            cur.append(rel)
        last_at = r["at"]
    if cur:
        sessions.append(cur)
    liked, lists = set(), defaultdict(list)
    for r in pl_rows:
        if r["rel_path"] not in by_rel:
            continue
        lists[r["playlist_id"]].append(r["rel_path"])
        if r["playlist_id"] == lp:
            liked.add(r["rel_path"])
            aff[r["rel_path"]] += 3.0
        else:
            aff[r["rel_path"]] += 1.0
    co, cnt = defaultdict(lambda: defaultdict(float)), Counter()
    for group in list(sessions) + list(lists.values()):
        for i, a in enumerate(group):
            cnt[a] += 1
            for b in group[i + 1:i + 6]:
                if a != b:
                    co[a][b] += 1
                    co[b][a] += 1
    art, gen, lang = Counter(), Counter(), Counter()
    for rel, a in aff.items():
        it = by_rel[rel]
        art[it["primary"]] += a
        gs = item_genres(it, common)
        for g in gs:
            gen[g] += a / len(gs)
        lang[it["language"]] += a

    def norm(c):
        m = max((abs(v) for v in c.values()), default=0) or 1
        return {k: v / m for k, v in c.items()}
    seeds = sorted((r for r in aff if aff[r] > 0.5), key=lambda r: -aff[r])[:30]
    top = max((aff[r] for r in seeds), default=1) or 1
    return {"now": now, "items": items, "by_rel": by_rel, "aff": aff, "stats": stats, "liked": liked, "common": common,
            "art": norm(art), "gen": norm(gen), "lang": norm(lang), "co": co, "cnt": cnt,
            "seeds": {r: aff[r] / top for r in seeds}, "plays": len(plays), "cold": len(plays) < 8 and not liked}


def sim(m, a, b):
    c = m["co"].get(a, {}).get(b, 0)
    return c / math.sqrt(m["cnt"][a] * m["cnt"][b]) if c else 0.0


def score_item(m, it, noise=0.07):
    rel = it["t"]["rel"]
    a = m["art"].get(it["primary"], 0.0)
    gs = item_genres(it, m["common"])
    g = sum(m["gen"].get(x, 0.0) for x in gs) / len(gs) if gs else 0.0
    l = m["lang"].get(it["language"], 0.0) if it["language"] != "Unknown" else 0.0
    best, best_sim = 0.0, None
    for s, w in m["seeds"].items():
        v = sim(m, s, rel) * w
        if v > best:
            best, best_sim = v, s
    c = min(1.0, best * 2)
    parts = {"artist": 0.40 * a, "co": 0.25 * c, "genre": 0.15 * g, "lang": 0.10 * l}
    sc = sum(parts.values())
    sc += 0.05 if (m["now"] - (it["t"].get("added_at") or 0)) < 14 * 86400 else 0.0       # fresh arrivals get a nudge
    sc -= 0.15 * m["stats"].get(rel, {}).get("skips", 0)                                  # songs you keep skipping sink
    sc += random.gauss(0, noise)                                                          # exploration
    why = "Something new to try"
    k = max(parts, key=parts.get)
    if parts[k] > 0.04:
        if k == "co" and best_sim:
            why = "You often play it with " + m["by_rel"][best_sim]["t"]["title"]
        elif k == "artist":
            why = "Because you listen to " + it["primary"]
        elif k == "genre":
            why = "Matches your taste: " + ", ".join(sorted(gs, key=lambda x: -m["gen"].get(x, 0))[:2])
        else:
            why = "You like " + it["language"] + " songs"
    return sc, why


def rec_json(it, why=""):
    return dict(track_json(it), why=why)


def pick_diverse(scored, limit, per_artist=2):
    out, used, rest = [], Counter(), []
    for sc, it, why in sorted(scored, key=lambda x: -x[0]):
        if used[it["primary"]] >= per_artist:
            rest.append((it, why))
            continue
        used[it["primary"]] += 1
        out.append(rec_json(it, why))
        if len(out) >= limit:
            return out
    for it, why in rest[:limit - len(out)]:               # small library: better a repeat artist than an empty shelf
        out.append(rec_json(it, why))
    return out


@app.get("/api/music/for-you")
def api_music_for_you():
    """Discover (never played), Rediscover (loved, not heard lately) and 'More like <artist>' shelves."""
    m = build_taste()
    items, stats = m["items"], m["stats"]
    unplayed = [i for i in items if i["t"]["rel"] not in stats]
    disc = []
    for it in unplayed:
        sc, why = score_item(m, it, 0.07 if not m["cold"] else 0.5)
        disc.append((sc, it, "Fresh from your library" if m["cold"] else why))
    discover = pick_diverse(disc, 40)

    redisc = []
    for it in items:
        rel = it["t"]["rel"]
        a, st = m["aff"].get(rel, 0), stats.get(rel)
        last = st["last"] if st else 0
        if (a >= 0.8 or rel in m["liked"]) and m["now"] - last > 21 * 86400:
            redisc.append((a + (m["now"] - last) / (365 * 86400) + random.gauss(0, 0.15), it,
                           "You loved this - not played in a while" if last else "Liked, but you have not played it yet"))
    rediscover = pick_diverse(redisc, 30, 3)

    # most listened artists, each with the songs you played most (real listens only, no guessing)
    cnt_song, cnt_art = Counter(), Counter()
    for rel, st in stats.items():
        it = m["by_rel"].get(rel)
        if not it:
            continue
        cnt_song[rel] = st.get("full", 0)
        cnt_art[it["primary"]] += st.get("full", 0)
    top_list = []
    for name, n in cnt_art.most_common(8):
        if n <= 0 or name == "Unknown":
            continue
        mine = sorted((i for i in items if i["primary"] == name and cnt_song[i["t"]["rel"]] > 0),
                      key=lambda i: -cnt_song[i["t"]["rel"]])[:12]
        top_list.append({"artist": name, "plays": n, "sample": mine[0]["id"] if mine else "",
                         "tracks": [rec_json(i, "%d play%s" % (cnt_song[i["t"]["rel"]], "" if cnt_song[i["t"]["rel"]] == 1 else "s")) for i in mine]})
    top_artists = [a for a, v in sorted(m["art"].items(), key=lambda kv: -kv[1])[:5] if v > 0]
    return jsonify({"discover": discover, "rediscover": rediscover, "top_artists_listened": top_list, "cold": m["cold"],
                    "stats": {"plays": m["plays"], "unplayed": len(unplayed), "songs": len(items), "top_artists": top_artists}})


# ----------------------------------------------------------------------------- Smart genres
AG = autogenre.Engine(db, log)


def ag_keys():
    cfg = load_settings().get("smartgenres") or {}
    return str(cfg.get("tmdb_key") or ""), str(cfg.get("lfm_key") or "")


@app.get("/api/autogenre/status")
def api_ag_status():
    tmdb, lfm = ag_keys()
    return jsonify({"state": AG.status(), "counts": autogenre.counts(db), "has_tmdb": bool(tmdb), "has_lfm": bool(lfm),
                    "online": bool(get_prefs().get("ag_online"))})


@app.post("/api/autogenre/config")
def api_ag_config():
    """Save (or clear, with an empty string) the TMDB and Last.fm keys. They stay on this PC and are never sent to the page."""
    d = request.get_json(silent=True) or {}
    with SETTINGS_LOCK:
        settings = load_settings()
        cfg = settings.setdefault("smartgenres", {})
        for k in ("tmdb_key", "lfm_key"):
            if k in d:
                cfg[k] = re.sub(r"\s+", "", str(d.get(k) or ""))[:600]
        SETTINGS_PATH.write_text(json.dumps(settings), encoding="utf-8")
    return jsonify({"ok": True})


@app.post("/api/autogenre/start")
def api_ag_start():
    d = request.get_json(silent=True) or {}
    what, redo = d.get("what"), bool(d.get("redo"))
    tmdb, lfm = ag_keys()
    online = bool(get_prefs().get("ag_online"))
    if what == "movies":
        if not online:
            return jsonify({"error": "Turn on \"Look genres up online\" first."}), 400
        if not tmdb:
            return jsonify({"error": "Paste your free TMDB key first."}), 400
        have = set() if redo else set(autogenre.load_map(db, "video", ("auto", "manual", "review", "none"))) | set(autogenre.load_map(db, "series", ("auto", "manual", "review", "none")))
        with LIB_LOCK:
            vids = [v for v in LIB["videos"].values() if not v["private"] and not v["series_id"]]
            sers = [s for s in LIB["series"].values() if not s["private"]]
        work = [{"id": v["id"], "title": v["title"], "year": v.get("year") or 0, "tv": False} for v in vids if v["id"] not in have]
        work += [{"id": s["id"], "title": s["name"], "year": 0, "tv": True} for s in sers if s["id"] not in have]
        done = lambda: None
    elif what == "music":
        have = set() if redo else set(autogenre.load_map(db, "track", ("auto", "manual", "none")))
        with LIB_LOCK:
            tracks = list(LIB["tracks"].values())
        work = [{"rel": t["rel"], "artist": (t.get("artist") or "").strip(), "tag": t.get("genre") or ""} for t in tracks if t["rel"] not in have]
        if not online:
            work = [w for w in work if w["tag"]]                 # offline: only what the files' own tags say
        done = rebuild_music
    else:
        return jsonify({"error": "Pick movies or music."}), 400
    if not work:
        return jsonify({"ok": True, "nothing": True})
    ok, err = AG.start(what, work, tmdb, lfm, done)
    return (jsonify({"ok": True, "total": len(work)}) if ok else (jsonify({"error": err}), 409))


@app.post("/api/autogenre/pause")
def api_ag_pause():
    AG.pause(bool((request.get_json(silent=True) or {}).get("on")))
    return jsonify({"ok": True})


@app.post("/api/autogenre/stop")
def api_ag_stop():
    AG.stop()
    return jsonify({"ok": True})


@app.get("/api/autogenre/review")
def api_ag_review():
    return jsonify({"items": autogenre.review_list(db)})


@app.post("/api/autogenre/pick")
def api_ag_pick():
    """Your choice for one movie/series: {kind: video|series, key, genres: [...]} (an empty list = none of these)."""
    d = request.get_json(silent=True) or {}
    kind, key = d.get("kind"), str(d.get("key") or "")
    genres = [str(g)[:30] for g in (d.get("genres") or [])][:4]
    if kind not in ("video", "series") or not key:
        return jsonify({"error": "Unknown item."}), 400
    if genres:
        autogenre.set_manual(db, kind, key, genres)
    else:
        autogenre._put(db, kind, key, [], "you", 1.0, "none")
    return jsonify({"ok": True})


@app.post("/api/autogenre/reset")
def api_ag_reset():
    """Forget every automatic answer (your own choices stay)."""
    if AG.status()["running"]:
        return jsonify({"error": "Stop the scan first."}), 409
    autogenre.reset(db, str((request.get_json(silent=True) or {}).get("kind") or ""))
    rebuild_music()
    return jsonify({"ok": True})


@app.post("/api/instance/show")
def api_instance_show():
    """A second copy of the app was started: bring this window to the front instead."""
    threading.Thread(target=show_from_tray, daemon=True).start()
    return jsonify({"ok": True})


@app.before_request
def require_lmp_header():
    """Every state-changing request must carry X-LMP: 1 (a plain cross-site form or <img> cannot send it)."""
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.headers.get("X-LMP") != "1":
        log.warning("blocked %s %s without X-LMP", request.method, request.path)
        return jsonify({"error": "Missing X-LMP header."}), 403


@app.get("/vendor/<path:name>")
def vendor_file(name):
    """Tailwind CSS, Font Awesome and Inter are served from the app itself (works offline)."""
    return send_from_directory(str(RES_DIR / "vendor"), name, max_age=86400)


@app.get("/assets/<path:name>")
def asset_file(name):
    """The app's own CSS and JS (split out of index.html). Revalidated on every load, so an updated file is never stale."""
    return send_from_directory(str(RES_DIR / "assets"), name, max_age=0)


@app.after_request
def no_cache_for_api(resp):
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ----------------------------------------------------------------------------- launch
_INSTANCE_LOCK = None


def claim_single_instance():
    """True when this is the only copy. A second copy would fight over the database and double every ffmpeg job, so it
    asks the running one to come forward and quits. (The lock is a local socket the system frees the moment the app dies.)"""
    global _INSTANCE_LOCK
    s = socket.socket()
    try:
        if os.name == "nt":
            s.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_EXCLUSIVEADDRUSE", socket.SO_REUSEADDR), 1)
        s.bind(("127.0.0.1", 47399))
        s.listen(1)
    except OSError:
        s.close()
        for port in (47321, 47322, 47323):
            try:
                req = urllib.request.Request("http://127.0.0.1:%d/api/instance/show" % port, data=b"{}", method="POST",
                                             headers={"X-LMP": "1", "Content-Type": "application/json"})
                urllib.request.urlopen(req, timeout=2).read()
                return False                                 # the running copy answered: it comes forward, this one quits
            except Exception:
                continue
        for _ in range(20):                                  # the other copy may still be starting its server: give it a few seconds
            for port in (47321, 47322, 47323):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                        return False
                except OSError:
                    pass
            time.sleep(0.25)
        return True                                          # something else holds the lock port and no copy of the app answers: just start
    _INSTANCE_LOCK = s
    return True


def kill_children_with_me():
    """Windows: put this process in a job object that kills every child (ffmpeg, yt-dlp, mpv helpers) when the app exits or crashes,
    so no orphaned ffmpeg is ever left running."""
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes
        k = ctypes.windll.kernel32
        k.CreateJobObjectW.restype = wintypes.HANDLE
        job = k.CreateJobObjectW(None, None)
        if not job:
            return

        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64), ("LimitFlags", wintypes.DWORD),
                        ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class IOC(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]

        class EXT(ctypes.Structure):
            _fields_ = [("Basic", BASIC), ("Io", IOC), ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
        info = EXT()
        info.Basic.LimitFlags = 0x2000                       # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
        k.GetCurrentProcess.restype = wintypes.HANDLE
        k.AssignProcessToJobObject(job, k.GetCurrentProcess())
        globals()["_JOB"] = job                              # keep the handle alive for the whole run
    except Exception:
        log.warning("kill_children_with_me failed", exc_info=True)


def free_port():
    for want in (47321, 47322, 47323, 0):          # a fixed port keeps the window's saved data attached to the same address
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", want))
                return s.getsockname()[1]
            except OSError:
                continue
    raise OSError("no free port")


def wait_for_server(port, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return True
        except OSError:
            time.sleep(0.1)
    return False


APP_TITLE = "ULTRON"
FULLSCREEN = False                               # is the desktop window currently fullscreen?


_NATIVE_FS = {}


def _native_fs(on):
    """Windows: strip the title bar and borders ourselves and cover the whole monitor (taskbar included).
    Returns True when it handled the request; False means 'fall back to pywebview's own toggle'."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        u.FindWindowW.restype = wintypes.HWND
        u.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
        u.GetWindowLongW.restype = ctypes.c_long
        u.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
        u.SetWindowLongW.restype = ctypes.c_long
        u.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_long]
        u.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        u.MonitorFromWindow.restype = wintypes.HANDLE
        u.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
        u.IsZoomed.argtypes = [wintypes.HWND]
        u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]

        class MONITORINFO(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

        hwnd = u.FindWindowW(None, APP_TITLE)
        if not hwnd:
            return False
        GWL_STYLE, GWL_EXSTYLE = -16, -20
        BORDERS = 0x00C00000 | 0x00040000 | 0x00020000 | 0x00010000 | 0x00080000   # caption, sizing frame, min/max boxes, sysmenu
        EDGES = 0x00000001 | 0x00000100 | 0x00000200 | 0x00020000                  # dlg frame, window edge, client edge, static edge
        FRAME = 0x0020 | 0x0040 | 0x0004                                           # FRAMECHANGED | SHOWWINDOW | NOZORDER-free flags below
        if on:
            if _NATIVE_FS.get("active"):
                return True
            was_max = bool(u.IsZoomed(hwnd))
            if was_max:
                u.ShowWindow(hwnd, 9)                                              # SW_RESTORE
            rc = wintypes.RECT()
            u.GetWindowRect(hwnd, ctypes.byref(rc))
            style, ex = u.GetWindowLongW(hwnd, GWL_STYLE), u.GetWindowLongW(hwnd, GWL_EXSTYLE)
            mi = MONITORINFO()
            mi.cbSize = ctypes.sizeof(MONITORINFO)
            mon = u.MonitorFromWindow(hwnd, 2)
            if not mon or not ctypes.windll.user32.GetMonitorInfoW(mon, ctypes.byref(mi)):
                return False
            _NATIVE_FS.update(active=True, style=style, ex=ex, rect=(rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top), max=was_max)
            u.SetWindowLongW(hwnd, GWL_STYLE, style & ~BORDERS)
            u.SetWindowLongW(hwnd, GWL_EXSTYLE, ex & ~EDGES)
            r = mi.rcMonitor
            u.SetWindowPos(hwnd, wintypes.HWND(0), r.left, r.top, r.right - r.left, r.bottom - r.top, 0x0020 | 0x0040)    # HWND_TOP, no frame. Not TOPMOST: a topmost window stays above every other app, so Alt+Tab and clicking away could never bring them forward
            return True
        if not _NATIVE_FS.get("active"):
            return False
        st = dict(_NATIVE_FS)
        _NATIVE_FS.clear()
        u.SetWindowLongW(hwnd, GWL_STYLE, st["style"])
        u.SetWindowLongW(hwnd, GWL_EXSTYLE, st["ex"])
        x, y, w, hgt = st["rect"]
        u.SetWindowPos(hwnd, wintypes.HWND(-2), x, y, w, hgt, 0x0020 | 0x0040)                                          # NOTOPMOST (also clears the flag older versions set), frame back
        if st["max"]:
            u.ShowWindow(hwnd, 3)                                                                                        # SW_MAXIMIZE
        return True
    except Exception as e:
        print("Native fullscreen failed, using the default one:", e)
        _NATIVE_FS.clear()
        return False


def set_fullscreen(on):
    """Window fullscreen on/off with no title bar or borders (pywebview alone only has a toggle, so remember the state)."""
    global FULLSCREEN
    on = bool(on)
    if WINDOW is None or on == FULLSCREEN:
        return FULLSCREEN
    if on:
        if not _native_fs(True):
            WINDOW.toggle_fullscreen()
    else:
        if not (_NATIVE_FS.get("active") and _native_fs(False)):
            WINDOW.toggle_fullscreen()
    FULLSCREEN = on
    return FULLSCREEN


def apply_display(mode, width=None, height=None):
    """Apply a display mode: windowed (at width x height), maximized, or fullscreen."""
    if WINDOW is None:
        return
    try:
        if mode == "fullscreen":
            set_fullscreen(True)
            return
        set_fullscreen(False)                         # leave fullscreen first
        if mode == "maximized":
            WINDOW.maximize()
        else:
            WINDOW.restore()                          # un-maximize, then size it
            if width and height:
                WINDOW.resize(int(width), int(height))
    except Exception as e:
        print("Could not change display mode:", e)


def window_is_maximized():
    if os.name != "nt":
        return False
    try:
        import ctypes
        hwnd = ctypes.windll.user32.FindWindowW(None, APP_TITLE)
        return bool(hwnd and ctypes.windll.user32.IsZoomed(hwnd))
    except Exception:
        log.warning("window_is_maximized: Exception ignored", exc_info=True)
        return False


_LAST_SIZE = {}


def on_window_resized(width, height):
    """Remember the latest normal-window size (ignores fullscreen, maximized and minimized)."""
    if FULLSCREEN or width < 900 or height < 600 or window_is_maximized():
        return
    _LAST_SIZE["wh"] = (int(width), int(height))


def save_window_size():
    wh = _LAST_SIZE.get("wh")
    try:
        now = get_prefs()
        if wh and now["remember_size"] and now["display_mode"] == "windowed":
            save_prefs({"win_width": wh[0], "win_height": wh[1]})
    except Exception:
        pass                                              # never block closing the window


QUITTING = False                                      # True once the app really is exiting (Exit button, tray menu)
TRAY = None                                           # the pystray icon, when the tray is available


def on_window_closing():
    """The window's X button. With the tray running, hide to the tray instead of quitting (return False cancels the close)."""
    save_window_size()
    try:
        if QUITTING or TRAY is None or not get_prefs().get("close_to_tray", True):
            return True
    except Exception:
        return True
    # hide from another thread: hiding inside the closing handler would wait on the UI thread that is waiting for us
    threading.Thread(target=hide_to_tray, daemon=True).start()
    return False


def _foreground():
    """Bring the main window in front of everything (Windows)."""
    if os.name != "nt":
        return
    try:
        import ctypes
        u = ctypes.windll.user32
        hwnd = u.FindWindowW(None, APP_TITLE)
        if hwnd:
            u.ShowWindow(hwnd, 9)                     # SW_RESTORE
            u.SetForegroundWindow(hwnd)
    except Exception:
        log.warning("_foreground: Exception ignored", exc_info=True)


def hide_to_tray():
    _tell_main("window.lockNow && lockNow()")         # private library locks itself while you are away; music keeps playing
    try:
        if WINDOW is not None:
            WINDOW.hide()
    except Exception:
        log.warning("hide_to_tray: Exception ignored", exc_info=True)


def show_from_tray(icon=None, item=None):
    try:
        if WINDOW is not None:
            WINDOW.show()
            try:
                WINDOW.restore()
            except Exception:
                pass
    except Exception:
        log.warning("show_from_tray: Exception ignored", exc_info=True)
    _foreground()


def tray_cmd(name):
    _tell_main("window.trayCmd && trayCmd(%s)" % json.dumps(name))


def tray_play_pause(icon=None, item=None):
    tray_cmd("toggle")


def tray_next(icon=None, item=None):
    tray_cmd("next")


def tray_prev(icon=None, item=None):
    tray_cmd("prev")


def tray_mute(icon=None, item=None):
    tray_cmd("mute")


def tray_lock(icon=None, item=None):
    _tell_main("window.lockNow && lockNow()")


def tray_open_folder(key):
    def _open(icon=None, item=None):
        try:
            d = CFG[key] if key in CFG else DATA_DIR
            Path(d).mkdir(parents=True, exist_ok=True)
            os.startfile(str(d))
        except Exception:
            log.warning("tray_open_folder: Exception ignored", exc_info=True)
    return _open


def tray_exit(icon=None, item=None):
    quit_app_now()


TRAY_INFO = {"title": "", "artist": "", "playing": False, "video": False, "muted": False}


def tray_poll_loop():
    """Every 2 seconds ask the page what is playing: feeds the tray tooltip and the top line of the tray menu."""
    while not QUITTING and TRAY is not None:
        try:
            if WINDOW is not None:
                raw = WINDOW.evaluate_js("window.trayInfo ? JSON.stringify(window.trayInfo()) : ''")
                if raw:
                    TRAY_INFO.update(json.loads(raw))
            label = tray_now_label()
            TRAY.title = (APP_TITLE + (" - " + label if TRAY_INFO["title"] else ""))[:120]
        except Exception:
            pass
        time.sleep(2)


def tray_now_label():
    t = TRAY_INFO
    if not t["title"]:
        return "Nothing playing"
    return ("\u25b6 " if t["playing"] else "\u23f8 ") + t["title"][:48] + ((" \u2014 " + t["artist"][:30]) if t["artist"] else "")


def tray_image():
    """The logo as a square tray icon (Pillow). Falls back to a simple LM badge."""
    from PIL import Image, ImageDraw
    src = find_logo()
    try:
        if src:
            im = Image.open(src).convert("RGBA")
            side = max(im.size)
            sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
            return sq.resize((64, 64), Image.LANCZOS)
    except Exception:
        log.warning("tray_image: Exception ignored", exc_info=True)
    im = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((2, 2, 62, 62), radius=12, fill=(255, 195, 113, 255))
    d.text((20, 24), "LM", fill=(0, 0, 0, 255))
    return im


def start_tray():
    """Windows only, and only if pystray is installed. Without it the X button simply quits like before."""
    global TRAY
    if os.name != "nt":
        return
    try:
        import pystray
        menu = pystray.Menu(
            pystray.MenuItem(lambda item: tray_now_label(), None, enabled=False),                                  # what is playing right now
            pystray.MenuItem(lambda item: "Pause" if TRAY_INFO["playing"] else "Play", tray_play_pause),
            pystray.MenuItem("Next", tray_next),
            pystray.MenuItem("Previous", tray_prev),
            pystray.MenuItem("Mute", tray_mute, checked=lambda item: bool(TRAY_INFO["muted"])),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Lock private library now", tray_lock),
            pystray.MenuItem("Open folder", pystray.Menu(
                pystray.MenuItem("Videos", tray_open_folder("video_dir")),
                pystray.MenuItem("Music", tray_open_folder("music_dir")),
                pystray.MenuItem("Photos", tray_open_folder("photo_dir")),
                pystray.MenuItem("ULTRON data and logs", tray_open_folder("data")),
            )),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Open " + APP_TITLE, show_from_tray, default=True),    # a click on the icon opens the window
            pystray.MenuItem("Exit", tray_exit),
        )
        icon = pystray.Icon(APP_TITLE, tray_image(), APP_TITLE, menu)
        TRAY = icon
        threading.Thread(target=icon.run, daemon=True).start()
        threading.Thread(target=tray_poll_loop, daemon=True).start()
    except Exception:
        TRAY = None
        log.warning("start_tray: the tray icon is not available (pip install pystray)", exc_info=True)


# ----------------------------------------------------------------------------- app icon (from logo.png)
def find_logo():
    for d in (APP_DIR, APP_DIR / "templates", APP_DIR / "static", RES_DIR, RES_DIR / "templates"):
        p = d / "logo.png"
        if p.is_file():
            return p
    return None


def make_icon():
    """Turn logo.png into data/app.ico (needs Pillow). Returns the .ico path or None."""
    src = find_logo()
    if not src:
        return None
    out = DATA_DIR / "app.ico"
    try:
        if out.is_file() and out.stat().st_mtime >= src.stat().st_mtime:
            return out
        from PIL import Image
        im = Image.open(src).convert("RGBA")
        side = max(im.size)
        sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))   # pad to a square so it is not stretched
        sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
        sq.save(out, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
        return out
    except Exception as e:
        print("Could not build the app icon:", e)
        return None


def set_app_id():
    """Windows groups the taskbar button by app id; without this it shows python.exe's icon."""
    if os.name != "nt":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("ULTRON.Player")
    except Exception:
        log.warning("set_app_id: Exception ignored", exc_info=True)


def set_window_icon(title):
    """Put the logo on the window's title bar and taskbar button (Windows)."""
    if os.name != "nt":
        return
    ico = make_icon()
    if not ico:
        return
    try:
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        u.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
        u.FindWindowW.restype = wintypes.HWND
        u.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        u.LoadImageW.restype = wintypes.HANDLE
        u.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        u.SendMessageW.restype = ctypes.c_ssize_t
        hwnd = None
        for _ in range(60):                           # wait for the window to exist
            hwnd = u.FindWindowW(None, title)
            if hwnd:
                break
            time.sleep(0.1)
        if not hwnd:
            return
        for kind, metric in ((1, 11), (0, 49)):       # ICON_BIG / ICON_SMALL, SM_CXICON / SM_CXSMICON
            size = u.GetSystemMetrics(metric)
            h = u.LoadImageW(None, str(ico), 1, size, size, 0x10)   # IMAGE_ICON, LR_LOADFROMFILE
            if h:
                u.SendMessageW(hwnd, 0x80, kind, h)   # WM_SETICON
    except Exception as e:
        print("Could not set the window icon:", e)


MINI = None                                      # the pop-out mini player window
APP_URL = ""
MINI_HTML = r'''<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mini player</title>
<style>
:root{--accent:#E41E2B}
*{box-sizing:border-box;margin:0}
html,body{height:100%;background:#000;overflow:hidden;font-family:'Segoe UI',system-ui,sans-serif;color:#fff;user-select:none}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.ui{position:absolute;inset:0;opacity:0;transition:opacity .2s;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(to bottom,rgba(0,0,0,.75),transparent 38%,transparent 52%,rgba(0,0,0,.85))}
body.show .ui{opacity:1} body.show{cursor:default} body:not(.show){cursor:none}
.top{display:flex;align-items:center;gap:8px;padding:8px 10px}
.title{flex:1;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 6px #000}
button{border:0;background:rgba(255,255,255,.16);color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .15s,transform .1s}
button:hover{background:rgba(255,255,255,.32)} button:active{transform:scale(.9)}
button svg{width:15px;height:15px;fill:currentColor}
.mid{display:flex;justify-content:center;align-items:center;gap:16px}
.big{width:52px;height:52px;background:#fff;color:#000} .big svg{width:22px;height:22px} .big:hover{background:#fff;transform:scale(1.07)}
.skip{width:36px;height:36px;font-size:10px;font-weight:800}
button.accent{background:var(--accent)}
button.dim{opacity:.45}
video::cue{font-size:15px}
.bot{padding:0 12px 8px}
.bar{height:16px;display:flex;align-items:center;cursor:pointer}
.track{position:relative;width:100%;height:3px;border-radius:3px;background:rgba(255,255,255,.28);transition:height .12s} .bar:hover .track{height:5px}
.fill{position:absolute;inset:0 auto 0 0;width:0;background:var(--accent);border-radius:3px;box-shadow:0 0 10px rgba(228,30,43,.8)}
#hint{position:absolute;top:44px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.7);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:700;opacity:0;transition:opacity .2s;pointer-events:none;z-index:5}
.time{font-size:11px;display:flex;justify-content:space-between;opacity:.85;margin-top:1px}
</style></head><body class="show">
<video id="v" playsinline></video><div id="hint"></div>
<div class="ui" id="ui">
 <div class="top"><div class="title" id="title"></div>
  <button id="bs" class="dim" title="Subtitles (C)"><svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm2 6v2h3v-2H6zm0 3v2h6v-2H6zm8-3v2h4v-2h-4zm-3 3v2h7v-2h-7z"/></svg></button>
  <button id="bn" class="dim" title="Next episode (N)"><svg viewBox="0 0 24 24"><path d="M6 6l9 6-9 6V6zm10 0h2v12h-2V6z"/></svg></button>
  <button id="bx" title="Back to the full player (E)"><svg viewBox="0 0 24 24"><path d="M14 3h7v7h-2V6.4l-5.3 5.3-1.4-1.4L17.6 5H14V3zM10 21H3v-7h2v3.6l5.3-5.3 1.4 1.4L6.4 19H10v2z"/></svg></button>
  <button id="bc" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M5.7 4.3 12 10.6l6.3-6.3 1.4 1.4-6.3 6.3 6.3 6.3-1.4 1.4-6.3-6.3-6.3 6.3-1.4-1.4 6.3-6.3-6.3-6.3z"/></svg></button></div>
 <div class="mid"><button class="skip" id="bb" title="Back 10s">-10</button><button class="big" id="bp" title="Play / pause (Space)"></button><button class="skip" id="bf" title="Forward 10s">+10</button></div>
 <div class="bot"><div class="bar" id="bar"><div class="track"><div class="fill" id="fill"></div></div></div><div class="time"><span id="cur">0:00</span><span id="dur">0:00</span></div></div>
</div>
<script>
const q=new URLSearchParams(location.search);let id=q.get('id');const v=document.getElementById('v'),$=i=>document.getElementById(i);
const PLAY='<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',PAUSE='<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
$('title').textContent=q.get('title')||'';document.title=(q.get('title')||'Video')+' - Mini player';
let start=parseFloat(q.get('t'))||0,ready=false,hideT=0;
const fmt=s=>{s=Math.max(0,Math.floor(s||0));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return(h?h+':'+String(m).padStart(2,'0'):m)+':'+String(x).padStart(2,'0')};
const api=()=>window.pywebview&&window.pywebview.api;
function paint(){$('bp').innerHTML=v.paused?PLAY:PAUSE;const d=v.duration||0;$('fill').style.width=d?(v.currentTime/d*100)+'%':'0';$('cur').textContent=fmt(v.currentTime);$('dur').textContent=fmt(d)}
function save(keep){if(!ready||!(v.duration>0))return;fetch('/api/videos/'+id+'/progress',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-LMP':'1'},keepalive:!!keep,body:JSON.stringify({position:v.currentTime,duration:v.duration})}).catch(()=>{})}
function toggle(){if(v.paused)v.play().catch(()=>{});else v.pause()}
function skip(s){v.currentTime=Math.min(Math.max(0,v.currentTime+s),v.duration||0)}
function show(){document.body.classList.add('show');clearTimeout(hideT);if(!v.paused)hideT=setTimeout(()=>document.body.classList.remove('show'),2500)}
function expand(){save(true);const a=api();if(a&&a.mini_expand)a.mini_expand(id,v.currentTime);else window.close()}
function closeIt(){save(true);const a=api();if(a&&a.mini_close)a.mini_close();else window.close()}
v.src=q.get('src');const vp=parseFloat(q.get('vol'));v.volume=isNaN(vp)?1:Math.min(1,Math.max(0,vp));v.muted=v.volume===0;
let hT=0;function hint(){let h=$('hint');h.textContent=v.muted||v.volume===0?'Muted':'Volume '+Math.round(v.volume*100)+'%';h.style.opacity=1;clearTimeout(hT);hT=setTimeout(()=>h.style.opacity=0,1100)}
function setv(x){v.volume=Math.min(1,Math.max(0,x));v.muted=v.volume===0;hint()}
v.addEventListener('loadedmetadata',()=>{if(start>0&&start<v.duration-1)v.currentTime=start;ready=true;if(q.get('paused')!=='1')v.play().catch(()=>{});paint()});
['timeupdate','play','pause','durationchange'].forEach(e=>v.addEventListener(e,paint));
v.addEventListener('play',show);v.addEventListener('pause',()=>{document.body.classList.add('show');save(false)});v.addEventListener('ended',()=>{save(true);document.body.classList.add('show')});
setInterval(()=>{if(!v.paused)save(false)},5000);
$('bp').onclick=toggle;$('bb').onclick=()=>skip(-10);$('bf').onclick=()=>skip(10);$('bx').onclick=expand;$('bc').onclick=closeIt;
$('bar').addEventListener('click',e=>{const r=e.currentTarget.getBoundingClientRect();if(v.duration)v.currentTime=v.duration*Math.min(1,Math.max(0,(e.clientX-r.left)/r.width))});
v.addEventListener('click',toggle);v.addEventListener('dblclick',expand);
document.addEventListener('mousemove',show);document.addEventListener('wheel',e=>{e.preventDefault();if(e.ctrlKey||e.shiftKey)setv((v.muted?0:v.volume)-Math.sign(e.deltaY)*.05);else{skip(-Math.sign(e.deltaY)*5);hintText(fmt(v.currentTime))}},{passive:false});
document.addEventListener('keydown',e=>{const k=e.key.toLowerCase();if(k===' '||k==='k'){e.preventDefault();toggle()}else if(k==='arrowleft')skip(-5);else if(k==='arrowright')skip(5);else if(k==='arrowup'){e.preventDefault();setv(v.volume+.05)}else if(k==='arrowdown'){e.preventDefault();setv(v.volume-.05)}else if(k==='m'){v.muted=!v.muted;hint()}else if(k==='e')expand();else if(k==='c')cycleSub();else if(k==='n')playNext();else if(k==='escape')closeIt();show()});
window.addEventListener('pagehide',()=>save(true));
let subs=[],subIdx=-1,nextId=null;
function clearTracks(){[...v.querySelectorAll('track')].forEach(t=>t.remove())}
function applySub(){clearTracks();$('bs').classList.toggle('accent',subIdx>=0);if(subIdx<0){hintText(subs.length?'Subtitles off':'No subtitles');return}
const s=subs[subIdx],t=document.createElement('track');t.kind='subtitles';t.label=s.label;t.srclang=s.lang||'en';t.src=s.url;t.default=true;v.appendChild(t);t.addEventListener('load',()=>{t.track.mode='showing'});hintText(s.label)}
function cycleSub(){if(!subs.length){hintText('No subtitles');return}subIdx=subIdx+1>=subs.length?-1:subIdx+1;applySub()}
function hintText(x){const h=$('hint');h.textContent=x;h.style.opacity=1;clearTimeout(hT);hT=setTimeout(()=>h.style.opacity=0,1200)}
async function loadInfo(){subs=[];subIdx=-1;nextId=null;clearTracks();$('bs').classList.remove('accent');
try{const r=await fetch('/api/videos/'+id+'/info',{credentials:'same-origin'});if(!r.ok)return;const d=await r.json();subs=d.subtitles||[];nextId=d.next||null;
if(subs.length&&d.subs_auto!==false){subIdx=0;applySub()}}catch(e){}
$('bs').classList.toggle('dim',!subs.length);$('bn').classList.toggle('dim',!nextId)}
async function playNext(){if(!nextId){hintText('No next episode');return}save(true);const nid=nextId;
try{const r=await fetch('/api/videos/'+nid+'/info',{credentials:'same-origin'});const d=r.ok?await r.json():{};id=nid;ready=false;v.src='/media/video/'+nid;
$('title').textContent=d.title||'';document.title=(d.title||'Video')+' - Mini player';start=d.resume||0;await loadInfo()}catch(e){}}
$('bs').onclick=cycleSub;$('bn').onclick=playNext;v.addEventListener('ended',()=>{if(nextId)playNext()});
loadInfo();
paint();show();
</script></body></html>
'''


@app.get("/mini")
def mini_page():
    return Response(MINI_HTML, mimetype="text/html")


def _tell_main(js):
    try:
        if WINDOW is not None:
            WINDOW.evaluate_js(js)
    except Exception:
        log.warning("_tell_main: Exception ignored", exc_info=True)


def _mini_closed():
    global MINI
    MINI = None
    _tell_main("window.miniClosed && miniClosed()")


def finish_exit():
    """The one clean way out: picture off the screen first, then the tray, then the player, then the process."""
    try:
        player_shutdown()
    except Exception:
        log.warning("finish_exit: player", exc_info=True)
    try:
        if TRAY is not None:
            TRAY.stop()
    except Exception:
        log.warning("finish_exit: tray", exc_info=True)
    try:
        logging.shutdown()
    except Exception:
        pass
    os._exit(0)


def on_window_closed():
    """The ULTRON window is really gone (not just hidden to the tray): take the player down with it."""
    threading.Thread(target=finish_exit, daemon=True).start()


def quit_app_now():
    """Really exit (the tray is removed, the windows are destroyed, the process ends)."""
    global QUITTING
    QUITTING = True
    try:
        save_window_size()
    except Exception:
        log.warning("quit_app_now: Exception ignored", exc_info=True)

    def _go():
        try:
            player_shutdown()                              # first: the picture disappears at once, nothing is left over while the window closes
        except Exception:
            log.warning("_go: player_shutdown", exc_info=True)
        time.sleep(0.1)
        try:
            if TRAY is not None:
                TRAY.stop()
        except Exception:
            log.warning("_go: Exception ignored", exc_info=True)
        for w in (MINI, WINDOW):
            try:
                if w is not None:
                    w.destroy()
            except Exception:
                log.warning("_go: Exception ignored", exc_info=True)
        time.sleep(0.8)
        os._exit(0)
    threading.Thread(target=_go, daemon=True).start()


NATIVE = {"proc": None}


def native_play(vid, token=""):
    """Start the native player process for a video. False = not possible here (the page then uses the web player)."""
    if WINDOW is None or not APP_URL or not get_prefs().get("native_player", True):
        return False
    v = get_video(vid)
    if not v or (v["private"] and not valid_token(token)):
        return False
    try:
        import native_ui  # noqa: F401  (only to know early whether PySide6 is there; the real work happens in the other process)
    except Exception:
        log.warning("native player unavailable (PySide6 missing?)", exc_info=True)
        return False
    old = NATIVE.get("proc")
    if old is not None:
        old._ultron_replaced = True                       # its exit is OURS: the watcher must not fall back to the web player for it
        NATIVE["proc"] = None
    if old is not None and old.poll() is None:
        try:
            old.terminate()
            old.wait(3)
        except Exception:
            log.warning("could not stop the previous native player", exc_info=True)
    args = ["--player", "--base", APP_URL.rstrip("/"), "--vid", str(vid), "--token", token or "",
            "--fullscreen", "1" if FULLSCREEN else "0", "--mpvdir", ";".join(str(d) for d in mpv_dirs())]
    cmd = [sys.executable] + args if FROZEN else [sys.executable, str(Path(__file__).resolve())] + args
    try:
        proc = subprocess.Popen(cmd, cwd=str(APP_DIR), creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
    except OSError:
        log.warning("native player could not start", exc_info=True)
        return False
    NATIVE["proc"] = proc
    threading.Thread(target=_native_watch, args=(proc, str(vid), time.time()), daemon=True).start()
    return True


def _native_watch(proc, vid, t0):
    rc = proc.wait()
    quick = time.time() - t0 < 25
    log.info("native player ended: code %s after %.0fs", rc, time.time() - t0)
    if getattr(proc, "_ultron_replaced", False) or NATIVE.get("proc") is not proc or WINDOW is None:
        return                                            # replaced by a newer one, or the app is closing
    js = ("window.nativePlayerFailed && nativePlayerFailed(%s)" % json.dumps(vid)) if (rc not in (0, None) and quick) \
        else "window.nativePlayerClosed && nativePlayerClosed()"
    try:
        WINDOW.evaluate_js(js)
    except Exception:
        log.warning("could not tell the page the native player ended", exc_info=True)


class Api:
    """Exposed to the page as window.pywebview.api - lets the player make the whole desktop window fullscreen
    (the browser's own fullscreen only fills the web view and leaves the title bar and borders)."""

    def quit_app(self):
        """Exit from the menu: close the mini player and the main window, then make sure the process ends."""
        quit_app_now()
        return True

    def toggle_fullscreen(self):
        return set_fullscreen(not FULLSCREEN)

    def play_native(self, vid, token=""):
        return native_play(str(vid), str(token or ""))

    def set_fullscreen(self, on):
        return set_fullscreen(on)

    def open_mini(self, src, title, t, vid, tk, paused, vol=1.0):
        """Pop the video out into its own small always-on-top window (like YouTube's mini player)."""
        global MINI
        if WINDOW is None:
            return False
        if native_mini_open(vid, t, paused, vol):                    # libmpv: a real always-on-top mpv window
            return True
        try:
            pv = get_video(str(vid or ""))
            if pv and pv["private"] and get_prefs().get("private_start_muted", True):
                vol = 0                                              # the plain web pop-out: private videos start silent here too
        except Exception:
            log.warning("open_mini: private check skipped", exc_info=True)
        try:
            import webview
            from urllib.parse import urlencode
            if MINI is not None:
                try:
                    MINI.destroy()
                except Exception:
                    log.warning("open_mini: Exception ignored", exc_info=True)
                MINI = None
            qs = urlencode({"src": src, "title": title or "", "t": "%.2f" % float(t or 0), "id": vid, "paused": "1" if paused else "0", "vol": "%.2f" % max(0.0, min(1.0, float(vol if vol is not None else 1.0)))})
            kw = {}
            try:
                scr = webview.screens[0]
                kw = {"x": max(0, int(scr.width - 480 - 24)), "y": max(0, int(scr.height - 300 - 90))}
            except Exception:
                log.warning("open_mini: Exception ignored", exc_info=True)
            MINI = webview.create_window("Mini player", APP_URL.rstrip("/") + "/mini?" + qs, width=480, height=300,
                                         min_size=(260, 180), on_top=True, resizable=True, background_color="#000000",
                                         js_api=Api(), **kw)
            MINI.events.closed += _mini_closed
            try:
                MINI.events.shown += lambda: set_window_icon("Mini player")
            except Exception:
                log.warning("open_mini: Exception ignored", exc_info=True)
            return True
        except Exception as e:
            print("Could not open the mini window:", e)
            return False

    def mini_expand(self, vid, t):
        global MINI
        m, MINI = MINI, None
        try:
            if m is not None:
                m.destroy()
        except Exception:
            log.warning("mini_expand: Exception ignored", exc_info=True)
        _tell_main("window.miniExpand && miniExpand(%s, %s)" % (json.dumps(vid), float(t or 0)))
        for fn in ("restore", "show"):
            try:
                getattr(WINDOW, fn)()
            except Exception:
                log.warning("mini_expand: Exception ignored", exc_info=True)
        return True

    def mini_close(self):
        global MINI
        m, MINI = MINI, None
        try:
            if m is not None:
                m.destroy()
        except Exception:
            log.warning("mini_close: Exception ignored", exc_info=True)
        _tell_main("window.miniClosed && miniClosed()")
        return True

    def pick_folder(self):
        """Native folder picker. Returns the path, '' if cancelled, None if unavailable."""
        if WINDOW is None:
            return None
        try:
            import webview
            kind = getattr(getattr(webview, "FileDialog", None), "FOLDER", None)
            if kind is None:
                kind = webview.FOLDER_DIALOG
            res = WINDOW.create_file_dialog(kind)
        except Exception:
            log.warning("pick_folder: Exception ignored", exc_info=True)
            return None
        if not res:
            return ""
        return str(res[0] if isinstance(res, (list, tuple)) else res)


# ----------------------------------------------------------------------------- native player (libmpv)
# Every video is played by libmpv (python-mpv): MKV, HEVC, AV1, AC3, DTS, TrueHD, ASS subtitles ... as they are, decoded on the GPU.
# Nothing is converted or copied. If libmpv is missing (or Settings turns it off) the page falls back to its built-in web player.
# mpv_backend.py owns the engines; this section is only the HTTP glue for the page (assets/js/mpv-player.js) and the pop-out window.
PLAYER = {"stage": None, "mini": None}
PLAYER_LOCK = threading.RLock()
SUB_URL_OK = re.compile(r"^/subtitle/[A-Za-z0-9_\-]+/\d{1,4}$")


def mpv_dirs():
    """Folders searched for libmpv-2.dll, in order: the one chosen in Settings, data\\mpv, next to the exe, the bundled copy."""
    raw = str(get_prefs().get("mpv_dir") or "").strip()
    return [d for d in ([Path(raw).expanduser()] if raw else []) + [DATA_DIR / "mpv", APP_DIR, APP_DIR / "mpv", RES_DIR] if d]


def stage_engine():
    with PLAYER_LOCK:
        if PLAYER["stage"] is None:
            PLAYER["stage"] = mpv_backend.Engine("stage", get_prefs, DATA_DIR / "mpv", mpv_dirs, main_title=APP_TITLE)
        return PLAYER["stage"]


def mpv_status():
    p = get_prefs()
    out = {"engine": "html5", "enabled": bool(p["mpv_enabled"]), "available": False, "error": "", "version": "", "lib": "", "audio": None}
    if not p["mpv_enabled"]:
        return out
    if not (mpv_backend.IS_WIN and WINDOW is not None):    # the picture is a child window inside the ULTRON window (Windows desktop app)
        out["error"] = "The native player needs the ULTRON desktop window on Windows."
        return out
    eng = stage_engine()
    if not eng.available():
        out["error"] = eng.error
        return out
    out["available"] = True
    if not eng.ensure():                                   # creating the instance also lists the audio devices for Settings
        out["error"] = eng.error
        return out
    out.update(engine="mpv", version=eng.version, lib=eng.lib, audio=getattr(eng, "audio", None))
    return out


def player_shutdown():
    for key in ("stage", "mini"):
        with PLAYER_LOCK:
            eng, PLAYER[key] = PLAYER[key], None
        if eng is not None:
            try:
                eng.shutdown()
            except Exception:
                log.warning("player_shutdown: Exception ignored", exc_info=True)


@app.get("/api/player/status")
def api_player_status():
    if request.args.get("boot") == "1":                    # a page that has just loaded has no player session: never leave the last picture on screen
        eng = PLAYER["stage"]
        if eng is not None:
            eng.stop()
    return jsonify(mpv_status())


@app.post("/api/player/load")
def api_player_load():
    d = request.get_json(silent=True) or {}
    v = get_video_checked(str(d.get("id") or ""))
    if not get_prefs()["mpv_enabled"]:
        return jsonify({"error": "libmpv is turned off in Settings."}), 409
    mini = PLAYER["mini"]
    if mini is not None and mini.m is not None:           # one video at a time: the pop-out makes room (it saves its position first)
        mini.close_mini()
    eng = stage_engine()
    if not eng.ensure():
        return jsonify({"error": eng.error or "libmpv is not available."}), 503
    if not eng.load(v["path"], paused=True, volume=d.get("volume"), mute=d.get("mute"), speed=d.get("speed"), vid=v["id"], private=v["private"]):
        return jsonify({"error": eng.error or "mpv could not open this file."}), 500
    eng.command("osc", bool(d.get("osc")))
    if not eng.wait_loaded(20.0):
        msg = eng.st.get("last_error") or eng.error or "mpv could not open this file."
        eng.stop()
        return jsonify({"error": msg}), 500
    return jsonify(eng.snapshot())


@app.post("/api/player/stop")
def api_player_stop():
    eng = PLAYER["stage"]
    if eng is not None:
        eng.stop()
    return jsonify({"ok": True})


@app.post("/api/player/surface")
def api_player_surface():
    """The page reports where the picture area is (css pixels) and whether it should be showing."""
    eng = PLAYER["stage"]
    if eng is not None:
        d = request.get_json(silent=True) or {}
        holes = []
        for c in (d.get("cuts") or [])[:24]:
            try:
                holes.append({k: float(c[k]) for k in ("x", "y", "w", "h")})
            except (KeyError, TypeError, ValueError):
                continue
        eng.place({k: d.get(k) for k in ("x", "y", "w", "h", "dpr", "vw", "vh", "lift")}, bool(d.get("visible")), holes)
    return jsonify({"ok": True})


@app.post("/api/player/cmd")
def api_player_cmd():
    eng = PLAYER["stage"]
    if eng is None or eng.m is None:
        return jsonify({"ok": False, "error": "no player"})
    d = request.get_json(silent=True) or {}
    cmd, value = str(d.get("cmd") or ""), d.get("value")
    if cmd == "sub-add":                                   # only this app's own /subtitle/ files, never an address chosen by the page
        u = urllib.parse.urlparse(str((value or {}).get("url") or ""))
        if not SUB_URL_OK.match(u.path):
            return jsonify({"ok": False, "error": "bad subtitle address"}), 400
        value = dict(value, url=APP_URL.rstrip("/") + u.path, cookie=request.headers.get("Cookie", ""))
    return jsonify(eng.command(cmd, value))


@app.get("/api/player/state")
def api_player_state():
    eng = PLAYER["stage"]
    if eng is None:
        return jsonify({"state": {}, "events": [], "seq": 0})
    try:
        since = int(request.args.get("since", 0))
    except ValueError:
        since = 0
    return jsonify(eng.snapshot(since, diag=request.args.get("diag") == "1"))


@app.get("/api/player/screenshot")
def api_player_screenshot():
    eng = PLAYER["stage"]
    if eng is None or eng.m is None:
        abort(404)
    if eng.st.get("private") and not valid_token(token_from_request()):
        abort(403)
    tmp = DATA_DIR / "tmp" / ("shot-%s.png" % secrets.token_hex(6))
    tmp.parent.mkdir(parents=True, exist_ok=True)
    try:
        if not eng.screenshot(tmp, with_subs=request.args.get("subs") == "1"):
            abort(404)
        data = tmp.read_bytes()
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return Response(data, mimetype="image/png", headers={"Cache-Control": "no-store"})


@app.post("/api/player/folder")
def api_player_folder():
    d = Path(str((request.get_json(silent=True) or {}).get("path") or "").strip().strip('"')).expanduser()
    if not any((x / n).is_file() for x in (d, d / "bin") for n in mpv_backend.LIB_NAMES):
        return jsonify({"error": "That folder has no libmpv-2.dll."}), 400
    save_prefs({"mpv_dir": str(d)})
    mpv_backend.reset_module_cache()
    return jsonify(mpv_status())


# ---- the pop-out (mini) player: its own always-on-top mpv window
def _mini_event(ev):
    """Called by the mini engine: the window was closed, or E / a double click asked to go back to the big player."""
    vid, t, dur = str(ev.get("id") or ""), float(ev.get("t") or 0), float(ev.get("dur") or 0)
    if vid and dur > 0:
        try:
            save_video_progress(vid, t, dur)
        except Exception:
            log.warning("_mini_event: progress not saved", exc_info=True)
    if ev.get("type") == "expand":
        try:
            show_from_tray()
        except Exception:
            log.warning("_mini_event: Exception ignored", exc_info=True)
        _tell_main("window.miniExpand && miniExpand(%s, %s)" % (json.dumps(vid), t))
    else:
        _tell_main("window.miniClosed && miniClosed()")


def _mini_progress_loop(eng):
    while eng.m is not None and not eng._stop.wait(5.0):
        st = eng.st
        if st.get("loaded") and not st.get("paused") and st.get("id") and st.get("dur", 0) > 0:
            save_video_progress(st["id"], st.get("t", 0.0), st["dur"])


def native_mini_open(vid, t, paused, vol):
    """Pop the video out into a native mpv window. False = not possible here (the caller then uses the web mini window)."""
    try:
        if not get_prefs()["mpv_enabled"]:
            return False
        v = get_video(str(vid or ""))
        if not v:
            return False
        with PLAYER_LOCK:
            old, PLAYER["mini"] = PLAYER["mini"], None
            if old is not None:
                old.shutdown()
            eng = mpv_backend.Engine("mini", get_prefs, DATA_DIR / "mpv", mpv_dirs, main_title=APP_TITLE, on_event=_mini_event)
            if not eng.available() or not eng.ensure():
                return False
            vol = 1.0 if vol is None else max(0.0, min(1.0, float(vol)))
            quiet = bool(v["private"]) and bool(get_prefs().get("private_start_muted", True))      # private videos pop out muted (M gives sound back)
            if not eng.load(v["path"], start=float(t or 0), paused=bool(paused), volume=vol, mute=(vol <= 0 or quiet), vid=v["id"], private=v["private"]):
                eng.shutdown()
                return False
            PLAYER["mini"] = eng
        stage = PLAYER["stage"]
        if stage is not None:
            stage.stop()                                       # the page closes its own player right after this call
        threading.Thread(target=_mini_progress_loop, args=(eng,), daemon=True).start()
        try:                                                   # a subtitle file next to the video, like the big player (never blocks the pop-out)
            if eng.wait_loaded(10.0) and get_prefs().get("subs_auto"):
                subs = find_subtitles(Path(v["path"]))
                if subs:
                    res = eng.command("sub-add", {"url": str(subs[0][0]), "title": subs[0][1], "lang": subs[0][2]})
                    if res.get("ok"):
                        eng.command("sid", res.get("id"))
        except Exception:
            log.warning("native_mini_open: subtitles skipped", exc_info=True)
        return True
    except Exception:
        log.warning("native_mini_open failed, using the web mini window", exc_info=True)
        return False



# ----------------------------------------------------------------------------- phone remote (see remote.py)
def remote_is_public(vid):
    with LIB_LOCK:
        v = LIB["videos"].get(str(vid or ""))
    return bool(v) and not v["private"]


def remote_poster(vid):
    with LIB_LOCK:
        v = LIB["videos"].get(str(vid or ""))
    if not v or v["private"]:
        return None
    side = find_sidecar_poster(v)
    if side:
        return side
    p = POSTER_DIR / f"{vid}.jpg"
    return p if p.is_file() else None


def remote_library():
    """Continue watching for the phone: public videos you stopped part-way, newest first. Never private ones."""
    with closing(db()) as con:
        rows = con.execute("""SELECT id, custom_title, position, duration FROM videos
                              WHERE missing = 0 AND position > 20 AND duration > 0 AND position < duration * 0.95
                              ORDER BY progress_at DESC LIMIT 40""").fetchall()
    out = []
    with LIB_LOCK:
        for r in rows:
            v = LIB["videos"].get(r["id"])
            if not v or v["private"]:
                continue
            sr = LIB["series"].get(v.get("series_id") or "")
            out.append({"id": r["id"], "title": display_title(r["custom_title"], v["title"]), "sub": sr["name"] if sr else "",
                        "progress": round(r["position"] / r["duration"], 3), "left": int(r["duration"] - r["position"])})
            if len(out) >= 12:
                break
    return out


app.register_blueprint(remote.bp)


def main():
    ap = argparse.ArgumentParser(description="ULTRON")
    ap.add_argument("--videos", help="folder with videos (default ./media/videos)")
    ap.add_argument("--music", help="folder with music (default ./media/music)")
    ap.add_argument("--private", help="folder with private videos (default ./media/private)")
    ap.add_argument("--browser", action="store_true", help="open in the default browser instead of a desktop window")
    ap.add_argument("--debug", action="store_true", help="enable the webview developer tools")
    args = ap.parse_args()
    for name in ("stdout", "stderr"):                    # windowed .exe builds have no console streams
        if getattr(sys, name) is None:
            setattr(sys, name, open(os.devnull, "w"))
    if not claim_single_instance():                       # already running: it has been asked to come forward
        sys.exit(0)
    kill_children_with_me()
    saved = load_settings().get("prefs") or {}            # folders chosen in Settings (command-line options still win)
    for key in FOLDER_KEYS.values():
        raw = str(saved.get(key) or "").strip()
        if raw:
            path = Path(raw).expanduser()
            try:
                path.mkdir(parents=True, exist_ok=True)
                CFG[key] = path
            except OSError:
                if not drive_present(path):               # drive unplugged: keep the folder, the library waits for it
                    CFG[key] = path
                    print(f"Saved folder {raw} is on a drive that is not connected. It is used again as soon as the drive is back.")
                    log.warning("saved folder %s (%s): drive not connected, kept", raw, key)
                else:
                    print(f"Saved folder {raw} is not available, using the default.")
                    log.warning("saved folder %s (%s) not available, using the default", raw, key, exc_info=True)
    if args.videos:
        CFG["video_dir"] = Path(args.videos).expanduser()
    if args.music:
        CFG["music_dir"] = Path(args.music).expanduser()
    if args.private:
        CFG["private_dir"] = Path(args.private).expanduser()

    for d in (DATA_DIR, POSTER_DIR, BACKDROP_DIR, TILE_DIR, CUSTOM_TILE_DIR, THUMB_DIR):
        d.mkdir(parents=True, exist_ok=True)
    for d in (CFG["video_dir"], CFG["music_dir"], CFG["private_dir"], CFG["private_dir"] / PHOTO_FOLDER, CFG["photo_dir"]):
        try:
            d.mkdir(parents=True, exist_ok=True)
        except OSError:                                   # media on a drive that is not connected: the scans wait for it
            log.warning("media folder %s not available at start-up", d)
    shutil.rmtree(DL_DIR, ignore_errors=True)         # leftovers of an interrupted download
    init_db()
    migrate_music_cache()
    load_protected()                                  # creates artist_rules.txt next to the app on first run
    print(f"Videos: {CFG['video_dir']}\nMusic:  {CFG['music_dir']}\nPrivate: {CFG['private_dir']}")
    STARTUP_SCAN.clear()
    def _first_scan():
        try:
            print(f"Found {scan_videos()} videos. Indexing music in the background...")
        except Exception:
            log.warning("first video scan failed", exc_info=True)
        finally:
            STARTUP_SCAN.set()
        background_io(True)
        scan_music()
    threading.Thread(target=_first_scan, daemon=True).start()
    threading.Thread(target=lambda: (STARTUP_SCAN.wait(180), pregenerate_posters()), daemon=True).start()
    threading.Thread(target=folder_watcher, daemon=True).start()
    threading.Thread(target=weekly_auto_backup, daemon=True).start()
    remote.init(DATA_DIR, RES_DIR, remote_library, remote_poster, remote_is_public)

    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    port = free_port()
    threading.Thread(target=lambda: app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False),
                     daemon=True).start()
    if not wait_for_server(port):
        sys.exit("The local server did not start.")
    url = f"http://127.0.0.1:{port}/"
    globals()["APP_URL"] = url
    os.environ.setdefault("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--autoplay-policy=no-user-gesture-required")

    if args.browser:
        webbrowser.open(url)
        print(f"Running at {url}  (Ctrl+C to stop)")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return
    import webview
    global WINDOW, FULLSCREEN
    prefs = get_prefs()
    mode = prefs["display_mode"]
    FULLSCREEN = False                                # a start-up fullscreen is applied below by set_fullscreen()
    set_app_id()
    WINDOW = webview.create_window(APP_TITLE, url, width=prefs["win_width"], height=prefs["win_height"],
                                   min_size=(900, 600), background_color="#141414", js_api=Api(),
                                   fullscreen=False, maximized=(mode == "maximized"))
    WINDOW.events.resized += on_window_resized
    WINDOW.events.closing += on_window_closing
    WINDOW.events.closed += on_window_closed
    logo_path = find_logo()
    extra = {"icon": str(logo_path)} if logo_path and os.name != "nt" else {}   # Linux/macOS only; on Windows pywebview feeds it to System.Drawing.Icon, which rejects PNG/JPEG and crashes. Windows uses set_window_icon instead
    def on_started():
        set_window_icon(APP_TITLE)
        start_tray()
        if mode == "fullscreen":
            time.sleep(0.6)                           # let the window finish opening first
            set_fullscreen(True)

    wv_dir = DATA_DIR / "webview"
    wv_dir.mkdir(parents=True, exist_ok=True)
    try:
        webview.start(on_started, debug=args.debug, private_mode=False, storage_path=str(wv_dir), **extra)
    except TypeError:                                 # very old pywebview without these options
        webview.start(on_started, debug=args.debug, **extra)
    finish_exit()                                     # webview.start() returned: every window is closed



# ----------------------------------------------------------------------------- movies: probe, strip, clips, auto-sort
# (playback itself is libmpv now: see the "native player" section. Nothing is converted or copied any more.)
STRIP_DIR = DATA_DIR / "strips"           # filmstrip images for the precision trimmer
PROBE_CACHE = {}
PROBE_FILE = DATA_DIR / "probe_cache.json"   # ffprobe + black-bar detection read the movie in several places: do it once, ever
PROBE_DISK = {}
PROBE_LOCK = threading.Lock()
PROBE_STATE = {"loaded": False}


def ff_tools():
    t = ytdlp_tools()
    return t["ffmpeg"], t["ffprobe"]


def _fraction(s):
    try:
        a, _, b = str(s).partition("/")
        return float(a) / float(b or 1) if float(b or 1) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _detect_crop(ffmpeg, path, duration, w, h):
    """Black bars baked into the picture (cropdetect on a few short samples). Returns (x, y, w, h) or None."""
    if not ffmpeg or duration < 30:
        return None
    seen = Counter()
    for frac in (0.2, 0.45, 0.7):
        try:
            r = ff_run([str(ffmpeg), "-v", "info", "-nostdin", "-ss", f"{duration * frac:.1f}", "-i", str(path), "-t", "2",
                                "-an", "-sn", "-vf", "cropdetect=limit=24:round=2:reset=0", "-f", "null", "-"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=40,
                               creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
        except Exception:
            log.warning("cropdetect failed", exc_info=True)
            continue
        found = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", r.stderr or "")
        if found:
            seen[tuple(int(x) for x in found[-1])] += 1
    if not seen:
        return None
    cw, ch, cx, cy = seen.most_common(1)[0][0]
    if cw <= 0 or ch <= 0 or cw > w or ch > h:
        return None
    if (h - ch) < h * 0.03 and (w - cw) < w * 0.03:           # nothing worth removing
        return None
    return cx, cy, cw, ch


def _probe_disk_key(v):
    return f"{v['id']}|{int(v['mtime'] or 0)}"


def _probe_disk_get(v):
    with PROBE_LOCK:
        if not PROBE_STATE["loaded"]:
            PROBE_STATE["loaded"] = True
            try:
                data = json.loads(PROBE_FILE.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    PROBE_DISK.update(data)
            except (OSError, ValueError):
                pass
        return PROBE_DISK.get(_probe_disk_key(v))


def _probe_disk_put(v, out):
    with PROBE_LOCK:
        PROBE_DISK.pop(_probe_disk_key(v), None)
        PROBE_DISK[_probe_disk_key(v)] = out
        while len(PROBE_DISK) > 3000:                          # forget the oldest
            PROBE_DISK.pop(next(iter(PROBE_DISK)))
        try:
            PROBE_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = PROBE_FILE.with_name(PROBE_FILE.name + ".tmp")
            tmp.write_text(json.dumps(PROBE_DISK), encoding="utf-8")
            tmp.replace(PROBE_FILE)
        except OSError:
            log.warning("could not save the probe cache", exc_info=True)


def probe_video(v):
    key = (v["id"], v["mtime"])
    if key in PROBE_CACHE:
        return dict(PROBE_CACHE[key])
    ffmpeg, ffprobe = ff_tools()
    saved = _probe_disk_get(v) if (ffmpeg and ffprobe) else None
    if saved:
        saved.pop("problem", None)                             # older cache files carried a "needs conversion" flag
        PROBE_CACHE[key] = dict(saved, ffmpeg=True)
        return dict(PROBE_CACHE[key])
    out = {"w": 0, "h": 0, "ratio": 0, "fps": 0, "duration": 0, "vcodec": "", "audio": [],
           "crop": None, "ffmpeg": bool(ffmpeg)}
    sar = 1.0
    if ffprobe:
        try:
            r = run_tool([str(ffprobe), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(v["path"])], 40)
            info = json.loads(r.stdout or "{}")
            for s in info.get("streams", []):
                if s.get("codec_type") == "video" and not out["vcodec"] and not (s.get("disposition") or {}).get("attached_pic"):
                    out.update(w=int(s.get("width") or 0), h=int(s.get("height") or 0), vcodec=s.get("codec_name") or "",
                               fps=round(_fraction(s.get("avg_frame_rate")) or _fraction(s.get("r_frame_rate")), 3))
                    a, _, b = str(s.get("sample_aspect_ratio") or "1:1").partition(":")
                    try:
                        sar = float(a) / float(b) if float(b) and float(a) else 1.0
                    except ValueError:
                        sar = 1.0
                    out["_pix"] = s.get("pix_fmt") or ""
                elif s.get("codec_type") == "audio":
                    out["audio"].append({"codec": s.get("codec_name") or "", "lang": (s.get("tags") or {}).get("language", "")})
            out["duration"] = round(float((info.get("format") or {}).get("duration") or 0), 3)
        except Exception:
            log.warning("ffprobe failed for %s", v["path"], exc_info=True)
    if not out["w"] and cv2 is not None:                       # no ffprobe: OpenCV knows the basics
        try:
            cap = cv2.VideoCapture(str(v["path"]))
            out.update(w=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0), h=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
                       fps=round(cap.get(cv2.CAP_PROP_FPS) or 0, 3))
            n = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
            out["duration"] = round(n / out["fps"], 3) if out["fps"] > 0 and n > 0 else 0
            cap.release()
        except Exception:
            log.warning("opencv probe failed", exc_info=True)
    if out["w"] and out["h"]:
        out["ratio"] = round(out["w"] / out["h"] * sar, 4)
    out.pop("_pix", None)
    c = _detect_crop(ffmpeg, v["path"], out["duration"], out["w"], out["h"]) if out["w"] else None
    if c:
        cx, cy, cw, ch = c
        out["crop"] = {"x": cx, "y": cy, "w": cw, "h": ch, "ratio": round(cw / ch * sar, 4)}
    if len(PROBE_CACHE) > 400:
        PROBE_CACHE.clear()
    PROBE_CACHE[key] = out
    if ffmpeg and ffprobe and out.get("w") and not unsettled(v["path"]):                    # only keep a complete result
        _probe_disk_put(v, out)
    return dict(out)


@app.get("/api/videos/<vid>/probe")
def api_video_probe(vid):
    v = get_video_checked(vid)
    return jsonify(probe_video(v))


# ----------------------------------------------------------------------------- FFmpeg is required
# Playback does not need ffmpeg (libmpv plays everything). ffmpeg + ffprobe are still used for black-bar detection, the precision
# trimmer, clips, auto subtitles and the downloader, so the page offers a one-click setup (it can be skipped).
FF_STATE = {"state": "idle", "pct": 0, "msg": "", "error": ""}        # idle | running | error
FF_LOCK = threading.Lock()
FF_URLS = ["https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
           "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"]


def _ff_set(**kw):
    with FF_LOCK:
        FF_STATE.update(kw)


def ff_status():
    ffmpeg, ffprobe = ff_tools()
    with FF_LOCK:
        st = dict(FF_STATE)
    return {"ok": bool(ffmpeg and ffprobe), "ffmpeg": str(ffmpeg or ""), "ffprobe": str(ffprobe or ""),
            "windows": os.name == "nt", "folder": str(DATA_DIR / "ffmpeg"), "install": st}


def _ff_install_worker():
    import zipfile
    dest = DATA_DIR / "ffmpeg"
    zpath = dest / "download.part"
    last = ""
    try:
        dest.mkdir(parents=True, exist_ok=True)
        for url in FF_URLS:
            try:
                _ff_set(msg="Downloading FFmpeg (about 80 MB)...", pct=0, error="")
                req = urllib.request.Request(url, headers={"User-Agent": "ULTRON"})
                with urllib.request.urlopen(req, timeout=30) as r, open(zpath, "wb") as f:
                    total, got = int(r.headers.get("Content-Length") or 0), 0
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if total:
                            _ff_set(pct=min(90, int(got / total * 90)))
                _ff_set(msg="Unpacking...", pct=92)
                found = 0
                with zipfile.ZipFile(zpath) as z:
                    for name in z.namelist():
                        n = name.replace("\\", "/")
                        base = n.rsplit("/", 1)[-1].lower()
                        if base in ("ffmpeg.exe", "ffprobe.exe") and "/bin/" in n:
                            with z.open(name) as src, open(dest / base, "wb") as out:
                                shutil.copyfileobj(src, out)
                            found += 1
                if found < 2:
                    raise RuntimeError("the download did not contain ffmpeg.exe and ffprobe.exe")
                break
            except Exception as e:
                last = str(e) or e.__class__.__name__
                log.warning("ffmpeg download from %s failed", url, exc_info=True)
        else:
            raise RuntimeError(last or "download failed")
        _ff_set(msg="Checking...", pct=97)
        r = run_tool([str(dest / "ffmpeg.exe"), "-version"], 30)
        if r.returncode != 0:
            raise RuntimeError("ffmpeg.exe was downloaded but does not run on this PC")
        _ff_set(state="idle", pct=100, msg="Done", error="")
    except Exception as e:
        log.exception("ffmpeg install failed")
        _ff_set(state="error", pct=0, msg="", error=(str(e) or "download failed")[:300])
    finally:
        try:
            zpath.unlink()
        except OSError:
            pass


@app.get("/api/ffmpeg/status")
def api_ffmpeg_status():
    return jsonify(ff_status())


@app.post("/api/ffmpeg/install")
def api_ffmpeg_install():
    if os.name != "nt":
        return jsonify({"error": "Install ffmpeg with your package manager (for example: sudo apt install ffmpeg), then press Check again."}), 400
    with FF_LOCK:
        if FF_STATE["state"] == "running":
            return jsonify(ff_status())
        FF_STATE.update(state="running", pct=0, msg="Starting...", error="")
    threading.Thread(target=_ff_install_worker, daemon=True).start()
    return jsonify(ff_status())


@app.post("/api/ffmpeg/folder")
def api_ffmpeg_folder():
    raw = str((request.get_json(silent=True) or {}).get("path") or "").strip().strip('"')
    d = Path(raw).expanduser() if raw else None
    if not d or not d.is_dir() or not any((x / ("ffmpeg" + EXE_SUFFIX)).is_file() and (x / ("ffprobe" + EXE_SUFFIX)).is_file() for x in (d, d / "bin")):
        return jsonify({"error": "That folder does not contain both ffmpeg and ffprobe."}), 400
    save_prefs({"ffmpeg_dir": str(d)})
    return jsonify(ff_status())


def _strip_frame(ffmpeg, path, t, w):
    try:
        if ffmpeg:
            r = ff_run([str(ffmpeg), "-v", "error", "-nostdin", "-ss", f"{max(0.0, t):.3f}", "-i", str(path), "-frames:v", "1",
                                "-vf", f"scale={w}:-2", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "6", "-"],
                               capture_output=True, timeout=60, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
            if r.stdout:
                return cv2.imdecode(np.frombuffer(r.stdout, np.uint8), cv2.IMREAD_COLOR)
        cap = cv2.VideoCapture(str(path))
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000)
        ok, fr = cap.read()
        cap.release()
        if ok and fr is not None:
            hh, ww = fr.shape[:2]
            return cv2.resize(fr, (w, max(2, int(hh * w / ww))), interpolation=cv2.INTER_AREA)
    except Exception:
        log.warning("strip frame failed", exc_info=True)
    return None


@app.get("/api/videos/<vid>/strip")
def api_video_strip(vid):
    """One wide JPEG with n frames spread evenly between a and b (seconds): the trimmer's filmstrip."""
    v = get_video_checked(vid)
    if cv2 is None or np is None:
        abort(404)
    try:
        a, b = float(request.args.get("a", 0)), float(request.args.get("b", 0))
    except ValueError:
        abort(400)
    n = _int(request.args.get("n"), 1, 40, 12)
    w = _int(request.args.get("w"), 60, 400, 180)
    if not (b > a >= 0):
        abort(400)
    key = hashlib.sha1(f"{vid}|{int(v['mtime'] or 0)}|{a:.2f}|{b:.2f}|{n}|{w}".encode()).hexdigest()[:20]
    out = STRIP_DIR / f"{key}.jpg"
    if not out.is_file():
        STRIP_DIR.mkdir(parents=True, exist_ok=True)
        files = sorted(STRIP_DIR.glob("*.jpg"), key=lambda p: p.stat().st_mtime)
        for old in files[:-300]:                              # keep the cache small
            try:
                old.unlink()
            except OSError:
                pass
        ffmpeg, _ = ff_tools()
        times = [a + (i + 0.5) * (b - a) / n for i in range(n)]
        with ThreadPoolExecutor(max_workers=2) as ex:
            frames = list(ex.map(lambda t: _strip_frame(ffmpeg, v["path"], t, w), times))
        good = [f for f in frames if f is not None]
        if not good:
            abort(404)
        h0, w0 = good[0].shape[:2]
        cells = [cv2.resize(f, (w0, h0)) if f is not None else np.zeros((h0, w0, 3), np.uint8) for f in frames]
        ok, buf = cv2.imencode(".jpg", np.hstack(cells), [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        if not ok:
            abort(500)
        out.write_bytes(buf.tobytes())
    return send_file(out, mimetype="image/jpeg", max_age=3600)


def _stamp(t):
    t = int(t)
    return f"{t // 3600}h{t % 3600 // 60:02d}m{t % 60:02d}s" if t >= 3600 else f"{t // 60}m{t % 60:02d}s"


@app.post("/api/videos/<vid>/clip")
def api_video_clip(vid):
    """Saves the IN..OUT part as its own file in Videos/Clips without re-encoding (cuts land on the nearest earlier keyframe)."""
    v = get_video_checked(vid)
    if v["private"]:
        return jsonify({"error": "Clips are not saved from the private library."}), 400
    body = request.get_json(silent=True) or {}
    try:
        a, b = float(body.get("a")), float(body.get("b"))
    except (TypeError, ValueError):
        return jsonify({"error": "Set IN and OUT first."}), 400
    if not (b - a >= 0.2 and a >= 0):
        return jsonify({"error": "OUT has to come after IN."}), 400
    ffmpeg, _ = ff_tools()
    if not ffmpeg:
        return jsonify({"error": "ffmpeg was not found. Set its folder in Settings > Downloader tools."}), 400
    folder = effective_dir("clips_dir")
    folder.mkdir(parents=True, exist_ok=True)
    with LIB_LOCK:
        title = v["title"]
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", f"{title} (clip {_stamp(a)}-{_stamp(b)})").strip()[:120] or "clip"
    dest, n = folder / (base + v["path"].suffix), 2
    while dest.exists():
        dest = folder / f"{base} ({n}){v['path'].suffix}"
        n += 1
    try:
        r = ff_run([str(ffmpeg), "-y", "-v", "error", "-nostdin", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(v["path"]),
                            "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-avoid_negative_ts", "make_zero", str(dest)],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900, long=True,
                           creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
    except Exception as e:
        return jsonify({"error": f"Could not save the clip: {e}"}), 500
    if r.returncode != 0 or not dest.is_file():
        try:
            dest.unlink()
        except OSError:
            pass
        return jsonify({"error": (r.stderr or "ffmpeg failed").strip().splitlines()[-1][:200]}), 500
    schedule_scan()
    return jsonify({"file": dest.name})


@app.post("/api/autosort/run")
def api_autosort_run():
    """Looks at the video folder again (with the Auto-sort / Clean names settings) and reports what it found."""
    scan_videos()
    d = video_cards(False)
    with LIB_LOCK:
        vids = [x for x in LIB["videos"].values() if not x["private"]]
        auto_series = [s for s in LIB["series"].values() if s.get("virtual") and not s["private"]]
    in_coll = sum(c["count"] for c in d.get("collections", []))
    roots = [x for x in vids if x.get("root") and not x["series_id"]]
    return jsonify({"collections": [{"name": c["name"], "count": c["count"]} for c in d.get("collections", [])],
                    "series": [{"name": s["name"], "episodes": len(s["episodes"])} for s in auto_series],
                    "singles": max(0, len(roots) - in_coll),
                    "in_folders": sum(1 for x in vids if x["genre"])})


# ----------------------------------------------------------------------------- auto subtitles (Whisper + NLLB, all local)
ASUB_DIR = DATA_DIR / "autosubs"
ASUB_TMP = DATA_DIR / "autosubs" / "tmp"
ASUB_MODELS = APP_DIR / "models"
ASUB_JOBS = {}                     # "<video id>:<target>" -> job dict
ASUB_Q = queue.Queue()
ASUB_LOCK = threading.Lock()
ASUB_DL = {"state": "idle", "pct": 0, "msg": "", "error": ""}
ASUB_STARTED = []


def _asub_public(j):
    return {k: j[k] for k in ("id", "vid", "target", "mode", "state", "pct", "msg", "error", "title") if k in j}


def _asub_set(job, **kw):
    with ASUB_LOCK:
        job.update(kw)


def _asub_worker():
    while True:
        job = ASUB_Q.get()
        try:
            if job["cancel"].is_set():
                _asub_set(job, state="cancelled", msg="Cancelled")
                continue
            _asub_set(job, state="running", pct=0, msg="Starting...", error="")
            v = get_video(job["vid"])
            if not v:
                raise RuntimeError("The video is not in the library any more.")
            ffmpeg, _ = ff_tools()
            if not ffmpeg:
                raise RuntimeError("ffmpeg was not found. Install it from the setup screen first.")
            key = autosubs.video_key(v["path"])
            autosubs.generate(
                v["path"], ffmpeg, key, ASUB_DIR, ASUB_MODELS, ASUB_TMP, job["target"], job["mode"], job["source"], job["force"],
                lambda pct, msg: _asub_set(job, pct=int(pct), msg=msg), job["cancel"].is_set)
            _asub_set(job, state="done", pct=100, msg="Done")
        except autosubs.Cancelled:
            _asub_set(job, state="cancelled", msg="Cancelled")
        except Exception as e:
            log.exception("auto subtitles failed")
            _asub_set(job, state="error", msg="", error=(str(e) or e.__class__.__name__)[:300])
        finally:
            if ASUB_Q.empty():
                try:
                    autosubs.unload()                      # give the RAM back when nothing is waiting
                except Exception:
                    log.warning("unload failed", exc_info=True)
            try:
                for f in ASUB_TMP.glob("*.wav"):
                    if time.time() - f.stat().st_mtime > 3600:
                        f.unlink()
            except OSError:
                pass


def _asub_enqueue(vid, target, mode, source, force):
    jid = "%s:%s" % (vid, target)
    with ASUB_LOCK:
        old = ASUB_JOBS.get(jid)
        if old and old["state"] in ("queued", "running"):
            return old
        v = get_video(vid)
        job = {"id": jid, "vid": vid, "target": target, "mode": mode, "source": source, "force": force,
               "state": "queued", "pct": 0, "msg": "Waiting in line...", "error": "",
               "title": (v or {}).get("title", ""), "cancel": threading.Event(), "t": time.time()}
        ASUB_JOBS[jid] = job
        done = sorted((j for j in ASUB_JOBS.values() if j["state"] not in ("queued", "running")), key=lambda j: j["t"])
        for j in done[:-40]:                                # keep the list short
            ASUB_JOBS.pop(j["id"], None)
        if not ASUB_STARTED:
            ASUB_STARTED.append(True)
            threading.Thread(target=_asub_worker, daemon=True, name="asub").start()
    ASUB_Q.put(job)
    return job


def _asub_ready_error(mode):
    if not autosubs:
        return "The auto-subtitle module is missing from this build."
    st = autosubs.status(ASUB_MODELS)
    if not st["packages"]["ok"]:
        return "The AI packages are missing (%s). Run build_exe.bat again, or: pip install faster-whisper sentencepiece huggingface_hub" % (
            ", ".join(st["packages"]["missing"]))
    if not st["can_transcribe"]:
        return "No speech model is installed yet. Download one in Settings > Subtitles."
    return ""


@app.get("/api/autosubs/status")
def api_autosubs_status():
    if not autosubs:
        return jsonify({"ready": False, "available": False, "langs": [], "download": dict(ASUB_DL)})
    st = autosubs.status(ASUB_MODELS)
    st["available"] = True
    with ASUB_LOCK:
        st["download"] = dict(ASUB_DL)
        st["active"] = sum(1 for j in ASUB_JOBS.values() if j["state"] in ("queued", "running"))
    return jsonify(st)


def _asub_dl_worker(keys):
    def rep(pct, msg):
        with ASUB_LOCK:
            ASUB_DL.update(pct=int(pct), msg=msg)
    try:
        autosubs.download(ASUB_MODELS, keys, rep)
        with ASUB_LOCK:
            ASUB_DL.update(state="idle", pct=100, msg="Done", error="")
    except Exception as e:
        log.exception("model download failed")
        with ASUB_LOCK:
            ASUB_DL.update(state="error", pct=0, msg="", error=(str(e) or "download failed")[:300])


@app.post("/api/autosubs/download")
def api_autosubs_download():
    if not autosubs:
        return jsonify({"error": "The auto-subtitle module is missing from this build."}), 400
    pk = autosubs.packages()
    if not pk["ok"]:
        return jsonify({"error": "The AI packages are missing (%s). Run build_exe.bat again." % ", ".join(pk["missing"])}), 400
    d = request.get_json(silent=True) or {}
    keys = [k for k in (d.get("models") or ["accurate", "fast", "nllb"]) if k in ("accurate", "fast", "nllb")]
    with ASUB_LOCK:
        if ASUB_DL["state"] == "running":
            return jsonify(dict(ASUB_DL))
        ASUB_DL.update(state="running", pct=0, msg="Starting...", error="")
    threading.Thread(target=_asub_dl_worker, args=(keys,), daemon=True).start()
    return jsonify(dict(ASUB_DL))


@app.get("/api/autosubs/jobs")
def api_autosubs_jobs():
    with ASUB_LOCK:
        jobs = sorted(ASUB_JOBS.values(), key=lambda j: j["t"])
        return jsonify({"jobs": [_asub_public(j) for j in jobs[-40:]],
                        "active": sum(1 for j in jobs if j["state"] in ("queued", "running"))})


@app.post("/api/autosubs/cancel-all")
def api_autosubs_cancel_all():
    with ASUB_LOCK:
        for j in ASUB_JOBS.values():
            if j["state"] in ("queued", "running"):
                j["cancel"].set()
    return jsonify({"ok": True})


@app.post("/api/autosubs/queue-all")
def api_autosubs_queue_all():
    """Queues every public video that has no subtitles yet (handy overnight). Private videos are never touched."""
    err = _asub_ready_error("")
    if err:
        return jsonify({"error": err}), 400
    d = request.get_json(silent=True) or {}
    prefs = get_prefs()
    target = d.get("target") or prefs["asub_lang"]
    mode = d.get("mode") if d.get("mode") in ("accurate", "fast") else prefs["asub_mode"]
    if target != "orig" and target not in autosubs.BY_CODE:
        return jsonify({"error": "Unknown language."}), 400
    with LIB_LOCK:
        vids = [dict(v) for v in LIB["videos"].values() if not v["private"]]
    queued = skipped = 0
    for v in sorted(vids, key=lambda x: str(x["path"]).lower()):
        try:
            key = autosubs.video_key(v["path"])
        except OSError:
            continue
        have = {m["target"] for m in autosubs.list_tracks(ASUB_DIR, key) if not m.get("partial")}   # an unfinished one gets finished
        if target in have or find_subtitles(v["path"]):
            skipped += 1
            continue
        _asub_enqueue(v["id"], target, mode, "", False)
        queued += 1
    return jsonify({"queued": queued, "skipped": skipped})


@app.get("/api/videos/<vid>/autosubs")
def api_video_autosubs(vid):
    v = get_video_checked(vid)
    if not autosubs:
        return jsonify({"tracks": [], "jobs": []})
    key = autosubs.video_key(v["path"])
    tracks = [{"target": m["target"], "lang": m.get("lang", "und"), "label": m.get("label", "Subtitles (AI)"),
               "url": "/autosub/%s/%s" % (vid, m["target"]), "created": m.get("created", 0),
               "partial": bool(m.get("partial")), "upto": m.get("upto", 0)}
              for m in autosubs.list_tracks(ASUB_DIR, key)]
    with ASUB_LOCK:
        jobs = [_asub_public(j) for j in ASUB_JOBS.values() if j["vid"] == vid]
    return jsonify({"tracks": tracks, "jobs": jobs})


@app.post("/api/videos/<vid>/autosubs")
def api_video_autosubs_start(vid):
    get_video_checked(vid)
    if not autosubs:
        return jsonify({"error": "The auto-subtitle module is missing from this build."}), 400
    d = request.get_json(silent=True) or {}
    prefs = get_prefs()
    target = str(d.get("target") or prefs["asub_lang"])
    mode = d.get("mode") if d.get("mode") in ("accurate", "fast") else prefs["asub_mode"]
    source = str(d.get("source") or "")
    if target != "orig" and target not in autosubs.BY_CODE:
        return jsonify({"error": "Unknown language."}), 400
    if source and source not in autosubs.BY_CODE:
        source = ""
    err = _asub_ready_error(mode)
    if err:
        return jsonify({"error": err, "need_models": True}), 400
    if target != "orig" and not autosubs.find_nllb(ASUB_MODELS):
        return jsonify({"error": "The translation model is not installed yet. Download it in Settings > Subtitles.", "need_models": True}), 400
    return jsonify(_asub_public(_asub_enqueue(vid, target, mode, source, bool(d.get("force")))))


SUB_STREAM_CACHE = {}


def embedded_sub_count(v):
    """How many subtitle streams are inside the file (None = could not tell). Cached per file version."""
    key = (v["id"], v.get("mtime"))
    if key in SUB_STREAM_CACHE:
        return SUB_STREAM_CACHE[key]
    _, ffprobe = ff_tools()
    n = None
    if ffprobe:
        try:
            r = run_tool([str(ffprobe), "-v", "error", "-select_streams", "s", "-show_entries", "stream=index",
                          "-of", "csv=p=0", str(v["path"])], 40)
            n = len([l for l in (r.stdout or "").splitlines() if l.strip()])
        except Exception:
            log.warning("subtitle stream probe failed for %s", v["path"], exc_info=True)
    if n is not None:
        if len(SUB_STREAM_CACHE) > 800:
            SUB_STREAM_CACHE.clear()
        SUB_STREAM_CACHE[key] = n
    return n


@app.post("/api/videos/<vid>/autosubs/auto")
def api_video_autosubs_auto(vid):
    """Called when a video starts: if it has no subtitles at all (no file next to it, none inside it, none made before),
    listen to it and make them in the chosen language. Never loops: a cancelled or failed try is not repeated by itself."""
    v = get_video_checked(vid)

    def no(reason, **kw):
        return jsonify(dict({"started": False, "reason": reason}, **kw))

    prefs = get_prefs()
    if not autosubs or not prefs.get("asub_enabled", True) or not prefs.get("asub_auto", False):
        return no("off")
    if v.get("private"):
        return no("private")                                    # private videos are never sent through the AI queue by themselves
    target, mode = prefs["asub_lang"], prefs["asub_mode"]
    key = autosubs.video_key(v["path"])
    if any(m["target"] == target and not m.get("partial") for m in autosubs.list_tracks(ASUB_DIR, key)):
        return no("have")
    old = ASUB_JOBS.get("%s:%s" % (vid, target))
    if old and old["state"] in ("queued", "running"):
        return jsonify({"started": True, "job": _asub_public(old)})
    if old and old["state"] in ("error", "cancelled"):
        return no("tried")
    if find_subtitles(v["path"]):
        return no("subtitle_file")
    if embedded_sub_count(v):
        return no("embedded")
    err = _asub_ready_error(mode)
    if not err and target != "orig" and not autosubs.find_nllb(ASUB_MODELS):
        err = "The translation model is not installed yet."
    if err:
        return no("need_models", error=err)
    return jsonify({"started": True, "job": _asub_public(_asub_enqueue(vid, target, mode, "", False))})


@app.post("/api/videos/<vid>/autosubs/cancel")
def api_video_autosubs_cancel(vid):
    get_video_checked(vid)
    with ASUB_LOCK:
        for j in ASUB_JOBS.values():
            if j["vid"] == vid and j["state"] in ("queued", "running"):
                j["cancel"].set()
    return jsonify({"ok": True})


@app.post("/api/videos/<vid>/autosubs/delete")
def api_video_autosubs_delete(vid):
    v = get_video_checked(vid)
    d = request.get_json(silent=True) or {}
    target = str(d.get("target") or "")
    if not autosubs or not re.fullmatch(r"[A-Za-z0-9\-]{2,12}", target):
        return jsonify({"error": "Bad request."}), 400
    autosubs.delete_track(ASUB_DIR, autosubs.video_key(v["path"]), target)
    return jsonify({"ok": True})


@app.get("/autosub/<vid>/<target>")
def autosub_file(vid, target):
    v = get_video_checked(vid)
    if not autosubs or not re.fullmatch(r"[A-Za-z0-9\-]{2,12}", target):
        abort(404)
    p = autosubs.track_path(ASUB_DIR, autosubs.video_key(v["path"]), target)
    if not p.is_file():
        abort(404)
    return Response(p.read_text(encoding="utf-8"), mimetype="text/vtt", headers={"Cache-Control": "no-store"})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        log.critical("fatal error", exc_info=True)
        (APP_DIR / "error.log").write_text(traceback.format_exc(), encoding="utf-8")   # .exe has no console
        raise
