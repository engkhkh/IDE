@echo off
rem Builds the Windows installer: dist\NovaIDE-Setup-<version>.exe
cd /d "%~dp0"
if not exist node_modules (
  call npm install || exit /b 1
)
call npm run dist
if errorlevel 1 exit /b 1
echo.
echo Installer created in the dist folder.
start "" dist
