"""ULTRON playback engine: libmpv through python-mpv.

libmpv plays every container and codec itself (MKV, HEVC, AV1, AC3, DTS, TrueHD, ASS subtitles ...) and decodes on the GPU,
so the original file is never touched or converted.

Two kinds of engine live here:
  * "stage": the picture of the main player. mpv renders into a CHILD window that lives inside the ULTRON window
    (mpv's --wid). The web page keeps drawing the title bar and the controls around it and tells us where the picture
    area is. Because the picture is a real child window, Windows itself moves it, hides it (minimise, close-to-tray) and
    destroys it together with the ULTRON window: nothing can be left behind on screen, and there is no polling thread.
  * "mini":  a small always-on-top native mpv window (the pop-out player).

Nothing in this file imports Flask or app.py: app.py wires it in (see the "native player" section there).
"""
from __future__ import annotations

import collections
import ctypes
import logging
import os
import re
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger("ultron.mpv")
IS_WIN = os.name == "nt"
LIB_NAMES = ("libmpv-2.dll", "mpv-2.dll", "libmpv.dll", "mpv-1.dll") if IS_WIN else ("libmpv.so.2", "libmpv.so.1", "libmpv.so", "libmpv.dylib")

# ----------------------------------------------------------------------------- finding libmpv
_MOD = {"mod": None, "lib": "", "error": "", "tried": None}
_MOD_LOCK = threading.Lock()


def find_libmpv(extra_dirs):
    """First folder (from extra_dirs, then PATH) that holds a libmpv library. Returns the file or None."""
    dirs = [Path(d) for d in extra_dirs if d]
    if IS_WIN:
        dirs += [Path(p) for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    for d in dirs:
        for sub in (d, d / "bin"):
            for name in LIB_NAMES:
                try:
                    p = sub / name
                    if p.is_file():
                        return p
                except OSError:
                    continue
    return None


_PINNED = []


def _pin_library(lib):
    """python-mpv looks for the DLL by name (mpv-2.dll / libmpv-2.dll / mpv-1.dll) on PATH. Point those lookups at the file that was
    found (and already loaded) so a differently named build, or another mpv on PATH, can never be picked up by mistake."""
    if _PINNED:
        return
    import ctypes.util
    real = ctypes.util.find_library

    def find_library(name):
        n = str(name).lower()
        if n.endswith(".dll"):
            n = n[:-4]
        if n.startswith("lib"):
            n = n[3:]
        return str(lib) if n in ("mpv", "mpv-1", "mpv-2") else real(name)
    ctypes.util.find_library = find_library
    _PINNED.append(str(lib))


def load_module(extra_dirs=()):
    """Import python-mpv once libmpv can be found. Returns (module or None, library path, error text). Cached per folder set."""
    key = tuple(str(d) for d in extra_dirs)
    with _MOD_LOCK:
        if _MOD["mod"] is not None:
            return _MOD["mod"], _MOD["lib"], ""
        if _MOD["tried"] == key and _MOD["error"]:
            return None, "", _MOD["error"]
        _MOD["tried"] = key
        lib = find_libmpv(extra_dirs)
        try:
            if IS_WIN:
                if lib is None:
                    raise OSError("libmpv-2.dll was not found")
                os.environ["PATH"] = str(lib.parent) + os.pathsep + os.environ.get("PATH", "")
                if hasattr(os, "add_dll_directory"):
                    os.add_dll_directory(str(lib.parent))
                ctypes.CDLL(str(lib))                            # load it by full path first
                _pin_library(lib)                                # ... and make python-mpv use exactly this file, whatever it is called
            import mpv                                           # noqa: WPS433  (python-mpv; raises OSError when libmpv is missing)
            _MOD.update(mod=mpv, lib=str(lib or ""), error="")
            return mpv, str(lib or ""), ""
        except ImportError:
            _MOD["error"] = "The python-mpv package is not installed (pip install python-mpv)."
        except OSError as e:
            _MOD["error"] = ("libmpv was not found. Put libmpv-2.dll next to ULTRON.exe (or in the data\\mpv folder)." if IS_WIN
                             else "libmpv was not found. Install it (for example: sudo apt install libmpv2).") + f" ({e})"
        except Exception as e:                                   # a broken DLL (wrong bitness, missing dependency)
            _MOD["error"] = f"libmpv could not be loaded: {e}"
        return None, "", _MOD["error"]


def reset_module_cache():
    with _MOD_LOCK:
        if _MOD["mod"] is None:
            _MOD.update(error="", tried=None)


# ----------------------------------------------------------------------------- options (the hardware profile)
BLOCKED_EXTRA = re.compile(r"^(script|scripts|script-opts|include|input-conf|input-commands|input-ipc-server|input-file|"
                           r"config|config-dir|ytdl.*|log-file|watch-later.*|load-scripts|wid|vo-.*-wid|use-filedir-conf|"
                           r"cover-art-files|sub-file|audio-file)$")


def parse_extra(text):
    """'key=value' lines from the Settings box -> dict. Unsafe options (scripts, command hooks, IPC) are dropped."""
    out = {}
    for line in str(text or "").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or "=" not in line:
            continue
        k, v = (s.strip() for s in line.split("=", 1))
        k = k.lstrip("-")
        if re.fullmatch(r"[a-z0-9][a-z0-9\-]{0,60}", k) and len(v) <= 160 and not BLOCKED_EXTRA.match(k):
            out[k] = v
    return out


def build_options(p, kind="stage", title="ULTRON-mpv", geometry="", wid=None):
    """Everything mpv needs at start-up, from the saved prefs.

    The defaults are tuned for: AMD Radeon RX 6950 XT (RDNA2, D3D11VA decode for H.264 / HEVC / VP9 / AV1, no iGPU on the
    i7-12700F so there is nothing else to pick by mistake), a fixed-refresh monitor, and an M-Audio Duo interface feeding
    stereo headphones (so: WASAPI, stereo downmix, the display clock steers the audio resampler instead of dropping frames).
    """
    hw = str(p.get("mpv_hwdec") or "auto")
    if hw == "auto":
        hw = "d3d11va" if IS_WIN else "auto-safe"
    o = {
        "vo": "gpu-next",
        "hwdec": hw,
        "hwdec-codecs": "all",                       # also 10-bit HEVC, VP9 and AV1 on the GPU
        "vd-lavc-dr": "yes",                         # direct rendering: fewer copies, easier on RAM bandwidth
        "video-sync": str(p.get("mpv_sync") or "display-resample"),
        "interpolation": "yes" if p.get("mpv_interpolation") else "no",
        "tscale": "oversample",
        "audio-channels": "stereo" if p.get("mpv_stereo", True) else "auto-safe",
        "audio-normalize-downmix": "yes",            # 5.1 / 7.1 film mixes folded down without clipping
        "audio-pitch-correction": "yes",
        "audio-client-name": "ULTRON",
        "cache": "yes",
        "demuxer-max-bytes": "512MiB",               # plenty of RAM: a big read-ahead keeps UHD remuxes smooth
        "demuxer-max-back-bytes": "256MiB",
        "demuxer-readahead-secs": "90",
        "hr-seek": "yes",                            # frame exact seeks (resume, A-B loop, trimmer)
        "keep-open": "yes",                          # stay on the last frame so the page can show "up next"
        "sub-auto": "no",                            # the page decides which subtitle files to load
        "sid": "no",
        "sub-scale": "%.2f" % (int(p.get("subs_size") or 100) / 100.0),
        "ytdl": "no",
        "osd-level": "1",
        "screenshot-format": "png",
        "input-default-bindings": "no",
        "input-vo-keyboard": "yes",
        "osc": "no" if p.get("mpv_overlay", True) else "yes",   # overlay layout: the page draws every control
        "cursor-autohide": "1500",
        "volume-max": "100",
        "title": title,
        "force-window": "yes" if kind == "mini" else "no",
        "idle": "yes",
    }
    if IS_WIN:
        o.update({"gpu-api": "d3d11", "gpu-context": "d3d11", "ao": "wasapi"})
        if p.get("mpv_exclusive"):
            o["audio-exclusive"] = "yes"             # bit-perfect straight to the M-Audio Duo (blocks other apps' sound)
    if kind == "mini":
        o.update({"ontop": "yes", "border": "no", "geometry": geometry or "480x270-24-90", "autofit": "480x270",
                  "window-dragging": "yes", "keepaspect-window": "yes"})
    else:
        o.update({"border": "no", "ontop": "no", "keepaspect-window": "no", "taskbar-progress": "no", "window-dragging": "no"})
        if wid:
            o["wid"] = str(wid)                                  # render into the child window inside ULTRON
            o["force-window"] = "yes"                            # create the (still hidden) picture surface right away, not at the first frame
        if geometry:
            o["geometry"] = geometry
    for k, v in parse_extra(p.get("mpv_extra")).items():
        o[k] = v
    return o


def safe_options(o):
    """The same thing with only options every libmpv from the last few years understands (used if the first start fails)."""
    o = dict(o)
    o["vo"] = "gpu"
    for k in ("gpu-api", "gpu-context", "hwdec-codecs", "vd-lavc-dr", "tscale"):
        o.pop(k, None)
    o["hwdec"] = "auto-safe"
    return o


# ----------------------------------------------------------------------------- Windows window plumbing
class _U32:
    """A private copy of user32 with correct 64-bit prototypes (the shared ctypes.windll one is also used by app.py)."""

    def __init__(self):
        from ctypes import wintypes as wt
        self.wt = wt
        u = ctypes.WinDLL("user32", use_last_error=True)
        self.u = u
        P, I, U = wt.HWND, ctypes.c_int, wt.UINT
        u.CreateWindowExW.restype = P
        u.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, I, I, I, I, P, wt.HMENU, wt.HINSTANCE, wt.LPVOID]
        u.DestroyWindow.argtypes = [P]
        u.IsWindow.argtypes = [P]
        u.IsWindowVisible.argtypes = [P]
        u.ShowWindow.argtypes = [P, I]
        u.SetWindowPos.argtypes = [P, P, I, I, I, I, U]
        u.GetParent.restype = P
        u.GetParent.argtypes = [P]
        u.FindWindowExW.restype = P
        u.FindWindowExW.argtypes = [P, P, wt.LPCWSTR, wt.LPCWSTR]
        u.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), P, U, U]
        u.TranslateMessage.argtypes = [ctypes.POINTER(wt.MSG)]
        u.DispatchMessageW.argtypes = [ctypes.POINTER(wt.MSG)]
        u.PostThreadMessageW.argtypes = [wt.DWORD, U, wt.WPARAM, wt.LPARAM]
        u.GetWindowThreadProcessId.argtypes = [P, ctypes.POINTER(wt.DWORD)]
        u.GetWindowTextW.argtypes = [P, wt.LPWSTR, I]
        u.EnumWindows.argtypes = [ctypes.c_void_p, wt.LPARAM]
        u.GetClientRect.argtypes = [P, ctypes.POINTER(wt.RECT)]
        u.GetWindowRect.argtypes = [P, ctypes.POINTER(wt.RECT)]
        u.GetCursorPos.argtypes = [ctypes.POINTER(wt.POINT)]
        u.SetWindowRgn.argtypes = [P, wt.HRGN, wt.BOOL]
        g = ctypes.WinDLL("gdi32", use_last_error=True)
        self.g = g
        g.CreateRectRgn.restype = wt.HRGN
        g.CreateRectRgn.argtypes = [I, I, I, I]
        g.CombineRgn.argtypes = [wt.HRGN, wt.HRGN, wt.HRGN, I]
        g.DeleteObject.argtypes = [wt.HGDIOBJ]


_U32_INSTANCE = []


def _u32():
    if not _U32_INSTANCE:
        _U32_INSTANCE.append(_U32())
    return _U32_INSTANCE[0]


def find_main_window(title, cached=0):
    """The ULTRON window of THIS process (matched by process id and exact title, so another program called the same cannot be hit)."""
    w = _u32()
    u = w.u
    if cached and u.IsWindow(cached):
        return cached
    pid, found = os.getpid(), []
    proto = ctypes.WINFUNCTYPE(w.wt.BOOL, w.wt.HWND, w.wt.LPARAM)

    def each(h, _lp):
        owner = w.wt.DWORD(0)
        u.GetWindowThreadProcessId(h, ctypes.byref(owner))
        if owner.value != pid or u.GetParent(h):
            return True
        buf = ctypes.create_unicode_buffer(256)
        u.GetWindowTextW(h, buf, 256)
        if buf.value == title:
            found.append(int(h))
            return False
        return True
    cb = proto(each)                                             # keep a reference alive for the duration of the call
    u.EnumWindows(cb, 0)
    return found[0] if found else 0


class _Host:
    """The picture surface: a plain black child window inside the ULTRON window. mpv renders into it (--wid).

    It has its own thread with a message loop (a window whose thread does not pump messages would freeze every
    cross-thread SetWindowPos). All moves are posted asynchronously, so the Flask threads never wait for the UI.
    """
    WS_CHILD, WS_CLIPSIBLINGS, WS_CLIPCHILDREN, SS_BLACKRECT = 0x40000000, 0x04000000, 0x02000000, 0x4
    SWP_NOSIZE, SWP_NOMOVE, SWP_NOZORDER, SWP_NOACTIVATE, SWP_SHOWWINDOW, SWP_ASYNC = 0x1, 0x2, 0x4, 0x10, 0x40, 0x4000
    WM_QUIT = 0x12

    def __init__(self, parent):
        self.parent = int(parent)
        self.hwnd = 0
        self.tid = 0
        self._ready = threading.Event()
        self._thread = None

    def start(self, timeout=5.0):
        self._thread = threading.Thread(target=self._run, name="ultron-picture-host", daemon=True)
        self._thread.start()
        self._ready.wait(timeout)
        return bool(self.hwnd)

    def _run(self):
        w = _u32()
        u = w.u
        try:
            self.tid = ctypes.windll.kernel32.GetCurrentThreadId()
            style = self.WS_CHILD | self.WS_CLIPSIBLINGS | self.WS_CLIPCHILDREN | self.SS_BLACKRECT
            self.hwnd = int(u.CreateWindowExW(0, "STATIC", None, style, 0, 0, 2, 2, self.parent, None, None, None) or 0)
        except Exception:
            log.warning("could not create the picture window", exc_info=True)
            self.hwnd = 0
        self._ready.set()
        if not self.hwnd:
            return
        msg = w.wt.MSG()
        while u.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:     # 0 = WM_QUIT, -1 = error
            u.TranslateMessage(ctypes.byref(msg))
            u.DispatchMessageW(ctypes.byref(msg))
        try:
            if u.IsWindow(self.hwnd):
                u.DestroyWindow(self.hwnd)
        except Exception:
            pass
        self.hwnd = 0

    def alive(self):
        return bool(self.hwnd) and bool(_u32().u.IsWindow(self.hwnd))

    def move(self, x, y, w, h):
        """Place and show the surface. Coordinates are device pixels inside the ULTRON window's client area."""
        if not self.alive():
            return
        u = _u32().u
        w, h = max(1, int(w)), max(1, int(h))
        # HWND_TOP keeps it over the web view (a sibling); async so a busy UI thread never stalls the caller
        u.SetWindowPos(self.hwnd, 0, int(x), int(y), w, h, self.SWP_NOACTIVATE | self.SWP_SHOWWINDOW | self.SWP_ASYNC)
        inner = u.FindWindowExW(self.hwnd, None, "mpv", None)       # mpv's own window: make sure it fills the surface
        if inner:
            u.SetWindowPos(inner, 0, 0, 0, w, h, self.SWP_NOZORDER | self.SWP_NOACTIVATE | self.SWP_ASYNC)

    def set_holes(self, w, h, holes):
        """Cut rectangles out of the picture window (coordinates inside it, device pixels). Whatever the page draws there shows
        through, so the page's own controls can sit OVER the picture, also in fullscreen. No holes = the whole window."""
        if not self.alive():
            return False
        w32 = _u32()
        u, g = w32.u, w32.g
        try:
            if not holes:
                u.SetWindowRgn(self.hwnd, None, True)
                return True
            full = g.CreateRectRgn(0, 0, int(w), int(h))
            for (x, y, cw, ch) in holes:
                x0, y0, x1, y1 = max(0, int(x)), max(0, int(y)), min(int(w), int(x + cw)), min(int(h), int(y + ch))
                if x1 - x0 < 1 or y1 - y0 < 1:
                    continue
                r = g.CreateRectRgn(x0, y0, x1, y1)
                g.CombineRgn(full, full, r, 4)                  # RGN_DIFF
                g.DeleteObject(r)
            if not u.SetWindowRgn(self.hwnd, full, True):       # on success the system owns the region
                g.DeleteObject(full)
                return False
            return True
        except Exception:
            log.debug("set_holes failed", exc_info=True)
            return False

    def hide(self):
        if self.alive():
            _u32().u.ShowWindow(self.hwnd, 0)

    def close(self):
        """End the message loop; the window is destroyed on its own thread."""
        hwnd, self.hwnd = self.hwnd, 0
        try:
            if self.tid:
                _u32().u.PostThreadMessageW(self.tid, self.WM_QUIT, 0, 0)
        except Exception:
            log.debug("host close failed", exc_info=True)
        if hwnd and self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(1.0)


# ----------------------------------------------------------------------------- the engine
class Engine:
    """One libmpv instance. Thread safe: Flask threads call the methods, mpv's event thread feeds the state."""

    def __init__(self, kind, get_prefs, data_dir, extra_dirs, main_title="", on_event=None):
        self.kind = kind
        self.get_prefs = get_prefs
        self.data_dir = Path(data_dir)
        self.extra_dirs = extra_dirs                # callable -> list of folders to look for libmpv in
        self.main_title = main_title
        self.on_event = on_event                    # callback(dict) for the app (mini player: expand / closed)
        self.m = None
        self.lock = threading.RLock()
        self.title = "ULTRON-%s-%d" % (kind, os.getpid())
        self.seq = 0
        self.events = collections.deque(maxlen=300)
        self.st = self._blank()
        self.rect = None                            # css rect of the stage + devicePixelRatio, from the page
        self.visible = False
        self._host = None                           # the child window mpv draws into (stage engine, Windows)
        self._main = 0
        self._stop = threading.Event()
        self._click = None
        self._closing = False
        self._hidden = None
        self._last_rect = None
        self.holes = []                             # css rects of page controls drawn over the picture
        self.view = None                            # css size of the page viewport when the rects were measured
        self._last_holes = None
        self._last_move = 0.0
        self._lift = 0.0
        self._sub_margin = None
        self._load_seq = 0
        self.error = ""
        self.lib = ""
        self.version = ""

    # ---- state
    @staticmethod
    def _blank():
        return {"loaded": False, "path": "", "t": 0.0, "dur": 0.0, "paused": True, "eof": False, "vol": 100.0, "mute": False,
                "speed": 1.0, "w": 0, "h": 0, "cache": 0.0, "buffering": False, "seeking": False, "tracks": [],
                "aid": 0, "sid": 0, "fs": False}

    def _emit(self, **ev):
        with self.lock:
            self.seq += 1
            ev["seq"] = self.seq
            self.events.append(ev)

    def available(self):
        mod, lib, err = load_module(self.extra_dirs())
        self.lib = lib
        self.error = "" if mod else err
        return bool(mod)

    # ---- start / stop
    def ensure(self):
        """Create the libmpv instance (first use). Returns True when playback is possible."""
        with self.lock:
            if self.m is not None:
                return True
            mod, lib, err = load_module(self.extra_dirs())
            if not mod:
                self.error = err
                return False
            p = self.get_prefs()
            wid = None
            if self.kind == "stage":
                if not IS_WIN:
                    self.error = "The native player needs the ULTRON desktop window on Windows."
                    return False
                if not self._make_host():
                    return False
                wid = self._host.hwnd
            opts = build_options(p, self.kind, self.title, "", wid)
            self.data_dir.mkdir(parents=True, exist_ok=True)
            opts["config-dir"] = str(self.data_dir)
            last = None
            for attempt in (opts, safe_options(opts)):
                try:
                    self.m = mod.MPV(log_handler=self._on_log, loglevel="warn", **{k.replace("-", "_"): v for k, v in attempt.items()})
                    break
                except Exception as e:                           # bad option for this libmpv build: retry with the safe set
                    last = e
                    log.warning("mpv start failed (%s), retrying with safe options", e)
            if self.m is None:
                self._drop_host()
                self.error = "mpv could not start: %s" % last
                return False
            self.error = ""
            self.lib = lib
            self._closing = False                                # a start after a shutdown (the user closed mpv's window) is a clean start
            self._stop = threading.Event()
            try:
                self.version = str(self.m["mpv-version"])
            except Exception:
                self.version = ""
            for _k, _v in (("sub-back-color", "#00000000"), ("sub-shadow-offset", "1"), ("sub-border-style", "outline-and-shadow"),
                           ("osd-back-color", "#00000000"), ("osd-border-style", "outline-and-shadow")):
                try:                                             # subtitles and on-screen text: outline only, never a black box
                    self.m[_k] = _v
                except Exception:
                    pass                                         # an older libmpv without this option: skip it
            self._sub_margin = None                              # a fresh mpv starts at its default margin: send the lift again
            self._hook()
            self._bindings()
            self._pick_audio_device()
            self._apply_place()
            if self.kind == "stage" and IS_WIN:
                threading.Thread(target=self._watch_cursor, args=(self._stop,), name="ultron-cursor-watch", daemon=True).start()
            return True

    def shutdown(self):
        """Stop playback and remove the picture. Safe to call twice, from any thread, and it can never hang the caller."""
        self._closing = True
        self._stop.set()
        with self.lock:
            m, self.m = self.m, None
            host, self._host = self._host, None
            self.st = self._blank()
            self.visible = False
            self._hidden, self._last_rect = None, None
        if host is not None:
            host.hide()                                          # gone from the screen at once, while libmpv is still tearing down
        if m is not None:
            t = threading.Thread(target=self._terminate, args=(m,), name="ultron-mpv-terminate", daemon=True)
            t.start()
            t.join(3.0)                                          # a stuck driver must not freeze the app's exit
        if host is not None:
            host.close()

    @staticmethod
    def _terminate(m):
        try:
            m.terminate()
        except Exception:
            log.warning("mpv terminate failed", exc_info=True)

    def _make_host(self):
        """Create the picture surface inside the ULTRON window (waits a moment if the window is still opening)."""
        for _ in range(30):
            self._main = find_main_window(self.main_title, self._main)
            if self._main:
                break
            time.sleep(0.1)
        if not self._main:
            self.error = "The ULTRON window was not found, so the native player cannot attach to it."
            return False
        host = _Host(self._main)
        if not host.start():
            self.error = "The picture window could not be created."
            return False
        self._host = host
        return True

    def _drop_host(self):
        host, self._host = self._host, None
        if host is not None:
            host.hide()
            host.close()

    def _on_log(self, level, prefix, text):
        if level in ("error", "fatal"):
            log.warning("mpv [%s] %s", prefix, str(text).strip())
            with self.lock:
                self.st["last_error"] = str(text).strip()[:200]

    # ---- observers
    def _hook(self):
        m = self.m

        def put(key, conv=lambda v: v):
            def cb(_name, v):
                if v is None:
                    return
                try:
                    self.st[key] = conv(v)
                except Exception:
                    pass
            return cb

        for prop, key, conv in (("duration", "dur", float), ("pause", "paused", bool), ("volume", "vol", float), ("mute", "mute", bool),
                                ("speed", "speed", float), ("eof-reached", "eof", bool), ("seeking", "seeking", bool),
                                ("paused-for-cache", "buffering", bool), ("aid", "aid", lambda v: 0 if v in (False, None, "no") else int(v)),
                                ("sid", "sid", lambda v: 0 if v in (False, None, "no") else int(v)), ("fullscreen", "fs", bool)):
            m.observe_property(prop, put(key, conv))

        def on_time(_n, v):
            if v is None:
                return
            self.st["t"] = float(v)

        def on_cache(_n, v):
            try:
                self.st["cache"] = float(v or 0.0)
            except (TypeError, ValueError):
                pass

        def on_params(_n, v):
            if isinstance(v, dict):
                self.st["w"] = int(v.get("dw") or v.get("w") or 0)
                self.st["h"] = int(v.get("dh") or v.get("h") or 0)
                self.st["cw"] = int(v.get("w") or 0)                # coded size: what video-crop works in
                self.st["ch"] = int(v.get("h") or 0)

        def on_tracks(_n, v):
            if isinstance(v, list):
                self.st["tracks"] = [self._track(t) for t in v if t.get("type") in ("audio", "sub")]

        m.observe_property("time-pos", on_time)
        m.observe_property("demuxer-cache-time", on_cache)
        m.observe_property("video-params", on_params)
        m.observe_property("track-list", on_tracks)

        @m.event_callback("file-loaded")
        def _loaded(_ev):
            self.st["loaded"] = True
            self.st["eof"] = False
            self._emit(type="loaded")

        @m.event_callback("end-file")
        def _end(ev):
            try:
                reason = str(ev.as_dict().get("reason", ""))
            except Exception:
                reason = ""
            if "error" in reason.lower():
                self.st["loaded"] = False
                self._emit(type="error", msg=self.st.get("last_error") or "mpv could not play this file")

        @m.event_callback("shutdown")
        def _shutdown(_ev):                                      # the user closed mpv's window (Alt+F4): same as pressing Esc
            if self._closing:
                return
            self._emit(type="closed")
            threading.Thread(target=self.close_mini if self.kind == "mini" else self.shutdown, daemon=True).start()

    @staticmethod
    def _track(t):
        g = lambda k, d=None: t.get(k, t.get(k.replace("-", "_"), d))
        return {"id": int(g("id", 0)), "type": g("type"), "lang": g("lang") or "", "title": g("title") or "", "codec": g("codec") or "",
                "external": bool(g("external")), "selected": bool(g("selected")), "default": bool(g("default")),
                "channels": g("demux-channel-count") or 0, "file": g("external-filename") or ""}

    # ---- keys that mpv's own window forwards to the page
    def _bindings(self):
        m = self.m
        binds = {
            "SPACE": "cycle pause", "p": "cycle pause", "m": "cycle mute", "LEFT": "seek -5", "RIGHT": "seek 5",
            "j": "seek -10", "l": "seek 10", "UP": "add volume 4", "DOWN": "add volume -4", "s": "script-message ultron-key shot",
            "WHEEL_UP": "add volume 3", "WHEEL_DOWN": "add volume -3", ">": "add speed 0.25", "<": "add speed -0.25",
            ".": "frame-step", ",": "frame-back-step", "ESC": "script-message ultron-key escape",
            "f": "script-message ultron-key fullscreen", "F11": "script-message ultron-key fullscreen",
            "MBTN_LEFT": "script-message ultron-key click", "MBTN_LEFT_DBL": "script-message ultron-key dbl",
            "n": "script-message ultron-key next", "N": "script-message ultron-key next",
            "e": "script-message ultron-key mini", "i": "script-message ultron-key mini",
            "MOUSE_MOVE": "script-message ultron-key move",
        }
        if self.kind == "mini":
            binds.update({"ESC": "script-message ultron-key close", "q": "script-message ultron-key close",
                          "e": "script-message ultron-key expand", "MBTN_LEFT_DBL": "script-message ultron-key expand",
                          "MBTN_LEFT": "ignore", "f": "ignore", "F11": "ignore", "n": "ignore", "i": "ignore", "MOUSE_MOVE": "ignore"})
        for key, cmd in binds.items():
            try:
                m.command("keybind", key, cmd)
            except Exception:
                log.debug("keybind %s failed", key, exc_info=True)

        @m.message_handler("ultron-key")
        def _key(*args):
            key = str(args[0]) if args else ""
            if key == "click":                                  # single click = play/pause, unless it turns into a double click
                if self._click:
                    self._click.cancel()
                self._click = threading.Timer(0.28, lambda: self._cmd_safe("cycle", "pause"))
                self._click.start()
                return
            if key == "dbl":
                if self._click:
                    self._click.cancel()
                key = "fullscreen"
            if key == "shot":
                self._emit(type="key", key="shot")
                return
            if key == "move":                                   # the page shows its controls again; at most ~7 events a second
                now = time.time()
                if now - self._last_move > 0.15:
                    self._last_move = now
                    self._emit(type="key", key="move")
                return
            if self.kind == "mini":
                if key == "expand":
                    self._emit(type="key", key="expand")
                    if self.on_event:
                        self.on_event({"type": "expand", "kind": "mini", "id": self.st.get("id", ""), "t": self.st.get("t", 0.0), "dur": self.st.get("dur", 0.0)})
                    threading.Thread(target=self.close_mini, daemon=True).start()
                elif key == "close":
                    threading.Thread(target=self.close_mini, daemon=True).start()
                return
            self._emit(type="key", key=key)

    def _cmd_safe(self, *a):
        try:
            if self.m:
                self.m.command(*a)
        except Exception:
            log.debug("mpv command %s failed", a, exc_info=True)

    # ---- audio device: pick the M-Audio Duo (or whatever the Settings box says) instead of the Windows default
    def _pick_audio_device(self):
        want = str(self.get_prefs().get("mpv_audio_device") or "").strip().lower()
        self.audio = {"wanted": want, "found": False, "using": "system default", "devices": []}
        try:
            devs = list(self.m["audio-device-list"] or [])
        except Exception:
            return
        self.audio["devices"] = [{"name": d.get("name", ""), "label": d.get("description", "")} for d in devs]
        if not want:
            return
        for d in devs:
            label = (d.get("description") or "") + " " + (d.get("name") or "")
            if want in label.lower() and (d.get("name") or "").lower() != "auto":
                try:
                    self.m["audio-device"] = d["name"]
                    self.audio.update(found=True, using=d.get("description") or d["name"])
                except Exception:
                    log.warning("could not select audio device %s", d, exc_info=True)
                return

    def _watch_cursor(self, stop):
        """The picture is a native window, so while it covers the page (controls hidden, e.g. in fullscreen) the web page never
        sees the mouse and mpv's own MOUSE_MOVE binding is not reliable inside an embedded window. So: while the picture is
        showing, look at the cursor ~8 times a second and tell the page when it moved over the picture (the page then brings
        its controls back). Reading the cursor position is cheap and it stops with the engine."""
        w = _u32()
        pt, rc, last = w.wt.POINT(), w.wt.RECT(), None
        while not stop.wait(0.12):
            host = self._host
            if host is None or not self.visible or not host.alive():
                last = None
                continue
            try:
                if not w.u.GetCursorPos(ctypes.byref(pt)) or not w.u.GetWindowRect(host.hwnd, ctypes.byref(rc)):
                    continue
                cur = (pt.x, pt.y)
                inside = rc.left <= pt.x < rc.right and rc.top <= pt.y < rc.bottom
                if last is not None and cur != last and inside:
                    self._emit(type="key", key="move")
                last = cur
            except Exception:
                log.debug("cursor watch failed", exc_info=True)
                return

    # ---- placement of the picture (stage engine, Windows)
    def place(self, rect, visible=True, holes=None):
        """The page tells us where the stage is (css pixels relative to the window), what page controls sit over it
        (holes) and whether it should be showing."""
        with self.lock:
            self.rect = {k: float(rect.get(k) or 0) for k in ("x", "y", "w", "h")}
            self.rect["dpr"] = float(rect.get("dpr") or 1.0)
            vw, vh = float(rect.get("vw") or 0), float(rect.get("vh") or 0)
            self.view = (vw, vh) if vw > 50 and vh > 50 else None
            self.holes = list(holes or [])
            try:
                self._lift = max(0.0, min(0.45, float(rect.get("lift") or 0.0)))   # share of the window height the page's bottom bar covers
            except (TypeError, ValueError):
                self._lift = 0.0
            self.visible = bool(visible) and self.rect["w"] > 2 and self.rect["h"] > 2
        self._apply_place()
        self._apply_lift()

    def _apply_lift(self):
        """Subtitles sit ABOVE the page's control bar while it shows (the bar is drawn over the picture, so they would hide behind it).
        mpv's sub margin counts in a 720-line scale: 22 is its default."""
        m = self.m
        if m is None or self.kind != "stage":
            return
        want = 22 + int(round(getattr(self, "_lift", 0.0) * 720))
        if want == getattr(self, "_sub_margin", None):
            return
        try:
            m["sub-margin-y"] = want
            self._sub_margin = want
        except Exception:
            log.debug("sub-margin-y failed", exc_info=True)

    def _scale(self):
        """css px -> device px. Measured against the real window, so Windows display scaling or a zoomed web view cannot
        push the bottom of the picture out of the window (the old 'height is cropped' problem)."""
        d = self.rect["dpr"]
        sx = sy = d
        if self.view and self._main:
            try:
                u = _u32()
                rc = u.wt.RECT()
                if u.u.GetClientRect(self._main, ctypes.byref(rc)):
                    cw, ch = rc.right - rc.left, rc.bottom - rc.top
                    if cw > 50 and ch > 50:
                        sx, sy = cw / self.view[0], ch / self.view[1]
            except Exception:
                log.debug("client rect failed", exc_info=True)
        return sx, sy

    def _apply_place(self):
        """Move the child window over the stage (or hide it). It is a child of the ULTRON window, so the coordinates are
        the page's css pixels times the scale: no screen maths, no polling, nothing to chase."""
        host = self._host
        if host is None or self.m is None or self.kind != "stage":
            return
        with self.lock:
            r, vis, holes = self.rect, self.visible, list(self.holes)
        if not (vis and r):
            if self._hidden is not True:
                host.hide()
                self._hidden = True
            return
        sx, sy = self._scale()
        px = (round(r["x"] * sx), round(r["y"] * sy), max(2, round(r["w"] * sx)), max(2, round(r["h"] * sy)))
        if px != self._last_rect or self._hidden is not False:
            host.move(*px)                                       # also shows it
            self._last_rect, self._hidden = px, False
            self._last_holes = None
        local = []
        for hd in holes[:24]:
            try:
                local.append((round(hd["x"] * sx) - px[0], round(hd["y"] * sy) - px[1], round(hd["w"] * sx), round(hd["h"] * sy)))
            except (KeyError, TypeError, ValueError):
                continue
        key = (px[2], px[3], tuple(local))
        if key != self._last_holes:
            self._last_holes = key
            host.set_holes(px[2], px[3], local)

    # ---- playback API
    def load(self, path, start=0.0, paused=True, volume=None, mute=None, speed=None, vid="", private=False):
        """volume is 0..1 (the page's scale); mpv itself works in 0..100."""
        if not self.ensure():
            return False
        m = self.m
        with self.lock:
            self.st.update(self._blank())
            self.st["path"] = str(path)
            self.st["id"] = str(vid or "")
            self.st["private"] = bool(private)
            self.st["loaded"] = False
            self.st["paused"] = bool(paused)
            self._load_seq = self.seq
            self._pick_audio_device()
        try:
            m["pause"] = bool(paused)
            if volume is not None:
                m["volume"] = max(0.0, min(1.0, float(volume))) * 100.0
            if mute is not None:
                m["mute"] = bool(mute)
            if speed:
                m["speed"] = float(speed)
            m["start"] = ("+%.3f" % start) if start and start > 1 else "none"
            m["sid"] = "no"
            m.command("loadfile", str(path), "replace")
            self.visible = True
            self._apply_place()
        except Exception as e:
            self.error = str(e)
            log.warning("loadfile failed", exc_info=True)
            return False
        return True

    def wait_loaded(self, timeout=12.0):
        end = time.time() + timeout
        while time.time() < end:
            if self.st.get("loaded"):
                return True
            if any(e.get("type") == "error" and e["seq"] > self._load_seq for e in list(self.events)):
                return False
            time.sleep(0.03)
        return False

    def stop(self):
        self.visible = False
        if self.m:
            self._cmd_safe("stop")
            try:
                self.m["pause"] = True
            except Exception:
                pass
            self.st.update(loaded=False, t=0.0, dur=0.0, eof=False, tracks=[])
        if self._host is not None:
            self._host.hide()
            self._hidden = True

    def command(self, name, value=None):
        """One verb from the page. Returns a small result dict."""
        m = self.m
        if m is None:
            return {"ok": False}
        try:
            if name == "play":
                m["pause"] = False
            elif name == "pause":
                m["pause"] = True
            elif name == "seek":
                m.command("seek", "%.3f" % max(0.0, float(value)), "absolute+exact")
            elif name == "volume":
                m["volume"] = max(0.0, min(1.0, float(value))) * 100.0
            elif name == "mute":
                m["mute"] = bool(value)
            elif name == "speed":
                m["speed"] = max(0.25, min(4.0, float(value)))
            elif name == "aid":
                m["aid"] = int(value) if value else "no"
            elif name == "sid":
                m["sid"] = int(value) if value else "no"
            elif name == "sub-delay":
                m["sub-delay"] = float(value)
            elif name == "audio-delay":
                m["audio-delay"] = float(value)
            elif name == "frame-step":
                m.command("frame-step" if int(value) > 0 else "frame-back-step")
            elif name == "osc":
                m.command("script-message", "osc-visibility", "auto" if value else "never", "no-osd")
            elif name == "picture":
                return self._picture(value or {})
            elif name == "sub-add":
                return self._sub_add(value or {})
            elif name == "sub-remove":
                m.command("sub-remove", int(value))
            elif name == "sub-scale":
                m["sub-scale"] = max(0.3, min(3.0, float(value)))
            else:
                return {"ok": False, "error": "unknown command"}
            return {"ok": True}
        except Exception as e:
            log.debug("command %s failed", name, exc_info=True)
            return {"ok": False, "error": str(e)}

    def _sub_add(self, d):
        m = self.m
        before = {t["id"] for t in self.st["tracks"] if t["type"] == "sub"}
        if d.get("cookie"):                                      # private-library subtitles are behind the session cookie
            m["http-header-fields"] = ["Cookie: %s" % d["cookie"]]
        m.command("sub-add", str(d["url"]), "cached", str(d.get("title") or "")[:80], str(d.get("lang") or "")[:8])
        for _ in range(40):                                      # the track list updates a moment later
            time.sleep(0.05)
            now = [t for t in self.st["tracks"] if t["type"] == "sub" and t["id"] not in before]
            if now:
                return {"ok": True, "id": now[0]["id"]}
        return {"ok": False, "error": "subtitle did not load"}

    def _picture(self, d):
        """Picture mode. fill = crop to the window (panscan), fit = whole frame, crop = {x,y,w,h} in source pixels (bars baked into the file)."""
        m = self.m
        crop = d.get("crop")
        res = {"ok": True, "cropped": False}
        try:
            m["panscan"] = 1.0 if d.get("mode") == "fill" else 0.0
        except Exception:
            log.debug("panscan failed", exc_info=True)
        try:
            if crop and int(crop["w"]) > 8 and int(crop["h"]) > 8:
                m["video-crop"] = "%dx%d+%d+%d" % (int(crop["w"]), int(crop["h"]), max(0, int(crop["x"])), max(0, int(crop["y"])))
                res["cropped"] = True
            else:
                m["video-crop"] = ""
        except Exception:                                        # libmpv older than 0.39 has no video-crop: the bars simply stay
            res["ok"] = not crop
        return res

    def screenshot(self, path, with_subs=False):
        if not self.m or not self.st.get("loaded"):
            return False
        try:
            self.m.command("screenshot-to-file", str(path), "subtitles" if with_subs else "video")
            return Path(path).is_file()
        except Exception:
            log.warning("screenshot failed", exc_info=True)
            return False

    def close_mini(self):
        if self._closing:
            return
        info = {"id": self.st.get("id", ""), "t": self.st.get("t", 0.0), "dur": self.st.get("dur", 0.0)}
        self.shutdown()
        if self.on_event:
            self.on_event(dict(info, type="closed", kind="mini"))

    # ---- what the page polls
    def snapshot(self, since=0, diag=False):
        with self.lock:
            st = dict(self.st)
            st["vol_lin"] = max(0.0, min(1.0, float(st.get("vol", 100.0)) / 100.0))
            evs = [e for e in self.events if e["seq"] > since]
            seq = self.seq
        out = {"state": st, "events": evs, "seq": seq, "audio": getattr(self, "audio", None)}
        if diag and self.m is not None:
            out["diag"] = self.diag()
        return out

    def diag(self):
        d = {}
        for key, prop in (("hwdec", "hwdec-current"), ("vo", "current-vo"), ("ao", "current-ao"), ("codec", "video-codec"),
                          ("fps", "container-fps"), ("display_fps", "display-fps"), ("sync", "video-sync"), ("avsync", "avsync"),
                          ("dropped", "frame-drop-count"), ("decoder_dropped", "decoder-frame-drop-count"),
                          ("audio_device", "audio-device"), ("audio_rate", "audio-params"), ("pix", "video-params")):
            try:
                v = self.m[prop]
                if prop in ("audio-params", "video-params") and isinstance(v, dict):
                    v = {k: v.get(k) for k in ("samplerate", "format", "hr-channels", "pixelformat", "colormatrix", "gamma")}
                d[key] = v
            except Exception:
                d[key] = None
        return d
