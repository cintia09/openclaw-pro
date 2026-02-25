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

REM Already admin, run PowerShell script directly
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; & { . ([scriptblock]::Create([IO.File]::ReadAllText('%~dp0install-windows.ps1',[Text.Encoding]::UTF8))) }"
echo.
pause
