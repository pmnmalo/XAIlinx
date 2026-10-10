@echo off
rem Silinx launcher for Windows: double-click this file.
title Silinx
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Install the "LTS" version from https://nodejs.org ^(it opens now^), then double-click this file again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo  Your Node.js is too old. Install the current "LTS" version from https://nodejs.org
  start "" https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\express" (
  echo Installing what Silinx needs ^(first time only, needs Internet^)...
  call npm install --omit=dev
  if errorlevel 1 ( echo Installation failed. & pause & exit /b 1 )
)
if "%PORT%"=="" set PORT=8642
echo Starting Silinx... your browser opens at http://127.0.0.1:%PORT%
node bin\silinx-ise.js serve --open
pause
