"""Dev-time curation of the Gallery background (NOT app code, never imported by app.py).

Builds assets/art/manifest.json and assets/art/starter/*.jpg from the National
Gallery of Art open data (CSV metadata + IIIF images; only openaccess = 1 rows).

  py -3.12 tools/art_curate.py resolve        # CSVs -> cache, then candidates.html (contact sheet)
  py -3.12 tools/art_curate.py build [--drop ID,ID] [--limit N]
                                               # candidates.json -> manifest + starter + size measurement

Cache lives outside the repo (ART_CACHE or %TEMP%/ultron_art_cache).
Seed lines: side | artist | title  (tools/art_seed.txt). Keyword candidates are
added per side from titles of paintings. Veto by eye in candidates.html, then
pass the ids to --drop (or delete lines from the seed and re-run).
"""
import argparse, csv, json, os, re, tempfile, unicodedata, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get("ART_CACHE") or os.path.join(tempfile.gettempdir(), "ultron_art_cache")
BASE = "https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data/"
SEED = os.path.join(ROOT, "tools", "art_seed.txt")
OUT = os.path.join(ROOT, "assets", "art")
KEYWORDS = {
    "good": ["angel", "annunciation", "madonna", "paradise", "dawn", "morning", "sunrise"],
    "evil": ["hell", "devil", "death", "storm", "night", "skull", "martyrdom", "moonlight", "demon"],
}
STARTER_PER_SIDE = 3
csv.field_size_limit(1 << 30)


def fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def fetch_csv(name):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, name)
    if not os.path.exists(p):
        print("downloading", name)
        urllib.request.urlretrieve(BASE + name, p + ".part")
        os.replace(p + ".part", p)
    return p


def rows(name):
    with open(fetch_csv(name), encoding="utf-8-sig", newline="") as f:
        yield from csv.DictReader(f)


def load():
    imgs = {}  # objectid -> primary open-access image
    for r in rows("published_images.csv"):
        if r.get("openaccess") == "1" and r.get("viewtype") == "primary" and r.get("depictstmsobjectid"):
            imgs[r["depictstmsobjectid"]] = r
    objs = []
    for r in rows("objects.csv"):
        im = imgs.get(r["objectid"])
        if im and (r.get("classification") or "").lower() == "painting":
            objs.append((r, im))
    return objs


def entry(side, o, im):
    w, h = int(im["width"] or 0), int(im["height"] or 0)
    return {"id": im["uuid"], "side": side, "title": o["title"], "artist": o["attribution"],
            "year": o["displaydate"], "iiif": im["iiifurl"], "w": w, "h": h}


def resolve():
    objs = load()
    print(len(objs), "open-access paintings")
    found, seen, missing = [], set(), []
    for ln in open(SEED, encoding="utf-8"):
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        side, artist, title = [x.strip() for x in ln.split("|", 2)]
        pat_a, pat_t = re.compile(fold(artist).replace("_", ".")), fold(title)
        hits = [(o, im) for o, im in objs if pat_a.search(fold(o["attribution"])) and pat_t in fold(o["title"])]
        if not hits:
            missing.append(ln)
        for o, im in hits[:1]:
            if im["uuid"] not in seen:
                seen.add(im["uuid"])
                found.append(dict(entry(side, o, im), src="seed"))
    for side, kws in KEYWORDS.items():
        for o, im in objs:
            if im["uuid"] in seen or int(im["width"] or 0) < 1800:
                continue
            t = fold(o["title"])
            if any(re.search(r"\b" + k, t) for k in kws):
                seen.add(im["uuid"])
                found.append(dict(entry(side, o, im), src="keyword"))
    os.makedirs(CACHE, exist_ok=True)
    json.dump(found, open(os.path.join(CACHE, "candidates.json"), "w"), indent=1)
    html = ["<meta charset=utf-8><style>body{background:#111;color:#ddd;font:13px sans-serif}"
            "figure{display:inline-block;width:240px;margin:6px;vertical-align:top}img{width:240px}</style>"]
    for side in ("good", "evil"):
        html.append("<h2>%s</h2>" % side)
        for e in (x for x in found if x["side"] == side):
            html.append('<figure><img loading=lazy src="%s/full/!240,240/0/default.jpg"><figcaption>%s<br>%s, %s<br>'
                        '<small>%s %s</small></figcaption></figure>' % (
                            e["iiif"], e["title"], e["artist"], e["year"], e["src"], e["id"]))
    p = os.path.join(CACHE, "candidates.html")
    open(p, "w", encoding="utf-8").write("\n".join(html))
    print("found", len(found), "| not found:", *missing, sep="\n  ")
    print("contact sheet:", p)


def build(drop, limit):
    found = json.load(open(os.path.join(CACHE, "candidates.json")))
    drop = set(drop)
    per = {"good": [], "evil": []}
    for e in found:
        if e["id"] not in drop:
            per[e["side"]].append(e)
    man = []
    for side, lst in per.items():
        lst.sort(key=lambda e: e["src"] != "seed")  # seeds first, then keywords
        man += [{k: v for k, v in e.items() if k != "src"} for e in lst[:limit]]
    os.makedirs(os.path.join(OUT, "starter"), exist_ok=True)
    for side in per:
        n = 0
        for e in (x for x in man if x["side"] == side):
            if n >= STARTER_PER_SIDE:
                break
            if e["w"] < e["h"]:  # landscape only, for a wide background
                continue
            dest = os.path.join(OUT, "starter", e["id"] + ".jpg")
            if not os.path.exists(dest):
                urllib.request.urlretrieve(e["iiif"] + "/full/!1920,1920/0/default.jpg", dest)
            n += 1
    total = 0  # measured by really fetching each image (HEAD is not always answered with a length)
    for e in man:
        with urllib.request.urlopen(e["iiif"] + "/full/!2560,2560/0/default.jpg", timeout=60) as r:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"source": "National Gallery of Art open access (api.nga.gov IIIF)",
                   "bytes_2560": total, "works": man}, f, indent=1, ensure_ascii=False)
    print(len(man), "works,", round(total / 1e6), "MB at 2560px")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["resolve", "build"])
    ap.add_argument("--drop", default="")
    ap.add_argument("--limit", type=int, default=40, help="max works per side")
    a = ap.parse_args()
    resolve() if a.cmd == "resolve" else build(a.drop.split(","), a.limit)
