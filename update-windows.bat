@echo off
setlocal

REM OpenClaw Pro - One-Click Updater
REM Double-click this file to update, or run from PowerShell

echo.
echo  =========================================
echo   OpenClaw Pro - Quick Updater
echo  =========================================
echo.

set "SCRIPT_URL=https://raw.githubusercontent.com/cintia09/openclaw-pro/main/update-windows.ps1"
set "TEMP_PS1=%TEMP%\openclaw-update.ps1"

echo  [1/3] Downloading latest update script...
curl.exe -sL "%SCRIPT_URL%" -o "%TEMP_PS1%" 2>nul
if not exist "%TEMP_PS1%" (
    echo  [FAIL] Download failed. Please check your network connection.
    echo.
    pause
    exit /b 1
)

echo  [2/3] Preparing...
echo  [3/3] Launching updater...
echo.

powershell -ExecutionPolicy Bypass -Command ^
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $s=[IO.File]::ReadAllText('%TEMP_PS1%',[Text.Encoding]::UTF8); Invoke-Expression $s"

echo.
del /q "%TEMP_PS1%" 2>nul
pause
