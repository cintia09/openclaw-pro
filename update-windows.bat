@echo off
setlocal
chcp 65001 >nul 2>&1

REM OpenClaw Pro - One-Click Updater
REM Double-click this file to update

echo.
echo  =========================================
echo   OpenClaw Pro - Quick Updater
echo  =========================================
echo.

powershell -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "$u='https://raw.githubusercontent.com/cintia09/openclaw-pro/main/update-windows.ps1';" ^
  "$s=$null;" ^
  "Write-Host '  Downloading update script...';" ^
  "try{$s=Invoke-RestMethod $u -UseBasicParsing}catch{};" ^
  "if(!$s){try{$f=\"$env:TEMP\openclaw-update.ps1\"; curl.exe -sL $u -o $f; $s=[IO.File]::ReadAllText($f,[Text.Encoding]::UTF8); Remove-Item $f -Force}catch{}};" ^
  "if(!$s){try{$wc=New-Object Net.WebClient; $wc.Encoding=[Text.Encoding]::UTF8; $s=$wc.DownloadString($u)}catch{}};" ^
  "if(!$s){Write-Host '  Download failed. Check network.' -ForegroundColor Red; Read-Host; exit 1};" ^
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" ^
  "Invoke-Expression $s"

echo.
pause
