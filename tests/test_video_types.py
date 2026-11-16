"""Every video the Cinema page gets says what it is: a movie, a clip, or bonus material (extras). Run:
    python tests/test_video_types.py
Builds a throw-away media tree in a temp folder and checks /api/videos. Your real data and media folders are never touched."""
import os, shutil, sys, tempfile, types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-vtype-"))
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
    "Action/Dune (2021).mkv",                                        # year in the name: a movie
    "Action/Iron Man (2008).mp4", "Action/Iron Man 2 (2010).mp4",    # a collection
    "Memes & Shorts/funny cat.mp4",                                  # no year: a clip
    "Animation/Being Pretty - Dystopian Animated Short Film.mp4",
    "Extras/Dune (2021) - Extras/Trailer.mkv",                       # bonus material shown as a series folder
    "Extras/Dune (2021) - Extras/Interview.mkv",
    "MTV Shows/Downtown/Episode 1.mp4", "MTV Shows/Downtown/Episode 2.mp4",
]
for rel in files:
    p = media / "videos" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * 64 + rel.encode())
(media / "videos" / "Action" / "Dune (2021).jpg").write_bytes(b"jpg")   # your own poster next to the video

app.scan_videos()
c = app.app.test_client()
d = c.get("/api/videos").get_json()
by_title = {v["title"]: v for v in d["loose"]}
assert by_title["Dune"]["type"] == "movie", by_title["Dune"]
assert by_title["Iron Man 2"]["type"] == "movie"
assert by_title["funny cat"]["type"] == "clip", by_title["funny cat"]
assert by_title["Being Pretty - Dystopian Animated Short Film"]["type"] == "clip"
assert all("type" in v for v in d["loose"]), "every loose video carries its type"

ser = {s["title"]: s for s in d["all_series"]}
extras = [s for s in d["all_series"] if s["extras"]]
assert len(extras) == 1 and extras[0]["genre"] == "Extras", d["all_series"]
assert any(not s["extras"] and s["genre"] == "MTV Shows" for s in d["all_series"]), ser

# the hero banner is a real movie when the library has one, never a clip
for _ in range(15):
    f = c.get("/api/videos").get_json()["featured"]
    assert f["type"] == "movie", f

# cards say how much is left (Continue watching / the banner) and whether the poster is a real one
from contextlib import closing
dune = by_title["Dune"]["id"]
with closing(app.db()) as con:
    con.execute("UPDATE videos SET position = 1800, duration = 7200, progress_at = 100 WHERE id = ?", (dune,))
    con.commit()
d = c.get("/api/videos").get_json()
cont = {v["title"]: v for v in d["continue"]}
assert cont["Dune"]["left"] == 5400, cont["Dune"]
assert cont["Dune"]["own_poster"] is True, cont["Dune"]
loose = {v["title"]: v for v in d["loose"]}
assert loose["Iron Man"]["left"] == 0 and loose["Iron Man"]["own_poster"] is False, loose["Iron Man"]

shutil.rmtree(tmp, ignore_errors=True)
print("ok: movies, clips and extras are told apart; the banner is always a movie; cards carry time left and own_poster")
