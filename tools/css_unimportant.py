"""Remove !important and leading "html body" / "html" prefixes where it provably changes nothing.

    py -3.12 tools/css_unimportant.py prepare SELS.json                       # 1. selectors to test in the browser
    <python with playwright> tools/css_snapshot.py match SELS.json M.json     # 2. match them against the live DOM
    py -3.12 tools/css_unimportant.py report --matches M.json                 # 3. what could go, what has to stay
    py -3.12 tools/css_unimportant.py apply  --matches M.json                 # 4. rewrite the stylesheets in place
    py -3.12 tools/css_unimportant.py why [SELECTOR-TEXT] --matches M.json    # why each remaining !important stays
(Without --matches it falls back to the markup alone, which cannot see nesting and keeps far more.)

How it decides. Every declaration (all app stylesheets + vendor/tailwind.css, which only competes) is compared with
every other declaration of the same property whose selector can hit the same element. "Same element" uses the markup:
templates/index.html and every tag written in the JS files give (tag, id, classes); classes that JS adds or toggles
count as possibly on any element; anything it cannot pin down counts as "could be anything". A change is kept only
if no such pair changes winner (the cascade key is !important, then specificity, then order). Changes that cause a
flip are undone and the check runs again until nothing flips. It never moves a rule, so source order is unchanged.

!important always stays on properties JS sets inline (style.x = ..., setProperty, style="..."), because without it
the inline value would win, and on anything inside a rule this tool cannot parse.
Confirm with tools/css_snapshot.py afterwards.
"""
import glob, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import css_dead as cd

ROOT = cd.ROOT
ALL = None                                              # candidate set meaning "could be any element"
STATIC_INLINE = {}                                      # prop -> DOM keys of elements with style="prop: ..." in index.html
DYN_TARGETS = {}                                        # class JS adds/toggles -> where ("#id", "body", "html", "*")
STATIC_IDS = set()                                      # ids written literally somewhere (markup or JS)


# ------------------------------------------------------------------ markup index
def unescape(s):
    return re.sub(r"\\(.)", r"\1", s)


def markup_index():
    els, dyn = [], set()
    texts = [("html", (ROOT / "templates" / "index.html").read_text(encoding="utf-8"))]
    texts += [("js", open(p, encoding="utf-8").read()) for p in glob.glob(str(ROOT / "assets" / "js" / "*.js"))]
    tag_re = re.compile(r"<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*/?>", re.S)
    for src, t in texts:
        for m in tag_re.finditer(t):
            tag, attrs = m.group(1).lower(), m.group(2)
            idm = re.search(r'\bid\s*=\s*\\?["\']([^"\']*)', attrs)
            clm = re.search(r'\bclass\s*=\s*\\?["\']([^"\']*)', attrs)
            sty = re.search(r'\bstyle\s*=\s*\\?["\']([^"\']*)', attrs)
            eid = idm.group(1) if idm else ""
            classes = set()
            if clm:
                for tok in re.split(r"\s+", clm.group(1)):
                    tok = tok.strip("'\"`")
                    if tok and not re.search(r"[${}()?:+]", tok.replace("\\:", "")) or (tok and re.fullmatch(r"[\w-]+(:[\w-]+)+", tok)):
                        classes.add(tok)
            inline = {d.split(":")[0].strip().lower() for d in (sty.group(1).split(";") if sty else []) if ":" in d}
            els.append({"src": src, "tag": tag, "id": eid, "cls": classes, "inline": inline,
                        "idpat": re.compile("^" + re.sub(r"\\\$\\\{[^}]*\\\}", ".*", re.escape(eid)) + "$") if "${" in eid else None})
        alias = {}
        for m in re.finditer(r"(?:var|let|const)\s+(\w+)\s*=\s*(document\.documentElement|document\.body)\b", t):
            alias[m.group(1)] = "html" if m.group(2).endswith("documentElement") else "body"
        recv_re = r"(\$\(\s*['\"]([-\w]+)['\"]\s*\)|document\.getElementById\(\s*['\"]([-\w]+)['\"]\s*\)|document\.documentElement|document\.body|[\w.$\]\[)'\"]+)"
        for m in re.finditer(recv_re + r"\s*\.classList\.(?:add|toggle|replace)\(([^)]*)\)", t):
            recv, id1, id2, args = m.group(1), m.group(2), m.group(3), m.group(4)
            if id1 or id2: target = "#" + (id1 or id2)
            elif recv.endswith("documentElement"): target = "html"
            elif recv.endswith("document.body"): target = "body"
            elif recv in alias: target = alias[recv]
            else: target = "*"
            names = re.findall(r"['\"]([-\w:/.\[\]]+)['\"]", args)
            if names and "toggle" in m.group(0)[len(recv):len(recv) + 20] and len(names) > 1:
                names = names[:1]                          # toggle('x', cond): only the first is a class
            for c in names:
                dyn.add(c); DYN_TARGETS.setdefault(c, set()).add(target)
        for m in re.finditer(r"className\s*[+]?=\s*([^;\n]*)", t):
            for c in [c for x in re.findall(r"['\"`]([^'\"`]*)['\"`]", m.group(1)) for c in x.split()]:
                DYN_TARGETS.setdefault(c, set()).add("*")
            dyn.update(re.findall(r"['\"`]([^'\"`]*)['\"`]", m.group(1)) and
                       [c for s in re.findall(r"['\"`]([^'\"`]*)['\"`]", m.group(1)) for c in s.split()])
        for m in re.finditer(r"\.id\s*=\s*['\"]([-\w]+)['\"]", t):
            els.append({"src": "js", "tag": "", "id": m.group(1), "cls": set(), "inline": set(), "idpat": None})
    STATIC_IDS.update(e["id"] for e in els if e["id"] and not e["idpat"])
    for tag in ("html", "body"):
        els.append({"src": "html", "tag": tag, "id": "", "cls": set(), "inline": set(), "idpat": None})
    return els, dyn


def inline_props():
    out = set()
    for p in glob.glob(str(ROOT / "assets" / "js" / "*.js")):
        t = open(p, encoding="utf-8").read()
        out.update(re.sub(r"([A-Z])", lambda x: "-" + x.group(1).lower(), m) for m in re.findall(r"\.style\.([a-zA-Z]+)\s*=", t))
        out.update(re.findall(r"style\.setProperty\(\s*['\"]([-\w]+)['\"]", t))
        for s in re.findall(r"(?:cssText\s*=\s*|style=\\?[\"'])([^;\n]*)", t):
            out.update(x.strip().lower() for x in re.findall(r"([-a-zA-Z]+)\s*:", s))
    out.discard("css-text")
    return out


def touches_inline(prop, inl):
    if prop.startswith("--"): return prop in inl
    mine = cd.longhands(prop)
    return any(mine & cd.longhands(p) for p in inl) or prop.split("-")[0] in inl


# ------------------------------------------------------------------ selector -> candidate elements
def compounds_of_subject(sel):
    """Alternatives for the rightmost compound (expands a leading :is()/:where())."""
    parts, depth, cur = [], 0, ""
    for ch in sel.strip():
        if ch in "([": depth += 1
        elif ch in ")]": depth -= 1
        if depth == 0 and ch in " >+~":
            if cur: parts.append(cur)
            cur = ""; continue
        cur += ch
    if cur: parts.append(cur)
    last = parts[-1] if parts else "*"
    m = re.match(r"^:(?:is|where)\((.*)\)(.*)$", last)
    if m and m.group(1).count("(") == m.group(1).count(")"):
        return [a + m.group(2) for a in cd.split_top(m.group(1))]
    return [last]


def parse_compound(c):
    pe = re.search(r"::?(before|after|first-line|first-letter|placeholder|selection|marker|backdrop|cue-region|cue|-webkit-[\w-]+)\b", c)
    pe = pe.group(1) if pe else ""
    bare = re.sub(r":[-\w]+\((?:[^()]|\([^()]*\))*\)", "", c)          # drop :not(...), :has(...), ...
    bare = re.sub(r"\[[^\]]*\]", "", bare)
    ids = [unescape(x) for x in re.findall(r"#((?:\\.|[-\w])+)", bare)]
    cls = [unescape(x) for x in re.findall(r"\.((?:\\.|[-\w])+)", re.sub(r"::?[-\w]+", "", bare))]
    tag = re.match(r"^([a-zA-Z][\w-]*)", bare)
    return pe, ids, set(cls), (tag.group(1).lower() if tag else "")


def candidates(sel, els, dyn, cache={}):
    if sel in cache: return cache[sel]
    pes, out = set(), set()
    for comp in compounds_of_subject(sel):
        pe, ids, cls, tag = parse_compound(comp)
        pes.add(pe)
        need = cls - dyn
        if not ids and not need and not tag:
            out = ALL; break
        for i, e in enumerate(els):
            if ids and not all(e["id"] == x or (e["idpat"] and e["idpat"].match(x)) for x in ids): continue
            if tag and e["tag"] and e["tag"] != tag: continue
            if not need <= e["cls"]: continue
            out.add(i)
        if out is not ALL and not out and (ids or need):
            pass                                        # matches nothing we know of: stays empty (no competitor)
    res = (frozenset(pes), out if out is ALL else frozenset(out))
    cache[sel] = res
    return res


def relax(sel, dyn):
    """Over-approximate a selector for querySelectorAll: drop state that changes at run time (pseudo-classes, toggled
    classes, attribute conditions, pseudo-elements). Combinators and stable ids / classes / tags stay."""
    toks, compound, i, n = [], "", 0, len(sel)

    def end_parens(j):
        depth = 0
        for k in range(j, n):
            if sel[k] == "(": depth += 1
            elif sel[k] == ")":
                depth -= 1
                if depth == 0: return k + 1
        return n

    def push_compound():
        nonlocal compound
        if compound.strip(): toks.append(compound.strip())
        compound = ""

    while i < n:
        ch = sel[i]
        if ch == "\\":
            compound += sel[i:i + 2]; i += 2; continue
        if ch == "[":
            j = sel.find("]", i); i = (j + 1) if j >= 0 else n
            compound += "\0"; continue                    # placeholder: "something was here"
        if ch == ":":
            pe = sel.startswith("::", i)
            j = i + (2 if pe else 1)
            m = re.match(r"[-\w]+", sel[j:]); name = (m.group(0) if m else "").lower(); j += len(m.group(0)) if m else 0
            arg_end = end_parens(j) if j < n and sel[j] == "(" else j
            if not pe and name in ("is", "where"):
                compound += ":is(" + ", ".join(relax(a, dyn) for a in cd.split_top(sel[j + 1:arg_end - 1])) + ")"
            elif not pe and name == "root":
                compound += ":root"
            else:
                compound += "\0"
            i = arg_end; continue
        if ch == ".":
            m = re.match(r"\.((?:\\.|[-\w])+)", sel[i:])
            if m:
                c = unescape(m.group(1))
                tg = DYN_TARGETS.get(c, set()) if c in dyn else set()
                if c not in dyn: compound += m.group(0)
                elif "*" in tg or not tg: compound += "\0"
                else: compound += ":is(" + ", ".join([m.group(0)] + sorted(tg)) + ")"
                i += len(m.group(0)); continue
        if ch in " >+~":
            push_compound()
            if ch != " ": toks.append(ch)
            i += 1; continue
        compound += ch; i += 1
    push_compound()
    out = []
    for t in toks:
        if t in (">", "+", "~"):
            if not out or out[-1] in (">", "+", "~"): out.append("*")
            out.append(t)
        else:
            t = t.replace("\0", "")
            out.append(t or "*")
    if not out or out[-1] in (">", "+", "~"): out.append("*")
    return " ".join(out)


def static_match(e, ids, cls, tag, dyn):
    for x in ids:
        if e["id"] == x: continue
        if e["idpat"] and x not in STATIC_IDS and e["idpat"].match(x): continue
        return False
    if tag and e["tag"] and e["tag"] != tag: return False
    for c in cls:
        if c in e["cls"]: continue
        if c in dyn:
            tg = DYN_TARGETS.get(c, {"*"})
            if "*" in tg or (e["id"] and "#" + e["id"] in tg) or (e["tag"] in tg): continue
        return False
    return True


def dom_candidates(sel, rel, dom, static_els, dyn):
    """(pseudo-elements, candidates): DOM matches of the relaxed selector + markup elements never seen in the DOM."""
    pes = frozenset(parse_compound(c)[0] for c in compounds_of_subject(sel))
    if rel not in dom or dom[rel] is None:
        return (pes, ALL)                                  # not evaluated / invalid in the browser: assume anything
    cand = set("d:" + k for k in dom[rel])
    for comp in compounds_of_subject(sel):
        _, ids, cls, tag = parse_compound(comp)
        for i, e in enumerate(static_els):
            if static_match(e, ids, cls, tag, dyn):
                cand.add(f"s:{i}")
    return (pes, frozenset(cand))


def overlap(ca, cb):
    if not (ca[0] & cb[0]): return False
    a, b = ca[1], cb[1]
    if a is ALL or b is ALL: return True
    return bool(a & b)


# ------------------------------------------------------------------ the analysis
def strip_prefix(sel):
    s = sel.strip()
    if re.match(r"^html\s+body\s+(?![>+~])\S", s): return re.sub(r"^html\s+body\s+", "", s)
    if re.match(r"^html\s+body[.:#\[]", s): return re.sub(r"^html\s+", "", s)
    if re.match(r"^html\s+(?![>+~])(?!body\b)\S", s): return re.sub(r"^html\s+", "", s)
    return s


def load(matches=None):
    els, dyn = markup_index()
    inl = inline_props()
    files = [ROOT / "vendor" / "tailwind.css"] + cd.load_order()
    decls, rules, order = [], [], 0
    for fi, f in enumerate(files):
        s = f.read_text(encoding="utf-8")
        def walk(nodes):
            nonlocal order
            for nd in nodes:
                if nd[0] == "group": walk(nd[4])
                elif nd[0] == "rule":
                    sels = cd.split_top(nd[3])
                    r = {"file": f, "fi": fi, "start": nd[1], "sels": sels, "new": [strip_prefix(x) for x in sels], "pref": False, "decls": []}
                    rules.append(r)
                    for d in nd[5]:
                        order += 1
                        d.update(order=order, rule=r, imp_old=d["imp"], imp_new=d["imp"])
                        r["decls"].append(d); decls.append(d)
        walk(cd.parse(s))
    if matches:
        import json
        data = json.loads(Path(matches).read_text(encoding="utf-8"))
        dom, dom_ids = data["matches"], set(data["ids"])
        STATIC_IDS.update(dom_ids)
        # markup the browser never rendered: JS-built tags, and index.html tags whose id never showed up
        static_els = [e for e in els if (e["src"] == "js" and not (e["id"] and e["id"] in dom_ids))
                      or (e["src"] == "html" and e["id"] and e["id"] not in dom_ids)]
        for r in rules:
            r["cand"] = [dom_candidates(x, relax(x, dyn), dom, static_els, dyn) for x in r["sels"]]
    else:
        for r in rules:
            r["cand"] = [candidates(x, els, dyn) for x in r["sels"]]
    # style="..." written in index.html: per element when it has an id, otherwise for every element
    STATIC_INLINE.clear()
    for e in els:
        if e["src"] != "html" or not e["inline"]: continue
        for prop in e["inline"]:
            if e["id"]: STATIC_INLINE.setdefault(prop, set()).add("d:#" + e["id"])
            else: inl.add(prop)
    for r in rules:
        r["spec_old"] = [cd.specificity(x) for x in r["sels"]]
        r["spec_pref"] = [cd.specificity(x) for x in r["new"]]
    return files, decls, rules, els, inl


def key(d, i, new):
    r = d["rule"]
    spec = r["spec_pref"][i] if (new and r["pref"]) else r["spec_old"][i]
    return ((d["imp_new"] if new else d["imp_old"]), spec, d["order"])


def flips(decls):
    """Pairs (a, b) of declarations that could hit the same element and whose winner differs between old and new."""
    by_lh = {}                                            # longhand -> declarations that set it (shorthands count)
    for d in decls:
        for lh in d.setdefault("lh", cd.longhands(d["prop"])):
            by_lh.setdefault(lh, []).append(d)
    out, seen = [], set()
    changed = [d for d in decls if d["imp_new"] != d["imp_old"] or d["rule"]["pref"]]
    cset = set(map(id, changed))
    for a in changed:
        comp = {id(b): b for lh in a["lh"] for b in by_lh.get(lh, ())}
        for b in comp.values():
                if b is a or (id(b) in cset and id(b) < id(a)): continue
                if (id(a), id(b)) in seen: continue
                seen.add((id(a), id(b)))
                ra, rb = a["rule"], b["rule"]
                if ra is rb: continue
                hit = False
                for i, ca in enumerate(ra["cand"]):
                    for j, cb in enumerate(rb["cand"]):
                        if overlap(ca, cb) and (key(a, i, False) > key(b, j, False)) != (key(a, i, True) > key(b, j, True)):
                            hit = True; break
                    if hit: break
                if hit: out.append((a, b))
    return out


def static_inline_hit(d):
    mine = cd.longhands(d["prop"])
    for prop, keys in STATIC_INLINE.items():
        if mine & cd.longhands(prop):
            for _, cand in d["rule"]["cand"]:
                if cand is ALL or (cand & keys): return True
    return False


def solve(decls, rules, inl, mode):
    """mode "imp": try dropping !important; mode "pref": try dropping html/body prefixes (on top of the imp result).
    Undo only what has to go: first every change that flips against something unchanged, then one side per pair."""
    app = [d for d in decls if d["rule"]["fi"] > 0]
    kept_inline = 0
    if mode == "imp":
        for d in app:
            if d["imp_old"]:
                if touches_inline(d["prop"], inl) or static_inline_hit(d): kept_inline += 1
                else: d["imp_new"] = False
        movable = lambda d: d["imp_new"] != d["imp_old"]
        undo = lambda d: d.__setitem__("imp_new", d["imp_old"])
    else:
        for r in rules:
            if r["fi"] > 0 and r["new"] != r["sels"]: r["pref"] = True
        movable = lambda d: d["rule"]["pref"]
        undo = lambda d: d["rule"].__setitem__("pref", False)
    rounds = 0
    while True:
        rounds += 1
        pairs = flips(decls)
        if not pairs: break
        forced = {id(x): x for a, b in pairs for x, y in ((a, b), (b, a)) if movable(x) and not movable(y)}
        if not forced:                                   # only changed-vs-changed pairs left: undo one side of each
            forced = {}
            for a, b in pairs:
                if movable(a) and movable(b) and id(a) not in forced and id(b) not in forced:
                    forced[id(b)] = b
        if not forced:                                   # flips we cannot attribute (should not happen): stop safely
            for a, b in pairs:
                for x in (a, b):
                    if movable(x): undo(x)
            continue
        for x in forced.values(): undo(x)
    return kept_inline, rounds


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"
    if cmd == "prepare":                                  # selectors for css_snapshot.py match
        import json
        els, dyn = markup_index()
        sels = set()
        for f in [ROOT / "vendor" / "tailwind.css"] + cd.load_order():
            def walk(nodes):
                for nd in nodes:
                    if nd[0] == "group": walk(nd[4])
                    elif nd[0] == "rule": sels.update(relax(x, dyn) for x in cd.split_top(nd[3]))
            walk(cd.parse(f.read_text(encoding="utf-8")))
        json.dump(sorted(sels), open(sys.argv[2], "w", encoding="utf-8"))
        print(f"{len(sels)} relaxed selectors -> {sys.argv[2]}")
        return
    mfile = sys.argv[sys.argv.index("--matches") + 1] if "--matches" in sys.argv else None
    files, decls, rules, els, inl = load(mfile)
    if cmd == "why":                                     # for each !important that has to stay: what it beats
        sel_filter = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else ""
        by_lh = {}
        for d in decls:
            for lh in cd.longhands(d["prop"]): by_lh.setdefault(lh, []).append(d)
        for d in decls:
            r = d["rule"]
            if r["fi"] == 0 or not d["imp_old"] or (sel_filter and not any(sel_filter in x for x in r["sels"])): continue
            if touches_inline(d["prop"], inl) or static_inline_hit(d):
                print(f'{r["file"].name}: {", ".join(r["sels"])[:70]} {{{d["prop"]}}}  -- JS / markup sets {d["prop"]} inline'); continue
            d["imp_new"] = False
            for b in {id(x): x for lh in cd.longhands(d["prop"]) for x in by_lh.get(lh, ())}.values():
                if b is d or b["rule"] is r: continue
                hit = next(((i, j) for i, ca in enumerate(r["cand"]) for j, cb in enumerate(b["rule"]["cand"])
                            if overlap(ca, cb) and (key(d, i, False) > key(b, j, False)) != (key(d, i, True) > key(b, j, True))), None)
                if hit:
                    print(f'{r["file"].name}: {r["sels"][hit[0]][:60]} {{{d["prop"]}}}  -- beats {b["rule"]["file"].name}: '
                          f'{b["rule"]["sels"][hit[1]][:60]} {{{b["prop"]}}}{" !important" if b["imp_old"] else ""}')
            d["imp_new"] = True
        return
    app = [d for d in decls if d["rule"]["fi"] > 0]
    kept_inline, r1 = solve(decls, rules, inl, "imp")
    _, r2 = solve(decls, rules, inl, "pref")             # prefixes, on top of the !important result
    imp_before = sum(d["imp_old"] for d in app)
    imp_after = sum(d["imp_new"] for d in app)
    pref_cand = sum(1 for r in rules if r["fi"] > 0 and r["new"] != r["sels"])
    pref_done = sum(1 for r in rules if r["pref"])
    print(f"elements indexed: {len(els)}")
    print(f"!important: {imp_before} -> {imp_after}  (kept {imp_after} : {kept_inline} for inline-styled properties, the rest win a real fight)")
    print(f"html/body prefixes: {pref_done} of {pref_cand} rules can drop them")
    per = {}
    for d in app:
        k = d["rule"]["file"].name
        a, b = per.get(k, (0, 0)); per[k] = (a + d["imp_old"], b + d["imp_new"])
    for k, (a, b) in per.items():
        if a: print(f"  {k:20} !important {a:4} -> {b:4}")
    if cmd != "apply":
        return
    for f in files[1:]:
        s = f.read_text(encoding="utf-8")
        edits = []
        for r in rules:
            if r["file"] != f: continue
            for d in r["decls"]:
                if d["imp_old"] and not d["imp_new"]:
                    seg = s[d["start"]:d["end"]]
                    m = list(re.finditer(r"\s*!\s*important", seg, re.I))[-1]
                    edits.append((d["start"] + m.start(), d["start"] + m.end(), ""))
            if r["pref"]:
                brace = s.index("{", r["start"])
                edits.append((r["start"], brace, ", ".join(r["new"]) + " "))
        if not edits: continue
        out, last = [], len(s)
        for a, b, t in sorted(edits, key=lambda e: e[0], reverse=True):
            s = s[:a] + t + s[b:]
        f.write_text(s, encoding="utf-8")
        print(f"rewrote {f.name}: {len(edits)} edit(s)")


if __name__ == "__main__":
    main()
