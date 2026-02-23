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


function Write-ProgressBar {
    <#
    .SYNOPSIS
        Draws an ASCII progress bar inline.
        Usage: Write-ProgressBar -Percent 45 -Label "下载中"
    #>
    param(
        [int]$Percent,
        [string]$Label = "",
        [int]$Width = 30
    )
    $filled = [math]::Floor($Width * $Percent / 100)
    $empty  = $Width - $filled
    $bar    = ("█" * $filled) + ("░" * $empty)
    $line   = "  $Label [$bar] ${Percent}%"
    Write-Host "`r$line" -NoNewline -ForegroundColor Cyan
}

function Start-AnimatedProgress {
    <#
    .SYNOPSIS
        Runs a ScriptBlock while showing an animated spinner + elapsed time.
        Returns the ScriptBlock result. Captures output via a temp file.
    #>
    param(
        [string]$Label,
        [scriptblock]$Action,
        [string]$CompletedLabel = ""
    )
    $spinner = @("⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏")
    $idx = 0
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # Run action as a background job
    $job = Start-Job -ScriptBlock $Action

    while ($job.State -eq "Running") {
        $elapsed = $sw.Elapsed.ToString("mm\:ss")
        $frame = $spinner[$idx % $spinner.Count]
        Write-Host "`r  $frame $Label ($elapsed)" -NoNewline -ForegroundColor Yellow
        Start-Sleep -Milliseconds 120
        $idx++
    }

    $sw.Stop()
    $elapsed = $sw.Elapsed.ToString("mm\:ss")

    # Get job result
    $result = Receive-Job -Job $job
    $jobState = $job.State
    Remove-Job -Job $job -Force

    # Clear spinner line
    Write-Host "`r$(' ' * 70)`r" -NoNewline

    if ($CompletedLabel) {
        Write-Host "  ✅ $CompletedLabel ($elapsed)" -ForegroundColor Green
    }

    return $result
}

function Show-StepProgress {
    <#
    .SYNOPSIS
        Shows a multi-step progress list with checkmarks, similar to:
        ✅ 更新软件包列表
        ⏳ 安装 Docker Engine...
        ○ 启动 Docker 服务
    #>
    param(
        [string[]]$Steps,
        [int]$CurrentStep   # 0-based index
    )
    for ($i = 0; $i -lt $Steps.Count; $i++) {
        if ($i -lt $CurrentStep) {
            Write-Host "     ✅ $($Steps[$i])" -ForegroundColor Green
        } elseif ($i -eq $CurrentStep) {
            Write-Host "     ⏳ $($Steps[$i])..." -ForegroundColor Yellow
        } else {
            Write-Host "     ○  $($Steps[$i])" -ForegroundColor DarkGray
        }
    }
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

    # wsl --status exit code is unreliable across Windows versions
    # Instead, use wsl --list which works more consistently
    try {
        $output = & wsl --list --verbose 2>&1 | Out-String
        # If wsl --list produces meaningful output (not just error), WSL is installed
        if ($output -match "NAME|名称|STATE|状态|Running|Stopped") {
            return $true
        }
        # Fallback: try wsl --status but accept exit codes 0 or 1
        # (some builds return 1 even when WSL is properly installed)
        $null = & wsl --status 2>&1
        if ($LASTEXITCODE -le 1) {
            # Check if the WSL kernel is present
            $kernelPath = "$env:SystemRoot\System32\lxss\tools\kernel"
            if (Test-Path $kernelPath) { return $true }
            # Also check via wsl.exe existing + Windows feature
            $wslFeature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -ErrorAction SilentlyContinue
            if ($wslFeature -and $wslFeature.State -eq "Enabled") { return $true }
        }
        return $false
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


# ─── Docker Desktop detection ─────────────────────────────────────────────────
function Test-DockerDesktopInstalled {
    # Check if Docker Desktop is installed and running
    $dockerExe = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerExe) {
        # Check common install paths
        $paths = @(
            "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
            "$env:LOCALAPPDATA\Docker\resources\bin\docker.exe"
        )
        foreach ($p in $paths) {
            if (Test-Path $p) {
                return $true
            }
        }
        return $false
    }

    try {
        $ver = & docker --version 2>&1
        if ($ver -match "Docker version") {
            Write-Log "Docker Desktop found: $ver"
            return $true
        }
    } catch { }
    return $false
}

function Test-DockerDesktopRunning {
    try {
        $info = & docker info 2>&1
        if ($LASTEXITCODE -eq 0) { return $true }
    } catch { }
    return $false
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
    Write-Host ""

    $steps = @("启用 WSL 功能", "下载 $UBUNTU_DISTRO 镜像", "安装并配置")
    Show-StepProgress -Steps $steps -CurrentStep 0

    try {
        # Clear step display area
        # Move cursor up to overwrite the step list during progress
        $lineCount = $steps.Count
        for ($i = 0; $i -lt $lineCount; $i++) {
            Write-Host "`e[1A`e[2K" -NoNewline
        }

        # Show animated spinner during wsl --install
        $distro = $UBUNTU_DISTRO
        $spinner = @("⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏")
        $idx = 0
        $sw = [System.Diagnostics.Stopwatch]::StartNew()

        # Start wsl install as a background process
        $pinfo = New-Object System.Diagnostics.ProcessStartInfo
        $pinfo.FileName = "wsl.exe"
        $pinfo.Arguments = "--install -d $distro --no-launch"
        $pinfo.RedirectStandardOutput = $true
        $pinfo.RedirectStandardError  = $true
        $pinfo.UseShellExecute = $false
        $pinfo.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($pinfo)

        while (-not $proc.HasExited) {
            $elapsed = $sw.Elapsed.ToString("mm\:ss")
            $frame = $spinner[$idx % $spinner.Count]

            # Estimate phase based on elapsed time
            if ($sw.Elapsed.TotalSeconds -lt 10) {
                $phase = "启用 WSL 功能"
                $pct = [math]::Min(30, [int]($sw.Elapsed.TotalSeconds * 3))
            } elseif ($sw.Elapsed.TotalSeconds -lt 120) {
                $phase = "下载 $distro 镜像"
                $pct = [math]::Min(80, 30 + [int](($sw.Elapsed.TotalSeconds - 10) * 0.45))
            } else {
                $phase = "安装并配置"
                $pct = [math]::Min(95, 80 + [int](($sw.Elapsed.TotalSeconds - 120) * 0.1))
            }

            Write-Host "`r  $frame $phase ($elapsed) " -NoNewline -ForegroundColor Yellow
            Write-ProgressBar -Percent $pct -Label "" -Width 20
            Start-Sleep -Milliseconds 150
            $idx++
        }

        $output = $proc.StandardOutput.ReadToEnd()
        $errOutput = $proc.StandardError.ReadToEnd()
        $exitCode = $proc.ExitCode
        $proc.Dispose()

        $sw.Stop()
        $elapsed = $sw.Elapsed.ToString("mm\:ss")

        # Clear spinner line
        Write-Host "`r$(' ' * 80)`r" -NoNewline

        Write-Log "wsl --install output: $output $errOutput"
        Write-Log "wsl --install exit code: $exitCode"

        # Show completed steps
        Write-Host "     ✅ 启用 WSL 功能" -ForegroundColor Green
        Write-Host "     ✅ 下载 $UBUNTU_DISTRO 镜像" -ForegroundColor Green

        if ($exitCode -eq 0) {
            Start-Sleep -Seconds 3
            $testOutput = & wsl --status 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Host "     ⚠️  安装并配置 — 需要重启" -ForegroundColor Yellow
                Write-Host ""
                Write-Info "安装耗时: $elapsed"
                return "reboot"
            }
            Write-Host "     ✅ 安装并配置 ($elapsed)" -ForegroundColor Green
            Write-Host ""
            return "ok"
        } elseif ($exitCode -eq 1) {
            if ("$output $errOutput" -match "restart|reboot|重启|重新启动") {
                Write-Host "     ⚠️  安装并配置 — 需要重启" -ForegroundColor Yellow
                Write-Host ""
                Write-Info "安装耗时: $elapsed"
                return "reboot"
            }
            Write-Err "WSL 安装失败 (exit code: $exitCode)"
            Write-Info "输出: $output $errOutput"
            return "error"
        } else {
            Write-Warn "WSL 安装返回代码 $exitCode，可能需要重启"
            Write-Host "     ⚠️  安装并配置 — 需要重启" -ForegroundColor Yellow
            Write-Host ""
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
                Write-Host "`r$(' ' * 70)`r" -NoNewline
                Write-OK "$DistroName 已就绪"
                return $true
            }
        } catch { }
        Start-Sleep -Seconds 5
        $elapsed += 5
        $pct = [math]::Min(99, [int]($elapsed * 100 / $MaxWaitSeconds))
        Write-ProgressBar -Percent $pct -Label "等待就绪" -Width 20
    }
    Write-Host ""
    Write-Err "$DistroName 启动超时"
    return $false
}

function Install-DockerInWsl {
    param([string]$DistroName)

    Write-Info "在 $DistroName 中安装 Docker Engine..."
    Write-Info "预计需要 5-10 分钟..."
    Write-Host ""

    $dockerSteps = @(
        "更新软件包列表",
        "安装依赖组件",
        "添加 Docker 软件源",
        "下载并安装 Docker Engine",
        "启动 Docker 服务",
        "验证安装"
    )
    Show-StepProgress -Steps $dockerSteps -CurrentStep 0

    # Docker installation script — outputs STEP markers for progress tracking
    $dockerInstallScript = @'
#!/bin/bash
set -e

echo "STEP:0"
sudo apt-get update -qq 2>&1

echo "STEP:1"
sudo apt-get install -y -qq ca-certificates curl 2>&1

echo "STEP:2"
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" |   sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update -qq 2>&1

echo "STEP:3"
sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>&1

echo "STEP:4"
sudo usermod -aG docker $USER 2>/dev/null || true
sudo service docker start 2>&1

echo "STEP:5"
sudo docker --version
sudo docker info --format "{{.ServerVersion}}" 2>/dev/null && echo "Docker daemon running OK" || echo "WARNING: Docker daemon may not be fully ready yet"

echo "DOCKER_INSTALL_COMPLETE"
'@

    $tmpScript = Join-Path $env:TEMP "openclaw-docker-setup.sh"
    $dockerInstallScript | Set-Content $tmpScript -Encoding UTF8 -Force
    $wslTmpPath = "/tmp/openclaw-docker-setup.sh"

    try {
        Get-Content $tmpScript -Raw | & wsl -d $DistroName --exec bash -c "cat > $wslTmpPath"
        & wsl -d $DistroName --exec bash -c "chmod +x $wslTmpPath"

        # Run with real-time output parsing for step progress
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $spinner = @("⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏")
        $sidx = 0
        $currentStep = 0

        # Start process
        $pinfo = New-Object System.Diagnostics.ProcessStartInfo
        $pinfo.FileName = "wsl.exe"
        $pinfo.Arguments = "-d $DistroName --exec bash $wslTmpPath"
        $pinfo.RedirectStandardOutput = $true
        $pinfo.RedirectStandardError  = $true
        $pinfo.UseShellExecute = $false
        $pinfo.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($pinfo)
        $allOutput = ""

        # Clear previous step display (go up N lines)
        for ($i = 0; $i -lt $dockerSteps.Count; $i++) {
            Write-Host "`e[1A`e[2K" -NoNewline
        }

        while (-not $proc.HasExited) {
            # Try reading available output
            if (-not $proc.StandardOutput.EndOfStream) {
                $line = $proc.StandardOutput.ReadLine()
                $allOutput += "$line`n"
                if ($line -match "^STEP:(\d+)") {
                    $currentStep = [int]$Matches[1]
                    # Redraw steps
                    Write-Host "`r$(' ' * 80)`r" -NoNewline
                    for ($i = 0; $i -lt $dockerSteps.Count; $i++) {
                        if ($i -lt $currentStep) {
                            Write-Host "     ✅ $($dockerSteps[$i])" -ForegroundColor Green
                        } elseif ($i -eq $currentStep) {
                            # Will be shown by spinner below
                            break
                        }
                    }
                }
            }

            $elapsed = $sw.Elapsed.ToString("mm\:ss")
            $frame = $spinner[$sidx % $spinner.Count]
            if ($currentStep -lt $dockerSteps.Count) {
                Write-Host "`r  $frame $($dockerSteps[$currentStep])... ($elapsed)" -NoNewline -ForegroundColor Yellow
            }
            Start-Sleep -Milliseconds 150
            $sidx++
        }

        # Read remaining output
        $remaining = $proc.StandardOutput.ReadToEnd()
        $allOutput += $remaining
        $errOutput = $proc.StandardError.ReadToEnd()
        $allOutput += $errOutput
        $proc.Dispose()

        $sw.Stop()
        $totalTime = $sw.Elapsed.ToString("mm\:ss")

        # Clear spinner line
        Write-Host "`r$(' ' * 80)`r" -NoNewline

        Write-Log "Docker install output: $allOutput"

        if ($allOutput -match "DOCKER_INSTALL_COMPLETE") {
            # Show all steps completed
            for ($i = 0; $i -lt $dockerSteps.Count; $i++) {
                Write-Host "     ✅ $($dockerSteps[$i])" -ForegroundColor Green
            }
            Write-Host ""
            Write-OK "Docker Engine 安装完成 ($totalTime)"
            Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue
            return $true
        } else {
            Write-Err "Docker 安装可能未完成"
            Write-Info "最后几行输出:"
            $allOutput -split "`n" | Select-Object -Last 10 | ForEach-Object { Write-Info "  $_" }
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
        $fileCount = (Get-ChildItem -Path $sourceDir -Recurse -File).Count
        Write-Info "正在复制 $fileCount 个文件..."
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
    Write-Host "  📋 管理命令：" -ForegroundColor White
    Write-Host "     docker ps                      # 查看容器状态" -ForegroundColor Gray
    Write-Host "     docker logs openclaw-pro       # 查看日志" -ForegroundColor Gray
    Write-Host "     docker stop openclaw-pro       # 停止服务" -ForegroundColor Gray
    Write-Host "     docker start openclaw-pro      # 启动服务" -ForegroundColor Gray
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

    # Detect Docker Desktop (takes priority over WSL-based Docker)
    $hasDockerDesktop = Test-DockerDesktopInstalled
    $dockerDesktopMode = $false

    if ($hasDockerDesktop) {
        Write-OK "检测到 Docker Desktop 已安装"
        if (Test-DockerDesktopRunning) {
            Write-OK "Docker Desktop 正在运行"
            $dockerDesktopMode = $true
        } else {
            Write-Warn "Docker Desktop 已安装但未运行"
            Write-Info "将尝试使用 Docker Desktop，请确保已启动"
            $dockerDesktopMode = $true
        }
    }

    # Display selected mode
    if ($dockerDesktopMode) {
        Write-Host ""
        Write-Host "  🔧 安装模式: 方案A — Docker Desktop (本地)" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "  🔧 安装模式: 方案B — WSL2 + Docker Engine" -ForegroundColor Green
    }

    $wslInstalled  = Test-Wsl2Installed
    $ubuntuPresent = $false

    if ($wslInstalled) {
        Write-OK "WSL2 已安装"
        $ubuntuPresent = Test-UbuntuInstalled
        if ($ubuntuPresent) {
            Write-OK "Ubuntu 发行版已存在"
        } else {
            if (-not $dockerDesktopMode) {
                Write-Info "未找到 Ubuntu 发行版，将安装 $UBUNTU_DISTRO"
            } else {
                Write-Info "未找到 Ubuntu 发行版（Docker Desktop 模式下可选）"
            }
        }
    } else {
        if (-not $dockerDesktopMode) {
            Write-Info "WSL2 未安装，将进行安装"
        } else {
            Write-Info "WSL2 未安装（Docker Desktop 模式下可选）"
        }
    }

    Write-Log "State: wslInstalled=$wslInstalled, ubuntuPresent=$ubuntuPresent, dockerDesktopMode=$dockerDesktopMode"

    # ── Phase 2: Install WSL2 if needed ───────────────────────────────────────
    if ($dockerDesktopMode) {
        # Docker Desktop mode — WSL is optional, Docker is already available
        Write-Step 2 5 "Docker Desktop 模式"
        Write-OK "使用 Docker Desktop，跳过 WSL2 + Ubuntu 安装"

        if (-not $wslInstalled -or -not $ubuntuPresent) {
            Write-Info "提示: Docker Desktop 已包含 WSL2 后端，无需单独安装"
        }
    } elseif (-not $wslInstalled -or -not $ubuntuPresent) {
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

    # ── Phase 3: Configure Docker ──────────────────────────────────────────────
    if ($dockerDesktopMode) {
        Write-Step 3 5 "Docker 已就绪"
        Write-OK "Docker Desktop 可用，跳过 Docker Engine 安装"
        $distroName = $null
    } else {
        # Get actual distro name
        $distroName = Get-UbuntuDistroName
        Write-Info "使用发行版: $distroName"

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
    }

    # ── Phase 4: Deploy OpenClaw ───────────────────────────────────────────────
    Write-Step 4 5 "部署 OpenClaw Pro..."

    if ($dockerDesktopMode) {
        # Docker Desktop mode: clone repo locally and run with docker compose / docker run
        Write-Info "Docker Desktop 模式：在本地部署..."

        $localDeployDir = Join-Path (Get-Location) "openclaw-pro"
        if (-not (Test-Path "$localDeployDir\Dockerfile")) {
            Write-Info "正在下载部署包到 $localDeployDir ..."

            # Prefer git if available, otherwise download ZIP from GitHub
            $hasGit = $null -ne (Get-Command git -ErrorAction SilentlyContinue)

            if ($hasGit) {
                Write-Info "使用 git clone 下载..."
                try {
                    # Clone with tags so we can checkout the latest release
                    & git clone --depth 1 https://github.com/cintia09/openclaw-pro.git "$localDeployDir" 2>&1
                    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
                    # Try to switch to latest release tag
                    try {
                        Push-Location $localDeployDir
                        & git fetch --tags --depth 1 2>&1 | Out-Null
                        $latestTag = & git tag --sort=-v:refname 2>$null | Select-Object -First 1
                        if ($latestTag) {
                            & git checkout $latestTag 2>&1 | Out-Null
                            Write-OK "仓库克隆完成 (Release: $latestTag)"
                        } else {
                            Write-OK "仓库克隆完成 (main 分支)"
                        }
                        Pop-Location
                    } catch {
                        Write-OK "仓库克隆完成 (main 分支)"
                        Pop-Location -ErrorAction SilentlyContinue
                    }
                } catch {
                    Write-Warn "git clone 失败，尝试 ZIP 下载..."
                    $hasGit = $false
                }
            }

            if (-not $hasGit) {
                # Try GitHub Release first, fallback to main branch ZIP
                $zipUrl = $null
                $zipFile = Join-Path $env:TEMP "openclaw-pro.zip"

                try {
                    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                    Write-Info "正在查询最新 Release 版本..."
                    $releaseApi = "https://api.github.com/repos/cintia09/openclaw-pro/releases/latest"
                    try {
                        $releaseJson = Invoke-RestMethod -Uri $releaseApi -TimeoutSec 10 -ErrorAction Stop
                        $zipUrl = $releaseJson.zipball_url
                        $relTag = $releaseJson.tag_name
                        Write-OK "找到最新 Release: $relTag"
                    } catch {
                        Write-Info "未找到 Release 版本，使用 main 分支"
                        $zipUrl = "https://github.com/cintia09/openclaw-pro/archive/refs/heads/main.zip"
                    }

                    Write-Info "正在下载部署包..."

                    # Show download progress
                    $sw = [System.Diagnostics.Stopwatch]::StartNew()
                    $spinner = @("⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏")
                    $sidx = 0

                    # Use WebClient for progress (Invoke-WebRequest is slow with large files)
                    $wc = New-Object System.Net.WebClient
                    $downloadComplete = $false
                    $downloadError = $null

                    Register-ObjectEvent -InputObject $wc -EventName DownloadProgressChanged -Action {
                        $pct = $Event.SourceArgs.ProgressPercentage
                        $received = [math]::Round($Event.SourceArgs.BytesReceived / 1MB, 1)
                        $total = [math]::Round($Event.SourceArgs.TotalBytesToReceive / 1MB, 1)
                        Write-Host "`r  📥 下载中: ${received}MB / ${total}MB ($pct%)" -NoNewline -ForegroundColor Cyan
                    } | Out-Null

                    Register-ObjectEvent -InputObject $wc -EventName DownloadFileCompleted -Action {
                        $script:downloadComplete = $true
                        if ($Event.SourceArgs.Error) {
                            $script:downloadError = $Event.SourceArgs.Error.Message
                        }
                    } | Out-Null

                    $wc.DownloadFileAsync([Uri]$zipUrl, $zipFile)

                    while (-not $downloadComplete) {
                        $elapsed = $sw.Elapsed.ToString("mm\:ss")
                        $frame = $spinner[$sidx % $spinner.Count]
                        Write-Host "`r  $frame 下载中... ($elapsed)" -NoNewline -ForegroundColor Yellow
                        Start-Sleep -Milliseconds 200
                        $sidx++
                    }
                    $wc.Dispose()
                    Write-Host "`r$(' ' * 70)`r" -NoNewline

                    if ($downloadError) {
                        throw $downloadError
                    }

                    $zipSize = [math]::Round((Get-Item $zipFile).Length / 1MB, 1)
                    Write-OK "下载完成 (${zipSize}MB)"

                    # Extract ZIP
                    Write-Info "正在解压..."
                    if (Test-Path $localDeployDir) {
                        Remove-Item $localDeployDir -Recurse -Force
                    }
                    Expand-Archive -Path $zipFile -DestinationPath $env:TEMP -Force

                    # GitHub ZIP directory names vary by download type:
                    # - main branch: "openclaw-pro-main/"
                    # - release zipball: "cintia09-openclaw-pro-{sha}/"
                    $extractedDir = $null
                    $candidates = @(
                        (Join-Path $env:TEMP "openclaw-pro-main"),
                        (Get-ChildItem $env:TEMP -Directory -Filter "openclaw-pro-*" -ErrorAction SilentlyContinue | Select-Object -First 1),
                        (Get-ChildItem $env:TEMP -Directory -Filter "*openclaw-pro-*" -ErrorAction SilentlyContinue | Select-Object -First 1)
                    )
                    foreach ($c in $candidates) {
                        $path = if ($c -is [System.IO.DirectoryInfo]) { $c.FullName } else { $c }
                        if ($path -and (Test-Path $path)) {
                            $extractedDir = $path
                            break
                        }
                    }
                    if ($extractedDir) {
                        Move-Item $extractedDir $localDeployDir -Force
                    } else {
                        throw "解压后未找到部署目录"
                    }

                    Write-OK "解压完成"
                    Remove-Item $zipFile -Force -ErrorAction SilentlyContinue
                } catch {
                    Write-Err "下载失败: $_"
                    Write-Host ""
                    Write-Host "  💡 请手动下载并解压:" -ForegroundColor Cyan
                    Write-Host "     1. 浏览器打开: https://github.com/cintia09/openclaw-pro/releases/latest" -ForegroundColor White
                    Write-Host "     2. 解压到当前目录，重命名为 openclaw-pro" -ForegroundColor White
                    Write-Host "     3. 重新运行此脚本" -ForegroundColor White
                    Write-Host ""
                    Read-Host "按回车退出"
                    exit 1
                }
            }
        } else {
            Write-OK "部署包已存在，跳过下载"
        }

        # Build and run with Docker
        Write-Step 5 5 "启动 OpenClaw..."
        Remove-ResumeTask
        Remove-InstallState

        Write-Info "正在构建并启动容器..."
        try {
            Push-Location $localDeployDir
            & docker build -t openclaw-pro . 2>&1
            if ($LASTEXITCODE -ne 0) { throw "docker build failed" }
            Write-OK "镜像构建完成"

            # Check if container exists
            $existing = & docker ps -a --filter "name=openclaw-pro" --format "{{.Names}}" 2>&1
            if ($existing -match "openclaw-pro") {
                Write-Info "删除旧容器..."
                & docker rm -f openclaw-pro 2>&1 | Out-Null
            }

            # Create home-data directory
            $homeData = Join-Path $localDeployDir "home-data"
            if (-not (Test-Path $homeData)) {
                New-Item -ItemType Directory -Path $homeData -Force | Out-Null
            }

            & docker run -d `
                --name openclaw-pro `
                --hostname openclaw `
                -v "${homeData}:/root" `
                -p 18789:18789 `
                -p 3000:3000 `
                --restart unless-stopped `
                openclaw-pro 2>&1

            if ($LASTEXITCODE -eq 0) {
                Write-OK "容器已启动"
                $launched = $true
            } else {
                throw "docker run failed"
            }
            Pop-Location
        } catch {
            Write-Err "Docker 操作失败: $_"
            Write-Suggestion "请手动运行: cd openclaw-pro && docker build -t openclaw-pro . && docker run -d --name openclaw-pro -p 18789:18789 -p 3000:3000 openclaw-pro"
            Pop-Location -ErrorAction SilentlyContinue
            $launched = $false
        }
    } else {
        # WSL mode: copy files to WSL and run there
        # Check if already deployed
        $alreadyDeployed = $false
        try {
            $checkDeploy = & wsl -d $distroName --exec bash -c "test -f /root/openclaw-pro/openclaw-docker.sh && echo FOUND" 2>&1
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

        # ── Phase 5: Cleanup + Launch ──────────────────────────────────────────
        Write-Step 5 5 "启动 OpenClaw..."

        # Remove scheduled task if it exists
        Remove-ResumeTask
        Remove-InstallState

        # Launch deploy in WSL terminal
        $launched = Start-OpenClawDeploy -DistroName $distroName
    }

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
