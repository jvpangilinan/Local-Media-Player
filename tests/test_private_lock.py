"""Private-library lock: password setup, unlock, wrong-password lockout, change, lock, and that private videos never
leak into the public lists (the Ctrl+K search is built from /api/videos). Also the Photos lock that shares the password.
Run:  python tests/test_private_lock.py
Works on a throw-away copy of the app code and fake media in a temp folder; your real data and media are never touched."""
import os, shutil, sys, tempfile, time, types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-lock-"))
for f in ROOT.glob("*.py"):
    shutil.copy(f, tmp / f.name)
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

assert Path(app.DATA_DIR).resolve().is_relative_to(tmp.resolve()), "test must not touch real data"
assert Path(app.CFG["private_dir"]).resolve().is_relative_to(tmp.resolve()), "test must not touch real media"
app.init_db(); app.WINDOW = None

for rel in ("videos/Action/Public Film.mp4", "private/Secret Film.mp4", "private/Secret Show/e01.mkv"):
    p = media / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * 100)
app.scan_videos()
lib = app.LIB["videos"]
pub_id = next(i for i, v in lib.items() if not v["private"])
priv_id = next(i for i, v in lib.items() if v["private"] and "Secret Film" in str(v["path"]))

H = {"X-LMP": "1"}
c = app.app.test_client()


def titles(resp):
    """Every string in a JSON answer, flattened, so a private title anywhere in it is caught."""
    out = []
    def walk(x):
        if isinstance(x, dict):
            [walk(v) for v in x.values()]
        elif isinstance(x, list):
            [walk(v) for v in x]
        elif isinstance(x, str):
            out.append(x)
    walk(resp.get_json())
    return " | ".join(out)


# 1. No password yet: locked, private content refused, public list has no private items.
assert c.get("/api/lock/status").json == {"has_password": False, "unlocked": False}
assert c.get("/api/videos?private=1").status_code == 403
assert c.get(f"/api/videos/{priv_id}/info").status_code == 403
assert c.get(f"/media/video/{priv_id}").status_code == 403
assert c.get(f"/api/videos/{pub_id}/info").status_code == 200
public = titles(c.get("/api/videos"))
assert "Public Film" in public and "Secret" not in public, public

# 2. The CSRF header is required.
assert c.post("/api/lock/setup", json={"password": "abcd"}).status_code == 403

# 3. Setup: too short is refused, a good one unlocks; a second setup is refused.
assert c.post("/api/lock/setup", json={"password": "abc"}, headers=H).status_code == 400
r = c.post("/api/lock/setup", json={"password": "abcd"}, headers=H)
assert r.status_code == 200 and r.json["token"]
assert "abcd" not in (Path(app.SETTINGS_PATH).read_text()), "password stored in plain text"
assert c.get("/api/lock/status").json["unlocked"] is True            # the cookie works on its own
assert c.post("/api/lock/setup", json={"password": "zzzz"}, headers=H).status_code == 409

# 4. Unlocked: private list works and holds only private items; the public list still has none.
private = titles(c.get("/api/videos?private=1"))
assert "Secret Film" in private and "Public Film" not in private, private
assert c.get(f"/api/videos/{priv_id}/info").status_code == 200
public = titles(c.get("/api/videos"))
assert "Secret" not in public, "private item in the public list while unlocked: " + public

# 5. Another client without the cookie is still locked; a made-up token does nothing.
other = app.app.test_client()
assert other.get("/api/videos?private=1").status_code == 403
assert other.get("/api/videos?private=1", headers={"X-Private-Token": "made-up"}).status_code == 403

# 6. Lock: the session is gone, the cookie too.
assert c.post("/api/lock/lock", headers=H).status_code == 200
assert c.get("/api/lock/status").json["unlocked"] is False
assert c.get("/api/videos?private=1").status_code == 403

# 7. Wrong password 5 times -> 30 s lockout, even the right password is refused meanwhile.
for _ in range(4):
    assert c.post("/api/lock/unlock", json={"password": "nope"}, headers=H).status_code == 401
assert c.post("/api/lock/unlock", json={"password": "nope"}, headers=H).status_code == 401   # 5th: starts the pause
r = c.post("/api/lock/unlock", json={"password": "abcd"}, headers=H)
assert r.status_code == 429 and r.json["retry_after"] > 0, r.json
app.LOCKOUT["until"] = 0                                              # skip the 30 s wait
r = c.post("/api/lock/unlock", json={"password": "abcd"}, headers=H)
assert r.status_code == 200
token1 = r.json["token"]

# 8. One unlocked session at a time: a new unlock ends the old one.
r = other.post("/api/lock/unlock", json={"password": "abcd"}, headers=H)
assert r.status_code == 200
assert not app.valid_token(token1), "old session still valid after a new unlock"
assert c.get("/api/videos?private=1").status_code == 403
token2 = r.json["token"]

# 9. Sessions expire.
app.SESSIONS[token2] = time.time() - 1
assert other.get("/api/videos?private=1").status_code == 403

# 10. Change password: needs an unlocked session and the old password.
assert c.post("/api/lock/change", json={"old": "abcd", "new": "efgh"}, headers=H).status_code == 403
c.post("/api/lock/unlock", json={"password": "abcd"}, headers=H)
assert c.post("/api/lock/change", json={"old": "wrong", "new": "efgh"}, headers=H).status_code == 401
assert c.post("/api/lock/change", json={"old": "abcd", "new": "ef"}, headers=H).status_code == 400
assert c.post("/api/lock/change", json={"old": "abcd", "new": "efgh"}, headers=H).status_code == 200
c.post("/api/lock/lock", headers=H)
assert c.post("/api/lock/unlock", json={"password": "abcd"}, headers=H).status_code == 401
assert c.post("/api/lock/unlock", json={"password": "efgh"}, headers=H).status_code == 200
c.post("/api/lock/lock", headers=H)
app.LOCKOUT.update(fails=0, until=0)

# 11. Photos lock shares the password: off by default; on -> locked until either unlock; disable needs the password.
p = app.app.test_client()
assert p.get("/api/plock/status").json["unlocked"] is True
assert p.post("/api/plock/enable", headers=H).status_code == 200      # password exists already, so none needed
assert app.photos_lock_on()
q = app.app.test_client()                                             # a fresh client has no Photos cookie
assert q.get("/api/plock/status").json == {"enabled": True, "has_password": True, "unlocked": False}
assert q.post("/api/plock/unlock", json={"password": "nope"}, headers=H).status_code == 401
assert q.post("/api/plock/unlock", json={"password": "efgh"}, headers=H).status_code == 200
assert q.get("/api/plock/status").json["unlocked"] is True
assert q.get("/api/lock/status").json["unlocked"] is True             # one password: Photos unlock opens private too
assert q.post("/api/plock/lock", headers=H).status_code == 200
assert q.get("/api/plock/status").json["unlocked"] is False
assert q.post("/api/plock/disable", json={"password": "nope"}, headers=H).status_code == 401
assert q.post("/api/plock/disable", json={"password": "efgh"}, headers=H).status_code == 200
assert not app.photos_lock_on()

print("private lock OK")
shutil.rmtree(tmp, ignore_errors=True)
