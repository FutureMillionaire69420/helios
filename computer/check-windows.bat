@echo off
rem Double-click me. Keep this window open.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed yet. Go to https://nodejs.org, install the LTS version, then double-click me again. & pause & exit /b 1)
echo Connection check (sends nothing)
node copybot.mjs check
pause
