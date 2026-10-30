@echo off
rem Builds dist\listSong.exe (send this one file to another PC) and dist\listSong.zip
rem (ASCII-only on purpose: cmd.exe mis-parses UTF-8 batch files)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
echo.
echo   Send dist\listSong.exe to another PC and double-click it.
echo.
pause
