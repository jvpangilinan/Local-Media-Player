"""The folder watcher notices new, removed and renamed videos and songs, waits for downloads to finish, and checks
rarely while nobody is looking at the library. Run:
    python tests/test_folder_watcher.py
Uses a throw-away media tree in a temp folder; your real data and media are never touched."""
import os, shutil, sys, tempfile, threading, time, types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-watch-"))
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


def put(rel, age=600):
    p = media / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x")
    t = time.time() - age
    os.utime(p, (t, t))
    return p


put("videos/Drama/Film.mp4"); put("private/Secret.mp4"); put("music/a.mp3")
vsig = lambda: app._tree_signature((app.CFG["video_dir"], app.CFG["private_dir"]), app.VIDEO_EXTS, app.SIDE_IMAGE_EXTS)
msig = lambda: app._tree_signature((app.CFG["music_dir"],), app.MUSIC_EXTS)

# 1. a rename is a change (the old signature only counted files, so renames went unnoticed)
s0, uns = vsig()
assert not uns
(media / "videos/Drama/Film.mp4").rename(media / "videos/Drama/Film (2020).mp4")
s1, _ = vsig()
assert s1 != s0 and s1 == vsig()[0]                 # changed, and stable while nothing else changes

# 2. a file still being written is left out, but flagged so the watcher keeps checking often
put("videos/Drama/New.mkv", age=5)
s2, uns = vsig()
assert s2 == s1 and uns
os.utime(media / "videos/Drama/New.mkv", (time.time() - 600,) * 2)    # download finished
s3, uns = vsig()
assert s3 != s2 and not uns

# 3. music is watched too: new songs, renames, and the drive going away
m0, _ = msig()
put("music/b.flac")
m1, _ = msig()
(media / "music/b.flac").rename(media / "music/c.flac")
m2, _ = msig()
(media / "music").rename(tmp / "music-away")
m3, _ = msig()
assert len({m0, m1, m2, m3}) == 4
(tmp / "music-away").rename(media / "music")
assert msig()[0] == m2

# 4. the watcher loop: rescans once after things go quiet, checks rarely while the page is not open,
#    and wakes up right away when the page comes back
calls = {"videos": 0, "music": 0}
app.schedule_scan = lambda: calls.__setitem__("videos", calls["videos"] + 1)
app._rescan_music_bg = lambda: calls.__setitem__("music", calls["music"] + 1)
app.WATCH_FAST, app.WATCH_SLOW = 0.05, 30
app.WATCH["seen"] = time.time() + 3600                # page "open" while the watcher takes its first look
threading.Thread(target=app.folder_watcher, daemon=True).start()
time.sleep(0.3)
assert calls == {"videos": 0, "music": 0}, calls      # nothing changed yet

def wait_for(cond, secs=3):
    end = time.time() + secs
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False

put("videos/Drama/Show/e01.mkv"); put("videos/Drama/Show/e02.mkv")
assert wait_for(lambda: calls["videos"] == 1), calls
time.sleep(0.3)
assert calls["videos"] == 1, calls                    # one rescan, not one per check
put("music/d.mp3")
assert wait_for(lambda: calls["music"] == 1), calls

# window hidden / video playing: the page stops asking, the watcher slows to WATCH_SLOW
app.WATCH["seen"] = 0
time.sleep(0.3)                                       # let it fall into the slow wait
(media / "videos/Drama/Show/e02.mkv").unlink()
time.sleep(0.5)
assert calls["videos"] == 1, calls                    # not looked at yet
r = app.app.test_client().get("/api/videos/version")  # the page is back
assert r.status_code == 200
assert wait_for(lambda: calls["videos"] == 2), calls  # woke at once and picked the change up

shutil.rmtree(tmp, ignore_errors=True)
print("folder watcher: OK")
