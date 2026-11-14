"""Phone remote (remote.py): off by default, pairing + lockout, every phone route needs pairing, private content never
reaches the phone, commands go to the right player, and the phone server cannot reach the normal API.
Run:  python tests/test_remote.py
Throw-away copy of the code and fake media in a temp folder; no network port is opened (the phone server is driven
through Flask's test client), so this never touches your data or triggers a firewall prompt."""
import os, shutil, sys, tempfile, time, types
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-remote-"))
for f in ROOT.glob("*.py"):
    shutil.copy(f, tmp / f.name)
(tmp / "assets").mkdir()
shutil.copy(ROOT / "assets" / "remote.html", tmp / "assets" / "remote.html")
media = tmp / "media"
os.environ["ZENO_DATA_DIR"] = str(tmp / "data")
os.environ["MEDIA_VIDEO_DIR"] = str(media / "videos")
os.environ["MEDIA_PRIVATE_DIR"] = str(media / "private")
os.environ["MEDIA_MUSIC_DIR"] = str(media / "music")
os.environ["MEDIA_PHOTO_DIR"] = str(media / "Photos")
sys.path.insert(0, str(tmp)); sys.argv = ["app.py"]
try:
    import mutagen  # noqa: F401
except ImportError:                                    # only the test machine may lack it
    for n in ("mutagen", "mutagen.flac"):
        sys.modules[n] = types.ModuleType(n)
    sys.modules["mutagen"].File = lambda *a, **k: None
    sys.modules["mutagen.flac"].Picture = object
import app  # noqa: E402
import remote  # noqa: E402

assert Path(app.DATA_DIR).resolve().is_relative_to(tmp.resolve()), "test must not touch real data"
app.init_db(); app.WINDOW = None
for rel in ("videos/Action/Public Film.mp4", "private/Secret Film.mp4"):
    p = media / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * 100)
app.scan_videos()
lib = app.LIB["videos"]
pub = next(i for i, v in lib.items() if not v["private"])
priv = next(i for i, v in lib.items() if v["private"])
with closing(app.db()) as con, con:                    # both half-watched, so both would be "continue watching" candidates
    con.execute("UPDATE videos SET position = 600, duration = 3600, progress_at = ?", (time.time(),))

# no real socket: pretend the phone server started
remote._start = lambda: (remote._server.update(port=47400) or True)
remote._stop = lambda: remote._server.update(port=None)
remote.lan_ip = lambda: "192.168.1.50"
remote.init(app.DATA_DIR, tmp, app.remote_library, app.remote_poster, app.remote_is_public)

H = {"X-LMP": "1"}
pc = app.app.test_client()
phone = remote.LAN.test_client()
X = {"X-Remote": "1"}

# 1. Off by default; the page's poll returns at once; enabling needs the CSRF header.
info = pc.get("/api/remote/info").json
assert info["enabled"] is False and info["running"] is False and "qr" not in info
assert pc.get("/api/remote/poll").json == {"on": False, "cmds": []}
assert pc.post("/api/remote/enable", json={"on": True}).status_code == 403
info = pc.post("/api/remote/enable", json={"on": True}, headers=H).json
assert info["enabled"] and info["running"] and info["url"] == "http://192.168.1.50:47400/"
assert info["qr"].startswith("data:image/png;base64,"), "QR code missing"
pin = info["pin"]
assert len(pin) == 6 and pin.isdigit()

# 2. Unpaired phone gets nothing but the page.
assert phone.get("/").status_code == 200 and b"ULTRON Remote" in phone.get("/").data
assert phone.get("/state").status_code == 401
assert phone.get("/library").status_code == 401
assert phone.get(f"/poster/{pub}").status_code == 404
assert phone.post("/cmd", json={"cmd": "toggle"}, headers=X).status_code == 401

# 3. Pairing: wrong code x5 -> locked out (even the right code); then it works and sets an HttpOnly cookie.
wrong = "%06d" % ((int(pin) + 1) % 1_000_000)
for _ in range(5):
    assert phone.post("/pair", json={"pin": wrong}).status_code == 401
assert phone.post("/pair", json={"pin": pin}).status_code == 429
remote._lockout["until"] = 0
r = phone.post("/pair", json={"pin": pin})
assert r.status_code == 200
cookie = r.headers.get("Set-Cookie", "")
assert "HttpOnly" in cookie and "SameSite=Strict" in cookie
assert pc.get("/api/remote/info").json["phones"] == 1
assert phone.get("/state").json == {"paired": True, "now": {"kind": "none"}}

# 4. Commands need the X-Remote header and a known command; arguments are checked.
assert phone.post("/cmd", json={"cmd": "toggle"}).status_code == 403
assert phone.post("/cmd", json={"cmd": "rm -rf"}, headers=X).status_code == 400
assert phone.post("/cmd", json={"cmd": "seek_rel", "arg": "abc"}, headers=X).status_code == 400
assert phone.post("/cmd", json={"cmd": "play_video", "arg": priv}, headers=X).status_code == 404     # never a private video
assert phone.post("/cmd", json={"cmd": "play_video", "arg": "nope"}, headers=X).status_code == 404
assert phone.post("/cmd", json={"cmd": "play_video", "arg": pub}, headers=X).status_code == 200
assert phone.post("/cmd", json={"cmd": "vol", "arg": 7}, headers=X).status_code == 200                # clamped to 1.0
assert phone.post("/cmd", json={"cmd": "fullscreen"}, headers=X).status_code == 200
d = pc.get("/api/remote/poll?src=page").json
assert d["on"] and d["cmds"] == [{"cmd": "play_video", "arg": pub}, {"cmd": "vol", "arg": 1.0}, {"cmd": "fullscreen", "arg": None}], d

# 5. Private titles never reach the phone, whatever the player reports.
pc.post("/api/remote/status", json={"src": "page", "kind": "video", "private": True, "title": "Secret Film", "sub": "S", "id": priv,
                                    "pos": 5, "dur": 100, "paused": False}, headers=H)
now = phone.get("/state").json["now"]
assert now["title"] == "Private video" and now["sub"] == "" and now["id"] is None, now
assert "Secret" not in phone.get("/state").get_data(as_text=True)

# 6. Continue watching: only the public video; posters only for public ids.
items = phone.get("/library").json["continue"]
assert [v["id"] for v in items] == [pub], items
assert "Secret" not in phone.get("/library").get_data(as_text=True)
assert phone.get(f"/poster/{priv}").status_code == 404

# 7. Routing: while the native window reports a video, it gets the commands; starting something stays on the page.
pc.post("/api/remote/status", json={"src": "native", "kind": "video", "title": "Public Film", "pos": 1, "dur": 9}, headers=H)
phone.post("/cmd", json={"cmd": "toggle"}, headers=X)
phone.post("/cmd", json={"cmd": "shuffle_music"}, headers=X)
assert pc.get("/api/remote/poll?src=native").json["cmds"] == [{"cmd": "toggle", "arg": None}]
assert pc.get("/api/remote/poll?src=page").json["cmds"] == [{"cmd": "shuffle_music", "arg": None}]
assert phone.get("/state").json["now"]["title"] == "Public Film"

# 8. The phone server is a separate app: none of the normal API exists on it.
for path in ("/api/videos", "/api/lock/status", f"/media/video/{pub}", "/api/remote/info", "/api/backup/export"):
    assert phone.get(path).status_code in (404, 405), path
assert pc.get("/state").status_code == 404 and pc.post("/pair", json={"pin": pin}, headers=H).status_code == 404

# 9. "New code" forgets every phone; switching off stops the page's poll.
pc.post("/api/remote/reset", headers=H)
assert phone.get("/state").status_code == 401
assert pc.get("/api/remote/info").json["phones"] == 0
pc.post("/api/remote/enable", json={"on": False}, headers=H)
assert pc.get("/api/remote/poll").json["on"] is False

print("phone remote OK")
shutil.rmtree(tmp, ignore_errors=True)
