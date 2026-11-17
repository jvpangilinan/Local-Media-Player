"""One folder per season ("Show S01/", "Show.S04.1080p.NF.WEB-DL-GRP/") makes ONE series with a section per season. Run:
    python tests/test_season_folders.py
Everything happens in a temp folder. Your real data and media are never touched."""
import os, shutil, sys, tempfile, types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-season-"))
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

assert app.season_folder("Love Death and Robots S04") == ("Love Death and Robots", 4)
assert app.season_folder("Dark Season 2") == ("Dark", 2)
assert app.season_folder("Dark Season 1-3") == ("Dark", 0)
assert app.season_folder("Blade Runner 2049") is None and app.season_folder("Season of the Witch") is None
assert app.episode_name("Love.Death.and.Robots.S04E01.Cant.Stop.1080p.NF.WEB-DL.DDP5.1.Atmos.H.264-FLUX") == (4, 1, "Cant Stop")
assert app.episode_name("Show.S01E03.1080p.WEB") == (1, 3, "Episode 3")
assert app.episode_name("Holiday 2019") is None

v = media / "videos"
s4 = "Love.Death.and.Robots.S04.1080p.NF.WEB-DL.DDP5.1.Atmos.H.264-FLUX"
files = [f"Movies/{s4}/Love.Death.and.Robots.S04E10.For.He.Can.Creep.1080p.NF.WEB-DL.DDP5.1.Atmos.H.264-FLUX.mkv",
         f"Movies/{s4}/Love.Death.and.Robots.S04E02.Close.Encounters.of.the.Mini.Kind.1080p.NF.WEB-DL.DDP5.1.Atmos.H.264-FLUX.mkv",
         f"Movies/{s4}/Love.Death.and.Robots.S04E01.Cant.Stop.1080p.NF.WEB-DL.DDP5.1.Atmos.H.264-FLUX.mkv",
         "Movies/Love Death and Robots S01/Love.Death.and.Robots.S01E01.Sonnies.Edge.1080p.mkv",
         "Movies/Love Death and Robots S01/Love.Death.and.Robots.S01E02.Three.Robots.1080p.mkv",
         "Drama/Plain Show/e01.mkv", "Drama/Plain Show/e02.mkv",                         # a normal series: untouched
         "Drama/Other Show/Season 1/e01.mkv"]                                          # season subfolders: untouched
for f in files:
    (v / f).parent.mkdir(parents=True, exist_ok=True)
    (v / f).write_bytes(b"x" * 10)
(v / "Movies/Love Death and Robots S01/poster.jpg").write_bytes(b"jpg")

app.scan_videos()
ser = {s["name"]: s for s in app.LIB["series"].values()}
assert set(ser) == {"Love Death and Robots", "Plain Show", "Other Show"}, list(ser)
ldr = ser["Love Death and Robots"]
eps = [app.LIB["videos"][e] for e in ldr["episodes"]]
assert [(e["season"], e["title"]) for e in eps] == [
    ("Season 1", "Sonnies Edge"), ("Season 1", "Three Robots"),
    ("Season 4", "Cant Stop"), ("Season 4", "Close Encounters of the Mini Kind"), ("Season 4", "For He Can Creep")], eps
assert len(ldr["folders"]) == 2 and ldr["art"] and ldr["art"].name == "poster.jpg"      # the poster from either season folder
assert ser["Plain Show"]["episodes"] and not ser["Plain Show"].get("merged")
other = [app.LIB["videos"][e] for e in ser["Other Show"]["episodes"]]
assert other[0]["season"] == "Season 1"

# the series page shows the seasons
d = c.get("/api/series/" + ldr["id"]).get_json()
assert [e["season"] for e in d["episodes"]][:3] == ["Season 1", "Season 1", "Season 4"], d

# renaming keeps a folder per season
r = c.post("/api/series/%s/rename" % ldr["id"], json={"name": "LDR"}, headers=H)
assert r.status_code == 200, r.get_json()
assert (v / "Movies/LDR Season 1/Love.Death.and.Robots.S01E01.Sonnies.Edge.1080p.mkv").is_file()
assert (v / "Movies/LDR Season 4").is_dir() and not (v / "Movies" / s4).exists()
app.scan_videos()
again = app.LIB["series"][r.get_json()["id"]]
assert again["name"] == "LDR" and len(again["episodes"]) == 5

# auto-sort off: folders are left exactly as they are
app.save_prefs({"auto_sort": False}) if hasattr(app, "save_prefs") else None
if not app.get_prefs().get("auto_sort", True):
    app.scan_videos()
    assert {s["name"] for s in app.LIB["series"].values()} >= {"LDR Season 1", "LDR Season 4"}

shutil.rmtree(tmp, ignore_errors=True)
print("season folders: OK")
