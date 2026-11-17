"""Smart genres: look movies, series and songs up online ONCE, remember every answer in the local database.

* Movies / series -> TMDB (free key needed). The year in the file name confirms the match, so a wrong "Dune" is rare.
                     The same match also gives the real poster and backdrop (saved once by the app, see Engine art_cb).
* Songs           -> the file's own genre tag first (no internet), then MusicBrainz (no key) and Last.fm (optional free key)
                     by ARTIST, which is far more reliable than per-song tags.
* Nothing is renamed, moved or written into your files. Answers live in the app's database (tables auto_genres + genre_cache);
  a choice you make by hand always beats an automatic one. Private-library items are never sent anywhere.
"""
import difflib
import gzip
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

from moviesort import clean_movie_title

UA = "ZENO/1.0 (personal media library; local app)"
ACCEPT = 0.82                      # confidence needed to apply a movie match without asking
MOVIE_WORKERS = 4                  # movies looked up at the same time (music stays one by one: MusicBrainz asks for that)

TMDB_MOVIE = {28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama",
              10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance",
              878: "Sci-Fi", 10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western"}
TMDB_TV = {10759: "Action", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
           10762: "Kids", 9648: "Mystery", 10763: "News", 10764: "Reality", 10765: "Sci-Fi", 10766: "Soap", 10767: "Talk",
           10768: "War", 37: "Western"}

# raw tag words -> one of our music genres (first match in this order wins for a given tag)
MUSIC_MAP = [
    ("Lo-fi", ("lo-fi", "lofi", "lo fi", "chillhop")),
    ("K-Pop", ("k-pop", "kpop", "korean pop")),
    ("J-Pop", ("j-pop", "jpop", "japanese pop", "city pop")),
    ("OPM", ("opm", "original pilipino", "pinoy", "filipino")),
    ("Hip-Hop", ("hip hop", "hip-hop", "hiphop", "rap", "trap", "drill", "grime", "boom bap", "gangsta")),
    ("R&B / Soul", ("r&b", "rnb", "rhythm and blues", "soul", "neo soul", "neo-soul", "funk", "motown")),
    ("Ambient", ("ambient", "drone", "new age", "downtempo", "chillout", "chill-out", "chill")),
    ("Metal", ("metal", "metalcore", "deathcore", "djent")),
    ("Punk", ("punk", "hardcore", "emo", "pop punk", "post-hardcore")),
    ("Rock", ("rock", "grunge", "shoegaze", "post-rock", "hard rock", "psychedelic")),
    ("Indie", ("indie", "alternative", "alt-rock", "bedroom pop", "dream pop")),
    ("Electronic", ("electronic", "electronica", "edm", "house", "techno", "trance", "dubstep", "electro", "drum and bass",
                    "dnb", "synthwave", "synth-pop", "synthpop", "idm", "garage", "future bass", "dance")),
    ("Jazz", ("jazz", "bebop", "swing", "bossa nova")),
    ("Classical", ("classical", "orchestra", "orchestral", "baroque", "opera", "piano", "soundtrack", "score", "film score")),
    ("Country", ("country", "bluegrass", "americana")),
    ("Folk", ("folk", "singer-songwriter", "acoustic")),
    ("Blues", ("blues",)),
    ("Reggae", ("reggae", "dancehall", "ska", "dub")),
    ("Latin", ("latin", "reggaeton", "salsa", "bachata", "cumbia", "latino")),
    ("Gospel", ("gospel", "christian", "worship")),
    ("Pop", ("pop", "teen pop", "dance-pop", "europop", "art pop")),
]
LEGACY_MUSIC = {"Hip-Hop", "Pop", "Rock", "Metal", "Punk", "Electronic", "K-Pop", "J-Pop", "Ambient", "Lo-fi"}   # already covered by the 5 built-in filters


class Offline(Exception):
    """The internet (or the service) could not be reached."""


class BadKey(Exception):
    """The service refused the key."""


# ---------------------------------------------------------------- http (swappable so it can be tested without a network)
def _default_fetch(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers=dict({"User-Agent": UA, "Accept": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise BadKey("The service refused the key (HTTP %d)." % e.code)
        if e.code == 404:
            return {}
        if e.code in (429, 503):
            try:
                wait = min(30, float(e.headers.get("Retry-After") or 3))
            except ValueError:
                wait = 3
            time.sleep(wait)
            raise Offline("Rate limited, will retry later (HTTP %d)." % e.code)
        raise Offline("HTTP %d" % e.code)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise Offline(str(getattr(e, "reason", e)) or "No internet connection.")


fetch = _default_fetch

IMG_MAX = 8 * 1024 * 1024


def _default_fetch_bytes(url, timeout=20):
    """Raw bytes of a picture (posters). Same errors as fetch."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read(IMG_MAX + 1)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return b""
        raise Offline("HTTP %d" % e.code)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise Offline(str(getattr(e, "reason", e)) or "No internet connection.")
    return b"" if len(data) > IMG_MAX else data


fetch_bytes = _default_fetch_bytes

FILE_MAX = 80 * 1024 * 1024


def _default_download(url, out, timeout=60):
    """Saves a file (the IMDb ratings list) to out, all or nothing. Same errors as fetch."""
    tmp = out.with_name(out.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
            n = 0
            while True:
                b = r.read(1 << 16)
                if not b:
                    break
                n += len(b)
                if n > FILE_MAX:
                    raise Offline("The file is bigger than expected.")
                f.write(b)
        os.replace(tmp, out)
    except urllib.error.HTTPError as e:
        raise Offline("HTTP %d" % e.code)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise Offline(str(getattr(e, "reason", e)) or "No internet connection.")
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


download = _default_download


class Throttle:
    def __init__(self, gap):
        self.gap, self.last, self.lock = gap, 0.0, threading.Lock()

    def wait(self):
        with self.lock:
            d = self.last + self.gap - time.time()
            if d > 0:
                time.sleep(d)
            self.last = time.time()


T_TMDB, T_MB, T_LFM = Throttle(0.06), Throttle(1.1), Throttle(0.25)


# ---------------------------------------------------------------- text helpers
def norm(s):
    s = str(s or "").lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\b(the|a|an)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def sim(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    return 1.0 if a == b else difflib.SequenceMatcher(None, a, b).ratio()


def _year(s):
    m = re.match(r"(\d{4})", str(s or ""))
    return int(m.group(1)) if m else 0


# edition words after the year hide it from the title cleaner ("Before Sunrise 1995 Criterion")
EDITION_RE = re.compile(r"[\s._\-\[(]+(?:the\s+)?(?:criterion(?:\s+collection)?|rm4k|rm|remaster(?:ed)?|restored|\d{2}th\s+anniv(?:ersary)?(?:\s+edition)?|"
                        r"anniversary(?:\s+edition)?|special\s+edition|collector'?s\s+edition|director'?s\s+cut|extended(?:\s+(?:cut|edition))?|"
                        r"unrated|theatrical(?:\s+cut)?|super\s+duper\s+cut|final\s+cut|imax|open\s+matte|bdmux|ita\s+eng|wvf|"
                        r"diamond(?:\s+edition)?|platinum(?:\s+edition)?|signature(?:\s+(?:collection|edition))?|"
                        r"\+\s*(?:extras|bonus)|(?:with\s+)?extras|bonus(?:\s+features)?)\b.*$", re.I)
_YEAR_IN = re.compile(r"(?:^|[\s._\-\[(])((?:19|20)\d{2})[\])]?(?=[\s._\-\[(]|$)")


def query_parts(title, year=0):
    """A library title -> (search words, year). Edition words after a year go, and a year still inside the name is taken out:
    'Before Sunrise 1995 Criterion' -> ('Before Sunrise', 1995), 'Cars (2006)' -> ('Cars', 2006). 'Blade Runner 2049' keeps its 2049."""
    t = str(title or "").strip()
    y = int(year or 0)
    ms = [m for m in _YEAR_IN.finditer(t) if t[:m.start(1)].strip(" -._([")]
    if ms:
        m = ms[-1]
        t = t[:m.end(1)] + EDITION_RE.sub("", t[m.end(1):])
    c, cy = clean_movie_title(t)
    if cy and (not y or cy == y):
        y, t = cy, c
    t = re.sub(r"\s*[(\[]\s*[)\]]\s*$", "", t).strip(" -._")
    return (t or str(title or "").strip()), y


def title_score(q, name):
    """How alike two titles are (0..1). A title found whole inside the other counts as close
    ('Rogue One' / 'Rogue One: A Star Wars Story', 'Star Wars Episode V The Empire Strikes Back' / 'The Empire Strikes Back')."""
    s = sim(q, name)
    a, b = norm(q), norm(name)
    if a and b and min(len(a), len(b)) >= 4 and ((" %s " % b) in (" %s " % a) or (" %s " % a) in (" %s " % b)):
        s = max(s, 0.86)
    return s


# ---------------------------------------------------------------- movies / series (TMDB)
def _tmdb_call(path, params, key):
    params = dict(params)
    headers = {}
    if key.startswith("eyJ"):                         # the long "read access token"
        headers["Authorization"] = "Bearer " + key
    else:
        params["api_key"] = key
    T_TMDB.wait()
    return fetch("https://api.themoviedb.org/3/" + path + "?" + urllib.parse.urlencode(params), headers)


def tmdb_candidates(title, year, key, tv=False, use_year=True):
    """Up to 3 best matches: [{title, year, genres, conf, id, poster, backdrop, media}] best first.
    use_year=False searches without the year but still scores with it."""
    params = {"query": title, "include_adult": "false", "language": "en-US"}
    if year and use_year:
        params["first_air_date_year" if tv else "year"] = year
    data = _tmdb_call("search/tv" if tv else "search/movie", params, key)
    gmap, out = (TMDB_TV if tv else TMDB_MOVIE), []
    for r in (data.get("results") or [])[:8]:
        name = r.get("name" if tv else "title") or ""
        orig = r.get("original_name" if tv else "original_title") or ""
        s = max(title_score(title, name), title_score(title, orig))
        ry = _year(r.get("first_air_date" if tv else "release_date"))
        if year and ry:
            d = abs(ry - year)
            conf = s * 0.8 + (0.2 if d == 0 else 0.1 if d == 1 else 0.05 if d == 2 else 0.0)   # festival vs cinema release
        elif year:
            conf = s * 0.75                                    # no date yet (not out): never beats a dated match
        else:
            conf = s * 0.9
        pop = float(r.get("popularity") or 0)
        if not year and s >= 0.95 and pop > 20:
            conf = min(1.0, conf + 0.05)
        genres = [gmap[g] for g in (r.get("genre_ids") or []) if g in gmap]
        out.append({"id": r.get("id"), "title": name, "year": ry, "genres": genres, "conf": round(conf, 3), "pop": pop,
                    "poster": r.get("poster_path") or "", "backdrop": r.get("backdrop_path") or "", "media": "tv" if tv else "movie"})
    out.sort(key=lambda c: (-c["conf"], -c["pop"]))
    return out[:3]


def _merge(a, b):
    seen, out = set(), []
    for c in sorted(a + b, key=lambda c: (-c["conf"], -c["pop"])):
        k = (c.get("media"), c.get("id"))
        if k not in seen:
            seen.add(k)
            out.append(c)
    return out[:3]


SEASON_TAG = re.compile(r"[\s._-]+(?:S\d{1,2}(?:\s*-\s*S?\d{1,2})?|Season\s*\d{1,2}(?:\s*-\s*\d{1,2})?|Complete(?:\s+Series)?)\s*$", re.I)


def series_query(name):
    """A series folder name without its season tag, for the online search: 'Love Death and Robots S01' -> 'Love Death and
    Robots', 'Dark Season 1-3' -> 'Dark'. TMDB finds nothing for the name with the tag."""
    t = str(name or "")
    while True:
        u = SEASON_TAG.sub("", t).strip()
        if not u or u == t:
            return t.strip()
        t = u


def tmdb_lookup(title, year, key, tv=False):
    """The best matches for a library item, trying harder than one search: the year is taken out of the name, a search
    with the year that finds nothing sure is repeated without it, and a series folder that carries a year ('Bumblebee (2018)')
    is also looked for as a movie. A series name without a year is never matched to a movie."""
    q, y = query_parts(title, year)
    best = []
    for as_tv in ([True, False] if (tv and y) else [tv]):
        c = tmdb_candidates(q, y, key, as_tv)
        if y and (not c or c[0]["conf"] < ACCEPT):
            c = _merge(c, tmdb_candidates(q, y, key, as_tv, use_year=False))
        best = _merge(best, c)
        if best and best[0]["conf"] >= ACCEPT:
            break
    return best


def decide_movie(cands):
    """-> (status, genres, conf): 'auto' when the best match is trustworthy, 'review' when several are plausible, 'none' otherwise."""
    if not cands:
        return "none", [], 0.0
    best = cands[0]
    if best["conf"] >= ACCEPT and best["genres"]:
        # two near-identical scores with different genres means a coin toss: ask instead of guessing
        if len(cands) > 1 and cands[1]["conf"] >= best["conf"] - 0.03 and cands[1]["genres"] != best["genres"] and not best["year"]:
            return "review", [], best["conf"]
        return "auto", best["genres"], best["conf"]
    if best["conf"] >= 0.5:
        return "review", [], best["conf"]
    return "none", [], best["conf"]


# ---------------------------------------------------------------- IMDb ratings
# The rating shown on movie cards. IMDb has by far the most voters, so its number says "a lot of people liked this" best.
# IMDb shares every title's rating as one free file (personal use), refreshed daily; TMDB tells which IMDb title a match is.
IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz"
IMDB_HEAD = "tconst\taverageRating\tnumVotes"


def tmdb_imdb_id(ref, key):
    """A saved match ('movie/603', 'tv/1399') -> its IMDb id ('tt0133093'), or '' when TMDB knows none."""
    media, _, tid = str(ref or "").partition("/")
    if media not in ("movie", "tv") or not tid.isdigit():
        return ""
    data = _tmdb_call("%s/%s/external_ids" % (media, tid), {}, key) or {}
    imdb = str(data.get("imdb_id") or "")
    return imdb if re.fullmatch(r"tt\d{5,10}", imdb) else ""


def imdb_file_ok(path):
    """True when path is the IMDb ratings list (gzip, the right header)."""
    try:
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
            return f.readline().rstrip("\r\n") == IMDB_HEAD
    except (OSError, EOFError, ValueError):
        return False


def imdb_download(out):
    """Fetches the ratings list to out. A broken download never replaces a good list already there."""
    tmp = out.with_name("_new_" + out.name)
    try:
        download(IMDB_RATINGS_URL, tmp)
        if not imdb_file_ok(tmp):
            raise Offline("The IMDb ratings file was not what was expected.")
        os.replace(tmp, out)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def imdb_scores(path, wanted):
    """{imdb id: (rating, votes)} for the ids in wanted, read from the ratings list."""
    out = {}
    if not wanted:
        return out
    try:
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
            if f.readline().rstrip("\r\n") != IMDB_HEAD:
                return out
            for line in f:
                tab = line.find("\t")
                if line[:tab] in wanted:
                    p = line.rstrip("\r\n").split("\t")
                    try:
                        out[p[0]] = (float(p[1]), int(p[2]))
                    except (IndexError, ValueError):
                        pass
    except (OSError, EOFError, ValueError):
        pass
    return out


# ---------------------------------------------------------------- music
def canon_music(raw):
    """raw tags [(name, count)] or strings -> up to 2 of our genres, strongest first."""
    score = {}
    for item in raw or []:
        name, cnt = (item if isinstance(item, (tuple, list)) else (item, 1))
        t = " " + norm(str(name).replace("-", " ").replace("&", "and")) + " "
        t2 = " " + str(name).lower().replace("-", " ").strip() + " "
        for genre, words in MUSIC_MAP:
            hit = False
            for w in words:
                w2 = w.replace("-", " ")
                if (" " + w2 + " ") in t2 or (" " + norm(w2) + " ") in t:
                    hit = True
                    break
            if hit:
                score[genre] = score.get(genre, 0) + max(1, int(cnt or 1))
                break
    if not score:
        return []
    top = max(score.values())
    return [g for g, v in sorted(score.items(), key=lambda kv: -kv[1]) if v >= top * 0.35][:2]


def split_tag(tag):
    """A file's own genre tag ('Hip-Hop/Rap; R&B') -> raw tag list."""
    return [p.strip() for p in re.split(r"[;/,|\\]+|\s{2,}", str(tag or "")) if p.strip() and not p.strip().isdigit()]


def mb_artist_tags(artist):
    T_MB.wait()
    q = urllib.parse.urlencode({"query": 'artist:"%s"' % artist.replace('"', " "), "fmt": "json", "limit": 3})
    data = fetch("https://musicbrainz.org/ws/2/artist/?" + q)
    for a in data.get("artists") or []:
        if int(a.get("score") or 0) >= 90 and sim(artist, a.get("name")) >= 0.85:
            tags = [(t.get("name"), t.get("count", 1)) for t in (a.get("genres") or []) + (a.get("tags") or []) if t.get("name")]
            if not tags and a.get("id"):
                T_MB.wait()
                d2 = fetch("https://musicbrainz.org/ws/2/artist/%s?inc=genres+tags&fmt=json" % a["id"])
                tags = [(t.get("name"), t.get("count", 1)) for t in (d2.get("genres") or []) + (d2.get("tags") or []) if t.get("name")]
            return tags
    return []


def lfm_artist_tags(artist, key):
    if not key:
        return []
    T_LFM.wait()
    q = urllib.parse.urlencode({"method": "artist.gettoptags", "artist": artist, "api_key": key, "format": "json", "autocorrect": 1})
    data = fetch("https://ws.audioscrobbler.com/2.0/?" + q)
    tags = (data.get("toptags") or {}).get("tag") or []
    return [(t.get("name"), int(t.get("count") or 0)) for t in tags if t.get("name") and int(t.get("count") or 0) >= 15]


def music_artist_genres(artist, lfm_key=""):
    tags = []
    try:
        tags += mb_artist_tags(artist)
    except Offline:
        if not lfm_key:
            raise
    if lfm_key:
        tags += lfm_artist_tags(artist, lfm_key)
    return canon_music(tags), tags[:12]


# ---------------------------------------------------------------- storage
def init_db(con):
    con.execute("""CREATE TABLE IF NOT EXISTS auto_genres (
        kind TEXT NOT NULL, key TEXT NOT NULL, genres TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT '',
        conf REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'auto', extra TEXT NOT NULL DEFAULT '', at REAL,
        PRIMARY KEY (kind, key))""")
    con.execute("""CREATE TABLE IF NOT EXISTS genre_cache (
        kind TEXT NOT NULL, qkey TEXT NOT NULL, result TEXT NOT NULL, at REAL, PRIMARY KEY (kind, qkey))""")
    # posters found online: ok (pictures saved by the app) | none (no sure match, not asked again) | review (waits for your pick)
    con.execute("""CREATE TABLE IF NOT EXISTS net_art (
        kind TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', at REAL, PRIMARY KEY (kind, key))""")
    # IMDb rating of a movie / series matched online: ref is the TMDB match it was found for, imdb '' = TMDB knows none
    con.execute("""CREATE TABLE IF NOT EXISTS net_rating (
        kind TEXT NOT NULL, key TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', imdb TEXT NOT NULL DEFAULT '',
        score REAL, votes INTEGER, at REAL, PRIMARY KEY (kind, key))""")


def art_refs(db):
    """{(kind, key): 'movie/603'} for every movie / series whose online match was saved."""
    try:
        with closing(db()) as con:
            return {(r["kind"], r["key"]): r["ref"] for r in con.execute("SELECT kind, key, ref FROM net_art WHERE status = 'ok' AND ref != ''")}
    except sqlite3.Error:
        return {}


def rating_rows(db):
    """{(kind, key): {ref, imdb, score, votes, at}}"""
    try:
        with closing(db()) as con:
            return {(r["kind"], r["key"]): dict(r) for r in con.execute("SELECT * FROM net_rating")}
    except sqlite3.Error:
        return {}


def rating_map(db):
    """{(kind, key): (rating, votes)} of every item that has an IMDb rating (only for the match saved now)."""
    try:
        with closing(db()) as con:
            rows = con.execute("""SELECT r.kind, r.key, r.score, r.votes FROM net_rating r JOIN net_art a
                                  ON a.kind = r.kind AND a.key = r.key AND a.status = 'ok' AND a.ref = r.ref
                                  WHERE r.score IS NOT NULL""").fetchall()
        return {(r["kind"], r["key"]): (r["score"], r["votes"] or 0) for r in rows}
    except sqlite3.Error:
        return {}


def rating_put_id(db, kind, key, ref, imdb):
    with closing(db()) as con, con:
        con.execute("INSERT OR REPLACE INTO net_rating (kind, key, ref, imdb, score, votes, at) VALUES (?,?,?,?,NULL,NULL,?)",
                    (kind, key, ref, imdb, time.time()))


def rating_put_scores(db, scores):
    """scores: {imdb id: (rating, votes)}. Every item with that id takes it; an id missing from the list has no rating."""
    with closing(db()) as con, con:
        for r in con.execute("SELECT kind, key, imdb FROM net_rating WHERE imdb != ''").fetchall():
            s = scores.get(r["imdb"])
            con.execute("UPDATE net_rating SET score = ?, votes = ? WHERE kind = ? AND key = ?",
                        (s[0] if s else None, s[1] if s else None, r["kind"], r["key"]))


def rating_ids(db):
    try:
        with closing(db()) as con:
            return {r["imdb"] for r in con.execute("SELECT DISTINCT imdb FROM net_rating WHERE imdb != ''")}
    except sqlite3.Error:
        return set()


def art_rows(db):
    """{(kind, key): (status, at)} for every movie / series the poster step already handled."""
    try:
        with closing(db()) as con:
            return {(r["kind"], r["key"]): (r["status"], r["at"] or 0) for r in con.execute("SELECT kind, key, status, at FROM net_art")}
    except sqlite3.Error:
        return {}


def art_put(db, kind, key, status, ref=""):
    with closing(db()) as con, con:
        con.execute("INSERT OR REPLACE INTO net_art (kind, key, status, ref, at) VALUES (?,?,?,?,?)", (kind, key, status, ref, time.time()))


def review_cands(db, kind, key):
    """The choices saved for an item that waits in Needs review (empty when there are none)."""
    with closing(db()) as con:
        r = con.execute("SELECT extra FROM auto_genres WHERE kind = ? AND key = ?", (kind, key)).fetchone()
    try:
        return (json.loads(r["extra"] or "{}") if r else {}).get("cands") or []
    except ValueError:
        return []


def load_map(db, kind, statuses=("auto", "manual")):
    """{key: [genres]} of every applied answer for kind (video | series | track)."""
    try:
        with closing(db()) as con:
            q = ",".join("?" * len(statuses))
            rows = con.execute("SELECT key, genres FROM auto_genres WHERE kind = ? AND status IN (%s)" % q, (kind, *statuses)).fetchall()
        return {r["key"]: json.loads(r["genres"] or "[]") for r in rows}
    except (sqlite3.Error, ValueError):
        return {}


def _put(db, kind, key, genres, source, conf, status, extra=None):
    with closing(db()) as con, con:
        old = con.execute("SELECT status FROM auto_genres WHERE kind = ? AND key = ?", (kind, key)).fetchone()
        if old and old["status"] == "manual" and status != "manual":
            return                                             # your own choice always wins
        con.execute("INSERT OR REPLACE INTO auto_genres (kind, key, genres, source, conf, status, extra, at) VALUES (?,?,?,?,?,?,?,?)",
                    (kind, key, json.dumps(genres), source, float(conf), status, json.dumps(extra) if extra else "", time.time()))


def _cache_get(db, kind, qkey):
    with closing(db()) as con:
        r = con.execute("SELECT result FROM genre_cache WHERE kind = ? AND qkey = ?", (kind, qkey)).fetchone()
    return json.loads(r["result"]) if r else None


def _cache_put(db, kind, qkey, result):
    with closing(db()) as con, con:
        con.execute("INSERT OR REPLACE INTO genre_cache (kind, qkey, result, at) VALUES (?,?,?,?)", (kind, qkey, json.dumps(result), time.time()))


def set_manual(db, kind, key, genres):
    _put(db, kind, key, genres, "you", 1.0, "manual")


def review_list(db, limit=200):
    with closing(db()) as con:
        rows = con.execute("SELECT kind, key, extra FROM auto_genres WHERE status = 'review' ORDER BY at DESC LIMIT ?", (limit,)).fetchall()
    out = []
    for r in rows:
        try:
            ex = json.loads(r["extra"] or "{}")
        except ValueError:
            ex = {}
        out.append({"kind": r["kind"], "key": r["key"], "name": ex.get("name", ""), "year": ex.get("year", 0), "cands": ex.get("cands", [])})
    return out


def counts(db):
    out = {"video": 0, "series": 0, "track": 0, "review": 0}
    try:
        with closing(db()) as con:
            for r in con.execute("SELECT kind, status, COUNT(*) n FROM auto_genres GROUP BY kind, status"):
                if r["status"] == "review":
                    out["review"] += r["n"]
                elif r["status"] in ("auto", "manual") and r["kind"] in out:
                    out[r["kind"]] += r["n"]
    except sqlite3.Error:
        pass
    return out


def reset(db, kind=""):
    """Forget automatic answers (manual ones stay). Posters already saved stay; items that found none are asked again."""
    with closing(db()) as con, con:
        if kind:
            con.execute("DELETE FROM auto_genres WHERE status != 'manual' AND kind = ?", (kind,))
        else:
            con.execute("DELETE FROM auto_genres WHERE status != 'manual'")
        con.execute("DELETE FROM genre_cache")
        if not kind:
            con.execute("DELETE FROM net_art WHERE status != 'ok'")
        elif kind in ("video", "series"):
            con.execute("DELETE FROM net_art WHERE status != 'ok' AND kind = ?", (kind,))


# ---------------------------------------------------------------- the background job
class Engine:
    def __init__(self, db, log):
        self.db, self.log = db, log
        self.lock = threading.Lock()
        self.stop_ev, self.run_ev = threading.Event(), threading.Event()
        self.run_ev.set()
        self.thread = None
        self.art_cb = None
        self.state = self._blank()

    @staticmethod
    def _blank():
        return {"running": False, "paused": False, "what": "", "total": 0, "done": 0, "found": 0, "review": 0, "none": 0,
                "art": 0, "current": "", "error": "", "finished": False, "quiet": False}

    def status(self):
        with self.lock:
            s = dict(self.state)
        s["paused"] = not self.run_ev.is_set() and s["running"]
        return s

    def start(self, what, work, tmdb_key="", lfm_key="", done_cb=None, art_cb=None, quiet=False):
        """what: 'movies' | 'music'. work: movies -> [{id, kind, title, year, tv, need_genre, need_art, genres}],
        music -> [{rel, artist, tag}]. art_cb(item, match) saves the poster of a sure match and returns True when it did.
        quiet: started by the app itself after a scan (the page does not announce it)."""
        with self.lock:
            if self.state["running"]:
                return False, "A scan is already running."
            self.state = self._blank()
            self.state.update(running=True, what=what, total=len(work), quiet=bool(quiet))
        self.art_cb = art_cb
        self.stop_ev.clear()
        self.run_ev.set()
        self.thread = threading.Thread(target=self._run, args=(what, work, tmdb_key, lfm_key, done_cb), daemon=True)
        self.thread.start()
        return True, ""

    def pause(self, on):
        (self.run_ev.clear if on else self.run_ev.set)()

    def stop(self):
        self.stop_ev.set()
        self.run_ev.set()

    def _bump(self, **kw):
        with self.lock:
            for k, v in kw.items():
                if k in ("found", "review", "none", "done", "art"):
                    self.state[k] += v
                else:
                    self.state[k] = v

    def _run(self, what, work, tmdb_key, lfm_key, done_cb):
        try:
            if what == "movies":
                # a few at once: each search or picture is mostly waiting on the network (TMDB allows far more than this)
                fails, flock, halt = [0], threading.Lock(), threading.Event()

                def one(w):
                    if halt.is_set() or not self._gate():
                        return
                    self._bump(current=w["title"])
                    try:
                        self._movie(w, tmdb_key)
                        with flock:
                            fails[0] = 0
                    except Offline as e:
                        with flock:
                            fails[0] += 1
                            if fails[0] >= 4 and not halt.is_set():
                                self._bump(error="Can't reach the internet: %s" % e)
                                halt.set()
                    except BadKey as e:
                        self._bump(error=str(e))
                        halt.set()
                        return
                    self._bump(done=1)

                with ThreadPoolExecutor(max_workers=MOVIE_WORKERS) as ex:
                    list(ex.map(one, work))
            else:
                self._music(work, lfm_key)
        except BadKey as e:
            self._bump(error=str(e))
        except Exception as e:                                  # never let the thread die silently
            self.log.warning("smart genres failed", exc_info=True)
            self._bump(error="Stopped: %s" % e)
        finally:
            self._bump(running=False, finished=True, current="")
            if done_cb:
                try:
                    done_cb()
                except Exception:
                    self.log.warning("smart genres: done callback failed", exc_info=True)

    def _gate(self):
        self.run_ev.wait()
        return not self.stop_ev.is_set()

    def _movie(self, w, key):
        title, year, tv = w["title"], int(w.get("year") or 0), bool(w.get("tv"))
        if tv:
            title = series_query(title)
        kind = w.get("kind") or ("series" if tv else "video")
        qkey = "v2|%s|%s|%d" % ("tv" if tv else "movie", norm(title), year)
        cands = _cache_get(self.db, "tmdb", qkey)
        if cands is None:
            cands = tmdb_lookup(title, year, key, tv)
            _cache_put(self.db, "tmdb", qkey, cands)
        status, genres, conf = decide_movie(cands)
        if w.get("need_genre", True):
            if status == "auto":
                _put(self.db, kind, w["id"], genres, "tmdb", conf, "auto")
            elif status == "review":
                _put(self.db, kind, w["id"], [], "tmdb", conf, "review", {"name": title, "year": year, "cands": cands})
            else:
                _put(self.db, kind, w["id"], [], "tmdb", conf, "none")
        self._bump(**{{"auto": "found"}.get(status, status): 1})
        if self.art_cb and w.get("need_art"):
            pick = cands[0] if status == "auto" else None
            if pick is None and w.get("genres"):               # you picked the genres by hand: the match with those genres
                pick = next((c for c in cands if c.get("genres") == w["genres"]), None)
            if pick is not None:
                try:
                    if self.art_cb(w, pick):
                        self._bump(art=1)
                except Offline:
                    raise
                except Exception:                              # one bad picture never stops the whole lookup
                    self.log.warning("poster for %s not saved", w.get("id"), exc_info=True)
            else:                                              # Needs review: the poster comes with your pick
                art_put(self.db, kind, w["id"], "review" if status == "review" else "none")

    def _music(self, work, lfm_key):
        by_artist, fails = {}, 0
        for w in work:                                          # 1) the file's own tag: no internet needed
            if not self._gate():
                return
            g = canon_music(split_tag(w.get("tag")))
            if g:
                _put(self.db, "track", w["rel"], g, "tag", 1.0, "auto")
                self._bump(found=1, done=1)
            else:
                by_artist.setdefault(w.get("artist") or "", []).append(w["rel"])
        for artist, rels in sorted(by_artist.items(), key=lambda kv: -len(kv[1])):   # 2) the rest, by artist (biggest artists first)
            if not self._gate():
                return
            if not artist or norm(artist) in ("unknown", "unknown artist", "various artists", "various"):
                self._bump(none=len(rels), done=len(rels))
                continue
            self._bump(current=artist)
            res = _cache_get(self.db, "artist", norm(artist))
            if res is None:
                try:
                    genres, raw = music_artist_genres(artist, lfm_key)
                    fails = 0
                except Offline as e:
                    fails += 1
                    if fails >= 4:
                        self._bump(error="Can't reach the internet: %s" % e)
                        return
                    self._bump(done=len(rels))
                    continue
                res = {"genres": genres}
                _cache_put(self.db, "artist", norm(artist), res)
            if res["genres"]:
                for r in rels:
                    _put(self.db, "track", r, res["genres"], "artist", 0.8, "auto")
                self._bump(found=len(rels))
            else:
                for r in rels:
                    _put(self.db, "track", r, [], "artist", 0, "none")
                self._bump(none=len(rels))
            self._bump(done=len(rels))
