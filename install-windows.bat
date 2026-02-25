@echo off
setlocal

REM OpenClaw Pro - Windows Installer
REM Right-click this file and select "Run as administrator"

echo.
echo  =========================================
echo   OpenClaw Pro - Windows Setup
echo  =========================================
echo.

REM Check if running as administrator
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  [INFO] Requesting administrator privileges...
    echo.
    powershell -Command "Start-Process cmd -ArgumentList '/c cd /d ""%~dp0"" && ""%~f0""' -Verb RunAs"
    exit /b
)

REM Already admin — try local file first, then download
cd /d "%~dp0"
if exist "%~dp0install-windows.ps1" (
    echo  [INFO] Using local install-windows.ps1
    powershell -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Invoke-Expression ([IO.File]::ReadAllText('%~dp0install-windows.ps1',[Text.Encoding]::UTF8))"
) else (
    echo  [INFO] Local script not found, downloading from GitHub...
    powershell -ExecutionPolicy Bypass -Command ^
      "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
      "$u='https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-windows.ps1';" ^
      "$s=$null;" ^
      "try{$s=Invoke-RestMethod $u -UseBasicParsing}catch{};" ^
      "if(!$s){try{$f=\"$env:TEMP\oc-install.ps1\"; curl.exe -sL $u -o $f; $s=[IO.File]::ReadAllText($f,[Text.Encoding]::UTF8); Remove-Item $f -Force}catch{}};" ^
      "if(!$s){try{$wc=New-Object Net.WebClient; $wc.Encoding=[Text.Encoding]::UTF8; $s=$wc.DownloadString($u)}catch{}};" ^
      "if(!$s){Write-Host '  Download failed.' -ForegroundColor Red; Read-Host; exit 1};" ^
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" ^
      "Invoke-Expression $s"
)
echo.
pause
