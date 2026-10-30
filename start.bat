@echo off
rem Keep this file ASCII-only: cmd.exe mis-parses UTF-8 batch files. Thai messages live in setup.ps1.
cd /d "%~dp0"
title listSong - YouTube queue
chcp 65001 >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
if errorlevel 1 (
  pause
  exit /b 1
)

set "NODE=node"
where node >nul 2>nul || set "NODE=%~dp0bin\node.exe"
if not defined OPEN_BROWSER set OPEN_BROWSER=1
"%NODE%" server.js
pause
