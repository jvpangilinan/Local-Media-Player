"""Gallery paintings (NGA): status/list/image routes, resumable download with a fake fetch, non-NGA host refused,
unknown id 404, removal, and the art_side / bg_mode prefs.
Run:  python tests/test_art.py
Throw-away copy in a temp folder; nothing is downloaded (the fetch function is replaced)."""
import json, os, shutil, sys, tempfile, time, types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-art-"))
for f in ROOT.glob("*.py"):
    shutil.copy(f, tmp / f.name)
(tmp / "assets" / "art" / "starter").mkdir(parents=True)
man = json.loads((ROOT / "assets" / "art" / "manifest.json").read_text(encoding="utf-8"))
man["works"] = man["works"][:4]                      # small manifest; the first one also exists as a starter file
(tmp / "assets" / "art" / "manifest.json").write_text(json.dumps(man), encoding="utf-8")
W = man["works"]
(tmp / "assets" / "art" / "starter" / (W[0]["id"] + ".jpg")).write_bytes(b"starter")
media = tmp / "media"
os.environ["ZENO_DATA_DIR"] = str(tmp / "data")
os.environ["MEDIA_VIDEO_DIR"] = str(media / "videos")
os.environ["MEDIA_PRIVATE_DIR"] = str(media / "private")
os.environ["MEDIA_MUSIC_DIR"] = str(media / "music")
os.environ["MEDIA_PHOTO_DIR"] = str(media / "Photos")
sys.path.insert(0, str(tmp)); sys.argv = ["app.py"]
try:
    import mutagen  # noqa: F401
except ImportError:
    for n in ("mutagen", "mutagen.flac"):
        sys.modules[n] = types.ModuleType(n)
    sys.modules["mutagen"].File = lambda *a, **k: None
    sys.modules["mutagen.flac"].Picture = object
import app  # noqa: E402

assert Path(app.DATA_DIR).resolve().is_relative_to(tmp.resolve()), "test must not touch real data"
app.init_db(); app.WINDOW = None
c = app.app.test_client()
H = {"X-LMP": "1"}


def wait_idle():
    for _ in range(200):
        st = c.get("/api/art/status").get_json()
        if st["install"]["state"] != "running":
            return st
        time.sleep(0.05)
    raise AssertionError("download did not finish")


# status + list: only the starter work exists at first
st = c.get("/api/art/status").get_json()
assert st["total"] == 4 and st["downloaded"] == 0 and st["available"] == 1 and st["bytes"] > 0, st
lst = c.get("/api/art/list").get_json()["works"]
assert [w["id"] for w in lst] == [W[0]["id"]] and "iiif" not in lst[0], lst
r = c.get("/art/%s.jpg" % W[0]["id"])
assert r.status_code == 200 and r.data == b"starter" and r.mimetype == "image/jpeg" and "max-age" in r.headers.get("Cache-Control", "")
r.close()

# unknown / malformed / not-yet-downloaded ids -> 404
for bad in ("00000000-0000-0000-0000-000000000000", "..", "nope", W[1]["id"]):
    assert c.get("/art/%s.jpg" % bad).status_code == 404, bad

# download with a fake fetch
calls = []
def fake(url, dest):
    calls.append(url)
    Path(dest).write_bytes(b"img:" + url.encode())
real_fetch = app._art_fetch
app._art_fetch = fake
assert c.post("/api/art/install").status_code == 403           # CSRF guard
c.post("/api/art/install", headers=H)
st = wait_idle()
assert st["install"]["state"] == "idle" and st["downloaded"] == 4 and st["available"] == 4, st
assert len(calls) == 4 and all(u.startswith("https://api.nga.gov/iiif/") and u.endswith("/full/!2560,2560/0/default.jpg") for u in calls), calls
assert not list((app.DATA_DIR / "art").glob("*.part"))
assert c.get("/art/%s.jpg" % W[1]["id"]).data.startswith(b"img:")
assert len(c.get("/api/art/list").get_json()["works"]) == 4

# resume: existing files are skipped
(app.DATA_DIR / "art" / (W[3]["id"] + ".jpg")).unlink()
calls.clear()
c.post("/api/art/install", headers=H); wait_idle()
assert len(calls) == 1 and W[3]["id"] in calls[0], calls

# a failing fetch leaves no .part and reports an error; the next run recovers
shutil.rmtree(app.DATA_DIR / "art")
def boom(url, dest):
    Path(dest).write_bytes(b"half"); raise RuntimeError("network down")
app._art_fetch = boom
c.post("/api/art/install", headers=H)
st = wait_idle()
assert st["install"]["state"] == "error" and "network down" in st["install"]["error"], st
assert not list((app.DATA_DIR / "art").glob("*.part")) and st["downloaded"] == 0
app._art_fetch = fake
c.post("/api/art/install", headers=H)
assert wait_idle()["downloaded"] == 4

# non-NGA host refused: by the worker (fetch never called) and by the real fetch function
orig = app._art_manifest
shutil.rmtree(app.DATA_DIR / "art"); calls.clear()
app._art_manifest = lambda: [dict(W[2], iiif="https://evil.example.com/iiif/x")]
c.post("/api/art/install", headers=H)
st = wait_idle()
assert st["install"]["state"] == "error" and not calls and "host" in st["install"]["error"], st
app._art_manifest = orig
for u in ("https://evil.example.com/x", "http://api.nga.gov/x", "https://api.nga.gov.evil.com/x", "file:///etc/passwd"):
    assert not app._art_url_ok(u), u
    try:
        real_fetch(u, tmp / "x.part")
        raise AssertionError("real fetch accepted " + u)
    except RuntimeError as e:
        assert "refusing" in str(e)
assert app._art_url_ok("https://api.nga.gov/iiif/x")

# remove the collection: downloaded copies go, the starter stays
app._art_fetch = fake
c.post("/api/art/install", headers=H); wait_idle()
assert c.delete("/api/art").status_code == 403
r = c.delete("/api/art", headers=H).get_json()
assert r["downloaded"] == 0 and r["available"] == 1 and not (app.DATA_DIR / "art").exists(), r

# prefs
for good in ("auto", "good", "evil"):
    assert app.clean_pref("art_side", good) == good
assert app.clean_pref("art_side", "heaven") == "auto" and app.clean_pref("art_side", None) == "auto"
assert app.clean_pref("bg_mode", "art") == "art" and app.clean_pref("bg_mode", "light") == "dark"

print("test_art: ok")
