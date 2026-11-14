"""An unplugged media drive must not empty the library or forget anything. Run:
    python tests/test_offline_drive.py
"Unplugging" is simulated by moving the media folder away inside a temp folder. Your real data and media are never touched."""
import os, shutil, string, sys, tempfile, types
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-off-"))
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

for rel, size in (("videos/Film.mp4", 100), ("videos/Drama/Show/e01.mkv", 200), ("videos/Gone.mp4", 300),
                  ("private/Secret.mp4", 400), ("music/song.mp3", 50)):
    p = media / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * size)

videos, unplugged = media / "videos", tmp / "unplugged-videos"
rows = lambda: {r["rel_path"]: dict(r) for r in app.db().execute("SELECT id, rel_path, missing, view_count FROM videos")}
version = lambda: app.app.test_client().get("/api/videos/version").get_json()

# 1. normal scan, and some history to keep
app.scan_videos(); app.scan_music()
assert len(app.LIB["videos"]) == 4 and not app.OFFLINE and version()["offline"] == []
with closing(app.db()) as con, con:
    con.execute("UPDATE videos SET view_count = 7 WHERE rel_path = 'Film.mp4'")
before = rows()

# 2. deleting one file still marks just that file missing (unchanged behaviour)
(videos / "Gone.mp4").unlink()
app.scan_videos()
assert rows()["Gone.mp4"]["missing"] == 1 and rows()["Film.mp4"]["missing"] == 0

# 3. "unplug" the videos drive; meanwhile a look-alike copy appears in the private folder (same size and date)
videos.rename(unplugged)
shutil.copy2(unplugged / "Film.mp4", media / "private" / "Film copy.mp4")
app.scan_videos()
lib = app.LIB["videos"]
assert all(v["private"] for v in lib.values()) and len(lib) == 2, [v["rel"] for v in lib.values()]   # public ones hidden, private still there
now = rows()
assert now["Film.mp4"]["missing"] == 0 and now["Drama/Show/e01.mkv"]["missing"] == 0, now                # not marked deleted
assert now["Film.mp4"]["id"] == before["Film.mp4"]["id"] and now["Film.mp4"]["view_count"] == 7            # not "moved" to the copy
assert "private/Film copy.mp4" in now
off = version()["offline"]
assert off == [{"lib": "videos", "path": str(videos)}], off
assert app.OFFLINE == {"videos": str(videos)}

# 4. the watcher notices: the signature changes when the drive goes and when it comes back
sig_off = app._folder_signature()
unplugged.rename(videos)
assert app._folder_signature() != sig_off

# 5. plugged back in: everything returns with its history, the notice clears
app.scan_videos()
assert len([v for v in app.LIB["videos"].values() if not v["private"]]) == 2
assert rows()["Film.mp4"]["view_count"] == 7 and not app.OFFLINE and version()["offline"] == []

# 6. the private folder's location is never sent to the page
priv, priv_away = media / "private", tmp / "unplugged-private"
priv.rename(priv_away)
app.scan_videos()
assert version()["offline"] == [{"lib": "private", "path": ""}], version()["offline"]
priv_away.rename(priv)
app.scan_videos()

# 7. music: the index is kept while its drive is away
music, music_away = media / "music", tmp / "unplugged-music"
music.rename(music_away)
app.scan_music()
assert app.db().execute("SELECT COUNT(*) FROM tracks").fetchone()[0] == 1 and "music" in app.OFFLINE
music_away.rename(music)
app.scan_music()
assert len(app.LIB["tracks"]) == 1 and "music" not in app.OFFLINE

# 8. drive_present tells "drive unplugged" apart from "folder missing on a connected drive"
assert app.drive_present(tmp / "does-not-exist")
free = next((c for c in reversed(string.ascii_uppercase) if not os.path.exists(c + ":\\")), None)
if os.name == "nt" and free:
    assert not app.drive_present(Path(free + ":\\Media\\videos"))

shutil.rmtree(tmp, ignore_errors=True)
print("offline drive: OK")
