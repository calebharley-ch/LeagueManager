@echo off
REM ---------------------------------------------------------------------------
REM  League Manager - Start (one click)
REM
REM  Double-click this file to start the app and open it in your browser.
REM  Leave the window OPEN while you use it - closing it stops the server.
REM  Press Ctrl+C in the window to stop.
REM
REM  What it does, in order:
REM    1. checks Node.js is installed
REM    2. runs npm install the first time only
REM    3. checks .env exists and is not still placeholders
REM    4. starts Vite on port 5173 and opens the browser
REM
REM  WARNING - THIS FILE MUST STAY CRLF + PURE ASCII.
REM  Saved with Unix (LF) endings AND any non-ASCII character, cmd.exe loses
REM  line sync: it executes this comment block word by word, then runs the real
REM  commands anyway, and still exits 0. Neither fault alone is harmful; the
REM  combination is, and the clean exit code hides it. Do not paste arrows,
REM  emoji or smart quotes in here.
REM ---------------------------------------------------------------------------

REM %~dp0 is this file's own folder, so double-clicking works regardless of
REM whatever directory Explorer hands us.
cd /d "%~dp0"

echo.
echo   League Manager
echo   ==============
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   ERROR: Node.js is not installed, or is not on your PATH.
  echo          Install the LTS build from https://nodejs.org, then run this again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do echo   Node %%v detected

if not exist "node_modules\" (
  echo.
  echo   First run - installing dependencies. This takes a minute or two.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   ERROR: npm install failed. Scroll up for the reason.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo.
  echo   ERROR: no .env file found.
  echo          Copy .env.example to .env, then paste in your Supabase URL and
  echo          anon key from Project Settings - Data API.
  echo.
  pause
  exit /b 1
)

REM findstr exits 0 when it FINDS a match, so 'not errorlevel 1' means found.
findstr /C:"placeholder" .env >nul 2>&1
if not errorlevel 1 (
  echo.
  echo   WARNING: .env still contains placeholder values.
  echo            The app will load but every query will fail.
  echo.
)

echo.
echo   Starting on http://localhost:5173
echo   Leave this window open. Press Ctrl+C to stop.
echo.

REM Vite only reads .env at startup, so this is also how you pick up any edit
REM you make to it. The extra -- passes --open through npm to vite itself.
call npm run dev -- --open

REM If the server dies immediately the window would vanish before you could
REM read why. Hold it open on a non-zero exit.
if errorlevel 1 pause
