"""Phone remote: control the app from a phone on the same Wi-Fi, browse the library, and watch on the phone.

Two halves:
- `bp`, a blueprint on the normal app (127.0.0.1 only). Settings uses it to switch the remote on / off and show the QR code;
  the page and the native player use it to report what is playing and to pick up the phone's commands (long poll).
- `LAN`, a SEPARATE small Flask app that is the only thing ever exposed to the network. It serves the phone app, a few
  routes of its own, and a READ-ONLY ALLOWLIST PROXY into the main app (`/x/...`).

Why the proxy is safe for the private library: it forwards a fixed list of GET paths (plus one POST: saving the resume
point) with a fresh test client that never carries cookies or the X-Private-Token header. The main app therefore answers
as it would to a LOCKED user: `get_video_checked` / `get_series_checked` refuse private items, and `/api/videos` without
`private=1` (stripped here) lists public items only. Same gates the lock tests cover.

Off by default. Pairing: the QR code carries a 6-digit PIN in the URL fragment (never sent to a server); typing it works
too. 5 wrong PINs lock pairing for 60 s. "Forget phones" makes a new PIN and drops every paired phone.
Private content: the phone never sees a private title or id (masked here, whatever the player sends), and nothing it can
list, open, stream or start is private.
"""
import base64, hashlib, io, json, logging, os, re, secrets, socket, subprocess, threading, time
from pathlib import Path

from flask import Blueprint, Flask, Response, abort, jsonify, request, send_file

log = logging.getLogger("remote")
PORTS = (47400, 47401, 47402, 47403)
COOKIE = "zeno_remote"
PAIR_DAYS = 365

bp = Blueprint("remote", __name__)
LAN = Flask("zeno_remote")

_cfg_path = None          # DATA_DIR / remote.json  {"enabled": bool, "pin": "123456", "phones": [sha256(token), ...]}
_res_dir = None
_main = None              # the main Flask app (for the proxy)
H = {                     # app.py fills these in (see init); defaults keep the module importable on its own
    "library": lambda: [],            # continue-watching list (public only)
    "is_public": lambda vid: False,   # public video id?
    "video_path": lambda vid: None,   # file of a PUBLIC video, else None
    "probe": lambda vid: {},          # probe_video() result
    "ffmpeg": lambda: None,           # ffmpeg executable or None
    "ranged": None,                   # ranged_file_response(path)
    "popen": None,                    # Popen at the app's background priority
    "track_exists": lambda tid: False,
    "track_path": lambda tid: None,   # file of a song (music is never private)
}

_lock = threading.Lock()
_cond = threading.Condition(_lock)
_queues = {"page": [], "native": []}
_status = {"page": ({}, 0.0), "native": ({}, 0.0)}
_lockout = {"fails": 0, "until": 0.0}
_server = {"srv": None, "port": None, "thread": None}
_stream = {"proc": None}
_stream_lock = threading.Lock()


# ------------------------------------------------------------------ settings file
def _load():
    try:
        d = json.loads(_cfg_path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _save(d):
    tmp = _cfg_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(d), encoding="utf-8")
    os.replace(tmp, _cfg_path)


def _cfg():
    d = _load()
    changed = False
    if not (isinstance(d.get("pin"), str) and len(d["pin"]) == 6 and d["pin"].isdigit()):
        d["pin"] = "%06d" % secrets.randbelow(1_000_000); changed = True
    if not isinstance(d.get("phones"), list):
        d["phones"] = []; changed = True
    if changed:
        _save(d)
    return d


def _h(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def init(data_dir, res_dir, main_app=None, **hooks):
    """Called once by app.py. Starts the phone server if it was on last time."""
    global _cfg_path, _res_dir, _main
    _cfg_path = Path(data_dir) / "remote.json"
    _res_dir = Path(res_dir)
    _main = main_app
    H.update({k: v for k, v in hooks.items() if v is not None})
    if _cfg().get("enabled"):
        threading.Thread(target=_start, daemon=True).start()


# ------------------------------------------------------------------ network
def lan_ip():
    """The address a phone on the same network should use."""
    for probe in ("10.255.255.255", "192.168.255.255"):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((probe, 1))                  # UDP connect sends nothing; it only picks the outgoing interface
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
        except OSError:
            pass
        finally:
            s.close()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                return ip
    except OSError:
        pass
    return None


def _start():
    from werkzeug.serving import make_server
    with _lock:
        if _server["srv"]:
            return True
    for port in PORTS:
        try:
            srv = make_server("0.0.0.0", port, LAN, threaded=True)
        except OSError:
            continue
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        with _lock:
            _server.update(srv=srv, port=port, thread=t)
        log.info("phone remote listening on port %d", port)
        return True
    log.warning("phone remote: no free port in %s", PORTS)
    return False


def _stop():
    with _lock:
        srv = _server["srv"]
        _server.update(srv=None, port=None, thread=None)
    _kill_stream()
    if srv:
        try:
            srv.shutdown()
        except Exception:
            pass


def _info():
    d = _cfg()
    port, ip = _server["port"], lan_ip()
    url = "http://%s:%d/" % (ip, port) if (port and ip) else None
    out = {"enabled": bool(d.get("enabled")), "running": bool(port), "url": url, "pin": d["pin"], "phones": len(d["phones"])}
    if url:
        out["qr"] = _qr_png(url + "#pin=" + d["pin"])
    return out


def _qr_png(text):
    """QR code as a data: URL. OpenCV is already a dependency (thumbnails), so no extra package."""
    try:
        import cv2, numpy as np
        q = cv2.QRCodeEncoder.create().encode(text)
        q = np.pad(q, 4, constant_values=255)                       # quiet zone
        q = cv2.resize(q, (q.shape[1] * 8, q.shape[0] * 8), interpolation=cv2.INTER_NEAREST)
        ok, png = cv2.imencode(".png", q)
        return "data:image/png;base64," + base64.b64encode(png.tobytes()).decode("ascii") if ok else None
    except Exception:
        log.warning("QR code failed", exc_info=True)
        return None


# ------------------------------------------------------------------ status + commands
_STATUS_KEYS = ("kind", "title", "sub", "pos", "dur", "paused", "vol", "muted", "private", "has_next", "has_prev", "id",
                "vid", "series_id", "tid", "liked", "rating", "speed", "subs", "audios", "chapters", "sleep", "queue", "qpos",
                "can_audio", "can_chapters")


def _clean_status(d):
    st = {k: d.get(k) for k in _STATUS_KEYS if k in d}
    for k in ("subs", "audios", "chapters", "queue"):
        v = st.get(k)
        st[k] = v[:60] if isinstance(v, list) else []
    return st


def _mask(st):
    """A private video: nothing that names it or points at it reaches the phone."""
    st = dict(st or {})
    if st.get("private"):
        st.update(title="Private video", sub="", id=None, vid=None, series_id=None, chapters=[], rating=None)
        for k in ("subs", "audios"):
            st[k] = [{"id": t.get("id"), "on": bool(t.get("on")),
                      "label": (str(t.get("lang") or "").upper() or "Track %d" % (i + 1))}
                     for i, t in enumerate(st.get(k) or []) if isinstance(t, dict)]
    return st


def _active():
    """Which player gets the phone's commands: the native window while it reports, else the page."""
    now = time.time()
    nst, nt = _status["native"]
    if now - nt < 4 and nst.get("kind") not in (None, "none"):
        return "native"
    return "page"


def _push(cmd, arg=None, target=None):
    with _cond:
        q = _queues[target or _active()]
        q.append({"cmd": cmd, "arg": arg})
        del q[:-20]
        _cond.notify_all()


# ---- local side (127.0.0.1 app; the CSRF header guard of app.py applies to these POSTs)
@bp.get("/api/remote/info")
def api_info():
    return jsonify(_info())


@bp.post("/api/remote/enable")
def api_enable():
    on = bool((request.get_json(silent=True) or {}).get("on"))
    d = _cfg(); d["enabled"] = on; _save(d)
    if on:
        _start()
    else:
        _stop()
    return jsonify(_info())


@bp.post("/api/remote/reset")
def api_reset():
    d = _cfg()
    d["pin"] = "%06d" % secrets.randbelow(1_000_000); d["phones"] = []
    _save(d)
    return jsonify(_info())


@bp.get("/api/remote/poll")
def api_poll():
    """Long poll for the page / native player: returns the phone's commands as soon as there are any (or after 20 s)."""
    src = "native" if request.args.get("src") == "native" else "page"
    if not _server["port"]:
        return jsonify({"on": False, "cmds": []})
    deadline = time.time() + 20
    with _cond:
        while not _queues[src] and time.time() < deadline and _server["port"]:
            _cond.wait(max(0.1, deadline - time.time()))
        cmds, _queues[src][:] = list(_queues[src]), []
    return jsonify({"on": True, "cmds": cmds})


@bp.post("/api/remote/status")
def api_status():
    d = request.get_json(silent=True) or {}
    src = "native" if d.get("src") == "native" else "page"
    _status[src] = (_clean_status(d), time.time())
    return jsonify({"ok": True})


# ---- network side (the phone)
def _paired():
    tok = request.cookies.get(COOKIE, "")
    return bool(tok) and _h(tok) in _cfg()["phones"]


def _need_pair():
    if not _paired():
        abort(401)


@LAN.after_request
def _lan_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers.setdefault("Cache-Control", "no-store")
    return resp


@LAN.get("/")
def lan_page():
    try:
        html = (_res_dir / "assets" / "remote.html").read_text(encoding="utf-8")
    except OSError:
        abort(404)
    return Response(html, mimetype="text/html", headers={"Cache-Control": "no-store"})


@LAN.get("/manifest.webmanifest")
def lan_manifest():
    m = {"name": "ULTRON Remote", "short_name": "ULTRON", "start_url": "/", "scope": "/", "display": "standalone",
         "orientation": "portrait", "background_color": "#0b0a0d", "theme_color": "#0b0a0d",
         "icons": [{"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
                   {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"}]}
    return Response(json.dumps(m), mimetype="application/manifest+json", headers={"Cache-Control": "max-age=86400"})


_ICONS = {}


@LAN.get("/icon-<int:size>.png")
def lan_icon(size):
    """The app logo as a square home-screen icon (made once from logo.png; a plain mark when there is none)."""
    if size not in (180, 192, 512):
        abort(404)
    if size not in _ICONS:
        from PIL import Image, ImageDraw
        img = Image.new("RGB", (size, size), "#0b0a0d")
        logo = next((p for p in (_res_dir / "logo.png", Path(os.getcwd()) / "logo.png") if p.is_file()), None)
        try:
            if logo:
                lg = Image.open(logo).convert("RGBA")
                lg.thumbnail((int(size * .78), int(size * .78)))
                img.paste(lg, ((size - lg.width) // 2, (size - lg.height) // 2), lg)
            else:
                ImageDraw.Draw(img).ellipse([size * .2, size * .2, size * .8, size * .8], fill="#ff5f8f")
        except Exception:
            log.warning("icon failed", exc_info=True)
        buf = io.BytesIO(); img.save(buf, "PNG"); _ICONS[size] = buf.getvalue()
    return Response(_ICONS[size], mimetype="image/png", headers={"Cache-Control": "max-age=86400"})


@LAN.post("/pair")
def lan_pair():
    wait = _lockout["until"] - time.time()
    if wait > 0:
        return jsonify({"error": "Too many tries. Wait %d s." % (int(wait) + 1)}), 429
    pin = str((request.get_json(silent=True) or {}).get("pin", "")).strip()
    d = _cfg()
    if not secrets.compare_digest(pin, d["pin"]):
        _lockout["fails"] += 1
        if _lockout["fails"] >= 5:
            _lockout.update(fails=0, until=time.time() + 60)
        return jsonify({"error": "Wrong code."}), 401
    _lockout["fails"] = 0
    tok = secrets.token_urlsafe(32)
    d["phones"] = (d["phones"] + [_h(tok)])[-8:]
    _save(d)
    resp = jsonify({"ok": True})
    resp.set_cookie(COOKIE, tok, max_age=PAIR_DAYS * 86400, httponly=True, samesite="Strict", path="/")
    return resp


@LAN.get("/state")
def lan_state():
    if not _paired():
        return jsonify({"paired": False}), 401
    src = _active()
    st, at = _status[src]
    if time.time() - at > 6:
        st = {"kind": "none"}
    st = _mask(st)
    st["age"] = round(max(0.0, time.time() - at), 3)        # how old "pos" is: the phone's sound follows the PC to the tenth of a second
    return jsonify({"paired": True, "now": st})


@LAN.route("/app.apk", methods=["GET", "HEAD"])
def lan_apk():
    """The Android app (android/, built into assets/ULTRON-Remote.apk), for phones that want more than the web page."""
    _need_pair()
    p = _res_dir / "assets" / "ULTRON-Remote.apk"
    if not p.is_file():
        abort(404)
    return send_file(p, mimetype="application/vnd.android.package-archive", as_attachment=True,
                     download_name="ULTRON-Remote.apk", max_age=0)


@LAN.get("/library")
def lan_library():
    _need_pair()
    try:
        items = [v for v in (H["library"]() or []) if H["is_public"](v.get("id"))]
    except Exception:
        log.warning("remote library failed", exc_info=True)
        items = []
    return jsonify({"continue": items})


# ---- the read-only proxy into the main app
_ID = r"[A-Za-z0-9_-]{1,64}"
_ALLOW_GET = [re.compile("^" + p + "$") for p in (
    r"/api/videos", r"/api/series/" + _ID, r"/api/videos/" + _ID + r"/info", r"/api/videos/" + _ID + r"/strip",
    r"/poster/" + _ID, r"/backdrop/" + _ID, r"/seriesart/" + _ID, r"/cover/" + _ID, r"/subtitle/" + _ID + r"/\d{1,3}",
    r"/api/playlists", r"/api/playlists/\d{1,9}", r"/api/likes", r"/api/music/albums", r"/api/music/recent")]
_ALLOW_POST = [(re.compile(r"^/api/videos/(" + _ID + r")/progress$"), lambda m: H["is_public"](m.group(1))),   # resume point
               (re.compile(r"^/api/playlist$"), lambda m: True)]          # music filter query (read-only; albums, song search)


@LAN.route("/x/<path:sub>", methods=["GET", "POST"])
def lan_proxy(sub):
    _need_pair()
    if _main is None:
        abort(404)
    path = "/" + sub
    headers = {}
    if request.method == "POST":
        hit = next(((r.match(path), ok) for r, ok in _ALLOW_POST if r.match(path)), None)
        if not hit or request.headers.get("X-Remote") != "1" or not hit[1](hit[0]):
            abort(404)
        headers["X-LMP"] = "1"
    elif not any(r.match(path) for r in _ALLOW_GET):
        abort(404)
    qs = [(k, v) for k, v in request.args.items(multi=True) if k.lower() != "private"]
    c = _main.test_client(use_cookies=False)          # fresh: never a private token, never the phone's cookie
    r = c.open(path, method=request.method, query_string=qs, headers=headers,
               data=request.get_data() if request.method == "POST" else None,
               content_type=request.content_type if request.method == "POST" else None)
    out = Response(r.get_data(), status=r.status_code, content_type=r.content_type)
    if r.status_code == 200 and request.method == "GET" and r.headers.get("Cache-Control") and not path.startswith("/api/"):
        out.headers["Cache-Control"] = r.headers["Cache-Control"]          # posters / covers may be cached
    return out


# ---- watch on the phone
DIRECT_EXT = {".mp4", ".m4v", ".mov", ".webm"}
PHONE_V = {"h264", "hevc", "vp9", "av1"}
PHONE_A = {"aac", "mp3", "opus", "vorbis"}


def choose_mode(ext, probe, audio_index=0):
    """direct = send the file as it is; remux = copy the picture, convert the sound; convert = re-encode (max 720p)."""
    v = str((probe or {}).get("vcodec") or "").lower()
    auds = [str(a.get("codec") or "").lower() for a in (probe or {}).get("audio") or []]
    ext = str(ext or "").lower()
    if not v:                                           # no ffprobe: trust the container
        return "direct" if ext in DIRECT_EXT else "convert"
    if ext in DIRECT_EXT and v in PHONE_V and all(a in PHONE_A for a in auds) and (audio_index == 0 or len(auds) <= 1):
        return "direct"
    if v in ("h264", "hevc"):
        return "remux"
    return "convert"


def _kill_stream():
    with _stream_lock:
        p, _stream["proc"] = _stream["proc"], None
    if p and p.poll() is None:
        try:
            p.kill()
        except Exception:
            pass


@LAN.get("/streaminfo/<vid>")
def lan_streaminfo(vid):
    _need_pair()
    path = H["video_path"](vid) if H["is_public"](vid) else None
    if not path:
        abort(404)
    pr = H["probe"](vid) or {}
    ff = bool(H["ffmpeg"]())
    mode = choose_mode(Path(path).suffix, pr)
    return jsonify({"mode": mode, "playable": mode == "direct" or ff, "ffmpeg": ff, "duration": pr.get("duration") or 0,
                    "audio": [{"lang": a.get("lang") or "", "codec": a.get("codec") or ""} for a in pr.get("audio") or []]})


@LAN.get("/stream/<vid>")
def lan_stream(vid):
    _need_pair()
    path = H["video_path"](vid) if H["is_public"](vid) else None
    if not path:
        abort(404)
    try:
        t = max(0.0, float(request.args.get("t") or 0))
        a = max(0, min(31, int(request.args.get("a") or 0)))
    except ValueError:
        abort(400)
    want = request.args.get("mode") or "auto"
    mode = choose_mode(Path(path).suffix, H["probe"](vid) or {}, a) if want not in ("direct", "remux", "convert") else want
    if mode == "direct":
        return H["ranged"](path)
    ff = H["ffmpeg"]()
    if not ff or H["popen"] is None:
        return jsonify({"error": "This file needs ffmpeg to play on a phone."}), 409
    cmd = [str(ff), "-hide_banner", "-loglevel", "error", "-ss", "%.3f" % t, "-i", str(path),
           "-map", "0:v:0", "-map", "0:a:%d?" % a, "-sn", "-dn"]
    if mode == "remux":
        cmd += ["-c:v", "copy"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                "-vf", "scale=-2:'min(720,ih)'"]
    cmd += ["-c:a", "aac", "-ac", "2", "-b:a", "192k",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"]
    if mode == "remux" and str((H["probe"](vid) or {}).get("vcodec")) == "hevc":
        i = cmd.index("-f")
        cmd[i:i] = ["-tag:v", "hvc1"]                      # Safari / iOS want this tag for HEVC
    _kill_stream()                                      # one phone stream at a time
    proc = H["popen"](cmd)
    with _stream_lock:
        _stream["proc"] = proc

    def body():
        try:
            while True:
                chunk = proc.stdout.read(256 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:                                        # the phone went away or seeked: stop ffmpeg
            if proc.poll() is None:
                try:
                    proc.kill()
                except Exception:
                    pass
    return Response(body(), mimetype="video/mp4", headers={"Cache-Control": "no-store", "X-Stream-Mode": mode})


# ---- sound on the phone (the picture stays on the PC): the soundtrack of a video, or a song file
@LAN.get("/audio/<vid>")
def lan_audio(vid):
    _need_pair()
    path = H["video_path"](vid) if H["is_public"](vid) else None
    if not path:
        abort(404)
    try:
        t = max(0.0, float(request.args.get("t") or 0))
        a = max(0, min(31, int(request.args.get("a") or 0)))
    except ValueError:
        abort(400)
    ff = H["ffmpeg"]()
    if not ff or H["popen"] is None:
        if Path(path).suffix.lower() in DIRECT_EXT:          # no ffmpeg: the phone plays the file's own sound (and seeks itself)
            return H["ranged"](path)
        return jsonify({"error": "Sound on the phone needs ffmpeg for this file."}), 409
    cmd = [str(ff), "-hide_banner", "-loglevel", "error", "-ss", "%.3f" % t, "-i", str(path), "-vn", "-sn", "-dn",
           "-map", "0:a:%d?" % a, "-c:a", "aac", "-ac", "2", "-b:a", "160k", "-f", "adts", "pipe:1"]
    _kill_stream()
    proc = H["popen"](cmd)
    with _stream_lock:
        _stream["proc"] = proc

    def body():
        try:
            while True:
                chunk = proc.stdout.read(32 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            if proc.poll() is None:
                try:
                    proc.kill()
                except Exception:
                    pass
    return Response(body(), mimetype="audio/aac", headers={"Cache-Control": "no-store"})


@LAN.get("/song/<tid>")
def lan_song(tid):
    _need_pair()
    p = H["track_path"](tid)
    if not p:
        abort(404)
    return send_file(p, conditional=True, max_age=0)


# ---- commands
def _f(v, lo, hi):
    try:
        v = float(v)
    except (TypeError, ValueError):
        abort(400)
    if v != v:                                          # NaN
        abort(400)
    return max(lo, min(hi, v))


def _i(v, lo, hi):
    try:
        v = int(v)
    except (TypeError, ValueError):
        abort(400)
    if not lo <= v <= hi:
        abort(400)
    return v


PAGE_ONLY = {"play_video", "shuffle_music", "rate", "heart", "play_music", "queue_jump", "surprise"}


def _check(cmd, arg):
    """Validated argument for a command (400 / 404 on anything unexpected)."""
    if cmd in ("toggle", "mute", "next", "prev", "close", "shuffle_music", "fullscreen", "surprise"):
        return None
    if cmd == "pc_mute":
        return bool(arg)
    if cmd in ("seek_rel", "seek_abs"):
        return _f(arg, -1e6, 1e6)
    if cmd == "vol":
        return _f(arg, 0.0, 1.0)
    if cmd == "speed":
        return _f(arg, 0.25, 4.0)
    if cmd == "sub_delay":
        return _f(arg, -1.0, 1.0)
    if cmd == "sub":
        return "off" if arg == "off" else _i(arg, 0, 999)
    if cmd in ("audio", "chapter", "queue_jump"):
        return _i(arg, 0, 9999)
    if cmd == "sleep":
        if arg in (None, "eov"):
            return arg
        return _i(arg, 1, 240)
    if cmd == "play_video":
        arg = str(arg or "")
        if not H["is_public"](arg):                     # the phone can only start public videos
            abort(404)
        return arg
    if cmd == "rate":
        if not isinstance(arg, dict) or not H["is_public"](str(arg.get("id") or "")):
            abort(404)
        return {"id": str(arg["id"]), "stars": _i(arg.get("stars"), 0, 5)}
    if cmd == "heart":
        arg = str(arg or "")
        if not H["track_exists"](arg):
            abort(404)
        return arg
    if cmd == "play_music":
        if not isinstance(arg, dict):
            abort(400)
        kind = arg.get("kind")
        if kind not in ("playlist", "album", "liked", "recent", "all", "search"):
            abort(400)
        out = {"kind": kind, "start": _i(arg.get("start") or 0, 0, 100000), "shuffle": bool(arg.get("shuffle"))}
        if kind == "playlist":
            out["id"] = _i(arg.get("id"), 0, 10 ** 9)
        elif kind == "album":
            out["id"] = str(arg.get("id") or "")[:200]
        elif kind == "search":
            out["q"] = str(arg.get("q") or "")[:100]
        return out
    abort(400)


CMDS = {"toggle", "seek_rel", "seek_abs", "vol", "mute", "next", "prev", "close", "play_video", "shuffle_music", "fullscreen",
        "sub", "audio", "speed", "sub_delay", "chapter", "sleep", "rate", "heart", "play_music", "queue_jump", "surprise", "pc_mute"}


@LAN.post("/cmd")
def lan_cmd():
    _need_pair()
    if request.headers.get("X-Remote") != "1":       # a plain cross-site form post cannot set this header
        abort(403)
    d = request.get_json(silent=True) or {}
    cmd = str(d.get("cmd", ""))
    if cmd not in CMDS:
        abort(400)
    arg = _check(cmd, d.get("arg"))
    _push(cmd, arg, "page" if cmd in PAGE_ONLY else None)     # starting things and library data are the page's job
    return jsonify({"ok": True})
