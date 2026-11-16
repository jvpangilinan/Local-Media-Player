"""ULTRON display helper (Windows): the monitor's refresh rate, the rates it offers, its bit depth, and a TEMPORARY refresh switch.

Why: a film is 23.976 / 24 frames a second. On a 144 / 165 Hz desktop those frames cannot be shown for equal times (judder);
at 120 Hz every frame is shown exactly 5 times. So while a film plays in the native player the screen can move to a rate that
fits the film, and goes back when the player closes.

The switch is made with CDS_FULLSCREEN: Windows treats it as temporary (it is never written to the registry, so a reboot or
logging out always brings back your own setting) and undoes it when the process that made it ends, also after a crash.
On top of that the player leaves a small marker file while the screen is switched; the app restores the saved mode from it
if the player process disappears without cleaning up (see restore_from_marker, called by app.py).

Nothing here imports Qt, mpv or Flask. Every function is best effort: on any error it returns None / False / {} and the
caller just keeps playing at the current rate.
"""
from __future__ import annotations

import ctypes
import json
import os
import time
from pathlib import Path

IS_WIN = os.name == "nt"
MARKER = "display-switch.json"
ENUM_CURRENT_SETTINGS = -1
CDS_FULLSCREEN, CDS_TEST = 0x4, 0x2
DISP_CHANGE_SUCCESSFUL = 0
DM_BITSPERPEL, DM_PELSWIDTH, DM_PELSHEIGHT, DM_DISPLAYFREQUENCY = 0x40000, 0x80000, 0x100000, 0x400000
MAX_SPEED_CHANGE = 0.01          # mpv's display-resample may play the video up to 1 % faster / slower (video-sync-max-video-change)


if IS_WIN:
    from ctypes import wintypes as wt

    class DEVMODEW(ctypes.Structure):
        _fields_ = [("dmDeviceName", wt.WCHAR * 32), ("dmSpecVersion", wt.WORD), ("dmDriverVersion", wt.WORD), ("dmSize", wt.WORD),
                    ("dmDriverExtra", wt.WORD), ("dmFields", wt.DWORD), ("dmPositionX", wt.LONG), ("dmPositionY", wt.LONG),
                    ("dmDisplayOrientation", wt.DWORD), ("dmDisplayFixedOutput", wt.DWORD), ("dmColor", ctypes.c_short),
                    ("dmDuplex", ctypes.c_short), ("dmYResolution", ctypes.c_short), ("dmTTOption", ctypes.c_short),
                    ("dmCollate", ctypes.c_short), ("dmFormName", wt.WCHAR * 32), ("dmLogPixels", wt.WORD), ("dmBitsPerPel", wt.DWORD),
                    ("dmPelsWidth", wt.DWORD), ("dmPelsHeight", wt.DWORD), ("dmDisplayFlags", wt.DWORD), ("dmDisplayFrequency", wt.DWORD),
                    ("dmICMMethod", wt.DWORD), ("dmICMIntent", wt.DWORD), ("dmMediaType", wt.DWORD), ("dmDitherType", wt.DWORD),
                    ("dmReserved1", wt.DWORD), ("dmReserved2", wt.DWORD), ("dmPanningWidth", wt.DWORD), ("dmPanningHeight", wt.DWORD)]

    class MONITORINFOEXW(ctypes.Structure):
        _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD), ("szDevice", wt.WCHAR * 32)]

    _u = ctypes.WinDLL("user32", use_last_error=True)
    _u.EnumDisplaySettingsExW.argtypes = [wt.LPCWSTR, wt.DWORD, ctypes.POINTER(DEVMODEW), wt.DWORD]
    _u.ChangeDisplaySettingsExW.argtypes = [wt.LPCWSTR, ctypes.POINTER(DEVMODEW), wt.HWND, wt.DWORD, wt.LPVOID]
    _u.ChangeDisplaySettingsExW.restype = wt.LONG
    _u.MonitorFromWindow.argtypes = [wt.HWND, wt.DWORD]
    _u.MonitorFromWindow.restype = wt.HMONITOR
    _u.GetMonitorInfoW.argtypes = [wt.HMONITOR, ctypes.POINTER(MONITORINFOEXW)]


def _devmode(dev, idx):
    dm = DEVMODEW()
    dm.dmSize = ctypes.sizeof(DEVMODEW)
    return dm if _u.EnumDisplaySettingsExW(dev, idx, ctypes.byref(dm), 0) else None


def monitor_device(hwnd=0):
    """GDI name of the monitor a window is on (\\\\.\\DISPLAY1). hwnd 0 = the primary monitor."""
    if not IS_WIN:
        return ""
    try:
        mon = _u.MonitorFromWindow(int(hwnd or 0), 2 if hwnd else 1)        # MONITOR_DEFAULTTONEAREST / _TOPRIMARY
        mi = MONITORINFOEXW()
        mi.cbSize = ctypes.sizeof(MONITORINFOEXW)
        if mon and _u.GetMonitorInfoW(mon, ctypes.byref(mi)):
            return mi.szDevice
    except Exception:
        pass
    return ""


def current(dev):
    """The mode the monitor runs right now: {w, h, hz, bpp}."""
    if not IS_WIN or not dev:
        return {}
    try:
        dm = _devmode(dev, ENUM_CURRENT_SETTINGS)
    except Exception:
        dm = None
    return {"w": dm.dmPelsWidth, "h": dm.dmPelsHeight, "hz": dm.dmDisplayFrequency, "bpp": dm.dmBitsPerPel} if dm else {}


def saved(dev):
    """Your own setting (the one in the registry, which a temporary switch never touches)."""
    if not IS_WIN or not dev:
        return {}
    try:
        dm = _devmode(dev, -2)                                                # ENUM_REGISTRY_SETTINGS
    except Exception:
        dm = None
    return {"w": dm.dmPelsWidth, "h": dm.dmPelsHeight, "hz": dm.dmDisplayFrequency, "bpp": dm.dmBitsPerPel} if dm else {}


def rates(dev):
    """Refresh rates the monitor offers at its current resolution, highest first."""
    cur = current(dev)
    if not cur:
        return []
    out, i = set(), 0
    try:
        while i < 2000:
            dm = _devmode(dev, i)
            if dm is None:
                break
            if (dm.dmPelsWidth, dm.dmPelsHeight, dm.dmBitsPerPel) == (cur["w"], cur["h"], cur["bpp"]) and dm.dmDisplayFrequency > 1:
                out.add(int(dm.dmDisplayFrequency))
            i += 1
    except Exception:
        pass
    return sorted(out, reverse=True)


def exact_hz(hz):
    """Windows lists 119.88 Hz as 119 and 59.94 Hz as 59: give the real number."""
    hz = float(hz or 0)
    return round((hz + 1) * 1000.0 / 1001.0, 3) if int(hz) in (23, 29, 47, 59, 71, 95, 119, 143, 239) else hz


def precise_hz(dev):
    """The refresh rate as a fraction-exact number when Windows can tell (the desktop compositor's clock), else the listed rate."""
    hz = exact_hz(current(dev).get("hz") or 0)
    if not IS_WIN or hz <= 0:
        return hz
    try:
        buf = (ctypes.c_ubyte * 292)()                                        # DWM_TIMING_INFO (packed); only the first fields are read
        ctypes.c_uint32.from_buffer(buf, 0).value = 292
        if ctypes.windll.dwmapi.DwmGetCompositionTimingInfo(None, ctypes.byref(buf)) == 0:
            num, den = ctypes.c_uint32.from_buffer(buf, 4).value, ctypes.c_uint32.from_buffer(buf, 8).value
            if num and den and abs(num / den - hz) < 0.6:                    # same monitor (the compositor follows the primary one)
                return round(num / den, 4)
    except Exception:
        pass
    return hz


def fits(fps, hz):
    """True when every frame can be shown for the same whole number of refreshes (allowing mpv's 1 % speed nudge)."""
    try:
        fps, hz = float(fps), float(hz)
    except (TypeError, ValueError):
        return False
    if fps <= 1 or hz <= 1:
        return False
    n = max(1, round(hz / fps))
    return abs(hz / n - fps) / fps <= MAX_SPEED_CHANGE


def pick_rate(fps, now_hz, offered, prefer=120):
    """Best refresh rate for a video: keep the current one if it already fits, else `prefer` (120 Hz: 24, 30 and 60 fps all
    fit), else the highest offered rate that fits (100 Hz for 25 / 50 fps), else stay put (smooth motion covers it)."""
    if not fps or fits(fps, exact_hz(now_hz)):
        return int(now_hz)
    if prefer in offered and fits(fps, prefer):
        return prefer
    good = [r for r in offered if r >= 48 and fits(fps, exact_hz(r))]
    return max(good) if good else int(now_hz)


def switch(dev, hz):
    """Temporarily run the monitor at `hz` (same resolution). True when the screen now runs at that rate."""
    if not IS_WIN or not dev:
        return False
    try:
        dm = _devmode(dev, ENUM_CURRENT_SETTINGS)
        if dm is None:
            return False
        if int(dm.dmDisplayFrequency) == int(hz):
            return True
        dm.dmDisplayFrequency = int(hz)
        dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_BITSPERPEL | DM_DISPLAYFREQUENCY
        if _u.ChangeDisplaySettingsExW(dev, ctypes.byref(dm), None, CDS_TEST, None) != DISP_CHANGE_SUCCESSFUL:
            return False
        return _u.ChangeDisplaySettingsExW(dev, ctypes.byref(dm), None, CDS_FULLSCREEN, None) == DISP_CHANGE_SUCCESSFUL
    except Exception:
        return False


def restore(dev):
    """Back to your own setting (the registry mode). Does nothing when the screen already runs at it."""
    if not IS_WIN or not dev:
        return False
    try:
        if current(dev).get("hz") == saved(dev).get("hz"):
            return True
        return _u.ChangeDisplaySettingsExW(dev, None, None, 0, None) == DISP_CHANGE_SUCCESSFUL
    except Exception:
        return False


# ---- the safety net: a marker file while the screen is switched
def write_marker(folder, dev, frm, to):
    try:
        Path(folder).mkdir(parents=True, exist_ok=True)
        (Path(folder) / MARKER).write_text(json.dumps({"device": dev, "from": frm, "to": to, "pid": os.getpid(), "t": time.time()}), encoding="utf-8")
    except OSError:
        pass


def clear_marker(folder):
    try:
        (Path(folder) / MARKER).unlink()
    except OSError:
        pass


def restore_from_marker(folder, pid=None):
    """Called by the app after the player process ended (pid = that process) and at start-up (pid None).
    If a switched screen was left behind, put your own refresh rate back. Returns True when it restored something."""
    f = Path(folder) / MARKER
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if pid is not None and int(d.get("pid") or 0) != int(pid):
        return False                                                          # it belongs to a newer player that is still running
    done = False
    dev = str(d.get("device") or "")
    if dev and current(dev).get("hz") != saved(dev).get("hz"):
        done = restore(dev)
    clear_marker(folder)
    return done


# ---- bit depth (DXGI): what the cable to the monitor actually carries
def _vt(obj, idx, restype, *argtypes):
    fn = ctypes.cast(ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0][idx], ctypes.c_void_p).value
    return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(fn)


class _GUID(ctypes.Structure):
    _fields_ = [("a", ctypes.c_uint32), ("b", ctypes.c_uint16), ("c", ctypes.c_uint16), ("d", ctypes.c_ubyte * 8)]


def _guid(s):
    import uuid
    u = uuid.UUID(s)
    g = _GUID()
    ctypes.memmove(ctypes.byref(g), u.bytes_le, 16)
    return g


def outputs():
    """Each monitor as DXGI sees it: {device, bits, hdr, max_nits}. bits = bits per colour on the wire (8 / 10 / 12);
    hdr = Windows HDR is on for that screen."""
    if not IS_WIN:
        return []
    res = []
    try:
        dxgi = ctypes.WinDLL("dxgi")
        fac = ctypes.c_void_p()
        if dxgi.CreateDXGIFactory1(ctypes.byref(_guid("770aae78-f26f-4dba-a829-253c83d1b387")), ctypes.byref(fac)) != 0:
            return []
        iid6 = _guid("068346e8-aaec-4b84-add7-137f513f77a1")                  # IDXGIOutput6
        try:
            a = 0
            while a < 8:
                ad = ctypes.c_void_p()
                if _vt(fac, 12, ctypes.c_long, ctypes.c_uint, ctypes.c_void_p)(fac, a, ctypes.byref(ad)) != 0:   # EnumAdapters1
                    break
                o = 0
                while o < 8:
                    out = ctypes.c_void_p()
                    if _vt(ad, 7, ctypes.c_long, ctypes.c_uint, ctypes.c_void_p)(ad, o, ctypes.byref(out)) != 0:  # EnumOutputs
                        break
                    o6 = ctypes.c_void_p()
                    if _vt(out, 0, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)(out, ctypes.byref(iid6), ctypes.byref(o6)) == 0:
                        desc = (ctypes.c_ubyte * 256)()                       # DXGI_OUTPUT_DESC1 (228 bytes on x64)
                        if _vt(o6, 27, ctypes.c_long, ctypes.c_void_p)(o6, ctypes.byref(desc)) == 0:   # GetDesc1
                            name = ctypes.wstring_at(ctypes.addressof(desc))       # stops at the first NUL
                            bits = ctypes.c_uint32.from_buffer(desc, 96).value
                            space = ctypes.c_uint32.from_buffer(desc, 100).value
                            nits = ctypes.c_float.from_buffer(desc, 140).value
                            res.append({"device": name, "bits": int(bits), "hdr": space == 12, "max_nits": round(nits)})
                        _vt(o6, 2, ctypes.c_ulong)(o6)                       # Release
                    _vt(out, 2, ctypes.c_ulong)(out)
                    o += 1
                _vt(ad, 2, ctypes.c_ulong)(ad)
                a += 1
        finally:
            _vt(fac, 2, ctypes.c_ulong)(fac)
    except Exception:
        return res
    return res


def info(hwnd=0):
    """Everything Settings shows about the screen a window is on."""
    dev = monitor_device(hwnd)
    cur = current(dev)
    if not cur:
        return {}
    out = dict(cur, device=dev, hz_exact=precise_hz(dev), saved_hz=saved(dev).get("hz"), rates=rates(dev))
    for o in outputs():
        if o["device"] == dev:
            out.update(bits=o["bits"], hdr=o["hdr"], max_nits=o["max_nits"])
            break
    return out


if __name__ == "__main__":                                                    # quick look: py -3.12 display_mode.py
    print(json.dumps(info(), indent=1))
