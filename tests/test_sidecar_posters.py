"""Posters and series art you put next to your videos are found by the scan, not by a disk search per request. Run:
    python tests/test_sidecar_posters.py
Builds a throw-away media tree in a temp folder and checks the scan picks the same image the old per-request lookup did.
Your real data and media folders are never touched."""
import os, shutil, sys, tempfile, types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-side-"))
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
assert Path(app.CFG["video_dir"]).resolve().is_relative_to(tmp.resolve()), "test must not touch real media"
app.init_db(); app.WINDOW = None

files = [
    "videos/Movie.mkv", "videos/Movie.JPG",                                   # upper-case extension (Windows ignores case)
    "videos/Two.mp4", "videos/Two-poster.png", "videos/Two.webp",             # plain name beats -poster
    "videos/Three.mp4", "videos/Three.png", "videos/Three.jpeg",              # .jpeg beats .png (IMAGE_EXTS order)
    "videos/Lonely.mp4",                                                      # no poster at all
    "videos/Drama/My.Movie.2020.mkv", "videos/Drama/My.Movie.2020.poster.jpg",
    "videos/Drama/Show/e01.mkv", "videos/Drama/Show/e02.mkv", "videos/Drama/Show/folder.png", "videos/Drama/Show/cover.jpg",
    "videos/Drama/Show2/Season 1/s1e1.mkv", "videos/Drama/Show2/poster.webp",
    "videos/Drama/Bare/x1.mkv",                                               # series without art
    "private/Secret.mp4", "private/secret.jpg",
]
for rel in files:
    p = media / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\xff\xd8\xff" + rel.encode())


def old_sidecar(video):                                # the lookup as it was before: up to 16 disk checks per request
    for suffix in ("", "-poster", ".poster", "_poster"):
        for ext in app.IMAGE_EXTS:
            p = video.with_name(video.stem + suffix + ext)
            if p.is_file():
                return p
    return None


def old_series_art(s):
    folder = s["folder"]
    for n in ("poster", "cover", "folder", "thumb", folder.name, s["name"]):
        for ext in app.IMAGE_EXTS:
            p = folder / (n + ext)
            if p.is_file():
                return p
    return None


def same(a, b):
    return (a is None and b is None) or (a is not None and b is not None and os.path.samefile(a, b))


sig_before = app._folder_signature()
app.scan_videos()
vids, series = app.LIB["videos"], app.LIB["series"]
assert len(vids) == 10, len(vids)
by_name = {v["path"].name: v for v in vids.values()}
for v in vids.values():
    assert same(app.find_sidecar_poster(v), old_sidecar(v["path"])), (v["rel"], app.find_sidecar_poster(v), old_sidecar(v["path"]))
for s in series.values():
    assert same(app.find_series_art(s), old_series_art(s)), (s["name"], app.find_series_art(s), old_series_art(s))

# the expected winners, spelled out
assert app.find_sidecar_poster(by_name["Movie.mkv"]).name == "Movie.JPG"
assert app.find_sidecar_poster(by_name["Two.mp4"]).name == "Two.webp"
assert app.find_sidecar_poster(by_name["Three.mp4"]).name == "Three.jpeg"
assert app.find_sidecar_poster(by_name["Lonely.mp4"]) is None
assert app.find_sidecar_poster(by_name["My.Movie.2020.mkv"]).name == "My.Movie.2020.poster.jpg"
assert app.find_sidecar_poster(by_name["Secret.mp4"]).name == "secret.jpg"
arts = {s["folder"].name: app.find_series_art(s) for s in series.values()}
assert arts["Show"].name == "cover.jpg" and arts["Show2"].name == "poster.webp" and arts["Bare"] is None, arts

# the poster route serves your own image
c = app.app.test_client()
r = c.get("/poster/" + by_name["Movie.mkv"]["id"])
assert r.status_code == 200 and r.data.startswith(b"\xff\xd8\xff") and b"Movie.JPG" in r.data, r.status_code
r.close()

# a poster deleted after the scan is not served (falls back to the generated one / placeholder)
(media / "videos/Two.webp").unlink()
assert app.find_sidecar_poster(by_name["Two.mp4"]) is None

# adding or removing a poster image changes the watcher's signature, so the next scan picks it up
sig_mid = app._folder_signature()
assert sig_mid != sig_before
(media / "videos/Lonely.png").write_bytes(b"\xff\xd8\xff")
assert app._folder_signature() != sig_mid
app.scan_videos()
lonely = next(v for v in app.LIB["videos"].values() if v["path"].name == "Lonely.mp4")
assert app.find_sidecar_poster(lonely).name == "Lonely.png"

shutil.rmtree(tmp, ignore_errors=True)
print("sidecar posters: OK")
