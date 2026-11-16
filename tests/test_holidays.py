"""Holiday themes: the holidays (on / off) and birthday ("MM-DD") prefs. The calendar itself lives in assets/js/holidays.js.
Run:  python tests/test_holidays.py
Works on a throw-away copy of the app code; your real data is never touched."""
import os, shutil, sys, tempfile, types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-holidays-"))
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

assert app.PREF_DEFAULTS["holidays"] is True and app.PREF_DEFAULTS["birthday"] == ""
p = c.get("/api/prefs").get_json()
assert p["holidays"] is True and p["birthday"] == "", p

def setp(**kw):
    r = c.post("/api/prefs", json=kw, headers=H)
    assert r.status_code == 200, r.status_code
    return r.get_json()

assert setp(holidays=False)["holidays"] is False
assert setp(holidays=True)["holidays"] is True
for good in ("12-25", "02-29", "01-01", "10-31"):
    assert setp(birthday=good)["birthday"] == good, good
for bad in ("13-01", "02-30", "00-10", "1-5", "12/25", "../x", "12-25x", 1225, None):
    assert setp(birthday=bad)["birthday"] == "", bad
assert c.post("/api/prefs", json={"birthday": "12-25"}).status_code == 403    # CSRF header still required

page = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
assert "holidays.js" in page and "holidays.css" in page and 'id="hol-row"' in page

shutil.rmtree(tmp, ignore_errors=True)
print("holidays OK")
