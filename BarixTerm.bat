@echo off
rem ============================================================================
rem  BarixTerm.bat - launches the local Barix agent (BarixTerm).
rem  Usage:  BarixTerm.bat [project-folder]        interactive session
rem          BarixTerm.bat -p "your request"        one-shot
rem          BarixTerm.bat doctor                   check your setup
rem          BarixTerm.bat publish . --repo you/name --pages
rem ============================================================================
setlocal EnableExtensions
set "BARIX_ROOT=%~dp0"
title BarixTerm

where node >nul 2>nul
if errorlevel 1 (
  echo [Barix] Node.js 20 or newer is required but was not found.
  echo         Install it from https://nodejs.org ^(LTS^), then run BarixTerm.bat again.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 20 (
  echo [Barix] Node.js 20+ is required ^(found major version %NODE_MAJOR%^). Please upgrade from https://nodejs.org
  pause
  exit /b 1
)

if not exist "%BARIX_ROOT%node_modules\@barix\core" (
  echo [Barix] First run: installing dependencies ^(one time, needs internet^)...
  pushd "%BARIX_ROOT%"
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [Barix] Dependency installation failed. Check your internet connection and try again.
    popd
    pause
    exit /b 1
  )
  popd
)

where git >nul 2>nul
if errorlevel 1 echo [Barix] Note: Git was not found. Editing and chat work; git/publishing features need Git from https://git-scm.com

node "%BARIX_ROOT%apps\term\bin\barixterm.js" %*
set "BARIX_EXIT=%ERRORLEVEL%"
if not "%BARIX_EXIT%"=="0" (
  echo.
  echo [Barix] BarixTerm exited with code %BARIX_EXIT%.
  pause
)
exit /b %BARIX_EXIT%
