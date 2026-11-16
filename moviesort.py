"""ULTRON movie auto-sort helpers (pure functions, no Flask, no disk access).

clean_movie_title("Spider-Man.No.Way.Home.2021.1080p.BluRay.H264.AAC-RARBG")  -> ("Spider-Man No Way Home", 2021)
group_franchises(["Iron Man", "Iron Man 2", "Iron Man 3", "Thor Ragnarok"])    -> {"Iron Man": [0, 1, 2]}
parse_episode("The.Boys.S03E05.1080p.WEB.x265-GRP")                             -> ("The Boys", 3, 5)
"""
import re

# words that mark the start of release junk (everything after the first one is dropped)
_STRONG = (r"(?:2160p|1080p|1080i|720p|576p|480p|uhd|hdr10\+?|"
           r"blu[ ._-]?ray|bdrip|brrip|bdremux|remux|web[ ._-]?dl|web[ ._-]?rip|hdrip|hdtv|hdts|hd[ ._-]?cam|"
           r"dvdrip|dvdscr|camrip|telesync|"
           r"x264|x265|h[ ._-]?264|h[ ._-]?265|hevc|xvid|divx|10[ ._-]?bit|"
           r"aac\d?(?:[ ._-]?\d)?|ac3|eac3|dts(?:[ ._-]?hd)?|truehd|atmos|ddp\d(?:[ ._-]?\d)?|"
           r"yify|yts|rarbg|ettv|eztv|psa|galaxyrg|fgt|sparks|geckos|amiable|ntb|ion10|tigole|qxr|hushrips|prolover|neonoir|"
           r"\d+(?:\.\d+)?[ ._]?(?:gb|mb))")
# weaker words: only treated as junk when they follow the release year
_WEAK = (r"(?:4k|hdr|dv|dolby[ ._-]?vision|web|hdcam|dvd|cam|ts|tc|r5|av1|avc|8[ ._-]?bit|dd\+?|5[ ._]1|7[ ._]1|2[ ._]0|6ch|2ch|8ch|"
         r"extended|unrated|remastered|directors?[ ._-]?cut|imax|proper|repack|internal|limited|multi|dual|dubbed|subbed|"
         r"hindi|eng|english|subs?|esub|nf|amzn|dsnp|hmax|atvp|flac|mp3|"
         r"upscaled?|criterion|rm4k|diamond|platinum)")
_SEP = r"(?:^|[ ._\-\[\(])"
_END = r"(?=$|[ ._\-\]\)])"
_JUNK_RE = re.compile(_SEP + _STRONG + _END, re.I)
_AFTER_YEAR_RE = re.compile(r"^[\s._\-\]\)\[\(]*(?:" + _STRONG + "|" + _WEAK + r")" + _END, re.I)
_YEAR_RE = re.compile(r"(?:^|[ ._\-\[\(])((?:19|20)\d{2})(?=$|[ ._\-\]\)])")
_BRACKETS = re.compile(r"\[[^\]]*\]|\{[^}]*\}")
_EP_RES = [re.compile(r"^(?P<show>.+?)[ ._\-]+[Ss](?P<s>\d{1,2})[ ._\-]?[Ee](?P<e>\d{1,3})(?:[Ee]\d{1,3})*(?![0-9])"),
           re.compile(r"^(?P<show>.+?)[ ._\-]+(?P<s>\d{1,2})x(?P<e>\d{2,3})(?![0-9])"),
           re.compile(r"^(?P<show>.+?)[ ._\-]+Season[ ._]?(?P<s>\d{1,2})[ ._\-]+Episode[ ._]?(?P<e>\d{1,3})", re.I)]

_STOP_FIRST = {"the", "a", "an", "my", "i", "in", "of", "one", "two", "new", "big", "little", "good", "bad", "love", "last", "first",
               "dark", "black", "white", "red", "blue", "green", "night", "day", "man", "dead", "dr", "mr", "star", "john", "land",
               "life", "war", "world", "wild", "good", "great", "final", "return", "rise", "night", "mission", "fast", "all"}


def _spaces(s):
    return re.sub(r"\s+", " ", s).strip(" ._-")


# junk that sits at the START of a name ("DTS 1080p x264 BLURAY Shrek 3") or is left over inside it
_STRAY_RE = re.compile(_SEP + _STRONG + _END, re.I)


def _strip_stray_junk(t):
    """Removes quality / source / codec / audio words wherever they still are (the first cut only drops everything after the first one)."""
    prev = None
    while prev != t:
        prev = t
        t = _spaces(_STRAY_RE.sub(" ", " " + t))
        t = re.sub(r"(?:\s[-\u2013]){2,}(?=\s|$)", " -", t)     # dashes left side by side after the junk went
        t = _spaces(t)
    return t


def clean_junk(stem):
    """For names that are NOT movies (series folders, episode titles): drop the release junk but keep years and numbers.
    'Breaking.Bad.S01.1080p.BluRay.DTS.x264-GRP' -> 'Breaking Bad S01'"""
    s = _BRACKETS.sub(" ", str(stem))
    s = re.sub(r"[_]+", " ", s)
    if "." in s and " " not in s.strip():
        s = s.replace(".", " ")
    j = _JUNK_RE.search(" " + s)
    if j:
        pos = max(0, j.start() - 1)
        if _spaces(s[:pos]):
            s = s[:pos]
    t = _strip_stray_junk(_spaces(s))
    return t or _spaces(re.sub(r"[._]+", " ", str(stem))) or str(stem)


def clean_movie_title(stem):
    """Drop torrent junk: quality, source, codec, group tags. Returns (title, year or None)."""
    s = _BRACKETS.sub(" ", str(stem))
    s = re.sub(r"[_]+", " ", s)
    dotted = "." in s and " " not in s.strip()
    if dotted:                                   # "Ant-Man.2015.1080p" -> dots are the word separators
        s = s.replace(".", " ")
    year = None
    ys = list(_YEAR_RE.finditer(" " + s))
    cut = len(s)
    # the release year is the LAST 4-digit year that still has a title before it ("2012" or "1917" can be a real title)
    for m in reversed(ys):
        start = max(0, m.start(1) - 1)
        before = _spaces(s[:start])
        rest = s[m.end(1):]
        # a year only ends the title when nothing but release junk follows it ("Valorant 2024 ace clip" keeps its words)
        if before and (not _spaces(rest) or _AFTER_YEAR_RE.match(rest)):
            year = int(m.group(1)); cut = start
            break
    j = _JUNK_RE.search(" " + s)
    if j:
        pos = max(0, j.start() - 1)
        if pos < cut and _spaces(s[:pos]):
            cut = pos
    t = _spaces(s[:cut])
    t = _strip_stray_junk(t)
    t = re.sub(r"\s*\(\s*$", "", t)              # "Thor Love and Thunder (2022) 1080p" -> "Thor Love and Thunder"
    t = re.sub(r"[\s\-–]+$", "", t)
    t = _spaces(t)
    if not t:
        t = _spaces(re.sub(r"[._]+", " ", str(stem))) or str(stem)
    # "Guardians Of The Galaxy Vol  2" (a stray dot) -> "Vol 2"
    t = re.sub(r"\bVol\s*\.?\s+(\d)", r"Vol. \1", t, flags=re.I)
    t = re.sub(r"\s+", " ", t)
    return t, year


def parse_episode(stem):
    """'The.Boys.S03E05.1080p' -> ('The Boys', 3, 5), or None when it does not look like an episode."""
    s = _BRACKETS.sub(" ", str(stem))
    for rx in _EP_RES:
        m = rx.match(s)
        if m:
            show = clean_movie_title(m.group("show"))[0]
            if len(show) >= 2:
                return show, int(m.group("s")), int(m.group("e"))
    return None


def _norm_words(title):
    t = re.sub(r"[’'`]", "", title.lower())
    t = re.sub(r"[^a-z0-9]+", " ", t).strip()
    w = t.split()
    if len(w) > 1 and w[0] in ("the", "a", "an"):
        w = w[1:]
    return w


def group_franchises(titles):
    """Group movies that share the start of their name (Spider-Man ..., Iron Man 2, Captain America ...).
    Returns {franchise name: [indexes]} for groups of 2+ movies. Single movies stay out."""
    words = [_norm_words(t) for t in titles]
    # count every word-prefix
    count = {}
    for w in words:
        for n in range(1, len(w) + 1):
            count.setdefault(tuple(w[:n]), set())
    for i, w in enumerate(words):
        for n in range(1, len(w) + 1):
            count[tuple(w[:n])].add(i)

    def acceptable(pre):
        members = count[pre]
        if len(members) < 2:
            return False
        if len(pre) >= 2:
            return True
        # one-word prefixes are risky ("Black Swan" + "Black Panther"): need an exact one-word title, or 3+ movies of a distinctive word
        if any(words[i] == list(pre) for i in members):
            return pre[0] not in _STOP_FIRST or len(members) >= 2 and any(words[i] == list(pre) for i in members) and len(pre[0]) > 3
        return len(members) >= 3 and pre[0] not in _STOP_FIRST and len(pre[0]) > 3

    owner = {}
    for i, w in enumerate(words):
        best = None
        for n in range(len(w), 0, -1):                    # the longest shared prefix first ...
            pre = tuple(w[:n])
            if acceptable(pre):
                best = pre
                break
        if best:
            owner[i] = best
    # ... then fold sub-groups into a shorter parent when the parent is a real group too
    # ("star wars episode" folds into "star wars" if a movie is called exactly "star wars" or 3 titles share it)
    keys = set(owner.values())
    fold = {}
    for k in sorted(keys, key=len, reverse=True):
        for n in range(len(k) - 1, 0, -1):
            parent = tuple(k[:n])
            if parent in keys or acceptable(parent) and len(count[parent]) > len(count[k]):
                fold[k] = parent
                break
    for i, k in list(owner.items()):
        seen = 0
        while k in fold and seen < 6:
            k = fold[k]; seen += 1
        owner[i] = k
    groups = {}
    for i, k in owner.items():
        groups.setdefault(k, []).append(i)
    out = {}
    for k, members in groups.items():
        if len(members) < 2:
            continue
        out[_display_name(k, [titles[i] for i in members])] = members
    return out


def _display_name(prefix, member_titles):
    """Nice name for a franchise: the shortest member title when it is exactly the prefix, else the shared leading words as typed."""
    n = len(prefix)
    for t in sorted(member_titles, key=len):
        w = re.split(r"\s+", re.sub(r"^(?:the|a|an)\s+(?=\S+\s)", "", t.strip(), flags=re.I)) if len(_norm_words(t)) < len(re.split(r"\s+", t.strip())) else re.split(r"\s+", t.strip())
        if _norm_words(" ".join(w)) == list(prefix):
            return " ".join(w)
    t = min(member_titles, key=len)
    toks = re.split(r"\s+", t.strip())
    if toks and toks[0].lower() in ("the", "a", "an") and len(toks) > 1:
        toks = toks[1:]
    # take as many typed tokens as the prefix has words (hyphenated names like Spider-Man are one token that normalises to two words)
    out, got = [], 0
    for tok in toks:
        got += max(1, len(_norm_words(tok)))
        out.append(tok)
        if got >= n:
            break
    return " ".join(out)
