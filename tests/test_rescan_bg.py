"""The Rescan button answers at once; music is re-indexed in the background. Run:
    python tests/test_rescan_bg.py
Builds a throw-away media tree in a temp folder; reading song tags is made slow on purpose.
Your real data and media folders are never touched."""
import os, shutil, sys, tempfile, threading, time, types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-rescan-"))
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
assert Path(app.CFG["music_dir"]).resolve().is_relative_to(tmp.resolve()), "test must not touch real media"
app.init_db(); app.WINDOW = None
app.pregenerate_posters = lambda: None


def put(rel):
    p = media / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * 10)
    old = time.time() - 600                            # older than SETTLE_SECS, so nothing counts as still downloading
    os.utime(p, (old, old))


def wait_for(cond, secs=5):
    end = time.time() + secs
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


for rel in ("videos/Film.mp4", "music/a.mp3", "music/b.mp3"):
    put(rel)
app.scan_videos(); app.scan_music()
assert len(app.LIB["tracks"]) == 2

# reading a new song's tags takes 0.4 s each from now on (a slow USB drive, a big FLAC)
real_read = app.read_track
reads = []
def slow_read(p, rel):
    reads.append(rel)
    time.sleep(0.4)
    return real_read(p, rel)
app.read_track = slow_read
for i in range(5):
    put(f"music/new{i}.mp3")
put("videos/Film2.mp4")

c = app.app.test_client()
H = {"X-LMP": "1"}

# 1. Rescan answers right away (5 songs x 0.4 s would take 2 s) with the new videos already indexed
t0 = time.time()
r = c.post("/api/rescan", headers=H)
took = time.time() - t0
d = r.get_json()
assert r.status_code == 200 and took < 1.0, (r.status_code, took)
assert d["videos"] == 2 and d["music_scanning"] is True and d["tracks"] == 2, d

# 2. the page can see the music is still indexing, then that it is done with every song
assert c.get("/api/scan/status").get_json()["music"] is True
assert wait_for(lambda: not c.get("/api/scan/status").get_json()["music"]), "music scan never finished"
assert len(app.LIB["tracks"]) == 7 and len(reads) == 5, (len(app.LIB["tracks"]), reads)

# 3. pressing Rescan several times while it runs gives one rerun, never two scans at once
active, peak = [0], [0]
real_inner = app._scan_music
def counting():
    active[0] += 1; peak[0] = max(peak[0], active[0])
    try:
        return real_inner()
    finally:
        active[0] -= 1
app._scan_music = counting
runs = []
app.read_track = lambda p, rel: (runs.append(rel), time.sleep(0.4), real_read(p, rel))[2]
put("music/late.mp3")
for _ in range(4):
    assert c.post("/api/rescan", headers=H).status_code == 200
assert wait_for(lambda: not app.music_busy())
assert peak[0] == 1, peak
assert runs == ["late.mp3"] and len(app.LIB["tracks"]) == 8, runs

# 4. a direct scan_music() (finished download) while a background scan runs waits for it, then sees its own files
put("music/dl1.mp3")
app.schedule_music_scan()
time.sleep(0.1)
put("music/dl2.mp3")                                   # landed after the background scan listed the folder
n = app.scan_music()
assert peak[0] == 1 and n == 10 and "dl2.mp3" in {t["rel"] for t in app.LIB["tracks"].values()}, (peak, n)
assert wait_for(lambda: not app.music_busy())

# 5. a failing scan does not leave the music stuck as "indexing"
def boom():
    raise RuntimeError("disk error")
app._scan_music = boom
app.schedule_music_scan()
assert wait_for(lambda: not app.music_busy())
assert c.get("/api/scan/status").get_json()["music"] is False

shutil.rmtree(tmp, ignore_errors=True)
print("rescan in background: OK")
