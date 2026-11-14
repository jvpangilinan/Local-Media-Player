"""ULTRON native player: the video screen as a real Qt window, with libmpv drawing INTO it.

Why a separate program instead of a web page with a video window stuck on top of it:
  the page and a native video window can never blend (the "airspace" problem), so every control that sat over the picture needed a
  hand-cut hole, the mouse never reached the page in fullscreen, and so on. Here the controls are Qt widgets that sit on top of an
  OpenGL surface that mpv renders into (mpv's render API), so everything composites normally: subtitles, preview boxes, menus, fullscreen.

It runs as its own process (``ULTRON.exe --player ...``) so a crash or a graphics-driver problem here can never take the library down,
and it talks to the running ULTRON server over localhost for everything else (resume point, view count, subtitles, next episode).

Exit codes: 0 = closed normally, 2 = bad arguments, 3 = could not start (the app then falls back to the old web player).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
import urllib.request
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)
APP_DIR = Path(sys.executable).parent if FROZEN else Path(__file__).resolve().parent
LOG_FILE = APP_DIR / "native_player.log"
EXIT_OK, EXIT_BAD, EXIT_FAIL = 0, 2, 3


def force_foreground(hwnd):
    """Put a window in front and give it the keyboard, even when this process is not the active one.
    Plain SetForegroundWindow is refused for background processes (the taskbar button only flashes), so borrow the
    input queue of the window that is in front for a moment, and also bump the window through the top-most band."""
    if os.name != "nt" or not hwnd:
        return
    try:
        import ctypes
        u, k = ctypes.windll.user32, ctypes.windll.kernel32
        u.ShowWindow(hwnd, 9 if u.IsIconic(hwnd) else 5)          # SW_RESTORE / SW_SHOW
        fg = u.GetForegroundWindow()
        me, other = k.GetCurrentThreadId(), u.GetWindowThreadProcessId(fg, None) if fg else 0
        attached = bool(other and other != me and u.AttachThreadInput(me, other, True))
        try:
            u.BringWindowToTop(hwnd)
            u.SetForegroundWindow(hwnd)
            u.SetFocus(hwnd)
        finally:
            if attached:
                u.AttachThreadInput(me, other, False)
        flags = 0x0001 | 0x0002 | 0x0040                         # SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW
        u.SetWindowPos(hwnd, -1, 0, 0, 0, 0, flags)               # HWND_TOPMOST ...
        u.SetWindowPos(hwnd, -2, 0, 0, 0, 0, flags)               # ... and back, so it is in front but not stuck on top
    except Exception:
        pass


def log(*parts):
    """Append to native_player.log next to the app (best effort; logging must never stop the player)."""
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 500_000:
            LOG_FILE.write_text("", encoding="utf-8")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write("%s  %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), " ".join(str(p) for p in parts)))
    except OSError:
        pass


def fmt_time(t):
    try:
        t = max(0, int(t))
    except (TypeError, ValueError):
        t = 0
    h, m, s = t // 3600, t % 3600 // 60, t % 60
    return "%d:%02d:%02d" % (h, m, s) if h else "%d:%02d" % (m, s)


class Api:
    """Talks to the running ULTRON server. Never uses the system proxy (it would try to route 127.0.0.1 through it)."""

    def __init__(self, base, token=""):
        self.base = str(base).rstrip("/")
        self.token = token or ""
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _open(self, method, path, body=None, timeout=15):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("X-LMP", "1")
        if self.token:
            req.add_header("X-Private-Token", self.token)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        return self.opener.open(req, timeout=timeout)

    def get_json(self, path, timeout=15):
        with self._open("GET", path, None, timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def post_json(self, path, body=None, timeout=15):
        with self._open("POST", path, body if body is not None else {}, timeout) as r:
            raw = r.read()
            return json.loads(raw.decode("utf-8")) if raw else {}

    def get_bytes(self, path, timeout=60):
        with self._open("GET", path, None, timeout) as r:
            return r.read()


def run(argv):
    ap = argparse.ArgumentParser(prog="ULTRON --player")
    ap.add_argument("--base", required=True, help="address of the running ULTRON server")
    ap.add_argument("--vid", required=True, help="id of the video to play")
    ap.add_argument("--token", default="", help="private-area token (private videos only)")
    ap.add_argument("--fullscreen", default="0")
    ap.add_argument("--front", default="0", help="1 = take the foreground (started from the phone remote)")
    ap.add_argument("--mpvdir", default="", help="folders (separated by ;) that may hold libmpv-2.dll")
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return EXIT_BAD
    log("start", a.vid, "frozen" if FROZEN else "python")
    try:
        import native_ui                       # PySide6 lives in there: if it is missing the app falls back to the web player
    except Exception:
        log("PySide6 / native_ui could not be imported:\n" + traceback.format_exc())
        return EXIT_FAIL
    try:
        return native_ui.main(a, Api(a.base, a.token))
    except Exception:
        log("player crashed:\n" + traceback.format_exc())
        return EXIT_FAIL
