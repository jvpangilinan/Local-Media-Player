"""
ULTRON auto subtitles - 100% local.

    speech -> text    faster-whisper  (OpenAI Whisper, CTranslate2 engine, int8 on the CPU)
    text   -> text    NLLB-200        (Meta, 200 languages, CTranslate2 engine, int8 on the CPU)

Nothing here talks to the internet except download(), which fetches the model files once into
<app folder>\\models. After that the whole pipeline works offline.

This module only uses the standard library at import time, so ULTRON still starts if the AI
packages are missing; status() then explains what is missing.
"""
import gc
import hashlib
import json
import math
import os
import re
import subprocess
import textwrap
import threading
import time
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")            # numpy / opencv / ctranslate2 may each ship an OpenMP runtime
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

NO_WINDOW = 0x08000000 if os.name == "nt" else 0


class Cancelled(Exception):
    pass


# ----------------------------------------------------------------------------- languages
# (code, name, NLLB-200 code). The code is what Whisper reports for the spoken language.
LANGS = [
    ("en", "English", "eng_Latn"), ("es", "Spanish", "spa_Latn"), ("fr", "French", "fra_Latn"),
    ("de", "German", "deu_Latn"), ("it", "Italian", "ita_Latn"), ("pt", "Portuguese", "por_Latn"),
    ("nl", "Dutch", "nld_Latn"), ("ru", "Russian", "rus_Cyrl"), ("uk", "Ukrainian", "ukr_Cyrl"),
    ("pl", "Polish", "pol_Latn"), ("cs", "Czech", "ces_Latn"), ("sk", "Slovak", "slk_Latn"),
    ("hu", "Hungarian", "hun_Latn"), ("ro", "Romanian", "ron_Latn"), ("bg", "Bulgarian", "bul_Cyrl"),
    ("el", "Greek", "ell_Grek"), ("tr", "Turkish", "tur_Latn"), ("ar", "Arabic", "arb_Arab"),
    ("he", "Hebrew", "heb_Hebr"), ("fa", "Persian", "pes_Arab"), ("hi", "Hindi", "hin_Deva"),
    ("bn", "Bengali", "ben_Beng"), ("ur", "Urdu", "urd_Arab"), ("ta", "Tamil", "tam_Taml"),
    ("te", "Telugu", "tel_Telu"), ("mr", "Marathi", "mar_Deva"), ("gu", "Gujarati", "guj_Gujr"),
    ("kn", "Kannada", "kan_Knda"), ("ml", "Malayalam", "mal_Mlym"), ("pa", "Punjabi", "pan_Guru"),
    ("ne", "Nepali", "npi_Deva"), ("si", "Sinhala", "sin_Sinh"), ("th", "Thai", "tha_Thai"),
    ("vi", "Vietnamese", "vie_Latn"), ("id", "Indonesian", "ind_Latn"), ("ms", "Malay", "zsm_Latn"),
    ("tl", "Filipino (Tagalog)", "tgl_Latn"), ("zh", "Chinese (Simplified)", "zho_Hans"),
    ("zh-TW", "Chinese (Traditional)", "zho_Hant"), ("ja", "Japanese", "jpn_Jpan"), ("ko", "Korean", "kor_Hang"),
    ("sv", "Swedish", "swe_Latn"), ("no", "Norwegian", "nob_Latn"), ("da", "Danish", "dan_Latn"),
    ("fi", "Finnish", "fin_Latn"), ("is", "Icelandic", "isl_Latn"), ("ca", "Catalan", "cat_Latn"),
    ("hr", "Croatian", "hrv_Latn"), ("sr", "Serbian", "srp_Cyrl"), ("sl", "Slovenian", "slv_Latn"),
    ("lt", "Lithuanian", "lit_Latn"), ("lv", "Latvian", "lvs_Latn"), ("et", "Estonian", "est_Latn"),
    ("sw", "Swahili", "swh_Latn"), ("af", "Afrikaans", "afr_Latn"), ("ceb", "Cebuano", "ceb_Latn"),
    ("am", "Amharic", "amh_Ethi"), ("kk", "Kazakh", "kaz_Cyrl"), ("uz", "Uzbek", "uzn_Latn"),
    ("az", "Azerbaijani", "azj_Latn"), ("ka", "Georgian", "kat_Geor"), ("hy", "Armenian", "hye_Armn"),
    ("mn", "Mongolian", "khk_Cyrl"), ("my", "Burmese", "mya_Mymr"), ("km", "Khmer", "khm_Khmr"),
    ("lo", "Lao", "lao_Laoo"), ("cy", "Welsh", "cym_Latn"), ("ga", "Irish", "gle_Latn"),
    ("eu", "Basque", "eus_Latn"), ("gl", "Galician", "glg_Latn"), ("sq", "Albanian", "als_Latn"),
    ("mk", "Macedonian", "mkd_Cyrl"), ("bs", "Bosnian", "bos_Latn"), ("be", "Belarusian", "bel_Cyrl"),
    ("yo", "Yoruba", "yor_Latn"), ("zu", "Zulu", "zul_Latn"), ("so", "Somali", "som_Latn"),
    ("ha", "Hausa", "hau_Latn"), ("mt", "Maltese", "mlt_Latn"), ("lb", "Luxembourgish", "ltz_Latn"),
]
BY_CODE = {c: (n, k) for c, n, k in LANGS}
NLLB_OF = {c: k for c, _, k in LANGS}
NLLB_OF["nn"] = "nno_Latn"                                  # Whisper can report Nynorsk separately
WHISPER_CODE = {c: ("zh" if c == "zh-TW" else c) for c, _, _ in LANGS}   # what to tell Whisper when the spoken language is forced


def lang_name(code):
    return BY_CODE.get(code, (code, ""))[0]


# ----------------------------------------------------------------------------- model files
WHISPER = {
    "accurate": {"dir": "whisper-large-v3-turbo", "repos": ["deepdml/faster-whisper-large-v3-turbo-ct2"], "mb": 1620,
                 "title": "Whisper large-v3-turbo (accurate)"},
    "fast": {"dir": "whisper-small", "repos": ["Systran/faster-whisper-small"], "mb": 490,
             "title": "Whisper small (fast)"},
}
NLLB = {"dir": "nllb-600m", "repos": ["JustFrederik/nllb-200-distilled-600M-ct2-int8"], "mb": 650,
        "spm_repo": "facebook/nllb-200-distilled-600M", "spm_file": "sentencepiece.bpe.model",
        "title": "NLLB-200 translator"}
NLLB_DIRS = ("nllb-1.3b", "nllb-600m")                      # the first one found wins (put a 1.3B conversion in nllb-1.3b for better quality)
SPM_NAMES = ("sentencepiece.bpe.model", "sentencepiece.model", "flores200_sacrebleu_tokenizer_spm.model")


def _has_ct2(d):
    return d.is_dir() and (d / "model.bin").is_file() and (d / "config.json").is_file()


def find_whisper(models_dir, mode):
    d = Path(models_dir) / WHISPER[mode]["dir"]
    return d if _has_ct2(d) and ((d / "tokenizer.json").is_file() or any(d.glob("vocabulary.*"))) else None


def _has_vocab(d):
    """CTranslate2 needs the vocabulary file(s) next to model.bin ("cannot load the target vocabulary" = they are missing)."""
    return any((d / n).is_file() for n in ("shared_vocabulary.txt", "shared_vocabulary.json", "target_vocabulary.txt", "target_vocabulary.json"))


def find_spm(d):
    for n in SPM_NAMES:
        if (d / n).is_file():
            return d / n
    return None


def find_nllb(models_dir):
    base = Path(models_dir)
    names = list(NLLB_DIRS)
    try:
        names += sorted(p.name for p in base.iterdir() if p.is_dir() and p.name.lower().startswith("nllb") and p.name not in names)
    except OSError:
        pass
    for n in names:
        d = base / n
        if _has_ct2(d) and find_spm(d) and _has_vocab(d):
            return d
    return None


def packages():
    """Imports the AI packages for real (that is the only honest test, also inside the .exe)."""
    out = {"ok": True, "missing": [], "error": ""}
    for mod, pipname in (("ctranslate2", "ctranslate2"), ("faster_whisper", "faster-whisper"),
                         ("sentencepiece", "sentencepiece"), ("huggingface_hub", "huggingface_hub")):
        try:
            __import__(mod)
        except Exception as e:
            out["ok"] = False
            out["missing"].append(pipname)
            out["error"] = out["error"] or ("%s: %s" % (mod, str(e)[:160]))
    return out


def status(models_dir):
    pk = packages()
    w = {m: bool(find_whisper(models_dir, m)) for m in WHISPER}
    n = bool(find_nllb(models_dir))
    return {"packages": pk, "whisper": w, "nllb": n, "models_dir": str(models_dir),
            "ready": bool(pk["ok"] and n and any(w.values())),
            "can_transcribe": bool(pk["ok"] and any(w.values())),
            "langs": [{"code": c, "name": nm} for c, nm, _ in LANGS]}


# ----------------------------------------------------------------------------- download (the only online part)
def _want(name):
    low = name.lower()
    if "vocabulary" in low:                                   # shared_vocabulary.txt / vocabulary.txt: the model cannot load without them
        return True
    return not (low.startswith(".") or low.endswith(".md") or low == ".gitattributes" or low.endswith(".txt"))


def _dir_bytes(d):
    total = 0
    try:
        for p in Path(d).rglob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                pass
    except OSError:
        pass
    return total


def _fetch(repos, dest, report_frac, need=("model.bin",)):
    """Download a repo into dest. Tries each repo in turn. report_frac(0..1) is called while it runs."""
    from huggingface_hub import HfApi, hf_hub_download
    last = None
    for repo in repos:
        try:
            info = HfApi().model_info(repo, files_metadata=True)
            files = [(s.rfilename, s.size or 0) for s in info.siblings if _want(s.rfilename)]
            if not all(any(n == f for f, _ in files) for n in need):
                raise RuntimeError("%s does not contain %s" % (repo, ", ".join(need)))
            total = sum(sz for _, sz in files) or 1
            dest.mkdir(parents=True, exist_ok=True)
            base = _dir_bytes(dest)
            stop = threading.Event()

            def watch():
                while not stop.wait(0.6):
                    report_frac(min(0.99, max(0.0, (_dir_bytes(dest) - base) / total)))
            t = threading.Thread(target=watch, daemon=True)
            t.start()
            try:
                for name, _ in files:
                    hf_hub_download(repo_id=repo, filename=name, local_dir=str(dest))
            finally:
                stop.set()
            report_frac(1.0)
            return
        except Exception as e:
            last = e
    raise RuntimeError("Could not download %s (%s). Check your internet connection and try again." % (
        " / ".join(repos), str(last)[:160] if last else "unknown error"))


def download(models_dir, keys, report):
    """keys: any of 'accurate', 'fast', 'nllb'. Skips what is already installed. report(pct, msg)."""
    models_dir = Path(models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)
    plan = []
    for k in keys:
        if k in WHISPER and not find_whisper(models_dir, k):
            plan.append((k, WHISPER[k]["title"], WHISPER[k]["mb"]))
        elif k == "nllb" and not find_nllb(models_dir):
            plan.append((k, NLLB["title"], NLLB["mb"]))
    if not plan:
        report(100, "Everything is already installed")
        return
    total = sum(mb for _, _, mb in plan)
    done = 0
    for k, title, mb in plan:
        def frac(f, _t=title, _mb=mb, _d=done):
            report(int((_d + _mb * f) / total * 100), "Downloading %s (about %d MB)..." % (_t, _mb))
        if k in WHISPER:
            _fetch(WHISPER[k]["repos"], models_dir / WHISPER[k]["dir"], frac)
        else:
            d = models_dir / NLLB["dir"]
            _fetch(NLLB["repos"], d, frac)
            if not find_spm(d):
                from huggingface_hub import hf_hub_download
                hf_hub_download(repo_id=NLLB["spm_repo"], filename=NLLB["spm_file"], local_dir=str(d))
        done += mb
    report(100, "Done")


# ----------------------------------------------------------------------------- engines (loaded on demand, freed when idle)
_LOCK = threading.RLock()
_W = {"path": None, "model": None, "mode": None}
_T = {"path": None, "tr": None, "sp": None}


def _threads():
    try:
        env = int(os.environ.get("ULTRON_ASUB_THREADS", "0"))
    except ValueError:
        env = 0
    if env > 0:
        return env
    n = os.cpu_count() or 8
    return max(4, min(16, n // 2 + 2))        # leaves the rest of the CPU for playback and the UI


def _whisper(models_dir, mode):
    order = [mode] + [m for m in WHISPER if m != mode]
    for m in order:
        p = find_whisper(models_dir, m)
        if not p:
            continue
        with _LOCK:
            if _W["model"] is not None and _W["path"] == str(p):
                return _W["model"], m
            _W.update(model=None, path=None)
            gc.collect()
            from faster_whisper import WhisperModel
            model = WhisperModel(str(p), device="cpu", compute_type="int8", cpu_threads=_threads(),
                                 num_workers=1, local_files_only=True)
            _W.update(model=model, path=str(p), mode=m)
            return model, m
    raise RuntimeError("No speech model is installed. Download one in Settings > Subtitles.")


def _nllb(models_dir):
    p = find_nllb(models_dir)
    if not p:
        raise RuntimeError("The translation model is not installed. Download it in Settings > Subtitles.")
    with _LOCK:
        if _T["tr"] is not None and _T["path"] == str(p):
            return _T["tr"], _T["sp"]
        _T.update(tr=None, sp=None, path=None)
        gc.collect()
        import ctranslate2
        import sentencepiece as spm
        tr = ctranslate2.Translator(str(p), device="cpu", compute_type="int8", inter_threads=1, intra_threads=_threads())
        sp = spm.SentencePieceProcessor()
        sp.Load(str(find_spm(p)))
        _T.update(tr=tr, sp=sp, path=str(p))
        return tr, sp


def unload():
    with _LOCK:
        _W.update(model=None, path=None, mode=None)
        _T.update(tr=None, sp=None, path=None)
    gc.collect()


# ----------------------------------------------------------------------------- helpers
def video_key(path):
    st = os.stat(path)
    return hashlib.sha1(("%s|%d|%d" % (path, st.st_size, int(st.st_mtime))).encode("utf-8", "replace")).hexdigest()[:16]


def _clock(sec):
    sec = max(0, int(sec))
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    return "%d:%02d:%02d" % (h, m, s) if h else "%d:%02d" % (m, s)


def _vtt_time(t):
    t = max(0.0, t)
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d.%03d" % (h, m, s, ms)


def _cjk(text):
    n = sum(1 for ch in text if "\u3040" <= ch <= "\u30ff" or "\u3400" <= ch <= "\u9fff" or "\uac00" <= ch <= "\ud7af" or "\u0e00" <= ch <= "\u0e7f")
    return n > len(text) * 0.3


def _wrap(text, width=42):
    text = " ".join(text.split())
    if _cjk(text):
        width = 20
    if len(text) <= width:
        return text
    n = int(math.ceil(len(text) / float(width)))
    if " " in text and not _cjk(text):
        return "\n".join(textwrap.wrap(text, int(math.ceil(len(text) / float(n))) + 3, break_long_words=False))
    step = int(math.ceil(len(text) / float(n)))
    return "\n".join(text[i:i + step] for i in range(0, len(text), step))


def _esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace("-->", "- >")


def write_vtt(path, segs):
    lines = ["WEBVTT", ""]
    for i, (s, e, t) in enumerate(segs, 1):
        t = _wrap(t)
        if not t.strip():
            continue
        lines += [str(i), "%s --> %s" % (_vtt_time(s), _vtt_time(e)), _esc(t), ""]
    tmp = Path(str(path) + ".part")
    tmp.write_text("\n".join(lines), encoding="utf-8")
    os.replace(tmp, path)


def _clean(segs, st=None):
    """Drops empty cues and the endless repeats Whisper sometimes produces over music or silence.
    st carries the repeat counter from one chunk to the next (pass the same dict every time)."""
    st = st if st is not None else {"last": "", "run": 0}
    out, last, run = [], st["last"], st["run"]
    for s, e, t in segs:
        t = " ".join(t.split())
        if not t:
            continue
        key = re.sub(r"\W+", "", t.lower())
        if key and key == last:
            run += 1
            if run >= 2:
                continue
        else:
            last, run = key, 0
        out.append((s, e, t))
    st["last"], st["run"] = last, run
    return out


def _split_long(segs):
    """Long Whisper segments become several short cues (timed in proportion to their text)."""
    out = []
    for s, e, t in segs:
        limit = 40 if _cjk(t) else 84
        if len(t) <= limit:
            out.append((s, e, t))
            continue
        parts = [p for p in re.split(r"(?<=[.!?\u3002\uff01\uff1f\u2026])\s*", t) if p.strip()]
        chunks, cur = [], ""
        for p in parts:
            if cur and len(cur) + 1 + len(p) > limit:
                chunks.append(cur)
                cur = p
            else:
                cur = (cur + " " + p).strip()
        if cur:
            chunks.append(cur)
        fixed = []
        for c in chunks:                                    # one sentence that is still too long: cut at the comma / space nearest the middle
            while len(c) > limit * 1.3:
                mid = len(c) // 2
                cuts = [m.end() for m in re.finditer(r"[,;:\u3001\uff0c]\s*|\s+", c)]
                if not cuts:
                    break
                cut = min(cuts, key=lambda x: abs(x - mid))
                if cut <= 0 or cut >= len(c):
                    break
                fixed.append(c[:cut].strip())
                c = c[cut:].strip()
            fixed.append(c)
        total = sum(len(c) for c in fixed) or 1
        t0, span = s, max(0.2, e - s)
        for c in fixed:
            d = span * len(c) / total
            out.append((t0, t0 + d, c))
            t0 += d
    fixed = []
    for i, (s, e, t) in enumerate(out):                     # readable on screen: at least 0.9 s, never into the next cue
        nxt = out[i + 1][0] if i + 1 < len(out) else None
        if e - s < 0.9:
            e = s + 0.9
        if nxt is not None and e > nxt - 0.02:
            e = max(s + 0.3, nxt - 0.02)
        fixed.append((s, e, t))
    return fixed


# ----------------------------------------------------------------------------- pipeline
def extract_audio(ffmpeg, video, wav, cancelled):
    cmd = [str(ffmpeg), "-y", "-nostdin", "-v", "error", "-i", str(video), "-map", "0:a:0?", "-vn", "-sn", "-dn",
           "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)]
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
    while p.poll() is None:
        if cancelled():
            p.kill()
            p.wait()
            raise Cancelled()
        time.sleep(0.25)
    err = (p.stderr.read() or b"").decode("utf-8", "replace").strip()
    if p.returncode != 0:
        raise RuntimeError("ffmpeg could not read the audio: " + (err.splitlines()[-1][:200] if err else "unknown error"))
    if not Path(wav).is_file() or Path(wav).stat().st_size < 4000:
        raise RuntimeError("This video has no audio track to transcribe.")


def _load_wav(wav):
    """Reads the 16 kHz mono WAV that ffmpeg just made straight into a float32 array.
    faster-whisper would otherwise decode the file again through PyAV (av.open(..., metadata_errors=...)), which crashes with
    "open() got an unexpected keyword argument 'metadata_errors'" when the installed PyAV is older than faster-whisper expects.
    Returns None if the file is not a plain 16-bit PCM WAV (then the old path is used)."""
    try:
        import numpy as np
        size = os.path.getsize(wav)
        with open(wav, "rb") as f:
            head = f.read(12)
            if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
                return None
            bits = ch = 0
            while True:
                ck = f.read(8)
                if len(ck) < 8:
                    return None
                cid, csz = ck[:4], int.from_bytes(ck[4:], "little")
                if cid == b"fmt ":
                    fmt = f.read(csz + (csz & 1))
                    ch, bits = int.from_bytes(fmt[2:4], "little"), int.from_bytes(fmt[14:16], "little")
                elif cid == b"data":
                    left = size - f.tell()
                    if csz == 0 or csz > left:                    # streamed / unfinished header: take the rest of the file
                        csz = left
                    if bits != 16 or ch < 1:
                        return None
                    n = (csz // (2 * ch)) * ch
                    a = np.fromfile(f, dtype="<i2", count=n)
                    if ch > 1:
                        a = a.reshape(-1, ch).mean(axis=1)
                    return (a.astype(np.float32) / 32768.0)
                else:
                    f.seek(csz + (csz & 1), 1)
    except Exception:
        return None


FIRST_CHUNK_SEC = 300      # the first piece is shorter so the first subtitles show up sooner
CHUNK_SEC = 600            # after that: every 10 minutes of the video are transcribed, translated and handed to the player


def _stream(models_dir, wav, mode, source, target, report, cancelled, publish):
    """Transcribes the video and, every CHUNK_SEC of video, translates what is new and publishes the subtitles made so far,
    so the viewer can watch while the rest is still being worked on. Returns (transcript dict, last meta)."""
    model, used = _whisper(models_dir, mode)
    fast = used == "fast" or mode == "fast"
    report(4, "Loading the speech model...")
    audio = _load_wav(wav)
    seg_iter, info = model.transcribe(
        audio if audio is not None else str(wav), language=WHISPER_CODE.get(source) if source else None, task="transcribe",
        beam_size=1 if used == "fast" else 3, temperature=(0.0, 0.2, 0.4), condition_on_previous_text=False,
        vad_filter=True, vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200})
    dur = float(info.duration or 0) or 1.0
    detected = info.language or "en"
    final = detected if target == "orig" else target
    need_tr = final != detected
    if need_tr and not NLLB_OF.get(detected):
        raise RuntimeError("The translator does not support the spoken language (%s). Pick \"Original language\" instead." % detected)
    st = {"last": "", "run": 0}
    raw, kept, result = [], [], []
    state = {"ready": 0.0, "meta": None, "pct": 4.0}

    def rep(pct, msg):
        state["pct"] = pct
        report(pct, ("Subtitles ready to %s - " % _clock(state["ready"]) if state["ready"] else "") + msg)

    def flush(upto, last):
        cleaned = _clean(raw, st)
        del raw[:]
        if cleaned:
            kept.extend(cleaned)
            piece = _split_long(cleaned)
            if need_tr:
                piece = _translate(models_dir, piece, detected, final, fast, state["pct"], state["pct"], rep, cancelled)
            result.extend(piece)
        if result:
            state["meta"] = publish(result, upto, detected, final, used, not last)
            state["ready"] = upto

    edge, t0 = float(FIRST_CHUNK_SEC), time.time()
    for seg in seg_iter:
        if cancelled():
            raise Cancelled()
        text = (seg.text or "").strip()
        if text and not (getattr(seg, "no_speech_prob", 0) > 0.85 and getattr(seg, "avg_logprob", 0) < -1.0):
            raw.append((float(seg.start), float(seg.end), text))
        end = float(seg.end)
        el = max(0.001, time.time() - t0)
        speed = end / el
        eta = (dur - end) / speed if speed > 0 else 0
        rep(4 + 93 * min(1.0, end / dur), "Transcribing %s / %s  (%.1fx real time, about %s left)" % (_clock(end), _clock(dur), speed, _clock(eta)))
        if end >= edge:
            flush(end, False)
            while end >= edge:
                edge += CHUNK_SEC
    flush(dur, True)
    return {"lang": detected, "duration": dur, "mode": used, "segments": [list(x) for x in kept]}, state["meta"]


def _pieces(segs, first=FIRST_CHUNK_SEC, step=CHUNK_SEC):
    """Cuts a finished transcript into time slices (used when only a translation is needed)."""
    out, cur, edge = [], [], float(first)
    for x in segs:
        if cur and x[0] >= edge:
            out.append(cur)
            cur = []
            while x[0] >= edge:
                edge += step
        cur.append(x)
    if cur:
        out.append(cur)
    return out


def _translate(models_dir, segs, src_code, tgt_code, fast, lo, hi, report, cancelled):
    src, tgt = NLLB_OF.get(src_code), NLLB_OF.get(tgt_code)
    if not src:
        raise RuntimeError("The translator does not support the spoken language (%s). Pick \"Original language\" instead." % src_code)
    if not tgt:
        raise RuntimeError("Unknown target language: %s" % tgt_code)
    report(lo, "Loading the translation model...")
    tr, sp = _nllb(models_dir)
    texts = [t for _, _, t in segs]
    out = [None] * len(texts)
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))      # similar lengths together = faster batches
    BATCH = 16
    for b in range(0, len(order), BATCH):
        if cancelled():
            raise Cancelled()
        idx = [i for i in order[b:b + BATCH]]
        todo = [i for i in idx if re.search(r"\w", texts[i])]
        for i in idx:
            if i not in todo:
                out[i] = texts[i]                                     # music notes, "..." and so on stay as they are
        if todo:
            toks = [[src] + sp.encode(texts[i], out_type=str)[:200] + ["</s>"] for i in todo]
            res = tr.translate_batch(toks, target_prefix=[[tgt]] * len(toks), beam_size=2 if fast else 4,
                                     max_decoding_length=int(max(len(t) for t in toks) * 2.5 + 10), max_batch_size=BATCH)
            for i, r in zip(todo, res):
                hyp = list(r.hypotheses[0])
                if hyp and hyp[0] == tgt:
                    hyp = hyp[1:]
                if hyp and hyp[-1] == "</s>":
                    hyp = hyp[:-1]
                try:
                    out[i] = sp.decode(hyp).strip() or texts[i]
                except Exception:
                    out[i] = sp.decode_pieces(hyp).strip() or texts[i]
        report(lo + (hi - lo) * min(1.0, (b + BATCH) / float(len(order))), "Translating to %s (%d / %d lines)" % (
            lang_name(tgt_code), min(len(order), b + BATCH), len(order)))
    return [(s, e, out[i]) for i, (s, e, _) in enumerate(segs)]


def generate(video, ffmpeg, key, out_dir, models_dir, tmp_dir, target, mode, source, force, report, cancelled):
    """Makes <out_dir>/<key>.<target>.vtt (+ .json with the label). target is a language code or 'orig'. Returns the meta dict.
    The .vtt is written again after every chunk (meta 'partial' = true until the end), so the player can show it while it grows."""
    out_dir, tmp_dir = Path(out_dir), Path(tmp_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    cache = out_dir / ("%s.transcript.json" % key)
    tr = None
    if cache.is_file() and not force:
        try:
            tr = json.loads(cache.read_text(encoding="utf-8"))
            if source and tr.get("lang") != WHISPER_CODE.get(source, source):
                tr = None
        except (OSError, ValueError):
            tr = None
    stamp = [0]

    def publish(result, upto, detected, final, used, partial):
        write_vtt(out_dir / ("%s.%s.vtt" % (key, target)), result)
        stamp[0] = max(stamp[0] + 1, int(time.time()))              # the page reloads the track when this number changes
        label = "%s (AI)" % lang_name(final) + (" - first %s" % _clock(upto) if partial else "")
        meta = {"target": target, "lang": final, "label": label, "source": detected, "mode": used,
                "created": stamp[0], "partial": bool(partial), "upto": int(upto)}
        mp = out_dir / ("%s.%s.json" % (key, target))
        tmp = Path(str(mp) + ".part")
        tmp.write_text(json.dumps(meta), encoding="utf-8")
        os.replace(tmp, mp)
        return meta

    if tr is None:
        wav = tmp_dir / ("%s.wav" % key)
        try:
            report(1, "Extracting the audio...")
            extract_audio(ffmpeg, video, wav, cancelled)
            tr, meta = _stream(models_dir, wav, mode, source, target, report, cancelled, publish)
        finally:
            try:
                wav.unlink()
            except OSError:
                pass
        if not tr["segments"] or meta is None:
            raise RuntimeError("No speech was found in this video.")
        tmp = Path(str(cache) + ".part")
        tmp.write_text(json.dumps(tr, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, cache)
        report(100, "Done")
        return meta
    # the speech was recognised before (another language, or a redo): only the translation is left, again piece by piece
    detected = tr.get("lang") or "en"
    final = detected if target == "orig" else target
    segs = [tuple(x) for x in tr["segments"]]
    used = tr.get("mode", mode)
    if final == detected:
        meta = publish(_split_long(segs), segs[-1][1] if segs else 0, detected, final, used, False)
    else:
        fast = used == "fast" or mode == "fast"
        parts = _pieces(segs)
        result, meta = [], None
        for n, part in enumerate(parts):
            if cancelled():
                raise Cancelled()
            lo = 5 + 92.0 * n / len(parts)
            result.extend(_translate(models_dir, _split_long(part), detected, final, fast, lo, lo + 92.0 / len(parts), report, cancelled))
            meta = publish(result, part[-1][1], detected, final, used, n < len(parts) - 1)
    report(100, "Done")
    return meta


def list_tracks(out_dir, key):
    out = []
    try:
        for p in sorted(Path(out_dir).glob("%s.*.json" % key)):
            if p.name.endswith(".transcript.json"):
                continue
            try:
                m = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if m.get("target") and (Path(out_dir) / ("%s.%s.vtt" % (key, m["target"]))).is_file():
                out.append(m)
    except OSError:
        pass
    return out


def track_path(out_dir, key, target):
    return Path(out_dir) / ("%s.%s.vtt" % (key, target))


def delete_track(out_dir, key, target):
    for ext in ("vtt", "json"):
        try:
            (Path(out_dir) / ("%s.%s.%s" % (key, target, ext))).unlink()
        except OSError:
            pass
