"""CSS safety net: snapshot every element's computed style + box across the main views, then diff two snapshots.
Use it before and after any stylesheet clean-up; the diff should be empty unless you meant to change something.

    <python with playwright> tools/css_snapshot.py snap  OUT_DIR      # writes OUT_DIR/snap.json + one PNG per state
    <python with playwright> tools/css_snapshot.py match SELECTORS.json OUT.json   # used by css_unimportant.py
    <python with playwright> tools/css_snapshot.py winners "#sidebar" OUT.json     # cascade data for css_unimportant.py usage
    py -3.12 tools/css_snapshot.py diff  OLD_DIR NEW_DIR [OLD2_DIR...] [--all]  # prints what changed; anything that differs
                                                                        # between OLD and OLD2 (run-to-run noise) is ignored

`snap` needs Playwright (pip install playwright, no browser download: it drives the installed Chrome) and starts
the app itself with `py -3.12` in a throw-away folder: a small synthetic library is made with ffmpeg + Pillow under
%TEMP%/zeno-css-fixture, and your real data and media are never touched. Pages are served unbundled (?nobundle=1).
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = Path(tempfile.gettempdir()) / "zeno-css-fixture"

VIEWS = [("home-view", "tab-home"), ("video-view", "tab-video"), ("music-view", "tab-music"),
         ("time-view", "tab-time"), ("photos-view", "tab-photos"), ("dl-view", "tab-dl")]
SIZES = [(1280, 800), (1920, 1080)]
SMALL = [(1024, 700), (900, 640)]            # breakpoints: 1050 / 900 wide, 700 tall (default look only)
VARIANTS = [  # name, localStorage
    ("default", {}),
    ("rail", {"lmp_rail": "1"}),
    ("rail-off", {"lmp_rail": "0"}),
    ("chrome", {"lmpv9_pal": "chrome"}),
    ("colorful", {"lmp_bg": "colorful"}),
]
PROPS = """display position top right bottom left z-index float box-sizing
margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left
overflow-x overflow-y opacity visibility color background-color background-image background-size background-position
border-top-width border-right-width border-bottom-width border-left-width border-top-style border-bottom-style
border-top-color border-right-color border-bottom-color border-left-color
border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius
box-shadow outline-style outline-color outline-width font-family font-size font-weight font-style line-height
letter-spacing text-transform text-align text-shadow text-decoration-line white-space text-overflow
transform filter backdrop-filter mix-blend-mode clip-path mask-image object-fit
flex-direction flex-wrap justify-content align-items gap grid-template-columns grid-template-rows
cursor pointer-events transition-property transition-duration animation-name""".split()
PSEUDO_PROPS = "content display position top left right bottom width height background-color background-image opacity transform border-top-width border-top-color".split()


# ------------------------------------------------------------------ fixture + server (runs under py -3.12)
def build_media(media):
    if (media / ".done").exists():
        return
    shutil.rmtree(media, ignore_errors=True)
    from PIL import Image
    from mutagen.id3 import ID3, TIT2, TPE1, TALB, TRCK, TCON
    # no ffmpeg needed: videos are placeholder files (no thumbnails, the same every run), a few get sidecar posters
    for genre, title, color in [("Action", "Alpha Strike", "red"), ("Action", "Bravo Run", "orange"),
                                ("Comedy", "Charlie Laughs", "yellow"), ("Sci-Fi", "Echo Station", "teal")]:
        p = media / "videos" / genre / f"{title}.mp4"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\0" * 4096)
        if color in ("red", "teal"):
            Image.new("RGB", (300, 450), color).save(p.with_name(f"{title}-poster.jpg"))
    for ep in (1, 2, 3):
        p = media / "videos" / "Drama" / "Delta Show" / f"Delta Show S01E0{ep}.mp4"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\0" * 4096)
    frame = b"\xff\xfb\x90\x64" + b"\0" * 413          # one silent MPEG-1 layer III frame, 128 kbps / 44.1 kHz
    for artist, album, n in [("Artist One", "First Album", 3), ("Artist Two", "Second Album", 2)]:
        for i in range(1, n + 1):
            p = media / "music" / artist / album / f"{i:02d} Track {i}.mp3"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(frame * 115)                 # ~3 s
            tags = ID3()
            for t in (TIT2(encoding=3, text=f"Track {i}"), TPE1(encoding=3, text=artist), TALB(encoding=3, text=album),
                      TRCK(encoding=3, text=str(i)), TCON(encoding=3, text="Pop")):
                tags.add(t)
            tags.save(p)
    colors = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#f39c12", "#16a085"]
    for i, c in enumerate(colors):
        sub = "Trip" if i >= 4 else ""
        p = media / "Photos" / sub / f"photo{i}.jpg"
        p.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (400 + 80 * i, 300), c).save(p)
    (media / "private").mkdir(parents=True, exist_ok=True)
    old = time.time() - 86400                          # the scanner skips files written in the last 2 minutes
    for p in media.rglob("*"):
        os.utime(p, (old, old))
    (media / ".done").write_text("ok")


def serve(port):
    media, data = FIX / "media", FIX / "data"
    build_media(media)
    shutil.rmtree(data, ignore_errors=True)            # fresh settings + DB every run: same start state each time
    os.environ.update(ZENO_DATA_DIR=str(data), ZENO_NO_BUNDLE="1",
                      MEDIA_VIDEO_DIR=str(media / "videos"), MEDIA_MUSIC_DIR=str(media / "music"),
                      MEDIA_PRIVATE_DIR=str(media / "private"), MEDIA_PHOTO_DIR=str(media / "Photos"))
    sys.path.insert(0, str(ROOT)); sys.argv = ["app.py"]
    import app
    assert Path(app.DATA_DIR).resolve().is_relative_to(FIX.resolve()), "must not touch real data"
    for d in (app.DATA_DIR, app.POSTER_DIR, app.BACKDROP_DIR, app.TILE_DIR, app.CUSTOM_TILE_DIR, app.THUMB_DIR):
        d.mkdir(parents=True, exist_ok=True)
    app.init_db(); app.WINDOW = None
    app.scan_videos(); app.STARTUP_SCAN.set(); app.scan_music(); app.pregenerate_posters()
    import logging; logging.getLogger("werkzeug").setLevel(logging.ERROR)
    print("READY", flush=True)
    app.app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False)


# ------------------------------------------------------------------ snapshot (runs under the playwright python)
COLLECT_JS = r"""([props, pprops]) => {
  for (const a of document.getAnimations()) { try { a.finish(); } catch (e) { a.pause(); a.currentTime = 0; } }
  const out = {};
  const key = el => { const parts = []; let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      if (n.id && !/-\d+$/.test(n.id)) { parts.unshift('#' + n.id); break; }   // skip counters like shelf-21
      let i = 1, s = n; while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + ':' + i); n = n.parentElement; }
    return parts.join('>'); };
  const clean = v => v.replace(/127\.0\.0\.1:\d+/g, 'HOST').replace(/\/(poster|tile|thumb|backdrop)\/[0-9a-f]+/g, '/$1/ID');
  const pick = (cs, list) => { const o = {}; for (const p of list) o[p] = clean(cs.getPropertyValue(p)); return o; };
  const r2 = v => Math.round(v * 2) / 2;
  for (const el of [document.documentElement, document.body, ...document.body.querySelectorAll('*')]) {
    if (['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE'].includes(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && el !== document.body) continue;
    const rec = pick(cs, props);
    rec._box = [r2(r.x), r2(r.y + window.scrollY), r2(r.width), r2(r.height)].join(',');
    for (const ps of ['::before', '::after']) {
      const pc = getComputedStyle(el, ps);
      if (pc.content && pc.content !== 'none' && pc.content !== 'normal') rec[ps] = pick(pc, pprops);
    }
    let k = key(el), j = 2; while (out[k]) k = key(el) + '~' + j++;
    out[k] = rec;
  }
  return out;
}"""


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def snap(out_dir):
    from playwright.sync_api import sync_playwright
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    port = free_port()
    srv = subprocess.Popen(["py", "-3.12", str(Path(__file__).resolve()), "serve", str(port)],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=str(ROOT))
    try:
        for line in srv.stdout:
            if "READY" in line:
                break
        else:
            sys.exit("server did not start")
        url = f"http://127.0.0.1:{port}/?nobundle=1"
        result, t0 = {}, time.time()
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome", headless=True)
            for vname, ls in VARIANTS:
                sizes = SIZES + SMALL if vname == "default" else SIZES if vname in ("rail", "rail-off") else SIZES[:1]
                for w, h in sizes:
                    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, reduced_motion="no-preference")
                    ctx.add_init_script("""(() => { let s = 42; Math.random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
                        localStorage.setItem('ultron_ffmpeg_skip', '1'); localStorage.setItem('lmpv9_seen', '1');   // first-run dialogs
                        const ls = LS_JSON; for (const k in ls) localStorage.setItem(k, ls[k]); })()""".replace("LS_JSON", json.dumps(ls)))
                    page = ctx.new_page()
                    errors = []
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    page.clock.install(time=1767268800000)       # fixed date: 2026-01-01 12:00 UTC
                    page.clock.pause_at(1767268800000)
                    page.goto(url); page.wait_for_load_state("networkidle")
                    states = [(v, t) for v, t in VIEWS] + [("settings", None), ("menu-open", None),
                                                           ("hover-tab", "#tab-music"), ("hover-tool", "#settings-btn")]
                    for view, tab in states:
                        if view.startswith("hover-"):           # mouse over a sidebar tab / tool (the sidebar is hovered too)
                            page.evaluate("() => { toggleMenu(false); switchTab('home-view', 'tab-home'); }")
                            page.hover(tab)
                        elif tab:
                            page.evaluate("([v, t]) => { if (typeof closeSettings === 'function') try { closeSettings(); } catch (e) {} switchTab(v, t); window.scrollTo(0, 0); }", [view, tab])
                        elif view == "settings":
                            page.evaluate("() => { switchTab('home-view', 'tab-home'); openSettings(); }")
                        else:                                   # the rail expanded with its labels (M key)
                            page.evaluate("() => { closeSettings(); switchTab('home-view', 'tab-home'); toggleMenu(true); }")
                        page.clock.run_for(2500)                # let timers / transitions settle on the fake clock
                        page.wait_for_timeout(600)
                        name = f"{vname}-{w}x{h}-{view}"
                        result[name] = page.evaluate(COLLECT_JS, [PROPS, PSEUDO_PROPS])
                        page.screenshot(path=str(out / f"{name}.png"))
                    if errors:
                        result[f"{vname}-{w}x{h}-_errors"] = {"errors": {"list": "; ".join(sorted(set(errors)))}}
                    ctx.close()
            browser.close()
        (out / "snap.json").write_text(json.dumps(result, sort_keys=True))
        n = sum(len(v) for v in result.values())
        print(f"{len(result)} states, {n} element records -> {out / 'snap.json'}  ({time.time() - t0:.0f}s)")
    finally:
        srv.kill()


MATCH_JS = r"""(sels) => {
  const key = el => { const parts = []; let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      if (n.id && !/-\d+$/.test(n.id)) { parts.unshift('#' + n.id); break; }
      let i = 1, s = n; while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + ':' + i); n = n.parentElement; }
    return parts.join('>') || 'html'; };
  const out = {}, ids = new Set(), sigs = new Set();
  for (const el of document.querySelectorAll('[id]')) ids.add(el.id);
  for (const el of document.querySelectorAll('*')) sigs.add(el.tagName.toLowerCase() + '|' + [...el.classList].sort().join(' '));
  for (const sel of sels) {
    try { out[sel] = [...document.querySelectorAll(sel)].map(key); } catch (e) { out[sel] = null; }
  }
  return { matches: out, ids: [...ids], sigs: [...sigs] };
}"""


def match(sel_file, out_file):
    """Evaluate selectors (JSON list) against the DOM of every view and variant; write {selector: [element keys]} (null = invalid)."""
    from playwright.sync_api import sync_playwright
    sels = json.loads(Path(sel_file).read_text(encoding="utf-8"))
    port = free_port()
    srv = subprocess.Popen(["py", "-3.12", str(Path(__file__).resolve()), "serve", str(port)],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=str(ROOT))
    res, ids, sigs = {}, set(), set()
    try:
        for line in srv.stdout:
            if "READY" in line: break
        url = f"http://127.0.0.1:{port}/?nobundle=1"
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome", headless=True)
            for vname, ls in VARIANTS:
                ctx = browser.new_context(viewport={"width": 1280, "height": 800})
                ctx.add_init_script("localStorage.setItem('ultron_ffmpeg_skip','1');localStorage.setItem('lmpv9_seen','1');"
                                    "const __ls = LS_JSON; for (const k in __ls) localStorage.setItem(k, __ls[k]);".replace("LS_JSON", json.dumps(ls)))
                page = ctx.new_page(); page.clock.install(time=1767268800000); page.clock.pause_at(1767268800000)
                page.goto(url); page.wait_for_load_state("networkidle")
                for view, tab in VIEWS + [("settings", None), ("menu-open", None)]:
                    if tab: page.evaluate("([v, t]) => { try { closeSettings(); } catch (e) {} switchTab(v, t); }", [view, tab])
                    elif view == "settings": page.evaluate("() => { switchTab('home-view', 'tab-home'); openSettings(); }")
                    else: page.evaluate("() => { closeSettings(); toggleMenu(true); }")
                    page.clock.run_for(2500); page.wait_for_timeout(300)
                    r = page.evaluate(MATCH_JS, sels)
                    ids.update(r["ids"]); sigs.update(r["sigs"])
                    for k, v in r["matches"].items():
                        if v is None: res[k] = None
                        elif res.get(k, 0) is not None: res.setdefault(k, set()).update(v)
                ctx.close()
            browser.close()
    finally:
        srv.kill()
    Path(out_file).write_text(json.dumps({"matches": {k: (None if v is None else sorted(v)) for k, v in res.items()}, "ids": sorted(ids), "sigs": sorted(sigs)}), encoding="utf-8")
    print(f"{len(sels)} selectors matched across {len(VARIANTS) * (len(VIEWS) + 2)} states -> {out_file}")


WIN_VARIANTS = VARIANTS + [("time-bg", {"lmp_bg": "time"}), ("plain", {"lmpv9_plain": "1"}), ("lite", {"lmpv9_lite": "1"})]


def winners(root, out_file):
    """For every element under ROOT (and ROOT), in every view / variant / hover / focus state, ask Chrome (DevTools
    protocol) which rules match, in cascade order, plus the inline style. Writes the raw data for
    css_unimportant.py usage. Hover is forced on each element together with its ancestors, so :hover rules count."""
    from playwright.sync_api import sync_playwright
    port = free_port()
    srv = subprocess.Popen(["py", "-3.12", str(Path(__file__).resolve()), "serve", str(port)],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=str(ROOT))
    records, t0 = [], time.time()
    try:
        for line in srv.stdout:
            if "READY" in line: break
        url = f"http://127.0.0.1:{port}/?nobundle=1"
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome", headless=True)
            for vname, ls in WIN_VARIANTS:
                ctx = browser.new_context(viewport={"width": 1280, "height": 800})
                ctx.add_init_script("localStorage.setItem('ultron_ffmpeg_skip','1');localStorage.setItem('lmpv9_seen','1');"
                                    "const __ls = LS_JSON; for (const k in __ls) localStorage.setItem(k, __ls[k]);".replace("LS_JSON", json.dumps(ls)))
                page = ctx.new_page()
                sheets = {}
                cdp = ctx.new_cdp_session(page)
                cdp.on("CSS.styleSheetAdded", lambda e: sheets.__setitem__(e["header"]["styleSheetId"], e["header"].get("sourceURL", "")))
                page.goto(url); page.wait_for_load_state("load"); page.wait_for_timeout(2500)
                cdp.send("DOM.enable"); cdp.send("CSS.enable")
                states = [("home-view", "tab-home", None), ("music-view", "tab-music", None), ("dl-view", "tab-dl", None),
                          ("menu-open", None, None), ("private", None, None)]
                for view, tab, _ in states:
                    if tab: page.evaluate("([v, t]) => { switchTab(v, t); }", [view, tab])
                    elif view == "menu-open": page.evaluate("() => { switchTab('home-view', 'tab-home'); toggleMenu(true); }")
                    else: page.evaluate("() => { toggleMenu(false); document.body.classList.add('is-private'); $('tab-private').classList.remove('hidden'); }")
                    page.wait_for_timeout(700)
                    doc = cdp.send("DOM.getDocument", {"depth": -1})
                    nodes = cdp.send("DOM.querySelectorAll", {"nodeId": doc["root"]["nodeId"], "selector": f"{root}, {root} *"})["nodeIds"]
                    keys = page.evaluate("""(root) => [...document.querySelectorAll(root + ', ' + root + ' *')].map(el => {
                        const parts = []; let n = el;
                        while (n && n.nodeType === 1 && n !== document.documentElement) {
                          if (n.id && !/-\\d+$/.test(n.id)) { parts.unshift('#' + n.id); break; }
                          let i = 1, s = n; while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) i++;
                          parts.unshift(n.tagName.toLowerCase() + ':' + i); n = n.parentElement; }
                        return parts.join('>'); })""", root)
                    parent, tags = {}, {}
                    for nid in nodes:
                        d = cdp.send("DOM.describeNode", {"nodeId": nid})
                        parent[nid] = d["node"].get("parentId"); tags[nid] = d["node"]["nodeName"].lower()
                    index, inside = {nid: i for i, nid in enumerate(nodes)}, set(nodes)
                    subtree = lambda nid: [n for n in nodes if nid in _chain(n, parent, inside)]
                    # plain; hover on the root, the logo and every button (with its ancestors, so #root:hover applies);
                    # focus on every button. Only the forced element's own subtree can change, so only that is read.
                    hot = [n for n in nodes if tags[n] in ("button", "a", "input") or n == nodes[0] or keys[index[n]] == "#lm-mark"]
                    forced_sets = [("none", [], nodes)] \
                        + [(f"hover:{keys[index[n]]}", _chain(n, parent, inside), subtree(n)) for n in hot] \
                        + [(f"focus:{keys[index[n]]}", [n], subtree(n)) for n in hot if tags[n] in ("button", "a", "input")]
                    for fname, forced, targets in forced_sets:
                        pc = ["focus", "focus-visible", "focus-within"] if fname.startswith("focus") else ["hover"]
                        for n in forced: cdp.send("CSS.forcePseudoState", {"nodeId": n, "forcedPseudoClasses": pc})
                        for nid in targets:
                            key = keys[index[nid]]
                            m = cdp.send("CSS.getMatchedStylesForNode", {"nodeId": nid})
                            rules = []
                            for mr in m.get("matchedCSSRules", []):
                                r = mr["rule"]
                                if r.get("origin") != "regular": continue
                                src = sheets.get(r.get("styleSheetId"), "")
                                rng = r["selectorList"]["selectors"][0].get("range") if r["selectorList"]["selectors"] else None
                                props = [[p["name"], bool(p.get("important"))] for p in r["style"]["cssProperties"]
                                         if p.get("range") and not p.get("disabled") and p.get("parsedOk", True)]
                                rules.append([src.split("/assets/css/")[-1].split("/vendor/")[-1].split("?")[0], rng["startLine"] if rng else -1,
                                              rng["startColumn"] if rng else -1, props, mr.get("matchingSelectors", [])])
                            inline = [[p["name"], bool(p.get("important"))] for p in (m.get("inlineStyle") or {}).get("cssProperties", [])
                                      if p.get("range") and p.get("value")]
                            records.append({"variant": vname, "state": view, "forced": fname, "el": key, "rules": rules, "inline": inline})
                        for n in forced: cdp.send("CSS.forcePseudoState", {"nodeId": n, "forcedPseudoClasses": []})
                ctx.close()
            browser.close()
    finally:
        srv.kill()
    Path(out_file).write_text(json.dumps(records), encoding="utf-8")
    print(f"{len(records)} element/state records under {root} -> {out_file} ({time.time() - t0:.0f}s)")


def _chain(nid, parent, inside):
    out = []
    while nid and nid in inside:
        out.append(nid); nid = parent.get(nid)
    return out


def diff(a_dir, b_dir, noise_dirs=(), limit=60):
    load = lambda d: json.loads((Path(d) / "snap.json").read_text())
    a, b = load(a_dir), load(b_dir)
    noisy = set()                                       # (state, element, prop) that differ between two baselines
    for nd in noise_dirs:
        n = load(nd)
        for state in set(a) | set(n):
            sa, sn = a.get(state, {}), n.get(state, {})
            for el in set(sa) | set(sn):
                ea, en = sa.get(el), sn.get(el)
                if ea is None or en is None:
                    noisy.add((state, el, "*")); continue
                for p in set(ea) | set(en):
                    if ea.get(p) != en.get(p):
                        noisy.add((state, el, p))
    changes = 0; by_prop = {}
    for state in sorted(set(a) | set(b)):
        sa, sb = a.get(state, {}), b.get(state, {})
        lines = []
        for el in sorted(set(sa) | set(sb)):
            ea, eb = sa.get(el), sb.get(el)
            if (state, el, "*") in noisy:
                continue
            if ea is None or eb is None:
                lines.append(f"  {el}: {'appeared' if ea is None else 'gone'}"); by_prop["<presence>"] = by_prop.get("<presence>", 0) + 1
                continue
            for p in sorted(set(ea) | set(eb)):
                if ea.get(p) != eb.get(p) and (state, el, p) not in noisy:
                    lines.append(f"  {el} {p}: {ea.get(p)!r} -> {eb.get(p)!r}"); by_prop[p] = by_prop.get(p, 0) + 1
        if lines:
            changes += len(lines)
            print(f"[{state}] {len(lines)} change(s)")
            for ln in lines[:limit]:
                print(ln[:300])
            if len(lines) > limit:
                print(f"  ... {len(lines) - limit} more")
    if by_prop:
        print("\nby property:", ", ".join(f"{k}={v}" for k, v in sorted(by_prop.items(), key=lambda x: -x[1])))
    print(f"\n{changes} difference(s)" if changes else "no differences")
    return changes


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "serve":
        serve(int(sys.argv[2]))
    elif cmd == "snap":
        snap(sys.argv[2])
    elif cmd == "winners":
        winners(sys.argv[2], sys.argv[3])
    elif cmd == "match":
        match(sys.argv[2], sys.argv[3])
    elif cmd == "diff":
        rest = [a for a in sys.argv[4:] if a != "--all"]
        sys.exit(1 if diff(sys.argv[2], sys.argv[3], rest, limit=10**9 if "--all" in sys.argv else 60) else 0)
    else:
        print(__doc__)
