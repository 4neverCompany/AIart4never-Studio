@echo off
REM Local Build Script for MashupForge
REM Use this to test before pushing to GitHub

echo ========================================
echo  MashupForge Local Build
echo ========================================
echo.

cd /d "%~dp0"

REM Check prerequisites
echo [1/6] Checking prerequisites...
where node >nul 2>&1 || (echo ERROR: Node.js not found && exit /b 1)
where cargo >nul 2>&1 || (echo ERROR: Rust not found && exit /b 1)
where npm >nul 2>&1 || (echo ERROR: npm not found && exit /b 1)

REM Build Next.js
echo [2/6] Building Next.js...
call npm run build
if errorlevel 1 (echo ERROR: Next.js build failed && exit /b 1)

REM Copy standalone
echo [3/6] Copying standalone...
powershell -Command ".\scripts\copy-standalone-to-resources.ps1"
if errorlevel 1 (echo ERROR: Copy standalone failed && exit /b 1)

REM Fetch Node.js
echo [4/6] Fetching Node.js...
powershell -Command ".\scripts\fetch-windows-node.ps1"
if errorlevel 1 (echo ERROR: Fetch Node.js failed && exit /b 1)

REM Build Tauri
echo [5/6] Building Tauri...
cd src-tauri
call cargo tauri build
if errorlevel 1 (echo ERROR: Tauri build failed && exit /b 1)
cd ..

REM Show output
echo [6/6] Build complete!
echo.
echo Output files:
dir src-tauri\target\release\bundle\nsis\*.exe 2>nul
echo.
echo To test: run the .exe file above
echo To release: git tag v0.1.X && git push origin v0.1.X
echo.
pause
