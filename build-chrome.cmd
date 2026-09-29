@echo off
rem Audio Extender - build the Chrome / Edge package (one package for both).
rem Result: dist\chrome\ and web-ext-artifacts\audio_extender-chrome-<version>.zip
rem Needs Node.js (https://nodejs.org). Add /q to skip the pause at the end.
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & goto :fail)

node scripts\build.mjs chrome || goto :fail

echo.
echo OK - load dist\chrome as an unpacked extension (chrome://extensions or edge://extensions, Developer mode),
echo or upload the zip from web-ext-artifacts to the Chrome Web Store / Edge Add-ons.
if /i not "%~1"=="/q" pause
exit /b 0

:fail
echo.
echo Build FAILED.
if /i not "%~1"=="/q" pause
exit /b 1
