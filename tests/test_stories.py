"""Diner stories: the story.txt compiler, the story routes, the image route and the diner_story pref.
Run:  python tests/test_stories.py
Works on a throw-away copy of the app code; your real data is never touched."""
import os, shutil, sys, tempfile, types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-stories-"))
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

# --- the example compiles clean ---
d = app.STORIES_DIR / "Example"
d.mkdir(parents=True)
(d / "rooftop.jpg").write_bytes(b"jpg")
meta, story, errs = app._story_compile(app.STORY_EXAMPLE, d)
assert errs == [], errs
assert meta["title"] == "The Rooftop" and meta["characters"] == ["Mika", "Tob"]
assert story["order"] == ["s1", "s2"], story["order"]
s1 = story["scenes"]["s1"]
assert s1["where"] == "stool" and s1["title"] == "First night"
assert ["pic", "rooftop.jpg"] in s1["steps"] and ["pic", ""] in s1["steps"]
assert ["s", "Tob", "I took the stairs. All of them. Twice.", "sad"] in s1["steps"]
assert ["?", ["Laugh", "", "laugh"], ["Help him up", "", "help"]] in s1["steps"]
assert ["do", "f:kind"] in s1["steps"] and ["#", "end"] == s1["steps"][-1]
assert ["if", "f:kind", "warm"] in story["scenes"]["s2"]["steps"]


def errors_of(text):
    return app._story_compile(text, d)[2]


def has(errs, line, frag):
    return any(e["line"] == line and frag in e["msg"] for e in errs)


# --- each error kind, with the right line ---
assert has(errors_of("hello\n# A\nx"), 1, "before the first")
assert has(errors_of("# A\n-> nowhere"), 2, "unknown label")
assert has(errors_of("# A\n? Go -> nowhere"), 2, "unknown label")
assert has(errors_of("# A\n= x\nhi\n= x"), 4, "twice")
assert has(errors_of("# A\npicture: missing.jpg"), 2, "not found")
assert has(errors_of("# A\npicture: ../app.py"), 2, "not found")
assert has(errors_of("# A\n# B\nhi"), 1, "empty")
assert has(errors_of(""), 0, "no scenes")
assert has(errors_of("# A\n= bad label\nhi"), 2, "bad label")
assert has(errors_of("# A\nremember: no way"), 2, "bad flag")
assert has(errors_of("# A\nif x y"), 2, "if flag")
assert has(errors_of("x" * (200 * 1024 + 1)), 0, "200 KB")
# unknown speaker is narration, not an error
steps = app._story_compile("characters: A\n# S\nZed: hi\nA: yo", d)[1]["scenes"]["s1"]["steps"]
assert steps[0] == ["n", "Zed: hi"] and steps[1][:2] == ["s", "A"]

# --- routes ---
(d / "story.txt").write_text(app.STORY_EXAMPLE, encoding="utf-8")
(d / "mika.png").write_bytes(b"png")
(d / "tob-sad.webp").write_bytes(b"webp")
(d / "notes.txt").write_text("x")
(tmp / "secret.jpg").write_bytes(b"secret")
r = c.get("/api/stories").get_json()
assert r["stories"] == [{"id": "Example", "title": "The Rooftop", "scenes": 2, "errors": []}], r
r = c.get("/api/stories/Example").get_json()
assert r["id"] == "Example" and r["pics"] == {"mika": "mika.png", "tob-sad": "tob-sad.webp"}, r["pics"]
assert r["story"]["order"] == ["s1", "s2"] and r["errors"] == []
assert c.get("/api/stories/nope").status_code == 404
assert c.get("/api/stories/..%2F..").status_code == 404

assert c.get("/stories/Example/rooftop.jpg").data == b"jpg"
assert c.get("/stories/Example/mika.png").status_code == 200
for bad in ("notes.txt", "story.txt", "..%2Fsecret.jpg", "missing.jpg", "%2e%2e/secret.jpg"):
    assert c.get("/stories/Example/" + bad).status_code == 404, bad
r_ = c.get("/stories/..%2F/rooftop.jpg"); assert r_.status_code in (308, 404), (r_.status_code, r_.data[:80])
assert c.get("/stories/Missing/rooftop.jpg").status_code == 404

# --- the pref ---
p = c.post("/api/prefs", json={"diner_story": "Example"}, headers=H).get_json()
assert p["diner_story"] == "Example"
p = c.post("/api/prefs", json={"diner_story": "Unknown"}, headers=H).get_json()
assert p["diner_story"] == ""
p = c.post("/api/prefs", json={"diner_story": "../x"}, headers=H).get_json()
assert p["diner_story"] == ""

# --- open creates the example in an empty folder ---
shutil.rmtree(app.STORIES_DIR)
app.os.startfile = lambda p: None            # never open a real Explorer window
r = c.post("/api/stories/open", headers=H)
assert r.status_code == 200 and (app.STORIES_DIR / "Example" / "story.txt").read_text(encoding="utf-8") == app.STORY_EXAMPLE
assert c.post("/api/stories/open").status_code == 403     # CSRF guard
print("test_stories: ok")
