"""IMDb ratings on movie cards: TMDB tells each matched movie's IMDb id once, the scores come from IMDb's ratings list. Run:
    python tests/test_imdb_ratings.py
Builds a throw-away media tree in a temp folder and fakes TMDB and the IMDb download, so no internet is used.
Your real data and media folders are never touched."""
import gzip, os, shutil, sys, tempfile, time, types, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-imdb-"))
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
import autogenre  # noqa: E402

assert Path(app.DATA_DIR).resolve().is_relative_to(tmp.resolve()), "test must not touch real data"
assert Path(app.CFG["video_dir"]).resolve().is_relative_to(tmp.resolve()), "test must not touch real media"
app.init_db(); app.WINDOW = None

for rel in ("Movies/Arrival (2016).mkv", "Movies/Obscure Film (2015).mkv", "Movies/Nothing Known (2019).mkv",
            "TV/Some Show/E1.mkv", "TV/Some Show/E2.mkv"):
    p = media / "videos" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * 4000)
(media / "private").mkdir(parents=True, exist_ok=True)
(media / "private" / "Secret Movie (2020).mkv").write_bytes(b"x" * 300)
old = time.time() - 3600
for p in media.rglob("*.mkv"):
    os.utime(p, (old, old))
app.scan_videos()

c = app.app.test_client()
H = {"X-LMP": "1"}
d = c.get("/api/videos").get_json()
vid = {v["title"]: v["id"] for v in d["loose"]}
sid = {s["title"]: s["id"] for s in d["all_series"]}
assert {"Arrival", "Obscure Film", "Nothing Known"} <= set(vid), vid
assert "Some Show" in sid, sid
priv = next(iter(v["id"] for v in app.LIB["videos"].values() if v["private"]))

# what the poster step saved earlier: the TMDB match of each item
autogenre.art_put(app.db, "video", vid["Arrival"], "ok", "movie/329865")
autogenre.art_put(app.db, "video", vid["Obscure Film"], "ok", "movie/111")
autogenre.art_put(app.db, "video", vid["Nothing Known"], "ok", "movie/222")
autogenre.art_put(app.db, "series", sid["Some Show"], "ok", "tv/77")
autogenre.art_put(app.db, "video", priv, "ok", "movie/999")       # never happens for real; still never shown

IDS = {"movie/329865": "tt2543164", "movie/111": "tt0000111", "tv/77": "tt0000077", "movie/999": "tt0000999", "movie/444": "tt0000444"}
asked = []


def fake_fetch(url, headers=None, timeout=15):
    path = urllib.parse.urlparse(url).path               # /3/movie/329865/external_ids
    parts = path.split("/")
    assert parts[-1] == "external_ids", url
    ref = parts[-3] + "/" + parts[-2]
    asked.append(ref)
    return {"imdb_id": IDS[ref]} if ref in IDS else {"imdb_id": None}


LIST = {"v": {"tt2543164": (7.9, 800000), "tt0000111": (9.1, 120), "tt0000077": (8.5, 30000), "tt0000999": (6.0, 1000),
              "tt0000444": (5.5, 20000), "tt9999999": (8.0, 5)}}
downloads = []


def gz(rows, head=autogenre.IMDB_HEAD):
    lines = [head] + ["%s\t%s\t%d" % (k, r, n) for k, (r, n) in rows.items()]
    return gzip.compress(("\n".join(lines) + "\n").encode())


def fake_download(url, out, timeout=60):
    assert url == autogenre.IMDB_RATINGS_URL
    downloads.append(url)
    out.write_bytes(LIST.get("raw") or gz(LIST["v"]))


autogenre.fetch, autogenre.download = fake_fetch, fake_download

# off unless "Look movies up online" is on and a key is saved
assert app.ratings_auto() is False
assert c.post("/api/prefs", json={"ag_online": True}, headers=H).status_code == 200
assert app.ratings_auto() is False, "no TMDB key yet"
assert c.post("/api/autogenre/config", json={"tmdb_key": "abc123"}, headers=H).status_code == 200


def cards():
    d = c.get("/api/videos").get_json()
    return {v["title"]: v for v in d["loose"]}, {s["title"]: s for s in d["all_series"]}


v0 = app.SCAN_VER["v"]
app.ratings_run("abc123")
assert sorted(asked) == sorted(["movie/329865", "movie/111", "movie/222", "tv/77", "movie/999"]), asked
assert len(downloads) == 1 and app.IMDB_FILE.is_file()
assert app.SCAN_VER["v"] > v0, "the page is told to reload"
lo, se = cards()
assert lo["Arrival"]["imdb"] == 7.9 and lo["Arrival"]["imdb_votes"] == 800000, lo["Arrival"]
assert lo["Obscure Film"]["imdb"] == 9.1 and lo["Obscure Film"]["imdb_votes"] == 120
assert lo["Nothing Known"]["imdb"] is None, "TMDB knows no IMDb id: no rating"
assert se["Some Show"]["imdb"] == 8.5 and se["Some Show"]["imdb_votes"] == 30000, se["Some Show"]
assert all(v.get("imdb") is None for v in app.video_cards(private=True)["loose"]), "never for the private library"

# run again: nothing new to ask, the list is fresh and already read in -> no internet, no reload
asked.clear(); downloads.clear(); v1 = app.SCAN_VER["v"]
app.ratings_run("abc123")
assert not asked and not downloads and app.SCAN_VER["v"] == v1, (asked, downloads)

# a week later the list is fetched again and the new numbers show
LIST["v"]["tt2543164"] = (8.0, 900000)
week = time.time() - 8 * 86400
os.utime(app.IMDB_FILE, (week, week))
app.ratings_run("abc123")
assert len(downloads) == 1 and not asked
assert cards()[0]["Arrival"]["imdb"] == 8.0, (cards()[0]["Arrival"], autogenre.rating_rows(app.db), autogenre.imdb_scores(app.IMDB_FILE, {"tt2543164"}))

# a broken download never replaces the good list
LIST["raw"] = b"<html>oops</html>"
os.utime(app.IMDB_FILE, (week, week))
downloads.clear()
app.ratings_run("abc123")
assert len(downloads) == 1 and autogenre.imdb_file_ok(app.IMDB_FILE)
assert cards()[0]["Arrival"]["imdb"] == 8.0, (cards()[0]["Arrival"], autogenre.rating_rows(app.db), autogenre.imdb_scores(app.IMDB_FILE, {"tt2543164"}))
(tmp / "wrong.gz").write_bytes(gz({}, head="not\tthe\tright\thead"))
assert not autogenre.imdb_file_ok(tmp / "wrong.gz") and not autogenre.imdb_file_ok(tmp / "missing.gz")
LIST.pop("raw")

# you picked another match for a movie: its IMDb id is asked again, the old rating is never shown for the new match
asked.clear()
autogenre.art_put(app.db, "video", vid["Obscure Film"], "ok", "movie/444")
assert cards()[0]["Obscure Film"]["imdb"] is None, "old rating belongs to the old match"
app.ratings_run("abc123")
assert asked == ["movie/444"], asked
assert cards()[0]["Obscure Film"]["imdb"] == 5.5

# the match is dropped (no poster any more): no rating
autogenre.art_put(app.db, "video", vid["Obscure Film"], "none")
assert cards()[0]["Obscure Film"]["imdb"] is None

shutil.rmtree(tmp, ignore_errors=True)
print("imdb ratings: all ok")
