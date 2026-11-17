"""More than one video / music folder (other drives): they join one library. Run:
    python tests/test_extra_folders.py
Everything happens in a temp folder. Your real data and media are never touched."""
import os, shutil, sys, tempfile, types
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-extra-"))
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

assert Path(app.DATA_DIR).resolve().is_relative_to(tmp.resolve()), "test must not touch real data"
app.init_db(); app.WINDOW = None
H = {"X-LMP": "1"}
c = app.app.test_client()

drive2, mdrive2 = tmp / "D" / "Movies", tmp / "E" / "Songs"
files = {media / "videos/Action/Main.mp4": 100, media / "videos/Drama/Show/S1E01.mkv": 110,
         drive2 / "Action/Other.mp4": 200, drive2 / "Drama/Show/S2E01.mkv": 210, drive2 / "Loose.mp4": 220,
         media / "private/Secret.mp4": 300, media / "music/a.mp3": 10, mdrive2 / "Album/b.mp3": 20}
for p, size in files.items():
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * size)
(tmp / "D" / "Empty").mkdir()

app.scan_videos(); app.scan_music()
assert len(app.LIB["videos"]) == 3 and len(app.LIB["tracks"]) == 1

# 1. adding folders: refused when missing, already used, or inside / around a used one
bad = [("video", str(tmp / "nope")), ("video", str(media / "videos")), ("video", str(media / "videos/Action")),
       ("video", str(media)), ("video", str(media / "private"))]
for kind, path in bad:
    r = c.post("/api/folders/extra", json={"kind": kind, "path": path}, headers=H)
    assert r.status_code == 400, (path, r.status_code)
r = c.post("/api/folders/extra", json={"kind": "video", "path": str(drive2)}, headers=H)
assert r.status_code == 200 and r.get_json()["extra_folders"]["video"] == [str(drive2)]
assert c.post("/api/folders/extra", json={"kind": "video", "path": str(drive2)}, headers=H).status_code == 400   # twice
r = c.post("/api/folders/extra", json={"kind": "music", "path": str(mdrive2)}, headers=H)
assert r.get_json()["extra_folders"]["music"] == [str(mdrive2)]
assert c.post("/api/folders/extra", json={"kind": "photos", "path": str(drive2)}, headers=H).status_code == 400
assert app.load_settings()["prefs"]["video_extra"] == [str(drive2)]

# 2. one library: genres and series merge over the two drives
app.scan_videos(); app.scan_music()
lib = app.LIB["videos"]
assert len(lib) == 6, [v["rel"] for v in lib.values()]
by_name = {v["path"].name: v for v in lib.values()}
assert by_name["Other.mp4"]["genre"] == "Action" and by_name["Other.mp4"]["rel"].startswith("@")
assert by_name["Main.mp4"]["rel"] == "Action/Main.mp4"                                 # main folder keys unchanged
sid = by_name["S1E01.mkv"]["series_id"]
assert sid and sid == by_name["S2E01.mkv"]["series_id"]
assert len(app.LIB["series"][sid]["episodes"]) == 2 and len(app.LIB["series"][sid]["folders"]) == 2
assert len(app.LIB["tracks"]) == 2
names = [v.get("genre") for v in lib.values()]
assert "Action" in names

# 3. stream a video from the second drive works (path is the real file)
r = c.get("/media/video/" + by_name["Other.mp4"]["id"])
assert r.status_code in (200, 206), r.status_code
r.close()

# 4. moving keeps each video on its own drive
with closing(app.db()) as con, con:
    con.execute("UPDATE videos SET view_count = 5 WHERE id = ?", (by_name["Other.mp4"]["id"],))
r = c.post("/api/videos/move", json={"ids": [by_name["Other.mp4"]["id"], by_name["Main.mp4"]["id"]], "genre": "Comedy"}, headers=H)
assert r.get_json()["moved"] == 2
assert (drive2 / "Comedy/Other.mp4").is_file() and (media / "videos/Comedy/Main.mp4").is_file()
app.scan_videos()
moved = next(v for v in app.LIB["videos"].values() if v["path"].name == "Other.mp4")
with closing(app.db()) as con:
    assert con.execute("SELECT view_count FROM videos WHERE id = ?", (moved["id"],)).fetchone()[0] == 5   # history kept

# 5. renaming a series renames it on both drives
r = c.post("/api/series/%s/rename" % sid, json={"name": "Better Show"}, headers=H)
assert r.status_code == 200, r.get_json()
assert (media / "videos/Drama/Better Show/S1E01.mkv").is_file() and (drive2 / "Drama/Better Show/S2E01.mkv").is_file()
app.scan_videos()
assert len(app.LIB["series"][r.get_json()["id"]]["episodes"]) == 2

# 6. second drive unplugged: its videos and songs are kept, not marked missing / deleted
drive2.rename(tmp / "D" / "away"); mdrive2.rename(tmp / "E" / "away")
app.scan_videos(); app.scan_music()
assert len(app.LIB["videos"]) == 3 and len(app.LIB["tracks"]) == 1
with closing(app.db()) as con:
    assert con.execute("SELECT COUNT(*) FROM videos WHERE rel_path LIKE '@%' AND missing = 1").fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM tracks WHERE rel_path LIKE '@%'").fetchone()[0] == 1
offline = c.get("/api/videos/version").get_json()["offline"]
assert {o["lib"] for o in offline} == {"videos", "music"}, offline
(tmp / "D" / "away").rename(drive2); (tmp / "E" / "away").rename(mdrive2)
app.scan_videos(); app.scan_music()
assert len(app.LIB["videos"]) == 6 and len(app.LIB["tracks"]) == 2 and not app.OFFLINE

# 7. removing a folder: its videos leave the library, files stay on disk
r = c.post("/api/folders/extra", json={"kind": "video", "path": str(drive2), "remove": True}, headers=H)
assert r.get_json()["extra_folders"]["video"] == []
app.scan_videos()
assert len(app.LIB["videos"]) == 3 and (drive2 / "Loose.mp4").is_file()

# 8. the drive comes back under another letter: add the new path, views carry over (matched like a moved file)
drive3 = tmp / "F" / "Movies"
drive3.parent.mkdir()
drive2.rename(drive3)
r = c.post("/api/folders/extra", json={"kind": "video", "path": str(drive3)}, headers=H)
assert r.status_code == 200
app.scan_videos()
other = next(v for v in app.LIB["videos"].values() if v["path"].name == "Other.mp4")
with closing(app.db()) as con:
    assert con.execute("SELECT view_count FROM videos WHERE id = ?", (other["id"],)).fetchone()[0] == 5, "views lost on new letter"
c.post("/api/folders/extra", json={"kind": "video", "path": str(drive3), "remove": True}, headers=H)

# 9. the setting is stored per PC
assert "video_extra" not in app.load_settings()["prefs"] and app.load_settings()["prefs"]["music_extra"] == [str(mdrive2)]

shutil.rmtree(tmp, ignore_errors=True)
print("extra folders: OK")
