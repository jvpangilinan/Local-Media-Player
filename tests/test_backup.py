"""Backup / restore round trip. Run:  python tests/test_backup.py
Works on a throw-away copy of the app code in a temp folder, so your real data folder is never touched."""
import json, os, shutil, sys, tempfile, types, zipfile
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-test-"))
for f in ROOT.glob("*.py"):
    shutil.copy(f, tmp / f.name)
sys.path.insert(0, str(tmp))
os.environ["ZENO_DATA_DIR"] = str(tmp / "data")      # V5: data may live outside the app folder, so pin it to the throw-away copy
sys.argv = ["app.py"]
try:
    import mutagen  # noqa: F401
except ImportError:                                    # only the test machine may lack it
    for n in ("mutagen", "mutagen.flac"):
        sys.modules[n] = types.ModuleType(n)
    sys.modules["mutagen"].File = lambda *a, **k: None
    sys.modules["mutagen.flac"].Picture = object
import app  # noqa: E402

assert Path(app.DATA_DIR).resolve().is_relative_to(tmp.resolve()), "test must not touch real data"
app.init_db(); app.WINDOW = None
app.SETTINGS_PATH.write_text(json.dumps({"prefs": {"bg_mode": "light", "video_dir": "D:/Other"}, "password": {"hash": "x"}}))
app.LS_PATH.write_text("{}")
c = app.app.test_client(); H = {"X-LMP": "1"}
count = lambda: app.db().execute("select count(*) from cinema_favs").fetchone()[0]

with closing(app.db()) as con, con:
    con.execute("INSERT INTO cinema_favs (kind, key, at) VALUES ('movie', 'm1', 1)")
path = c.post("/api/backup/export", headers=H).json["path"]
assert "media_stats.db" in zipfile.ZipFile(path).namelist()

with closing(app.db()) as con, con:
    con.execute("delete from cinema_favs")
app.SETTINGS_PATH.write_text(json.dumps({"prefs": {"bg_mode": "dark", "video_dir": "C:/Here"}}))
r = c.post("/api/backup/import", data=Path(path).read_bytes(), headers=H)
assert r.status_code == 200 and "database" in r.json["restored"], r.json
assert count() == 1, "favorite not restored"
s = json.loads(app.SETTINGS_PATH.read_text())
assert s["prefs"]["bg_mode"] == "light", "setting not restored"
assert s["prefs"]["video_dir"] == "C:/Here", "media folder of this PC must be kept"
assert "password" in s
assert c.post("/api/backup/import", data=b"not a zip", headers=H).status_code == 400
print("backup round trip OK")
shutil.rmtree(tmp, ignore_errors=True)
