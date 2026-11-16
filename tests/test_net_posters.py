"""Real posters found online (Smart genres): looked up once, saved locally, shown instead of a frame. Run:
    python tests/test_net_posters.py
Builds a throw-away media tree in a temp folder and answers TMDB from a fake, so no internet is used.
Your real data and media folders are never touched."""
import os, shutil, sys, tempfile, time, types, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-netart-"))
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

# ---------------------------------------------------------------- title cleaning for the search
for raw, want in [(("Before Sunrise 1995 Criterion", 0), ("Before Sunrise", 1995)), (("Cars (2006)", 0), ("Cars", 2006)),
                  (("Blade Runner 2049", 2017), ("Blade Runner 2049", 2017)), (("Superbad 2007 Unrated Extended", 0), ("Superbad", 2007)),
                  (("Gladiator (2000) Extended", 0), ("Gladiator", 2000)), (("Valorant", 0), ("Valorant", 0))]:
    assert autogenre.query_parts(*raw) == want, (raw, autogenre.query_parts(*raw))
assert autogenre.title_score("Star Wars Episode V The Empire Strikes Back", "The Empire Strikes Back") >= 0.86
assert autogenre.title_score("It Follows", "It") < 0.5

# ---------------------------------------------------------------- the library
files = {
    "Animation/Short Film.mp4": 300,
    "Sci-Fi/Arrival (2016).mkv": 300,
    "Drama/Mystery Film (2010).mkv": 300,
    "Movies/Cars (2006) (1080p BluRay x265 Tigole)/Cars.2006.1080p.mkv": 100000,   # one movie + featurettes + a sample
    "Movies/Cars (2006) (1080p BluRay x265 Tigole)/Featurettes/Making of.mkv": 2000,
    "Movies/Cars (2006) (1080p BluRay x265 Tigole)/Sample.mkv": 500,
    "Movies/Dune (2021) [1080p]/Dune.2021.mkv": 50000,                            # one movie alone in its folder
    "Family/Shrek (2001).mkv": 300, "Family/WALL-E (2008).mkv": 300,              # you keep animated films in Family
    "Movies/Shrek 2 (2004).mkv": 300,                                            # a sequel follows the first film
    "Movies/Coco (2017).mkv": 300,                                               # animated: goes where you keep yours
    "Action/Captain America (2011).mkv": 300, "Action/Captain America 2 (2014).mkv": 300,
    "Movies/Captain Underpants (2017).mkv": 300,                                 # shares a word, not a series: not Action
    "Movies/Bumblebee (2018).mkv": 300,                                          # anything else: its first genre you have a folder for
    "Memes & Shorts/funny cat.mp4": 300,                                         # no year: a clip, keeps its frame
    "MTV Shows/Downtown/Episode 1.mp4": 4000, "MTV Shows/Downtown/Episode 2.mp4": 4000,
    "TV/Some Show (2019)/E1.mkv": 4000, "TV/Some Show (2019)/E2.mkv": 4100,      # episodes of about the same size: a real series
}
for rel, size in files.items():
    p = media / "videos" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * size)
(media / "private").mkdir(parents=True, exist_ok=True)
(media / "private" / "Secret Movie (2020).mkv").write_bytes(b"x" * 300)
old = time.time() - 3600                                # older than the "still downloading" guard
for p in media.rglob("*.m*"):
    os.utime(p, (old, old))
app.scan_videos()

# ---------------------------------------------------------------- a fake TMDB
R = {
    ("movie", "cars"): [{"id": 920, "title": "Cars", "release_date": "2006-06-08", "genre_ids": [16, 12, 35, 10751], "popularity": 50,
                          "poster_path": "/cars.jpg", "backdrop_path": "/cars_bd.jpg"}],
    ("movie", "dune"): [{"id": 438631, "title": "Dune", "release_date": "2021-09-15", "genre_ids": [878, 12], "popularity": 80,
                          "poster_path": "/dune.jpg", "backdrop_path": ""}],
    ("movie", "funny cat"): [{"id": 5, "title": "Funny Cat", "release_date": "2001-01-01", "genre_ids": [35], "popularity": 30,
                               "poster_path": "/cat.jpg"}],
    ("movie", "mystery film"): [{"id": 6, "title": "Mystery Films", "release_date": "2012-01-01", "genre_ids": [9648], "popularity": 5,
                                  "poster_path": "/mys.jpg"}],
    ("tv", "downtown"): [{"id": 77, "name": "Downtown", "first_air_date": "1999-08-10", "genre_ids": [16, 35], "popularity": 3,
                           "poster_path": "/dt.jpg"}],
    ("movie", "shrek"): [{"id": 808, "title": "Shrek", "release_date": "2001-05-18", "genre_ids": [16, 35, 14, 12, 10751], "popularity": 40, "poster_path": "/s1.jpg"}],
    ("movie", "shrek 2"): [{"id": 809, "title": "Shrek 2", "release_date": "2004-05-19", "genre_ids": [16, 10751, 35, 14, 12], "popularity": 40, "poster_path": "/s2.jpg"}],
    ("movie", "wall-e"): [{"id": 10681, "title": "WALL·E", "release_date": "2008-06-22", "genre_ids": [16, 10751, 878], "popularity": 40, "poster_path": "/w.jpg"}],
    ("movie", "coco"): [{"id": 354912, "title": "Coco", "release_date": "2017-10-27", "genre_ids": [10751, 16, 10402, 12], "popularity": 40, "poster_path": "/coco.jpg"}],
    ("movie", "bumblebee"): [{"id": 424783, "title": "Bumblebee", "release_date": "2018-12-15", "genre_ids": [28, 12, 878], "popularity": 40, "poster_path": "/bb.jpg"}],
    ("movie", "captain america"): [{"id": 1771, "title": "Captain America", "release_date": "2011-07-22", "genre_ids": [28, 12, 878], "popularity": 40, "poster_path": "/ca1.jpg"}],
    ("movie", "captain america 2"): [{"id": 100402, "title": "Captain America 2", "release_date": "2014-03-20", "genre_ids": [28, 12, 878], "popularity": 40, "poster_path": "/ca2.jpg"}],
    ("movie", "captain underpants"): [{"id": 3, "title": "Captain Underpants", "release_date": "2017-06-01", "genre_ids": [10751, 35, 16, 878], "popularity": 40, "poster_path": "/cu.jpg"}],
    ("movie", "secret movie"): [{"id": 9, "title": "Secret Movie", "release_date": "2020-01-01", "genre_ids": [18], "popularity": 9,
                                  "poster_path": "/secret.jpg"}],
}
asked, pictures = [], []


def fake_fetch(url, headers=None, timeout=15):
    u = urllib.parse.urlparse(url)
    q = urllib.parse.parse_qs(u.query)
    media_kind = "tv" if u.path.endswith("/tv") else "movie"
    query = q.get("query", [""])[0]
    asked.append((media_kind, query))
    year = q.get("year", q.get("first_air_date_year", [""]))[0]
    res = [dict(r) for r in R.get((media_kind, query.lower()), [])]
    if year:
        res = [r for r in res if (r.get("release_date") or r.get("first_air_date") or "").startswith(year)]
    return {"results": res}


import cv2, numpy as np  # noqa: E402


def fake_bytes(url, timeout=20):
    pictures.append(url)
    w, h = (1280, 720) if "w1280" in url else (500, 750)
    img = np.full((h, w, 3), (len(pictures) * 40) % 255, np.uint8)
    return cv2.imencode(".jpg", img)[1].tobytes()


autogenre.fetch, autogenre.fetch_bytes = fake_fetch, fake_bytes
c = app.app.test_client()
H = {"X-LMP": "1"}


def wait():
    for _ in range(300):
        if not app.AG.status()["running"]:
            return app.AG.status()
        time.sleep(0.05)
    raise AssertionError("lookup never finished")


# off by default: nothing is looked up without your say-so
assert app.net_auto() is False and not asked
assert c.post("/api/prefs", json={"ag_online": True}, headers=H).status_code == 200
assert app.net_auto() is False, "no TMDB key yet"
assert c.post("/api/autogenre/config", json={"tmdb_key": "abc123"}, headers=H).status_code == 200

d = c.get("/api/videos").get_json()
loose = {v["title"]: v for v in d["loose"]}
assert "Cars" in loose and loose["Cars"]["year"] == 2006 and loose["Cars"]["type"] == "movie", loose.keys()
assert "Dune" in loose and loose["Dune"]["series"] == "", loose["Dune"]
ser = {s["title"]: s for s in d["all_series"]}
assert ser["Cars - Extras"]["extras"] is True and ser["Cars - Extras"]["episodes"] == 2, ser.keys()
assert not any(t.startswith("Dune") for t in ser), "a folder with only the movie is not a series any more"
assert ser["Downtown"]["extras"] is False and ser["Some Show (2019)"]["episodes"] == 2, ser.keys()
assert loose["Cars"]["own_poster"] is False and "-" not in loose["Cars"]["poster"].split("?v=")[1]

v0 = app.SCAN_VER["v"]
assert app.net_auto() is True
st = wait()
assert not st["error"], st
assert app.SCAN_VER["v"] > v0, "the open page is told to reload"
assert not any("secret" in q.lower() for _, q in asked), "the private library is never sent anywhere"
assert ("movie", "Downtown") not in asked, "a series name without a year is never looked up as a movie"
assert ("movie", "Some Show") in asked, "a series folder with a year is also looked up as a movie"
assert not any("cat.jpg" in u for u in pictures), "clips without a year keep their own frame"

d = c.get("/api/videos").get_json()
loose = {v["title"]: v for v in d["loose"]}
cars, dune = loose["Cars"], loose["Dune"]
assert cars["own_poster"] is True and "-" in cars["poster"].split("?v=")[1], cars["poster"]
assert cars["place"] == "Family" and cars["genre"] == "Movies", cars      # animated, and you keep those in Family
assert dune["place"] == "Sci-Fi", dune
assert loose["Arrival"]["place"] == "", "a movie you sorted yourself stays where you put it"
assert loose["Shrek 2"]["place"] == "Family", ("a sequel joins the first film", loose["Shrek 2"])
assert loose["Coco"]["place"] == "Family", ("animated films go where you keep yours", loose["Coco"])
assert loose["Bumblebee"]["place"] == "Action", ("its first genre you have a folder for", loose["Bumblebee"])
assert loose["Captain Underpants"]["place"] == "Family", ("a shared word is not a series", loose["Captain Underpants"])
assert loose["funny cat"]["own_poster"] is False

net = lambda part="": app.net_file("video", cars["id"], part).read_bytes()
r = c.get(cars["poster"]); assert r.mimetype == "image/jpeg" and r.data == net(), "poster: the real one"
r = c.get(cars["poster"].replace("/poster/", "/tile/")); assert r.data == net("sq"), "tile: the square cut of the real one"
sq = cv2.imdecode(np.frombuffer(r.data, np.uint8), cv2.IMREAD_COLOR); assert sq.shape[:2] == (app.TILE_SIZE, app.TILE_SIZE)
r = c.get(cars["backdrop"]); assert r.data == net("bd"), "banner: the real backdrop"
assert not app.net_file("video", dune["id"], "bd").exists(), "no backdrop online: the banner keeps the frame"
r = c.get("/seriestile/" + ser["Cars - Extras"]["id"]); assert r.data == net("sq"), "the extras folder wears the movie's poster"
dt = {s["title"]: s for s in d["all_series"]}["Downtown"]
assert "-" in dt["poster"].split("?v=")[1] and c.get(dt["poster"]).data == app.net_file("series", dt["id"]).read_bytes()

# one time: a second pass has nothing to do and asks nothing
n_asked, n_pics = len(asked), len(pictures)
assert app.movie_work() == [] and app.net_auto() is False
assert len(asked) == n_asked and len(pictures) == n_pics

# Needs review: your pick brings its poster
mys = loose["Mystery Film"]
assert not mys["own_poster"]
rv = c.get("/api/autogenre/review").get_json()["items"]
it = next(i for i in rv if i["key"] == mys["id"])
assert c.post("/api/autogenre/pick", json={"kind": "video", "key": mys["id"], "genres": it["cands"][0]["genres"], "cand": 0}, headers=H).status_code == 200
for _ in range(100):
    if app.net_stamp("video", mys["id"]):
        break
    time.sleep(0.05)
assert app.net_art("video", mys["id"]) is not None, "picked poster saved"
st = c.get("/api/autogenre/status").get_json()
assert st["counts"]["posters"] == 12, st["counts"]         # the 9 movies with a year, 3 Captains, Downtown, Mystery Film (picked)

# no internet: nothing is remembered, so the next scan tries again
(media / "videos" / "Action").mkdir(exist_ok=True)
(media / "videos" / "Action" / "Heat (1995).mkv").write_bytes(b"x" * 300)
os.utime(media / "videos" / "Action" / "Heat (1995).mkv", (old, old))
app.scan_videos()
R[("movie", "heat")] = [{"id": 949, "title": "Heat", "release_date": "1995-12-15", "genre_ids": [80, 18, 28], "popularity": 30, "poster_path": "/heat.jpg"}]


def offline(*a, **k):
    raise autogenre.Offline("no internet")


autogenre.fetch_bytes = offline
assert app.net_auto() is True; wait()
heat = next(w for w in app.movie_work() if w["title"] == "Heat")
assert heat["need_art"] and not heat["need_genre"], heat
autogenre.fetch_bytes = fake_bytes
assert app.net_auto() is True; wait()
assert app.movie_work() == []
heat_id = heat["id"]
assert app.net_art("video", heat_id) is not None

# private: never looked up, never served a poster from online
with app.LIB_LOCK:
    sec = next(v for v in app.LIB["videos"].values() if v["private"])
assert not app.net_stamp("video", sec["id"])

shutil.rmtree(tmp, ignore_errors=True)
print("ok: real posters are found once, shown on tiles / posters / banner, movie folders are movies, piles sort by genre, private stays offline")
