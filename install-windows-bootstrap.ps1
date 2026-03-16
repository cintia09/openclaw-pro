#Requires -Version 5.1
<#
.SYNOPSIS
    OpenClaw Pro - Windows Bootstrap Installer
    Downloads the full installer script to a temp file, then executes it.
.DESCRIPTION
    This small bootstrap avoids the "irm | iex" streaming EOF issue
    by downloading install-windows.ps1 to disk first, with multiple
    fallback sources and download methods.
#>
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ErrorActionPreference = 'Stop'

$repo      = 'cintia09/openclaw-pro'
$branch    = 'main'
$fileName  = 'install-windows.ps1'
$nonce     = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$directUrl = "https://raw.githubusercontent.com/$repo/$branch/$fileName"

$sources = @(
    $directUrl,
    "https://ghfast.top/$directUrl",
    "https://mirror.ghproxy.com/$directUrl",
    "https://gh-proxy.com/$directUrl",
    "https://ghproxy.net/$directUrl"
)

$tempFile = Join-Path $env:TEMP "openclaw-install-$nonce.ps1"

function Download-Script {
    param([string]$Url, [string]$OutFile)

    $fullUrl = "$Url`?ts=$nonce"

    # Method 1: Invoke-WebRequest (more reliable than Invoke-RestMethod for large files)
    try {
        Invoke-WebRequest -Uri $fullUrl -OutFile $OutFile -UseBasicParsing -TimeoutSec 30
        if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 1000) { return $true }
    } catch {}

    # Method 2: curl.exe (ships with Windows 10+)
    try {
        $curlPath = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
        if ($curlPath) {
            & $curlPath -fsSL --connect-timeout 10 --max-time 60 --retry 2 -o $OutFile $fullUrl 2>$null
            if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 1000) { return $true }
        }
    } catch {}

    # Method 3: WebClient
    try {
        $wc = New-Object Net.WebClient
        $wc.Encoding = [Text.Encoding]::UTF8
        $wc.DownloadFile($fullUrl, $OutFile)
        if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 1000) { return $true }
    } catch {}

    return $false
}

Write-Host ""
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host "   OpenClaw Pro - Windows Setup" -ForegroundColor Cyan
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  [INFO] Downloading installer script..." -ForegroundColor Gray

$downloaded = $false
foreach ($src in $sources) {
    try {
        if (Test-Path $tempFile) { Remove-Item $tempFile -Force -ErrorAction SilentlyContinue }
        if (Download-Script -Url $src -OutFile $tempFile) {
            $downloaded = $true
            break
        }
    } catch {}
}

if (-not $downloaded) {
    # Final fallback: check if local copy exists
    $localScript = Join-Path $PSScriptRoot $fileName
    if (-not $localScript -or -not (Test-Path $localScript)) {
        $localScript = Join-Path (Get-Location) $fileName
    }
    if (Test-Path $localScript) {
        Write-Host "  [WARN] Remote download failed, using local $fileName" -ForegroundColor Yellow
        $tempFile = $localScript
        $downloaded = $true
    } else {
        Write-Host ""
        Write-Host "  [ERROR] Failed to download installer script from all sources." -ForegroundColor Red
        Write-Host "  Please check your network connection and try again." -ForegroundColor Red
        Write-Host "  Alternatively, download install-windows.bat and run it manually." -ForegroundColor Yellow
        Write-Host ""
        exit 1
    }
}

Write-Host "  [INFO] Running installer..." -ForegroundColor Gray
Write-Host ""

try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    & powershell.exe -ExecutionPolicy Bypass -NoProfile -File $tempFile
} finally {
    if (($tempFile -like "$env:TEMP*") -and (Test-Path $tempFile)) {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
}
