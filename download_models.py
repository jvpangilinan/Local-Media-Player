"""Downloads the auto-subtitle models (Whisper + NLLB) into the models folder next to this file.
Already-installed models are skipped. build_exe.bat runs this; you can also run:  python download_models.py [accurate] [fast] [nllb]"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import autosubs  # noqa: E402

last = [-1]


def report(pct, msg):
    if pct != last[0] or pct in (0, 100):
        last[0] = pct
        print("\r  %3d%%  %-70s" % (pct, msg[:70]), end="", flush=True)


def main():
    keys = [a for a in sys.argv[1:] if a in ("accurate", "fast", "nllb")] or ["accurate", "fast", "nllb"]
    pk = autosubs.packages()
    if not pk["ok"]:
        print("The AI packages are missing (%s): %s" % (", ".join(pk["missing"]), pk["error"]))
        return 1
    try:
        autosubs.download(HERE / "models", keys, report)
    except Exception as e:
        print("\nDownload failed: %s" % e)
        return 1
    print("\nModels are ready in %s" % (HERE / "models"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
