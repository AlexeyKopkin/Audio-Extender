@echo off
rem Audio Extender - build the Firefox package (desktop + Android).
rem Result: dist\firefox\ and web-ext-artifacts\audio_extender-firefox-<version>.zip
rem Needs Node.js (https://nodejs.org). Add /q to skip the pause at the end.
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & goto :fail)

node scripts\build.mjs firefox || goto :fail
echo.
echo Checking the package like addons.mozilla.org does...
call npx --yes web-ext lint || goto :fail

echo.
echo OK - load dist\firefox\manifest.json in about:debugging, or upload the zip from web-ext-artifacts to AMO.
if /i not "%~1"=="/q" pause
exit /b 0

:fail
echo.
echo Build FAILED.
if /i not "%~1"=="/q" pause
exit /b 1
