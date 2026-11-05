@echo off
setlocal
cd /d "%~dp0"
REM ---------------------------------------------------------------
REM  Builds ULTRON.exe. Needs Python from python.org
REM  (tick "Add Python to PATH"). Python 3.12 is the safest version.
REM ---------------------------------------------------------------

REM vendor\ holds Tailwind CSS, Font Awesome 6.4.0 and Inter so the app works offline
if not exist vendor\tailwind.css (
    echo ERROR: the vendor folder is missing. Keep it next to build_exe.bat.
    pause
    exit /b 1
)

REM assets\ holds the app's own CSS and JS (split out of index.html)
if not exist assets\js\app.js (
    echo ERROR: the assets folder is missing. Keep it next to build_exe.bat.
    pause
    exit /b 1
)

REM index.html can sit next to this file or inside a "templates" folder
if not exist templates mkdir templates
if exist index.html if not exist templates\index.html move /Y index.html templates\index.html >nul
if not exist templates\index.html (
    echo ERROR: index.html not found. Put it next to build_exe.bat or in a "templates" folder.
    pause
    exit /b 1
)

set PY=py -3.12
%PY% --version >nul 2>&1 || set PY=py

echo Installing packages...
%PY% -m pip install --upgrade -r requirements.txt
if errorlevel 1 (
    echo.
    echo Package install failed. If you use a very new Python, install Python 3.12 and run this again.
    pause
    exit /b 1
)

REM auto-subtitle models (Whisper + NLLB): downloaded once into the models folder, skipped when they are already there
echo.
echo Checking the auto-subtitle models (first time about 2.8 GB, after that this is skipped)...
%PY% download_models.py
if errorlevel 1 (
    echo.
    echo WARNING: the subtitle models could not be downloaded now. The app still builds.
    echo You can download them later inside ULTRON: Settings, Subtitles, Download models.
)

REM turn logo.png into the .exe icon (skipped if there is no logo.png)
set ICONARG=
if exist logo.png %PY% -c "from PIL import Image; im=Image.open('logo.png').convert('RGBA'); s=max(im.size); c=Image.new('RGBA',(s,s),(0,0,0,0)); c.paste(im,((s-im.width)//2,(s-im.height)//2)); c.save('app.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
if exist app.ico set ICONARG=--icon app.ico

REM libmpv-2.dll is deliberately NOT packed into the exe: a 100+ MB DLL inside a one-file exe is unpacked to a temp folder on
REM EVERY launch (slow start, wasted disk). Keep libmpv-2.dll next to ULTRON.exe (or in data\mpv); ULTRON finds it there.
set HAVEMPV=0
if exist libmpv-2.dll set HAVEMPV=1
if exist mpv\libmpv-2.dll set HAVEMPV=1
if "%HAVEMPV%"=="0" (
    echo.
    echo NOTE: libmpv-2.dll was not found next to build_exe.bat.
    echo       Get it from the mpv-dev-x86_64-*.7z archive of the shinchiro or zhongfly mpv Windows builds,
    echo       and put libmpv-2.dll next to ULTRON.exe. Until then ULTRON uses the built-in web player.
    echo.
)

echo Building the app (a few minutes)...
%PY% -m PyInstaller --noconfirm --onefile --noconsole %ICONARG% --name ULTRON --add-data "templates;templates" --add-data "vendor;vendor" --add-data "assets;assets" --hidden-import mpv_backend --hidden-import mpv --hidden-import native_player --hidden-import native_ui --hidden-import PySide6.QtOpenGLWidgets --hidden-import PySide6.QtOpenGL --exclude-module PySide6.QtWebEngineCore --exclude-module PySide6.QtQml --exclude-module PySide6.QtQuick --exclude-module PySide6.Qt3DCore --exclude-module PySide6.QtMultimedia --exclude-module PySide6.QtPdf --collect-submodules pystray --collect-all webview --collect-all langdetect --collect-all faster_whisper --collect-all ctranslate2 --collect-all onnxruntime --collect-all av --collect-all tokenizers --collect-all sentencepiece --collect-all huggingface_hub --hidden-import autosubs app.py
if errorlevel 1 (
    echo.
    echo Build failed. Scroll up for the error and send it to me.
    pause
    exit /b 1
)

if not exist dist\ULTRON.exe (
    echo.
    echo Build finished but dist\ULTRON.exe was not found. Nothing was deleted.
    pause
    exit /b 1
)
copy /Y dist\ULTRON.exe ULTRON.exe >nul
if errorlevel 1 (
    echo.
    echo Could not copy the exe here. It is still inside the dist folder.
    pause
    exit /b 1
)
REM clean up build leftovers (only after the exe was copied safely)
rmdir /s /q build dist >nul 2>&1
del /q LMPV7.spec >nul 2>&1
del /q LMPV8.spec >nul 2>&1
del /q ULTRON.spec >nul 2>&1
del /q LMPV5.spec >nul 2>&1
del /q LMPV6.spec >nul 2>&1
del /q LocalMediaPlayer_Colorful.spec >nul 2>&1
del /q LocalMediaPlayer_MusicUI.spec >nul 2>&1
del /q LocalMediaPlayer_SpecialEdition.spec >nul 2>&1
del /q LocalMediaPlayer_minimalist.spec >nul 2>&1
del /q LocalMediaPlayer.spec >nul 2>&1
del /q app.ico >nul 2>&1
echo.
echo Done! Run ULTRON.exe in this folder.
echo Keep artist_rules.txt next to the exe (it is created for you if missing).
echo Private photos go in media\private\Photos (the Private tab has a Photos view).
echo Albums: every folder inside media\Photos (or media\private\Photos) is an album. Make a folder to make an album.
echo It creates media\videos and media\music here. Put your files in them, or drop a logo.png next to the exe.
echo Playback: ULTRON plays MKV, HEVC, AV1, AC3, DTS and everything else as it is, on the GPU, through libmpv-2.dll. Keep libmpv-2.dll NEXT TO ULTRON.exe.
echo Auto subtitles: keep the models folder next to the exe (it holds the Whisper + translation models, about 2.8 GB).
echo If it ever fails to start, look for error.log next to the exe.
pause
