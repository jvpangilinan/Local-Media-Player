"""Summaries and official episode stills from TMDB (faked here, no internet used). Run:
    python tests/test_tmdb_info.py
Everything happens in a temp folder. Your real data and media are never touched."""
import os, shutil, sys, tempfile, types, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-info-"))
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
except ImportError:
    for n in ("mutagen", "mutagen.flac"):
        sys.modules[n] = types.ModuleType(n)
    sys.modules["mutagen"].File = lambda *a, **k: None
    sys.modules["mutagen.flac"].Picture = object
import app  # noqa: E402
import autogenre  # noqa: E402

assert Path(app.DATA_DIR).resolve().is_relative_to(tmp.resolve()), "test must not touch real data"
app.init_db(); app.WINDOW = None
c = app.app.test_client()

v = media / "videos"
for rel in ("Movies/Arrival (2016).mkv", "Movies/Love Death and Robots S04/Love.Death.and.Robots.S04E01.Cant.Stop.1080p.mkv",
            "Movies/Love Death and Robots S04/Love.Death.and.Robots.S04E02.1080p.mkv",
            "Movies/Love Death and Robots S04/Love.Death.and.Robots.S04E03.Spider.Rose.1080p.mkv",
            "TV/Plain/Season 2/E05.mkv"):
    (v / rel).parent.mkdir(parents=True, exist_ok=True)
    (v / rel).write_bytes(b"x" * 100)
(media / "private").mkdir(parents=True, exist_ok=True)
(media / "private" / "Secret (2020).mkv").write_bytes(b"x")
app.scan_videos()
lib = app.LIB["videos"]
by = {x["path"].name: x for x in lib.values()}
movie = by["Arrival (2016).mkv"]["id"]
e1, e2, e3 = (by[n]["id"] for n in ("Love.Death.and.Robots.S04E01.Cant.Stop.1080p.mkv", "Love.Death.and.Robots.S04E02.1080p.mkv",
                                    "Love.Death.and.Robots.S04E03.Spider.Rose.1080p.mkv"))
sid = by["Love.Death.and.Robots.S04E01.Cant.Stop.1080p.mkv"]["series_id"]
priv = next(x["id"] for x in lib.values() if x["private"])

# episode numbers from different naming styles
assert app.episode_numbers(lib[e1]) == (4, 1)
assert app.episode_numbers(by["E05.mkv"]) == (2, 5)

# what the poster step saved: the matches
autogenre.art_put(app.db, "video", movie, "ok", "movie/329865")
autogenre.art_put(app.db, "series", sid, "ok", "tv/86831")

asked, imgs = [], []
JPG = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbd3ffd9")


def fake_fetch(url, headers=None, timeout=15):
    path = urllib.parse.urlparse(url).path
    asked.append(path)
    if path.endswith("/movie/329865"):
        return {"overview": "A linguist works with the military to talk to aliens."}
    if path.endswith("/tv/86831"):
        return {"overview": "Short animated stories."}
    if path.endswith("/tv/86831/season/4"):
        return {"episodes": [{"episode_number": 1, "name": "Can't Stop", "overview": "Puppets dance.", "still_path": "/a.jpg"},
                             {"episode_number": 2, "name": "Close Encounters of the Mini Kind", "overview": "Tiny aliens.", "still_path": "/b.jpg"},
                             {"episode_number": 3, "name": "Spider Rose", "overview": "", "still_path": ""}]}
    return {}


def fake_bytes(url, timeout=20):
    imgs.append(url)
    return JPG


autogenre.fetch, autogenre.fetch_bytes = fake_fetch, fake_bytes
app.info_run("k")
assert any(p.endswith("/season/4") for p in asked), asked
assert len(imgs) == 2 and all("/w300/" in u for u in imgs), imgs

# the series page
d = c.get("/api/series/" + sid).get_json()
assert d["overview"] == "Short animated stories."
eps = {e["id"]: e for e in d["episodes"]}
assert eps[e1]["overview"] == "Puppets dance." and eps[e1]["title"] == "Cant Stop"                  # our cleaned name stays
assert eps[e2]["title"] == "Close Encounters of the Mini Kind", eps[e2]                             # "Episode 2" -> real name
assert eps[e3]["overview"] == ""
assert eps[e1]["poster"].endswith("s") and not eps[e3]["poster"].endswith("s")

# the episode picture is the official still; no still -> the frame from the video (or the placeholder here)
r = c.get("/poster/" + e1)
assert r.mimetype == "image/jpeg" and r.data == JPG
r.close()
r = c.get("/poster/" + e3)
assert r.data != JPG
r.close()

# banner summaries
assert c.get("/api/info/" + movie).get_json()["overview"].startswith("A linguist")
assert c.get("/api/info/" + e1).get_json()["overview"] == "Puppets dance."
assert c.get("/api/info/" + e3).get_json()["overview"] == "Short animated stories."        # no episode text: the show's

# private videos: never
r = c.get("/api/info/" + priv)
assert r.status_code == 403 or r.get_json()["overview"] == ""

# a second pass asks nothing again
asked.clear(); imgs.clear()
app.info_run("k")
assert asked == [] and imgs == [], (asked, imgs)

# a different match later: the old summary is not shown for it
autogenre.art_put(app.db, "video", movie, "ok", "movie/1")
assert c.get("/api/info/" + movie).get_json()["overview"] == ""

shutil.rmtree(tmp, ignore_errors=True)
print("tmdb info: OK")
