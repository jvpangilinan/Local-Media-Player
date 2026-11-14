"""Find (and optionally delete) CSS declarations that can never win because a later rule overrides them.

    py -3.12 tools/css_dead.py report                       # per file: declarations, dead, !important
    py -3.12 tools/css_dead.py strip FILE [FILE...]          # delete the dead declarations from these files in place

Files are read in the order templates/index.html loads them. A declaration D is dead when a LATER declaration L (any
later rule, any later file; never the same rule, so in-rule fallbacks stay) has
  - the same selector (a leading "html body " / "html " / "body " is ignored: it matches the same elements),
  - the same property,
  - no condition, or exactly D's @media/@supports condition,
  - and wins: L is !important and D is not, or both match in importance and L's specificity >= D's.
In a selector list ("a, b { ... }") D must be dead for every selector. Shorthand/longhand overlaps are not counted
(so it under-reports, never over-reports). Always confirm with tools/css_snapshot.py before and after.
"""
import re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "assets" / "css"
GROUPING = ("@media", "@supports", "@layer", "@container", "@document")


def load_order():
    html = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    return [CSS / m for m in re.findall(r'href="/assets/css/([^"?]+\.css)', html)]


# ------------------------------------------------------------------ tiny CSS parser that keeps source offsets
def skip_ws_comments(s, i, end):
    while i < end:
        if s[i].isspace():
            i += 1
        elif s.startswith("/*", i):
            j = s.find("*/", i + 2); i = end if j < 0 else j + 2
        else:
            break
    return i


def scan_to(s, i, end, stops):
    """Index of the first char in `stops` at paren depth 0, outside strings/comments (or end)."""
    depth = 0
    while i < end:
        c = s[i]
        if s.startswith("/*", i):
            j = s.find("*/", i + 2); i = end if j < 0 else j + 2; continue
        if c in "\"'":
            j = i + 1
            while j < end and s[j] != c:
                j += 2 if s[j] == "\\" else 1
            i = j + 1; continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth = max(0, depth - 1)
        elif depth == 0 and c in stops:
            return i
        i += 1
    return end


def match_brace(s, i, end):
    """s[i] == '{' -> index of the matching '}'."""
    depth = 0
    while i < end:
        j = scan_to(s, i, end, "{}")
        if j >= end:
            return end
        depth += 1 if s[j] == "{" else -1
        if depth == 0:
            return j
        i = j + 1
    return end


def parse(s, i=0, end=None, ctx=()):
    """-> list of nodes: ('rule', start, end, selector, ctx, decls) | ('group', start, end, prelude, children) | ('other', start, end)"""
    end = len(s) if end is None else end
    out = []
    while True:
        i = skip_ws_comments(s, i, end)
        if i >= end:
            return out
        j = scan_to(s, i, end, "{;}")
        if j >= end or s[j] != "{":                       # statement at-rule (@import ...;) or stray text
            out.append(("other", i, min(j + 1, end))); i = j + 1; continue
        prelude = re.sub(r"/\*.*?\*/", "", s[i:j], flags=re.S).strip()
        k = match_brace(s, j, end)
        if prelude.startswith("@"):
            if prelude.lower().startswith(GROUPING):
                cond = re.sub(r"\s+", " ", prelude)
                out.append(("group", i, k + 1, cond, parse(s, j + 1, k, ctx + (cond,))))
            else:
                out.append(("other", i, k + 1))           # @keyframes, @font-face, ...: left alone
        elif scan_to(s, j + 1, k, "{") < k:              # nested CSS: left alone
            out.append(("other", i, k + 1))
        else:
            out.append(("rule", i, k + 1, prelude, ctx, parse_decls(s, j + 1, k)))
        i = k + 1


def parse_decls(s, i, end):
    out = []
    while i < end:
        j = scan_to(s, i, end, ";")
        text = re.sub(r"/\*.*?\*/", "", s[i:j], flags=re.S).strip()
        if ":" in text:
            prop, val = text.split(":", 1)
            imp = bool(re.search(r"!\s*important\s*$", val, re.I))
            out.append({"start": i, "end": min(j + 1, end), "prop": prop.strip().lower(), "imp": imp})
        i = j + 1
    return out


# ------------------------------------------------------------------ selectors
def split_top(sel, sep=","):
    parts, depth, cur, q = [], 0, "", None
    for c in sel:
        if q:
            cur += c; q = None if c == q else q; continue
        if c in "\"'":
            q = c
        elif c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        if c == sep and depth == 0:
            parts.append(cur); cur = ""
        else:
            cur += c
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def specificity(sel):
    a = b = c = 0
    i, n = 0, len(sel)
    while i < n:
        ch = sel[i]
        if ch == "#":
            a += 1; i += 1
            while i < n and (sel[i].isalnum() or sel[i] in "-_\\"): i += 1
        elif ch == ".":
            b += 1; i += 1
            while i < n and (sel[i].isalnum() or sel[i] in "-_\\"): i += 1
        elif ch == "[":
            b += 1; i = sel.find("]", i) + 1 or n
        elif ch == ":":
            pe = sel.startswith("::", i)
            i += 2 if pe else 1
            m = re.match(r"[-\w]+", sel[i:]); name = m.group(0).lower() if m else ""; i += len(name)
            arg = None
            if i < n and sel[i] == "(":
                depth, j = 0, i
                while j < n:
                    if sel[j] == "(": depth += 1
                    elif sel[j] == ")":
                        depth -= 1
                        if depth == 0: break
                    j += 1
                arg = sel[i + 1:j]; i = j + 1
            if pe or name in ("before", "after", "first-line", "first-letter"):
                c += 1
            elif name == "where":
                pass
            elif name in ("is", "not", "has", "matches", "-webkit-any"):
                best = max((specificity(x) for x in split_top(arg or "")), default=(0, 0, 0))
                a, b, c = a + best[0], b + best[1], c + best[2]
            else:
                b += 1
        elif ch.isalpha() or ch == "_":
            c += 1
            while i < n and (sel[i].isalnum() or sel[i] in "-_"): i += 1
        else:
            i += 1
    return (a, b, c)


def norm_sel(sel):
    s = re.sub(r"\s*([>+~])\s*", r" \1 ", re.sub(r"\s+", " ", sel.strip()))
    s = re.sub(r"^(html body|html|body) (?![>+~])", "", s)   # html body X == X (for X other than html/body)
    return s


# ------------------------------------------------------------------ analysis
def collect(files):
    """-> files_data, flat list of (order, file_idx, rule_id, sel_norm, spec, ctx, decl)."""
    data, flat, order, rid = [], [], 0, 0
    def walk(nodes, fi):
        nonlocal order, rid
        for nd in nodes:
            if nd[0] == "group":
                walk(nd[4], fi)
            elif nd[0] == "rule":
                rid += 1
                sels = [(norm_sel(x), specificity(x)) for x in split_top(nd[3])]
                for d in nd[5]:
                    order += 1
                    d["order"], d["rule"], d["sels"], d["ctx"] = order, rid, sels, nd[4]
                    flat.append(d)
    for fi, f in enumerate(files):
        s = f.read_text(encoding="utf-8")
        nodes = parse(s)
        data.append((f, s, nodes)); walk(nodes, fi)
    return data, flat


def mark_dead(flat):
    # index later declarations by (selector, prop)
    by_key = {}
    for d in flat:
        for sel, spec in d["sels"]:
            by_key.setdefault((sel, d["prop"]), []).append((d["order"], d["rule"], spec, d["ctx"], d["imp"]))
    for d in flat:
        dead_all = True
        for sel, spec in d["sels"]:
            ok = False
            for o, r, sp, ctx, imp in by_key.get((sel, d["prop"]), ()):
                if o <= d["order"] or r == d["rule"]:
                    continue
                if ctx and ctx != d["ctx"]:
                    continue
                if (imp and not d["imp"]) or (imp == d["imp"] and sp >= spec):
                    ok = True; break
            if not ok:
                dead_all = False; break
        d["dead"] = dead_all


def strip_file(path, s, nodes):
    cuts = []
    def rule_empty(nd):
        return all(d.get("dead") for d in nd[5])
    def walk(nodes):
        removed_all = True
        for nd in nodes:
            if nd[0] == "rule":
                if nd[5] and rule_empty(nd):
                    cuts.append((nd[1], nd[2]))
                else:
                    removed_all = False
                    for d in nd[5]:
                        if d.get("dead"):
                            cuts.append((d["start"], d["end"]))
            elif nd[0] == "group":
                inner_cut_before = len(cuts)
                if walk(nd[4]):
                    del cuts[inner_cut_before:]; cuts.append((nd[1], nd[2]))
                else:
                    removed_all = False
            else:
                removed_all = False
        return removed_all and bool(nodes)
    walk(nodes)
    out, last = [], 0
    for a, b in sorted(cuts):
        if a < last:
            continue
        out.append(s[last:a]); last = b
    out.append(s[last:])
    text = "".join(out)
    text = re.sub(r"[ \t]+\n", "\n", text)               # trailing spaces left behind
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"\{\s+\}", "{ }", text)
    path.write_text(text, encoding="utf-8")
    return len([c for c in cuts])


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"
    files = load_order()
    data, flat = collect(files)
    mark_dead(flat)
    if cmd == "report":
        per = {}
        for d in flat:
            pass
        for f, s, nodes in data:
            ds = []
            def walk(nodes):
                for nd in nodes:
                    if nd[0] == "group": walk(nd[4])
                    elif nd[0] == "rule": ds.extend(nd[5])
            walk(nodes)
            dead = sum(1 for d in ds if d["dead"])
            imp = sum(1 for d in ds if d["imp"])
            print(f"  {f.name:20} decls {len(ds):5}  dead {dead:5} ({100 * dead // max(1, len(ds)):3}%)  !important {imp}")
    elif cmd == "strip":
        targets = {Path(a).resolve() for a in sys.argv[2:]}
        for f, s, nodes in data:
            if f.resolve() in targets:
                n = strip_file(f, s, nodes)
                print(f"{f.name}: removed {n} declaration(s)/rule(s)")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
