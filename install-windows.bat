@echo off
setlocal
chcp 65001 >nul 2>&1

REM ClawNook - Windows Installer
REM Right-click this file and select "Run as administrator"

echo.
echo  =========================================
echo   ClawNook - Windows Setup
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

REM Already admin — prefer remote latest script, fallback to local
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
    "$nonce=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();" ^
    "$u='https://raw.githubusercontent.com/menriothink/clawnook/main/install-windows.ps1?ts='+$nonce;" ^
    "$s=$null;" ^
    "Write-Host '  [INFO] Downloading latest installer script...';" ^
    "Write-Host '  [NOTE] Installer uses the Docker Desktop + ImageOnly path only.';" ^
    "try{$s=Invoke-RestMethod $u -UseBasicParsing}catch{};" ^
    "if(!$s){try{$f=\"$env:TEMP\oc-install.ps1\"; curl.exe -sL $u -o $f; $s=[IO.File]::ReadAllText($f,[Text.Encoding]::UTF8); Remove-Item $f -Force}catch{}};" ^
    "if(!$s){try{$wc=New-Object Net.WebClient; $wc.Encoding=[Text.Encoding]::UTF8; $s=$wc.DownloadString($u)}catch{}};" ^
    "if($s){try{[IO.File]::WriteAllText('%~dp0install-windows.ps1',$s,[Text.Encoding]::UTF8)}catch{}; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Invoke-Expression $s; exit 0};" ^
    "Write-Host '  [WARN] Remote download failed, fallback to local install-windows.ps1' -ForegroundColor Yellow;" ^
    "if(Test-Path '%~dp0install-windows.ps1'){[Console]::OutputEncoding=[Text.Encoding]::UTF8; Invoke-Expression ([IO.File]::ReadAllText('%~dp0install-windows.ps1',[Text.Encoding]::UTF8)); exit 0};" ^
    "Write-Host '  Download failed and local script not found.' -ForegroundColor Red; Read-Host; exit 1"
echo.
pause
