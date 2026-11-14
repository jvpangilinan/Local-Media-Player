"""Phone remote: control the app from a phone on the same Wi-Fi.

Two halves:
- `bp`, a blueprint on the normal app (127.0.0.1 only). Settings uses it to switch the remote on / off and show the QR code;
  the page and the native player use it to report what is playing and to pick up the phone's commands (long poll).
- `LAN`, a SEPARATE tiny Flask app that is the only thing ever exposed to the network. It serves the remote page and
  five routes, all behind a pairing cookie. It cannot reach the library API, media files or the private library.

Off by default. Pairing: the QR code carries a 6-digit PIN in the URL fragment (never sent to a server); typing it works
too. 5 wrong PINs lock pairing for 60 s. "Forget phones" makes a new PIN and drops every paired phone.
Private content: the phone never sees a private title (masked here, whatever the player sends), and "Continue
watching" only lists public videos.
"""
import base64, hashlib, json, logging, os, secrets, socket, threading, time
from pathlib import Path

from flask import Blueprint, Flask, Response, abort, jsonify, request, send_file

log = logging.getLogger("remote")
PORTS = (47400, 47401, 47402, 47403)
COOKIE = "zeno_remote"
PAIR_DAYS = 365

bp = Blueprint("remote", __name__)
LAN = Flask("zeno_remote")

_cfg_path = None          # DATA_DIR / remote.json  {"enabled": bool, "pin": "123456", "phones": [sha256(token), ...]}
_page_path = None         # assets/remote.html
_library = lambda: []     # app.py sets: continue-watching list (public only)
_poster = lambda vid: None  # app.py sets: poster file path for a PUBLIC video id, else None
_is_public = lambda vid: False

_lock = threading.Lock()
_cond = threading.Condition(_lock)
_queues = {"page": [], "native": []}
_status = {"page": ({}, 0.0), "native": ({}, 0.0)}
_lockout = {"fails": 0, "until": 0.0}
_server = {"srv": None, "port": None, "thread": None}


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


def init(data_dir, res_dir, library, poster, is_public):
    """Called once by app.py. Starts the phone server if it was on last time."""
    global _cfg_path, _page_path, _library, _poster, _is_public
    _cfg_path = Path(data_dir) / "remote.json"
    _page_path = Path(res_dir) / "assets" / "remote.html"
    _library, _poster, _is_public = library, poster, is_public
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
def _mask(st):
    st = dict(st or {})
    if st.get("private"):
        st.update(title="Private video", sub="", id=None)
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
    keep = ("kind", "title", "sub", "pos", "dur", "paused", "vol", "muted", "private", "has_next", "has_prev", "id")
    _status[src] = ({k: d.get(k) for k in keep}, time.time())
    return jsonify({"ok": True})


# ---- network side (the phone)
def _paired():
    tok = request.cookies.get(COOKIE, "")
    return bool(tok) and _h(tok) in _cfg()["phones"]


@LAN.after_request
def _lan_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@LAN.get("/")
def lan_page():
    try:
        return Response(_page_path.read_text(encoding="utf-8"), mimetype="text/html")
    except OSError:
        abort(404)


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
    return jsonify({"paired": True, "now": _mask(st)})


@LAN.get("/library")
def lan_library():
    if not _paired():
        abort(401)
    try:
        items = [v for v in (_library() or []) if _is_public(v.get("id"))]
    except Exception:
        log.warning("remote library failed", exc_info=True)
        items = []
    return jsonify({"continue": items})


@LAN.get("/poster/<vid>")
def lan_poster(vid):
    if not _paired() or not _is_public(vid):
        abort(404)
    p = _poster(vid)
    if not p:
        abort(404)
    return send_file(p, mimetype="image/jpeg", max_age=3600)


CMDS = {"toggle", "seek_rel", "seek_abs", "vol", "mute", "next", "prev", "close", "play_video", "shuffle_music"}


@LAN.post("/cmd")
def lan_cmd():
    if not _paired():
        abort(401)
    if request.headers.get("X-Remote") != "1":       # a plain cross-site form post cannot set this header
        abort(403)
    d = request.get_json(silent=True) or {}
    cmd, arg = str(d.get("cmd", "")), d.get("arg")
    if cmd not in CMDS:
        abort(400)
    if cmd in ("seek_rel", "seek_abs", "vol"):
        try:
            arg = float(arg)
        except (TypeError, ValueError):
            abort(400)
        if cmd == "vol":
            arg = max(0.0, min(1.0, arg))
    elif cmd == "play_video":
        arg = str(arg or "")
        if not _is_public(arg):                       # the phone can only start public videos
            abort(404)
    else:
        arg = None
    target = "page" if cmd in ("play_video", "shuffle_music") else None     # starting something is the page's job
    _push(cmd, arg, target)
    return jsonify({"ok": True})
