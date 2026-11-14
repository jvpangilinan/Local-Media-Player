@echo off
cd /d "%~dp0"
git init
git add .
git commit -m "Initial commit: ZENO V6"
git branch -M main
git remote add origin https://github.com/6950xt/Local-Media-Player.git
git push -u origin main
pause
