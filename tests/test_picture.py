"""Playback picture settings: the high-quality profile, HDR, smooth motion, the film refresh rate and the Picture line. Run:
    python tests/test_picture.py
Runs in a temp folder. Never changes the real screen: refresh switching is only checked through its decisions (pick_rate),
and the restore safety net is driven with a marker that names no monitor."""
import json, os, shutil, sys, tempfile, types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tmp = Path(tempfile.mkdtemp(prefix="zeno-picture-"))
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
import display_mode as dm  # noqa: E402
import mpv_backend as mb  # noqa: E402

assert Path(app.DATA_DIR).resolve().is_relative_to(tmp.resolve()), "test must not touch real data"
app.init_db(); app.WINDOW = None
H = {"X-LMP": "1"}

# ---- prefs: defaults, junk, and the old "Smooth motion" switch
p = app.get_prefs()
assert (p["mpv_hq"], p["mpv_refresh"], p["mpv_motion"], p["mpv_hdr"]) == (True, True, "auto", "balanced"), p
assert app.clean_pref("mpv_motion", "warp") == "auto" and app.clean_pref("mpv_hdr", "x") == "balanced"
assert app.save_prefs({"mpv_interpolation": True})["mpv_motion"] == "always", "old switch on = always blend"
assert app.save_prefs({"mpv_motion": "off"})["mpv_motion"] == "off", "the new setting wins once it is saved"
app.save_prefs({"mpv_motion": "auto", "mpv_interpolation": False})

# ---- mpv options
o = mb.build_options(app.get_prefs())
assert next(iter(o)) == "profile" and o["profile"] == "high-quality", "the profile must come first so our options win over it"
assert o["deband"] == "yes" and o["interpolation"] == "no" and o["video-sync"] == "display-resample"
assert o["tone-mapping"] == "spline" and o["hdr-compute-peak"] == "yes"
assert mb.build_options(dict(p, mpv_hdr="natural"))["tone-mapping"] == "bt.2446a"
assert mb.build_options(dict(p, mpv_motion="always"))["interpolation"] == "yes"
o2 = mb.build_options(dict(p, mpv_hq=False))
assert "profile" not in o2 and "deband" not in o2
assert mb.build_options(dict(p, mpv_extra="tone-mapping=bt.2390"))["tone-mapping"] == "bt.2390", "advanced options still win"
safe = mb.safe_options(o)
assert "profile" not in safe and "hdr-contrast-recovery" not in safe

# ---- smooth motion "auto": only when the frames cannot be shown for equal times
auto = {"mpv_motion": "auto"}
assert mb.motion_wanted(auto, 25, 120) and mb.motion_wanted(auto, 50, 120)
assert not mb.motion_wanted(auto, 23.976, 120) and not mb.motion_wanted(auto, 24, 120) and not mb.motion_wanted(auto, 60, 120)
assert not mb.motion_wanted({"mpv_motion": "off"}, 25, 120) and mb.motion_wanted({"mpv_motion": "always"}, 24, 120)
assert not mb.motion_wanted(auto, 0, 120), "unknown frame rate: leave it alone"
assert mb.motion_wanted({"mpv_interpolation": True}, 24, 120), "old settings without mpv_motion"

# ---- refresh rate decisions (this monitor: 165 / 160 / 144 / 120 / 60, no 100)
offered = [165, 160, 144, 120, 60]
assert dm.pick_rate(23.976, 165, offered) == 120 and dm.pick_rate(24, 165, offered) == 120
assert dm.pick_rate(29.97, 165, offered) == 120 and dm.pick_rate(59.94, 165, offered) == 120
assert dm.pick_rate(24, 144, offered) == 144, "144 Hz already fits 24 fps: no switch"
assert dm.pick_rate(24, 120, offered) == 120 and dm.pick_rate(25, 120, offered) == 120, "already at 120: nothing to do"
assert dm.pick_rate(25, 165, offered) == 165, "nothing fits 25 fps here: stay (smooth motion covers it)"
assert dm.pick_rate(25, 165, offered + [100]) == 100, "a screen that offers 100 Hz gets it for 25 / 50 fps"
assert dm.pick_rate(0, 165, offered) == 165
assert dm.exact_hz(119) == 119.88 and dm.exact_hz(120) == 120

# ---- bit depth from mpv's pixel formats
assert mb.video_bits({"pixelformat": "yuv420p10"}) == 10 and mb.video_bits({"pixelformat": "yuv420p"}) == 8
assert mb.video_bits({"pixelformat": "d3d11", "hw-pixelformat": "p010"}) == 10 and mb.video_bits({"pixelformat": "nv12"}) == 8
assert mb.video_bits({}) == 0

# ---- the safety net: a marker left behind is only acted on for its own process, and always cleared at start-up
data = Path(app.DATA_DIR)
dm.write_marker(data, "", 165, 120)
mk = json.loads((data / dm.MARKER).read_text())
assert not dm.restore_from_marker(data, mk["pid"] + 1) and (data / dm.MARKER).exists(), "a newer player's marker is left alone"
dm.restore_from_marker(data)
assert not (data / dm.MARKER).exists(), "start-up clears a stale marker"

# ---- the Picture line: the native player's report is kept as plain numbers only
c = app.app.test_client()
assert c.post("/api/native/picture", json={"fps": 24}).status_code == 403, "CSRF header required"
r = c.post("/api/native/picture", headers=H, json={"fps": 23.976, "display_fps": 120, "sync": "display-resample", "interp": False,
                                                  "dropped": 2, "bits": 10, "hdr": "HDR10", "title": "secret film", "path": "C:/x.mkv",
                                                  "w": "junk", "speed_fix": float("nan")})
assert r.status_code == 200
pic = c.get("/api/picture").get_json()
now = pic["now"]
assert now and now["fps"] == 23.976 and now["dropped"] == 2 and now["hdr"] == "HDR10" and now["w"] == 0 and now["speed_fix"] == 0.0, now
assert "title" not in now and "path" not in now, "no title or path is ever kept"
assert "screen" in pic
app.NATIVE_PIC["playing"] = False
pic = c.get("/api/picture").get_json()
assert pic["now"] is None and pic["last"]["fps"] == 23.976, "after the player closed: shown as the last video"

# ---- the native player gets the new settings
vdir = media / "videos" / "Drama"
vdir.mkdir(parents=True, exist_ok=True)
(vdir / "Film (2020).mkv").write_bytes(b"x" * 64)
app.scan_videos()
vid = c.get("/api/videos").get_json()["loose"][0]["id"]
sess = c.get("/api/native/session/%s" % vid).get_json()
for k in ("mpv_hq", "mpv_refresh", "mpv_motion", "mpv_hdr"):
    assert k in sess["prefs"], k

print("test_picture: all good")
shutil.rmtree(tmp, ignore_errors=True)
