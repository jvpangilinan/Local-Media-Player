#!/bin/sh
# Same build step as build_exe.bat (icon + PyInstaller + copy + cleanup), without the pip / model download steps.
set -e
cd "/e/ZENO FINALFORM V6"
ICON=""
if [ -f logo.png ]; then
  py -3.12 -c "from PIL import Image; im=Image.open('logo.png').convert('RGBA'); s=max(im.size); c=Image.new('RGBA',(s,s),(0,0,0,0)); c.paste(im,((s-im.width)//2,(s-im.height)//2)); c.save('app.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
  ICON="--icon app.ico"
fi
py -3.12 -m PyInstaller --noconfirm --onefile --noconsole $ICON --name ULTRON --add-data "templates;templates" --add-data "vendor;vendor" --add-data "assets;assets" --hidden-import mpv_backend --hidden-import mpv --hidden-import native_player --hidden-import native_ui --hidden-import PySide6.QtOpenGLWidgets --hidden-import PySide6.QtOpenGL --exclude-module PySide6.QtWebEngineCore --exclude-module PySide6.QtQml --exclude-module PySide6.QtQuick --exclude-module PySide6.Qt3DCore --exclude-module PySide6.QtMultimedia --exclude-module PySide6.QtPdf --collect-submodules pystray --collect-all webview --collect-all langdetect --collect-all faster_whisper --collect-all ctranslate2 --collect-all onnxruntime --collect-all av --collect-all tokenizers --collect-all sentencepiece --collect-all huggingface_hub --hidden-import autosubs app.py
test -f dist/ULTRON.exe
cp -f dist/ULTRON.exe ULTRON.exe
rm -rf build dist ULTRON.spec app.ico
echo BUILD_OK
