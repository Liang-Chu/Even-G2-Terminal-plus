@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" --import tsx apps/windows/src/setup.ts
  if errorlevel 1 exit /b 1
  echo Ready. Double-click Even-Pilot.exe. No dependency download is needed.
  exit /b 0
)
node -e "if(Number(process.versions.node.split('.')[0])<22)process.exit(1)"
if errorlevel 1 (
  echo Install Node.js 22 or newer with npm, then run Setup.cmd again.
  pause
  exit /b 1
)
call npm ci --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo Dependency installation failed. Check the error above and try again.
  pause
  exit /b 1
)
node --import tsx apps/windows/src/setup.ts
if errorlevel 1 (
  echo Local configuration could not be prepared. Existing settings were retained.
  pause
  exit /b 1
)
echo Ready. Double-click Even-Pilot.exe to open the desktop manager.
pause
