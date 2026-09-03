@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BatchMesh

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js가 설치되어 있지 않습니다.
  echo   https://nodejs.org 에서 LTS 버전을 설치한 뒤 이 파일을 다시 실행하세요.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo   처음 실행이라 필요한 라이브러리를 설치합니다. 몇 분 걸릴 수 있습니다...
  echo.
  call npm install
  if errorlevel 1 (
    echo   설치에 실패했습니다. 인터넷 연결을 확인하고 다시 실행하세요.
    pause
    exit /b 1
  )
)

rem 서버가 뜬 뒤 브라우저를 연다
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3838"

echo.
echo   BatchMesh 실행 중 — http://localhost:3838
echo   이 창을 닫으면 종료됩니다.
echo.
node server.mjs
pause
