"""Photo galleries: sizes are remembered across restarts, the private folder is walked once, and a page asking for
unknown photos cannot make the app re-scan the folder for each one. Run:
    python tests/test_photo_scan.py
Uses a throw-away media tree in a temp folder; your real data and media are never touched."""
import os, re, shutil, sys, tempfile, time, types
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-photo-"))
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
from PIL import Image  # noqa: E402

assert Path(app.DATA_DIR).resolve().is_relative_to(tmp.resolve()), "test must not touch real data"
assert Path(app.CFG["private_dir"]).resolve().is_relative_to(tmp.resolve()), "test must not touch real media"
app.init_db(); app.WINDOW = None

sizes = {"private/Photos/a.jpg": (40, 30), "private/Photos/Trip/b.png": (20, 50), "private/loose.webp": (64, 64),
         "private/Movie.jpg": (10, 10), "private/Show/Movie-poster.png": (10, 10), "private/cover.jpg": (10, 10),
         "Photos/x.jpg": (33, 22), "Photos/Beach/y.png": (12, 34)}
for rel, wh in sizes.items():
    p = media / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", wh, "red").save(p)
for rel in ("private/Movie.mp4", "private/Show/Movie.mkv"):
    (media / rel).write_bytes(b"x")


def old_scan(public):                                  # the scan as it was: two walks, sizes only cached in memory
    root = app.CFG["photo_dir"] if public else app.CFG["private_dir"]
    video_stems = set() if public else {(str(p.parent).lower(), p.stem.lower()) for p, _ in app.walk_entries(root, app.VIDEO_EXTS)}
    out = []
    for p, entry in app.walk_entries(root, app.PHOTO_EXTS):
        parts = p.relative_to(root).parts
        stem = p.stem.lower()
        if not public and not (len(parts) > 1 and parts[0].lower() == app.PHOTO_FOLDER.lower()):
            base = re.sub(r"(-poster|\.poster|_poster)$", "", stem)
            if (str(p.parent).lower(), base) in video_stems or base in app.PHOTO_SKIP:
                continue
        rel = "/".join(parts)
        inner = parts[1:] if (not public and parts[0].lower() == app.PHOTO_FOLDER.lower()) else parts
        out.append((app.item_id(("pphoto/" if public else "photo/") + rel), rel, app.photo_size(p, 0),
                    inner[0] if len(inner) > 1 else ""))
    return sorted(out)


new_view = lambda public: sorted((x["id"], x["rel"], (x["w"], x["h"]), x["album"]) for x in app.scan_photos(public))

# 1. same photos, ids, sizes and albums as before; posters and series art are still left out
for public in (False, True):
    assert new_view(public) == old_scan(public), (public, new_view(public), old_scan(public))
priv = {x["rel"]: x for x in app.scan_photos()}
assert set(priv) == {"Photos/a.jpg", "Photos/Trip/b.png", "loose.webp"}, set(priv)
assert (priv["Photos/a.jpg"]["w"], priv["Photos/a.jpg"]["h"]) == (40, 30) and priv["Photos/Trip/b.png"]["album"] == "Trip"

# 2. the private folder is walked once per scan, not twice
real_walk, walks = app.walk_entries, []
app.walk_entries = lambda *a, **k: (walks.append(1), real_walk(*a, **k))[1]
app.scan_photos()
app.walk_entries = real_walk
assert len(walks) == 1, walks

# 3. sizes survive a restart: no image is opened again unless it changed
real_size, opened = app.photo_size, []
app.photo_size = lambda p, m: (opened.append(p.name), real_size(p, m))[1]
app.PHOTO_DIMS.clear(); app.PHOTO_DIMS_LOADED.clear()            # "restart"
app.scan_photos(); app.scan_photos(True)
assert opened == [], opened
p = media / "private/Photos/a.jpg"
Image.new("RGB", (80, 60), "blue").save(p)                       # edited: new size, new date
t = time.time() + 5; os.utime(p, (t, t))
x = next(v for v in app.scan_photos() if v["rel"] == "Photos/a.jpg")
assert opened == ["a.jpg"] and (x["w"], x["h"]) == (80, 60), (opened, x["w"], x["h"])
app.photo_size = real_size

# 4. a deleted photo is forgotten by the size table too; private and public entries do not mix
(media / "private/loose.webp").unlink()
app.scan_photos()
with closing(app.db()) as con:
    keys = {r[0] for r in con.execute("SELECT key FROM photo_dims")}
assert "private:loose.webp" not in keys and "private:Photos/a.jpg" in keys and "public:x.jpg" in keys, keys

# 5. find_photo: hundreds of unknown ids cause at most one scan; known ids cause none; a change made here is seen at once
real_scan, scans = app.scan_photos, []
app.scan_photos = lambda public=False: (scans.append(public), real_scan(public))[1]
good = priv["Photos/a.jpg"]["id"]
app.find_photo(good)                                             # warm
scans.clear()
for i in range(200):
    assert app.find_photo("nope%d" % i) is None
assert len(scans) <= 1, len(scans)
scans.clear()
for _ in range(50):
    assert app.find_photo(good)["id"] == good
assert scans == [], scans
app.photo_invalidate()
app.find_photo(good)
assert scans == [False], scans                                   # invalidated: re-scanned right away
gone = app.find_photo(next(v["id"] for v in priv.values() if v["rel"] == "Photos/Trip/b.png"))
(gone["path"]).unlink()
assert app.find_photo(gone["id"]) is None                        # file gone: never served, even before the next scan
app.scan_photos = real_scan

# 6. the gallery routes still work
c = app.app.test_client()
r = c.get("/api/pphotos")
assert r.status_code == 200, r.status_code
got = {(x["w"], x["h"]) for x in r.get_json()["photos"]}
assert got == {(33, 22), (12, 34)}, got

shutil.rmtree(tmp, ignore_errors=True)
print("photo scan: OK")
