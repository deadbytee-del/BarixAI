@echo off
rem ============================================================================
rem  BarixTerm.bat - launches the local Barix agent (BarixTerm).
rem  Works from anywhere: put this single file in any folder (e.g. Downloads) and run it.
rem  If the Barix program files are not next to it, they are downloaded once to
rem  %LOCALAPPDATA%\Barix\app (needs internet the first time).
rem
rem  Usage:  BarixTerm.bat [project-folder]        interactive session
rem          BarixTerm.bat -p "your request"        one-shot
rem          BarixTerm.bat doctor                   check your setup
rem          BarixTerm.bat self --hours 24          self-edit mode (Barix works on its own repo, up to 24h)
rem          BarixTerm.bat publish . --repo you/name --pages
rem          BarixTerm.bat --update                 re-download the latest Barix program files
rem ============================================================================
setlocal EnableExtensions
title BarixTerm
if "%BARIX_ZIP_URL%"=="" set "BARIX_ZIP_URL=https://github.com/deadbytee-del/BarixAI/archive/refs/heads/main.zip"

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

rem --- where are the Barix program files? next to this script (a repo checkout) or in the per-user app folder
set "BARIX_ROOT=%~dp0"
if exist "%BARIX_ROOT%apps\term\bin\barixterm.js" goto have_root
set "BARIX_ROOT=%LOCALAPPDATA%\Barix\app\"
set "BARIX_BOOT=1"
if /i "%~1"=="--update" goto force_update
if exist "%BARIX_ROOT%apps\term\bin\barixterm.js" goto have_root
call :download
if errorlevel 1 (
  pause
  exit /b 1
)
:have_root
rem --- bootstrapped installs refresh themselves: at most once a day, compare the latest commit on GitHub with the one we downloaded
if defined BARIX_BOOT (
  forfiles /p "%BARIX_ROOT%." /m ".barix-sha" /d -1 >nul 2>nul
  if not errorlevel 1 call :maybe_update
)
goto after_update

:force_update
echo [Barix] Updating the program files...
call :download
if errorlevel 1 (
  pause
  exit /b 1
)
echo [Barix] Program files are up to date in %BARIX_ROOT%
exit /b 0

:maybe_update
set "REMOTE_SHA="
call :getsha
if "%REMOTE_SHA%"=="" exit /b 0
set "LOCAL_SHA="
if exist "%BARIX_ROOT%.barix-sha" set /p LOCAL_SHA=<"%BARIX_ROOT%.barix-sha"
if "%REMOTE_SHA%"=="%LOCAL_SHA%" (
  (echo %REMOTE_SHA%)>"%BARIX_ROOT%.barix-sha"
  exit /b 0
)
echo [Barix] A newer BarixTerm is available - updating once ^(set BARIX_NO_UPDATE=1 to skip^)...
if defined BARIX_NO_UPDATE exit /b 0
call :download
exit /b 0

:after_update

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
if errorlevel 1 echo [Barix] Note: Git was not found. Editing and chat work; git/publishing/self-edit need Git from https://git-scm.com

node "%BARIX_ROOT%apps\term\bin\barixterm.js" %*
set "BARIX_EXIT=%ERRORLEVEL%"
if not "%BARIX_EXIT%"=="0" (
  echo.
  echo [Barix] BarixTerm exited with code %BARIX_EXIT%. The error is printed above.
  echo         Next steps:  BarixTerm.bat doctor     ^(checks your setup and the model^)
  echo                      BarixTerm.bat --update   ^(refresh the program files; they are downloaded only once^)
  echo         Details of the last error: %USERPROFILE%\.barix\last-error.log
  pause
)
exit /b %BARIX_EXIT%

:getsha
for /f "delims=" %%s in ('powershell -NoProfile -Command "try{(Invoke-RestMethod -TimeoutSec 5 -Headers @{'User-Agent'='BarixTerm'} https://api.github.com/repos/deadbytee-del/BarixAI/commits/main).sha}catch{''}"') do set "REMOTE_SHA=%%s"
exit /b 0

:download
echo [Barix] Downloading the Barix program files to:
echo         %BARIX_ROOT%
set "BARIX_TMP=%TEMP%\barix-%RANDOM%"
mkdir "%BARIX_TMP%" 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:BARIX_ZIP_URL -OutFile '%BARIX_TMP%\barix.zip'; Expand-Archive -Force -Path '%BARIX_TMP%\barix.zip' -DestinationPath '%BARIX_TMP%\x'"
if errorlevel 1 (
  echo [Barix] Download failed. Check your internet connection, or download the repository ZIP from
  echo         https://github.com/deadbytee-del/BarixAI and run BarixTerm.bat from the extracted folder.
  rmdir /s /q "%BARIX_TMP%" 2>nul
  exit /b 1
)
mkdir "%LOCALAPPDATA%\Barix" 2>nul
set "BARIX_SRC="
for /d %%d in ("%BARIX_TMP%\x\*") do set "BARIX_SRC=%%d"
if "%BARIX_SRC%"=="" (
  echo [Barix] The downloaded archive was empty.
  rmdir /s /q "%BARIX_TMP%" 2>nul
  exit /b 1
)
xcopy "%BARIX_SRC%" "%BARIX_ROOT%" /E /I /Q /Y >nul
rmdir /s /q "%BARIX_TMP%" 2>nul
if not exist "%BARIX_ROOT%apps\term\bin\barixterm.js" (
  echo [Barix] Unexpected archive layout; barixterm.js was not found.
  exit /b 1
)
set "REMOTE_SHA="
call :getsha
if not defined REMOTE_SHA set "REMOTE_SHA=unknown"
(echo %REMOTE_SHA%)>"%BARIX_ROOT%.barix-sha"
rem files were copied over the old ones: refresh dependencies too
rmdir /s /q "%BARIX_ROOT%node_modules\@barix" 2>nul
exit /b 0
