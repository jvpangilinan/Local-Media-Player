@echo off
setlocal
cd /d "%~dp0"
REM Builds the ULTRON Remote Android app and puts it where the PC offers it to phones (assets\ULTRON-Remote.apk).
REM Needs Android Studio (for its Java and the Android SDK). The first build downloads Gradle once.
if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
if not exist local.properties (
    if exist "%LOCALAPPDATA%\Android\Sdk" (echo sdk.dir=%LOCALAPPDATA:\=/%/Android/Sdk> local.properties) else (
        echo Android SDK not found. Install Android Studio first.
        pause
        exit /b 1
    )
)
call gradlew.bat assembleDebug
if errorlevel 1 (
    echo Build failed. Scroll up for the error.
    pause
    exit /b 1
)
copy /Y app\build\outputs\apk\debug\app-debug.apk ..\assets\ULTRON-Remote.apk >nul
echo.
echo Done: assets\ULTRON-Remote.apk. Rebuild ULTRON.exe (build_exe.bat) to ship it, or run from source.
echo Phones get it from the phone page: the phone icon at the top right (Android only).
pause
