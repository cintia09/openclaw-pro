#Requires -Version 5.1
<#
.SYNOPSIS
    OpenClaw Pro - Windows Installer
    Installs WSL2 + Ubuntu + Docker Engine + OpenClaw Pro

.DESCRIPTION
    This script automates the complete installation of OpenClaw Pro on Windows
    by setting up WSL2, installing Docker Engine inside Ubuntu, and deploying
    the OpenClaw Pro container.

    Phases:
    1. Environment detection (admin check, Windows version, WSL2, Ubuntu)
    2. Install WSL2 if needed (may require reboot)
    3. Configure Ubuntu + install Docker Engine
    4. Deploy OpenClaw Pro
    5. Cleanup + show completion info
#>

[CmdletBinding()]
param(
    [switch]$Resume,        # Internal: resume after reboot
    [switch]$SkipWelcome    # Skip welcome screen
)

# ─── Constants ────────────────────────────────────────────────────────────────
$SCRIPT_VERSION  = "1.0.0"
$TASK_NAME       = "OpenClawSetup"
$UBUNTU_DISTRO   = "Ubuntu-24.04"
$OPENCLAW_PORT   = "18789"
$WSL_TARGET_DIR  = "/root/openclaw-pro"
$SCRIPT_URL      = "https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-windows.ps1"
$SCRIPT_DIR      = if ($MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
    $env:TEMP
}
$LOG_FILE        = Join-Path $SCRIPT_DIR "install-log.txt"
$STATE_FILE      = Join-Path $SCRIPT_DIR ".install-state.json"

# ─── Colors / Logging ─────────────────────────────────────────────────────────
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $entry = "[$timestamp] [$Level] $Message"
    Add-Content -Path $LOG_FILE -Value $entry -ErrorAction SilentlyContinue
}

function Write-Title {
    param([string]$Text)
    Write-Host ""
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host "  $('─' * ($Text.Length))" -ForegroundColor DarkCyan
}

function Write-Step {
    param([int]$Num, [int]$Total, [string]$Text)
    Write-Host ""
    Write-Host "  [$Num/$Total] $Text" -ForegroundColor Yellow
    Write-Log "$Text"
}

function Write-OK {
    param([string]$Text)
    Write-Host "  ✅ $Text" -ForegroundColor Green
    Write-Log "OK: $Text"
}

function Write-Warn {
    param([string]$Text)
    Write-Host "  ⚠️  $Text" -ForegroundColor Yellow
    Write-Log "WARN: $Text" "WARN"
}

function Write-Err {
    param([string]$Text)
    Write-Host ""
    Write-Host "  ❌ $Text" -ForegroundColor Red
    Write-Host ""
    Write-Log "ERROR: $Text" "ERROR"
}

function Write-Info {
    param([string]$Text)
    Write-Host "  $Text" -ForegroundColor Gray
    Write-Log $Text
}

function Write-Suggestion {
    param([string]$Text)
    Write-Host "  💡 $Text" -ForegroundColor Cyan
}

# ─── ASCII Art Logo ────────────────────────────────────────────────────────────
function Show-Logo {
    if ($SkipWelcome) { return }
    Clear-Host
    Write-Host ""
    Write-Host "   ██████╗ ██████╗ ███████╗███╗   ██╗ ██████╗██╗      █████╗ ██╗    ██╗" -ForegroundColor Cyan
    Write-Host "  ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██║     ██╔══██╗██║    ██║" -ForegroundColor Cyan
    Write-Host "  ██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║     ██║     ███████║██║ █╗ ██║" -ForegroundColor Cyan
    Write-Host "  ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║     ██║     ██╔══██║██║███╗██║" -ForegroundColor Cyan
    Write-Host "  ╚██████╔╝██║     ███████╗██║ ╚████║╚██████╗███████╗██║  ██║╚███╔███╔╝" -ForegroundColor Cyan
    Write-Host "   ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "                    🐾  OpenClaw Pro  —  Windows Installer" -ForegroundColor White
    Write-Host "                              方案B: WSL2 + Docker Engine" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  ─────────────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""
}

# ─── State persistence (for post-reboot resume) ───────────────────────────────
function Get-InstallState {
    if (Test-Path $STATE_FILE) {
        try {
            return Get-Content $STATE_FILE -Raw | ConvertFrom-Json
        } catch { }
    }
    return [PSCustomObject]@{
        Phase            = 1
        WslInstalled     = $false
        UbuntuConfigured = $false
        DockerInstalled  = $false
        RebootPending    = $false
    }
}

function Save-InstallState {
    param([PSCustomObject]$State)
    $State | ConvertTo-Json | Set-Content $STATE_FILE -Force
}

function Remove-InstallState {
    if (Test-Path $STATE_FILE) { Remove-Item $STATE_FILE -Force }
}

# ─── Admin check ──────────────────────────────────────────────────────────────
function Test-IsAdministrator {
    $current = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $current.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
    if (Test-IsAdministrator) {
        Write-OK "已以管理员权限运行"
        return
    }

    Write-Host ""
    Write-Host "  ❌ 此脚本需要管理员权限运行" -ForegroundColor Red
    Write-Host ""
    Write-Host "  安装 WSL2 和 Docker 需要管理员权限，请以管理员身份重新运行。" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  💡 操作方法:" -ForegroundColor Cyan
    Write-Host "     1. 右键点击 '开始' 菜单 → 'Windows PowerShell (管理员)'" -ForegroundColor White
    Write-Host "        或搜索 PowerShell → 右键 → 以管理员身份运行" -ForegroundColor Gray
    Write-Host "     2. 运行以下命令:" -ForegroundColor White
    Write-Host "        irm $SCRIPT_URL | iex" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "     如果已下载 install-windows.bat，可右键 → 以管理员身份运行" -ForegroundColor Gray
    Write-Host ""
    Read-Host "按回车退出"
    exit 1
}

# ─── Windows version check ────────────────────────────────────────────────────
function Test-WindowsVersion {
    $os = Get-WmiObject -Class Win32_OperatingSystem -ErrorAction SilentlyContinue
    if (-not $os) {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction SilentlyContinue
    }

    $caption = $os.Caption
    $build   = [int]$os.BuildNumber

    Write-Info "操作系统: $caption (Build $build)"

    # Win11: build >= 22000; Win10 2004: build >= 19041
    if ($build -lt 19041) {
        Write-Err "Windows 版本过低 (Build $build)"
        Write-Suggestion "WSL2 需要 Windows 10 版本 2004 (Build 19041) 或更高版本 / Windows 11"
        Write-Suggestion "请前往 Windows Update 升级系统后重试"
        exit 1
    }

    Write-OK "Windows 版本符合要求"
    return $build
}

# ─── WSL2 detection ───────────────────────────────────────────────────────────
function Test-Wsl2Installed {
    # Check if wsl.exe exists
    $wslPath = Get-Command wsl -ErrorAction SilentlyContinue
    if (-not $wslPath) {
        return $false
    }

    # Check wsl --status exit code
    try {
        $null = & wsl --status 2>&1
        # If wsl works and returns 0, WSL is installed
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Test-UbuntuInstalled {
    try {
        $distros = & wsl --list --quiet 2>&1 | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
        foreach ($d in $distros) {
            # Normalize: remove null chars that wsl sometimes outputs
            $clean = $d -replace "`0", ""
            if ($clean -match "Ubuntu") {
                Write-Info "已找到 Ubuntu 发行版: $clean"
                return $true
            }
        }
    } catch { }
    return $false
}

function Get-UbuntuDistroName {
    try {
        $distros = & wsl --list --quiet 2>&1 | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ -ne "" }
        foreach ($d in $distros) {
            if ($d -match "Ubuntu") { return $d }
        }
    } catch { }
    return $UBUNTU_DISTRO
}

# ─── Scheduled task for post-reboot resume ────────────────────────────────────
function Register-ResumeTask {
    $psExe    = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $scriptPs = Join-Path $SCRIPT_DIR "install-windows.ps1"

    # Save current state before scheduling
    $state = Get-InstallState
    $state.RebootPending = $true
    Save-InstallState $state

    $action  = New-ScheduledTaskAction -Execute $psExe `
        -Argument "-ExecutionPolicy Bypass -File `"$scriptPs`" -Resume -SkipWelcome"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -RunOnlyIfNetworkAvailable:$false

    try {
        Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
        Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger `
            -Settings $settings -RunLevel Highest -Force | Out-Null
        Write-OK "已创建计划任务 '$TASK_NAME'，重启后自动继续安装"
    } catch {
        Write-Warn "无法创建计划任务: $_"
        Write-Suggestion "重启后请手动再次运行 install-windows.bat 继续安装"
    }
}

function Remove-ResumeTask {
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
}

# ─── Phase 2: Install WSL2 ────────────────────────────────────────────────────
function Install-Wsl2 {
    Write-Info "正在安装 WSL2 和 $UBUNTU_DISTRO..."
    Write-Info "首次安装约需 3-5 分钟（需要下载 Ubuntu 镜像）"

    try {
        $output = & wsl --install -d $UBUNTU_DISTRO --no-launch 2>&1
        $exitCode = $LASTEXITCODE
        Write-Log "wsl --install output: $output"
        Write-Log "wsl --install exit code: $exitCode"

        # Exit code 0 or specific "reboot required" codes
        if ($exitCode -eq 0) {
            # Check if reboot is actually needed by testing wsl again
            Start-Sleep -Seconds 3
            $testOutput = & wsl --status 2>&1
            if ($LASTEXITCODE -ne 0) {
                return "reboot"
            }
            return "ok"
        } elseif ($exitCode -eq 1) {
            # Common: reboot required
            if ($output -match "restart|reboot|重启|重新启动") {
                return "reboot"
            }
            Write-Err "WSL 安装失败 (exit code: $exitCode)"
            Write-Info "输出: $output"
            return "error"
        } else {
            # Other non-zero: likely reboot needed
            Write-Warn "WSL 安装返回代码 $exitCode，可能需要重启"
            return "reboot"
        }
    } catch {
        Write-Err "WSL 安装异常: $_"
        return "error"
    }
}

# ─── Phase 3: Configure Ubuntu + Install Docker ───────────────────────────────
function Wait-WslReady {
    param([string]$DistroName, [int]$MaxWaitSeconds = 120)

    Write-Info "等待 $DistroName 就绪..."
    $elapsed = 0
    while ($elapsed -lt $MaxWaitSeconds) {
        try {
            $test = & wsl -d $DistroName --exec echo "ready" 2>&1
            if ($test -match "ready") {
                Write-OK "$DistroName 已就绪"
                return $true
            }
        } catch { }
        Start-Sleep -Seconds 5
        $elapsed += 5
        Write-Host "  ⏳ 等待中... ($elapsed/$MaxWaitSeconds 秒)" -ForegroundColor DarkGray -NoNewline
        Write-Host "`r" -NoNewline
    }
    Write-Err "$DistroName 启动超时"
    return $false
}

function Install-DockerInWsl {
    param([string]$DistroName)

    Write-Info "在 $DistroName 中安装 Docker Engine..."
    Write-Info "预计需要 5-10 分钟..."

    # Docker installation script (official method)
    $dockerInstallScript = @'
#!/bin/bash
set -e

echo "==> 更新软件包列表..."
sudo apt-get update -qq

echo "==> 安装依赖..."
sudo apt-get install -y -qq ca-certificates curl

echo "==> 添加 Docker GPG 密钥..."
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "==> 添加 Docker 软件源..."
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

echo "==> 更新软件包列表（含 Docker 源）..."
sudo apt-get update -qq

echo "==> 安装 Docker Engine..."
sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> 将当前用户加入 docker 组..."
sudo usermod -aG docker $USER 2>/dev/null || true

echo "==> 启动 Docker 服务..."
sudo service docker start

echo "==> 验证 Docker 安装..."
sudo docker --version
sudo docker info --format "{{.ServerVersion}}" 2>/dev/null && echo "Docker daemon running OK" || echo "WARNING: Docker daemon may not be fully ready yet"

echo "DOCKER_INSTALL_COMPLETE"
'@

    # Write script to temp location accessible from WSL
    $tmpScript = Join-Path $env:TEMP "openclaw-docker-setup.sh"
    $dockerInstallScript | Set-Content $tmpScript -Encoding UTF8 -Force

    # Convert Windows path to WSL path
    $wslTmpPath = "/tmp/openclaw-docker-setup.sh"

    try {
        # Copy script into WSL (PowerShell does not support < redirection)
        Get-Content $tmpScript -Raw | & wsl -d $DistroName --exec bash -c "cat > $wslTmpPath"
        & wsl -d $DistroName --exec bash -c "chmod +x $wslTmpPath"

        # Run the installation script
        Write-Info "开始安装（此过程需要较长时间，请耐心等待）..."
        $output = & wsl -d $DistroName --exec bash "$wslTmpPath" 2>&1

        Write-Log "Docker install output: $output"

        if ($output -match "DOCKER_INSTALL_COMPLETE") {
            Write-OK "Docker Engine 安装完成"
            Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue
            return $true
        } else {
            Write-Err "Docker 安装可能未完成"
            Write-Info "最后几行输出:"
            $output | Select-Object -Last 10 | ForEach-Object { Write-Info "  $_" }
            return $false
        }
    } catch {
        Write-Err "Docker 安装失败: $_"
        return $false
    }
}

# ─── Phase 4: Deploy OpenClaw ─────────────────────────────────────────────────
function Copy-DeployPackageToWsl {
    param([string]$DistroName)

    $sourceDir = $SCRIPT_DIR
    Write-Info "部署包目录: $sourceDir"

    # Use the \\wsl$ UNC path to copy files into WSL filesystem
    # This is much more reliable than wsl cp commands

    # Get WSL distro filesystem root
    $wslRoot = "\\wsl$\$DistroName"

    # Wait for WSL filesystem to be accessible
    $maxWait = 30
    $waited = 0
    while (-not (Test-Path $wslRoot) -and $waited -lt $maxWait) {
        Write-Info "等待 WSL 文件系统挂载..."
        Start-Sleep -Seconds 2
        $waited += 2
    }

    if (-not (Test-Path $wslRoot)) {
        # Alternative: use wsl to create dir and copy via stdin
        Write-Warn "无法通过 UNC 路径访问 WSL，尝试备用方法..."
        return Copy-DeployPackageToWslAlt -DistroName $DistroName
    }

    # Target directory in WSL
    $targetWslPath = "$wslRoot\root\openclaw-pro"
    Write-Info "目标路径: /root/openclaw-pro/"

    try {
        # Create target directory
        if (-not (Test-Path $targetWslPath)) {
            New-Item -ItemType Directory -Path $targetWslPath -Force | Out-Null
        }

        # Copy all files from the docker deploy package directory
        Write-Info "正在复制文件..."
        Copy-Item -Path "$sourceDir\*" -Destination $targetWslPath -Recurse -Force -ErrorAction Stop

        Write-OK "文件复制完成"
        return $true
    } catch {
        Write-Err "文件复制失败: $_"
        Write-Warn "尝试备用方法..."
        return Copy-DeployPackageToWslAlt -DistroName $DistroName
    }
}

function Copy-DeployPackageToWslAlt {
    param([string]$DistroName)

    Write-Info "使用备用方法：通过 tar 传输文件..."
    $sourceDir = $SCRIPT_DIR

    # Create a tar archive of the deploy package
    $tarFile = Join-Path $env:TEMP "openclaw-deploy.tar"

    try {
        # Use PowerShell Compress-Archive isn't great for tar, use wsl tar instead
        # First, convert the Windows source path to WSL path
        $driveLetter = $sourceDir.Substring(0, 1).ToLower()
        $rest = $sourceDir.Substring(2) -replace "\\", "/"
        $wslSourcePath = "/mnt/$driveLetter$rest"

        Write-Info "WSL源路径: $wslSourcePath"

        # Create target dir and copy using WSL's cp
        & wsl -d $DistroName --exec bash -c "mkdir -p /root/openclaw-pro && cp -r '$wslSourcePath/.' /root/openclaw-pro/"
        $exitCode = $LASTEXITCODE

        if ($exitCode -eq 0) {
            Write-OK "文件复制完成（备用方法）"
            return $true
        } else {
            Write-Err "备用复制方法也失败了 (exit code: $exitCode)"
            return $false
        }
    } catch {
        Write-Err "备用文件复制异常: $_"
        return $false
    }
}

function Start-OpenClawDeploy {
    param([string]$DistroName)

    Write-Info "在 WSL 中启动 OpenClaw 部署..."
    Write-Info "这将运行 openclaw-docker.sh run"
    Write-Info ""

    $deployScript = @"
#!/bin/bash
set -e
cd /root/openclaw-pro

# Fix line endings (in case Windows copied CRLF)
if command -v dos2unix &>/dev/null; then
    dos2unix openclaw-docker.sh 2>/dev/null || true
else
    sed -i 's/\r$//' openclaw-docker.sh
fi

chmod +x openclaw-docker.sh

echo ""
echo "=========================================="
echo "  OpenClaw Pro 正在启动部署向导..."
echo "  请按照提示完成配置"
echo "=========================================="
echo ""

./openclaw-docker.sh run
"@

    $tmpDeploy = Join-Path $env:TEMP "openclaw-deploy.sh"
    $deployScript | Set-Content $tmpDeploy -Encoding UTF8 -Force

    # Copy to WSL (PowerShell does not support < redirection)
    Get-Content $tmpDeploy -Raw | & wsl -d $DistroName --exec bash -c "cat > /tmp/openclaw-deploy-run.sh"
    & wsl -d $DistroName --exec bash -c "chmod +x /tmp/openclaw-deploy-run.sh"

    # Open a new Windows Terminal / PowerShell window with WSL to run interactive deploy
    # This lets the user see and interact with the deployment
    try {
        # Try Windows Terminal first (modern)
        $wtPath = Get-Command wt -ErrorAction SilentlyContinue
        if ($wtPath) {
            Start-Process wt -ArgumentList "wsl -d $DistroName bash /tmp/openclaw-deploy-run.sh"
        } else {
            # Fall back to a new PowerShell window running wsl
            Start-Process powershell -ArgumentList "-NoExit -Command `"& wsl -d $DistroName bash /tmp/openclaw-deploy-run.sh`""
        }
        return $true
    } catch {
        Write-Err "无法打开终端窗口: $_"
        Write-Suggestion "请手动打开 WSL 终端，执行以下命令完成部署："
        Write-Host ""
        Write-Host "    wsl -d $DistroName" -ForegroundColor White
        Write-Host "    cd /root/openclaw-pro" -ForegroundColor White
        Write-Host "    chmod +x openclaw-docker.sh && ./openclaw-docker.sh run" -ForegroundColor White
        Write-Host ""
        return $false
    }
}

# ─── Phase 5: Cleanup + Summary ───────────────────────────────────────────────
function Show-Completion {
    param([bool]$DeployLaunched)

    Write-Host ""
    Write-Host "  ══════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host "                🎉  安装完成！" -ForegroundColor Green
    Write-Host "  ══════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host ""
    Write-Host "  ✅  WSL2" -ForegroundColor Green
    Write-Host "  ✅  Ubuntu ($UBUNTU_DISTRO)" -ForegroundColor Green
    Write-Host "  ✅  Docker Engine" -ForegroundColor Green

    if ($DeployLaunched) {
        Write-Host "  🚀  OpenClaw Pro 部署已在新窗口启动" -ForegroundColor Cyan
    } else {
        Write-Host "  ⚠️   请手动完成 OpenClaw Pro 部署" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "  访问地址: " -NoNewline -ForegroundColor White
    Write-Host "http://localhost:$OPENCLAW_PORT" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  ─────────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  📋 管理命令（在 WSL 终端中运行）：" -ForegroundColor White
    Write-Host "     wsl -d $UBUNTU_DISTRO" -ForegroundColor Gray
    Write-Host "     cd /root/openclaw-pro" -ForegroundColor Gray
    Write-Host "     ./openclaw-docker.sh status    # 查看状态" -ForegroundColor Gray
    Write-Host "     ./openclaw-docker.sh logs      # 查看日志" -ForegroundColor Gray
    Write-Host "     ./openclaw-docker.sh stop      # 停止服务" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  📄 完整日志: $LOG_FILE" -ForegroundColor DarkGray
    Write-Host ""
}

function Show-RebootMessage {
    Write-Host ""
    Write-Host "  ══════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host "             🔄  需要重启计算机" -ForegroundColor Yellow
    Write-Host "  ══════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  WSL2 安装完成，需要重启才能继续。" -ForegroundColor White
    Write-Host ""
    Write-Host "  重启后安装程序将自动继续（已创建计划任务）。" -ForegroundColor White
    Write-Host ""
    Write-Host "  ─────────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  [Y] 立即重启    [N] 稍后手动重启" -ForegroundColor Cyan
    Write-Host ""

    $choice = Read-Host "  请选择"
    if ($choice -eq "Y" -or $choice -eq "y") {
        Write-Host "  正在重启..." -ForegroundColor Yellow
        Start-Sleep -Seconds 3
        Restart-Computer -Force
    } else {
        Write-Host ""
        Write-Warn "请记得重启后安装程序会自动继续"
        Write-Suggestion "如果重启后未自动运行，请再次双击 install-windows.bat"
        Write-Host ""
    }
}

function Show-Error {
    param([string]$Step, [string]$Detail, [string]$Suggestion)

    Write-Host ""
    Write-Host "  ══════════════════════════════════════════════════" -ForegroundColor Red
    Write-Host "             ❌  安装失败" -ForegroundColor Red
    Write-Host "  ══════════════════════════════════════════════════" -ForegroundColor Red
    Write-Host ""
    Write-Host "  失败步骤: $Step" -ForegroundColor Red
    if ($Detail) {
        Write-Host "  详细信息: $Detail" -ForegroundColor Yellow
    }
    if ($Suggestion) {
        Write-Host ""
        Write-Host "  💡 建议: $Suggestion" -ForegroundColor Cyan
    }
    Write-Host ""
    Write-Host "  📄 完整日志: $LOG_FILE" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  如需帮助，请将日志文件发送给技术支持。" -ForegroundColor Gray
    Write-Host ""
}

# ─── Main ─────────────────────────────────────────────────────────────────────
function Main {
    # Initialize log
    $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LOG_FILE -Value ""
    Add-Content -Path $LOG_FILE -Value "=== OpenClaw Windows Installer v$SCRIPT_VERSION started at $now ==="
    Add-Content -Path $LOG_FILE -Value "Resume: $Resume"

    # Show logo
    Show-Logo

    if ($Resume) {
        Write-Host "  [续] 重启后自动继续安装..." -ForegroundColor Cyan
        Write-Host ""
    }

    $state = Get-InstallState

    # ── Phase 1: Environment Detection ────────────────────────────────────────
    Write-Step 1 5 "检测环境..."

    Assert-Administrator

    $buildNumber = Test-WindowsVersion

    $wslInstalled  = Test-Wsl2Installed
    $ubuntuPresent = $false

    if ($wslInstalled) {
        Write-OK "WSL2 已安装"
        $ubuntuPresent = Test-UbuntuInstalled
        if ($ubuntuPresent) {
            Write-OK "Ubuntu 发行版已存在"
        } else {
            Write-Info "未找到 Ubuntu 发行版，将安装 $UBUNTU_DISTRO"
        }
    } else {
        Write-Info "WSL2 未安装，将进行安装"
    }

    Write-Log "State: wslInstalled=$wslInstalled, ubuntuPresent=$ubuntuPresent"

    # ── Phase 2: Install WSL2 if needed ───────────────────────────────────────
    if (-not $wslInstalled -or -not $ubuntuPresent) {
        Write-Step 2 5 "安装 WSL2 + Ubuntu..."
        Write-Info "预计时间: 3-5 分钟（需要下载 Ubuntu 镜像，取决于网速）"

        $result = Install-Wsl2

        if ($result -eq "reboot") {
            Write-OK "WSL2 安装包已安装，需要重启以完成配置"
            Register-ResumeTask
            Show-RebootMessage
            exit 0
        } elseif ($result -eq "error") {
            Show-Error `
                "WSL2 安装" `
                "wsl --install 命令失败" `
                "请访问 https://aka.ms/wsl 手动安装 WSL2，然后重新运行此脚本"
            Read-Host "按回车退出"
            exit 1
        }

        Write-OK "WSL2 + $UBUNTU_DISTRO 安装成功"

        # Re-check
        $wslInstalled  = Test-Wsl2Installed
        $ubuntuPresent = Test-UbuntuInstalled
    } else {
        Write-Step 2 5 "WSL2 已就绪，跳过安装"
        Write-OK "WSL2 + Ubuntu 均已安装，无需重复安装"
    }

    # Get actual distro name
    $distroName = Get-UbuntuDistroName
    Write-Info "使用发行版: $distroName"

    # ── Phase 3: Configure Ubuntu + Install Docker ─────────────────────────────
    # Check if Docker is already installed in WSL
    $dockerInstalled = $false
    try {
        $dockerCheck = & wsl -d $distroName --exec bash -c "command -v docker && docker --version" 2>&1
        if ($dockerCheck -match "Docker version") {
            $dockerInstalled = $true
            Write-OK "Docker 已安装在 WSL 中: $($dockerCheck | Select-String 'Docker version')"
        }
    } catch { }

    if (-not $dockerInstalled) {
        Write-Step 3 5 "配置 Ubuntu + 安装 Docker Engine..."
        Write-Info "预计时间: 5-10 分钟（取决于网速和服务器响应）"
        Write-Host ""
        Write-Host "  ℹ️  此步骤需要较长时间，请勿关闭窗口" -ForegroundColor Yellow
        Write-Host ""

        # Wait for WSL to be ready
        $ready = Wait-WslReady -DistroName $distroName

        if (-not $ready) {
            Show-Error `
                "等待 Ubuntu 就绪" `
                "$distroName 启动超时" `
                "请尝试手动运行: wsl -d $distroName，然后重新运行此脚本"
            Read-Host "按回车退出"
            exit 1
        }

        $dockerOK = Install-DockerInWsl -DistroName $distroName

        if (-not $dockerOK) {
            Show-Error `
                "Docker Engine 安装" `
                "在 WSL 中安装 Docker 失败" `
                "请手动运行: wsl -d $distroName，然后参考 https://docs.docker.com/engine/install/ubuntu/ 安装 Docker"
            Read-Host "按回车退出"
            exit 1
        }
    } else {
        Write-Step 3 5 "Docker 已安装，跳过"
        Write-OK "Docker Engine 已就绪"
    }

    # ── Phase 4: Deploy OpenClaw ───────────────────────────────────────────────
    Write-Step 4 5 "部署 OpenClaw Pro..."

    # Check if already deployed
    $alreadyDeployed = $false
    try {
        $checkDeploy = & wsl -d $distroName --exec bash -c "test -f /root/openclaw-docker/openclaw-docker.sh && echo FOUND" 2>&1
        if ($checkDeploy -match "FOUND") {
            $alreadyDeployed = $true
        }
    } catch { }

    if (-not $alreadyDeployed) {
        Write-Info "正在将部署包复制到 WSL..."
        $copyOK = Copy-DeployPackageToWsl -DistroName $distroName

        if (-not $copyOK) {
            Show-Error `
                "文件复制" `
                "无法将部署包复制到 WSL" `
                "请手动复制 docker 目录到 WSL 后运行: cd /root/openclaw-pro && ./openclaw-docker.sh run"
            Read-Host "按回车退出"
            exit 1
        }
    } else {
        Write-OK "部署包已存在，跳过复制"
    }

    # ── Phase 5: Cleanup + Launch ──────────────────────────────────────────────
    Write-Step 5 5 "启动 OpenClaw..."

    # Remove scheduled task if it exists
    Remove-ResumeTask
    Remove-InstallState

    # Launch deploy in WSL terminal
    $launched = Start-OpenClawDeploy -DistroName $distroName

    Write-Log "Deploy launched: $launched"

    Show-Completion -DeployLaunched $launched

    Read-Host "按回车关闭此窗口"
}

# ─── Entry Point ──────────────────────────────────────────────────────────────
try {
    Main
} catch {
    $errMsg = $_.Exception.Message
    Write-Log "FATAL: $errMsg" "ERROR"
    Write-Log "Stack trace: $($_.ScriptStackTrace)" "ERROR"
    Write-Host ""
    Write-Host "  ❌ 安装程序遇到意外错误:" -ForegroundColor Red
    Write-Host "  $errMsg" -ForegroundColor Red
    Write-Host ""
    Write-Host "  📄 日志文件: $LOG_FILE" -ForegroundColor DarkGray
    Write-Host ""
    Read-Host "按回车退出"
    exit 1
}
