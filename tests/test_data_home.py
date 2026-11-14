"""Data folder + password survive a new version. Run:  python tests/test_data_home.py
Works in a temp folder only; your real data is never touched."""
import json, os, shutil, sqlite3, sys, tempfile, types
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-home-"))
old, new = tmp / "ZENO_OLD", tmp / "ZENO_NEW"
(old / "data" / "custom_tiles").mkdir(parents=True)
with closing(sqlite3.connect(old / "data" / "media_stats.db")) as c, c:
    c.execute("create table videos(id text)"); c.execute("insert into videos values('x')")
(old / "data" / "settings.json").write_text(json.dumps({"password": {"salt": "00", "hash": "11", "rounds": 1}}))
(old / "data" / "custom_tiles" / "a.jpg").write_bytes(b"x")
new.mkdir()
for f in ROOT.glob("*.py"):
    shutil.copy(f, new / f.name)
os.environ.pop("ZENO_DATA_DIR", None)
os.environ["APPDATA"] = str(tmp / "appdata"); os.environ["XDG_DATA_HOME"] = str(tmp / "xdg"); os.environ["HOME"] = str(tmp)
sys.path.insert(0, str(new)); sys.argv = ["app.py"]
try:
    import mutagen  # noqa: F401
except ImportError:
    for n in ("mutagen", "mutagen.flac"):
        sys.modules[n] = types.ModuleType(n)
    sys.modules["mutagen"].File = lambda *a, **k: None
    sys.modules["mutagen.flac"].Picture = object
import app  # noqa: E402

assert Path(app.DATA_DIR).resolve().is_relative_to(tmp.resolve()), "test must not touch real data"
assert app.DATA_WHERE == "user-folder", app.DATA_WHERE
assert app.DATA_IMPORTED_FROM and Path(app.DATA_IMPORTED_FROM).name == "ZENO_OLD", app.DATA_IMPORTED_FROM
assert json.loads((app.DATA_DIR / "settings.json").read_text())["password"]["hash"] == "11", "password must come along"
assert (app.DATA_DIR / "custom_tiles" / "a.jpg").is_file()
with closing(sqlite3.connect(app.DATA_DIR / "media_stats.db")) as c:
    assert c.execute("select count(*) from videos").fetchone()[0] == 1
assert (old / "data" / "settings.json").is_file(), "the old version must keep its data"
# second start: reuse, do not import again
d2, where2, from2 = app.resolve_data_dir()
assert d2 == app.DATA_DIR and from2 is None
# an existing app-folder install keeps using its own data folder
(new / "data").mkdir(); (new / "data" / "settings.json").write_text("{}")
assert app.resolve_data_dir()[1] == "app-folder"
print("data home: OK")
