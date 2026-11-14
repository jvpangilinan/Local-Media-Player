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
for rel in ("videos/Action/Public Film.mp4", "private/Secret Film.mp4", "private/Drama/Hidden Show/Hidden Show S01E01.mkv",
            "private/Drama/Hidden Show/Hidden Show S01E02.mkv"):
    p = media / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * 100)
app.scan_videos()
lib = app.LIB["videos"]
pub = next(i for i, v in lib.items() if not v["private"])
priv = next(i for i, v in lib.items() if v["private"] and "Secret" in str(v["path"]))
priv_series = next((sid for sid, s in app.LIB["series"].items() if s["private"]), None)
assert priv_series, "fixture needs a private series"
with closing(app.db()) as con, con:                    # both half-watched, so both would be "continue watching" candidates
    con.execute("UPDATE videos SET position = 600, duration = 3600, progress_at = ?", (time.time(),))
    con.execute("UPDATE videos SET position = 0, duration = 0 WHERE rel_path LIKE '%Hidden Show%'")

# no real socket: pretend the phone server started
remote._start = lambda: (remote._server.update(port=47400) or True)
remote._stop = lambda: remote._server.update(port=None)
remote.lan_ip = lambda: "192.168.1.50"
remote.init(app.DATA_DIR, tmp, app.app, library=app.remote_library, is_public=app.remote_is_public, video_path=app.remote_video_path,
            probe=lambda vid: {}, ffmpeg=lambda: None, ranged=app.ranged_file_response, popen=None,
            track_exists=app.remote_track_exists)

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
assert phone.get(f"/x/poster/{pub}").status_code == 401
assert phone.get("/x/api/videos").status_code == 401
assert phone.get(f"/streaminfo/{pub}").status_code == 401 and phone.get(f"/stream/{pub}").status_code == 401
assert phone.get("/manifest.webmanifest").status_code == 200 and phone.get("/icon-192.png").mimetype == "image/png"
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
st0 = phone.get("/state").json
assert st0["paired"] is True and st0["now"]["kind"] == "none", st0

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
assert phone.get(f"/x/poster/{priv}").status_code in (403, 404)

# 6b. The read-only proxy: allowed paths answer like a LOCKED user would; everything else does not exist.
vids = phone.get("/x/api/videos").get_data(as_text=True)
assert "Public Film" in vids and "Secret" not in vids and "Hidden" not in vids, vids[:300]
vids = phone.get("/x/api/videos?private=1").get_data(as_text=True)                   # the private flag is stripped
assert "Secret" not in vids and "Hidden" not in vids
assert phone.get(f"/x/api/videos/{pub}/info").status_code == 200
for path in (f"/x/api/videos/{priv}/info", f"/x/backdrop/{priv}", f"/x/api/videos/{priv}/strip?a=0&b=9",
             f"/x/api/series/{priv_series}", f"/x/seriesart/{priv_series}", f"/x/subtitle/{priv}/0"):
    assert phone.get(path).status_code in (403, 404), path
for path in ("/x/api/lock/status", f"/x/media/video/{pub}", "/x/api/backup/export", "/x/api/remote/info", "/x/api/prefs",
             "/x/api/videos/../lock/status", "/x/settings"):
    assert phone.get(path).status_code == 404, path
assert phone.post("/x/api/likes", json={"id": "x"}, headers=X).status_code == 404         # writes are commands, not proxied
assert phone.post(f"/x/api/videos/{pub}/progress", json={"position": 1200, "duration": 3600}).status_code == 404   # header needed
assert phone.post(f"/x/api/videos/{priv}/progress", json={"position": 1, "duration": 9}, headers=X).status_code == 404
assert phone.post(f"/x/api/videos/{pub}/progress", json={"position": 1200, "duration": 3600}, headers=X).status_code == 200
assert app.db().execute("SELECT position FROM videos WHERE id = ?", (pub,)).fetchone()[0] == 1200
assert phone.post("/x/api/playlist", json={"mode": "all", "q": "zzz"}, headers=X).status_code == 200
assert phone.get("/x/api/music/albums").status_code == 200 and phone.get("/x/api/playlists").status_code == 200

# 6c. Watch on the phone: public files stream (Range works), private ones do not exist.
assert phone.get(f"/streaminfo/{priv}").status_code == 404 and phone.get(f"/stream/{priv}").status_code == 404
si = phone.get(f"/streaminfo/{pub}").json
assert si["mode"] == "direct" and si["playable"] is True, si
r = phone.get(f"/stream/{pub}?mode=direct", headers={"Range": "bytes=0-9"})
assert r.status_code == 206 and r.data == b"x" * 10, (r.status_code, r.data[:20])
assert phone.get(f"/stream/{pub}?mode=remux").status_code == 409                         # no ffmpeg here: clear error
cm = remote.choose_mode
assert cm(".mp4", {"vcodec": "h264", "audio": [{"codec": "aac"}]}) == "direct"
assert cm(".mp4", {"vcodec": "h264", "audio": [{"codec": "aac"}, {"codec": "aac"}]}, 1) == "remux"     # pick 2nd audio
assert cm(".mkv", {"vcodec": "h264", "audio": [{"codec": "aac"}]}) == "remux"
assert cm(".mp4", {"vcodec": "hevc", "audio": [{"codec": "ac3"}]}) == "remux"
assert cm(".avi", {"vcodec": "mpeg4", "audio": [{"codec": "mp3"}]}) == "convert"
assert cm(".mkv", {}) == "convert" and cm(".mp4", {}) == "direct"

# 6c2. Sound on the phone: soundtrack / song routes refuse private and unknown ids; no ffmpeg + mp4 = the file itself.
assert phone.get(f"/audio/{priv}").status_code == 404 and phone.get("/song/nope").status_code == 404
r = phone.get(f"/audio/{pub}", headers={"Range": "bytes=0-3"})
assert r.status_code == 206 and r.data == b"xxxx", r.status_code

# 6d. New commands are validated.
ok = lambda c, a=None: phone.post("/cmd", json={"cmd": c, "arg": a}, headers=X).status_code
assert ok("sub", "off") == 200 and ok("sub", 2) == 200 and ok("sub", "x") == 400
assert ok("speed", 9) == 200 and ok("audio", 1) == 200 and ok("chapter", -1) == 400
assert ok("sleep", "eov") == 200 and ok("sleep", 30) == 200 and ok("sleep", None) == 200 and ok("sleep", "soon") == 400
assert ok("rate", {"id": priv, "stars": 3}) == 404 and ok("rate", {"id": pub, "stars": 6}) == 400 and ok("rate", {"id": pub, "stars": 4}) == 200
assert ok("heart", "nope") == 404 and ok("play_music", {"kind": "evil"}) == 400 and ok("play_music", {"kind": "album", "id": "a|b", "start": 2}) == 200
assert ok("surprise") == 200 and ok("queue_jump", 3) == 200
assert ok("pc_mute", True) == 200 and ok("pc_mute", 0) == 200
cmds = pc.get("/api/remote/poll?src=page").json["cmds"]
by = {c["cmd"]: c["arg"] for c in cmds}
assert by["speed"] == 4.0 and by["rate"] == {"id": pub, "stars": 4} and by["play_music"]["kind"] == "album", cmds
assert [x["arg"] for x in cmds if x["cmd"] == "pc_mute"] == [True, False], cmds

# 6e. Private status: track labels, chapters and ids are masked too.
pc.post("/api/remote/status", json={"src": "page", "kind": "video", "private": True, "title": "Secret Film", "vid": priv, "series_id": "s1",
                                    "subs": [{"id": 1, "on": True, "lang": "eng", "label": "Secret Film commentary"}],
                                    "chapters": [{"t": 5, "title": "Secret chapter"}], "pos": 1, "dur": 9}, headers=H)
body = phone.get("/state").get_data(as_text=True)
assert "Secret" not in body, body
st = phone.get("/state").json["now"]
assert 0 <= st["age"] < 5, st
assert st["vid"] is None and st["series_id"] is None and st["chapters"] == [] and st["subs"][0]["label"] == "ENG", st

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
