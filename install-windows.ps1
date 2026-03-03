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
    ,[switch]$ImageOnly      # If set, skip repo download and only download/load image
)

# --- Constants ----------------------------------------------------------------
$SCRIPT_VERSION  = "1.0.7"
$TASK_NAME       = "OpenClawSetup"
$UBUNTU_DISTRO   = "Ubuntu-24.04"
$OPENCLAW_PORT   = "18789"
$WEB_PANEL_PORT  = "3000"
$DEFAULT_HTTPS_PORT = "443"
$DEFAULT_HTTP_PORT  = "80"
$WSL_TARGET_DIR  = "/root/openclaw-pro"
$GITHUB_REPO     = "cintia09/openclaw-pro"
$IMAGE_NAME      = "openclaw-pro"
$script:imageEdition = "lite"  # 发布仅保留 lite
$SCRIPT_URL      = "https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-windows.ps1"
$SCRIPT_DIR      = if ($MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
    # bat 远程调用时 $MyInvocation.MyCommand.Path 为空，用当前工作目录
    $PWD.Path
}
# 日志与镜像下载目录将在部署阶段统一设置到部署目录 openclaw-pro
# 在部署目录确定前先写入系统临时目录，避免在安装目录生成 install-log.txt
$TMP_DIR         = $env:TEMP
$LOG_FILE        = Join-Path $env:TEMP "openclaw-install-log.txt"
$STATE_FILE      = Join-Path $SCRIPT_DIR ".install-state.json"

$script:sshServiceReady = $false
$script:sshPasswordAuthDisabled = $false
$script:sshInjectedKeyPath = ""
$script:rootPasswordFilePath = ""
$script:deployedContainerName = ""

# 如果通过 `irm ... | iex` (远程执行) 运行且用户未显式指定 -ImageOnly，则默认启用 ImageOnly 模式
# Track whether ImageOnly was explicitly passed vs defaulted by remote exec
$ImageOnlyExplicit = $PSBoundParameters.ContainsKey('ImageOnly')
$ImageOnlyDefaulted = $false
if (-not $ImageOnlyExplicit) {
    if (-not $MyInvocation.MyCommand.Path) {
        $ImageOnly = $true
        $ImageOnlyDefaulted = $true
    }
}

# --- Colors / Logging ---------------------------------------------------------
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
    Write-Host "  $('-' * ($Text.Length))" -ForegroundColor DarkCyan
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

function New-StrongPassword {
    param([int]$Length = 20)

    if ($Length -lt 12) { $Length = 12 }

    $upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    $lower = "abcdefghijkmnopqrstuvwxyz"
    $digit = "23456789"
    $special = "!@#$%^&*-_=+"
    $all = ($upper + $lower + $digit + $special).ToCharArray()

    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $result = New-Object System.Collections.Generic.List[char]

        foreach ($set in @($upper, $lower, $digit, $special)) {
            $chars = $set.ToCharArray()
            $buf = New-Object byte[] 4
            $rng.GetBytes($buf)
            $idx = [BitConverter]::ToUInt32($buf, 0) % $chars.Length
            $result.Add($chars[$idx])
        }

        for ($i = $result.Count; $i -lt $Length; $i++) {
            $buf = New-Object byte[] 4
            $rng.GetBytes($buf)
            $idx = [BitConverter]::ToUInt32($buf, 0) % $all.Length
            $result.Add($all[$idx])
        }

        # Fisher-Yates shuffle
        for ($i = $result.Count - 1; $i -gt 0; $i--) {
            $buf = New-Object byte[] 4
            $rng.GetBytes($buf)
            $j = [BitConverter]::ToUInt32($buf, 0) % ($i + 1)
            $tmp = $result[$i]
            $result[$i] = $result[$j]
            $result[$j] = $tmp
        }

        return -join $result
    }
    finally {
        $rng.Dispose()
    }
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
    $bar    = ("#" * $filled) + ("-" * $empty)
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
    $spinner = @("|","/","-","\","|","/","-","\","|","/")
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
        Shows a multi-step progress list, similar to:
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

# --- ASCII Art Logo ------------------------------------------------------------
function Show-Logo {
    if ($SkipWelcome) { return }
    Clear-Host
    Write-Host ""
    Write-Host "    ___                    ____ _               " -ForegroundColor Cyan
    Write-Host "   / _ \ _ __   ___ _ __ / ___| | __ ___      __" -ForegroundColor Cyan
    Write-Host "  | | | | '_ \ / _ \ '_ | |   | |/ _' \ \ /\ / /" -ForegroundColor Cyan
    Write-Host "  | |_| | |_) |  __/ | || |___| | (_| |\ V  V / " -ForegroundColor Cyan
    Write-Host "   \___/| .__/ \___|_| |_\____|_|\__,_| \_/\_/  " -ForegroundColor Cyan
    Write-Host "        |_|                                     " -ForegroundColor Cyan
    Write-Host ""
    Write-Host "                    🐾  OpenClaw Pro  —  Windows Installer" -ForegroundColor White
    Write-Host ""
    Write-Host "  ---------------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host ""
}

# --- State persistence (for post-reboot resume) -------------------------------
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

# --- Admin check --------------------------------------------------------------
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
    return
}

# --- Windows version check ----------------------------------------------------
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
        return
    }

    Write-OK "Windows 版本符合要求"
    return $build
}

# --- WSL2 detection -----------------------------------------------------------
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


# --- Docker Desktop detection -------------------------------------------------
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

# --- Scheduled task for post-reboot resume ------------------------------------
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

# --- Phase 2: Install WSL2 ----------------------------------------------------
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
        $spinner = @("|","/","-","\","|","/","-","\","|","/")
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

# --- Phase 3: Configure Ubuntu + Install Docker -------------------------------
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
        $spinner = @("|","/","-","\","|","/","-","\","|","/")
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

# --- Phase 4: Deploy OpenClaw -------------------------------------------------
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

# --- Port availability check --------------------------------------------------
function Test-PortAvailable {
    param([int]$Port)
    # Check 1: TcpListener on all interfaces (0.0.0.0)
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $Port)
        $listener.Start()
        $listener.Stop()
    } catch {
        return $false
    }
    # Check 1b: TcpListener on loopback (127.0.0.1)
    # 某些 Windows/Docker 场景下，0.0.0.0 可绑定但 127.0.0.1 已被占用
    try {
        $listenerLoop = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
        $listenerLoop.Start()
        $listenerLoop.Stop()
    } catch {
        return $false
    }
    # Check 2: Also check Docker container port mappings
    try {
        $dockerPorts = & docker ps --format "{{.Ports}}" 2>$null
        if ($dockerPorts -and ($dockerPorts | Out-String) -match ":${Port}->") {
            return $false
        }
    } catch {}
    return $true
}

function Get-PortProcess {
    param([int]$Port)
    # 查找占用指定端口的进程名和 PID
    try {
        # 方式 1: netstat
        $netstat = netstat -ano 2>$null | Where-Object { $_ -match ":${Port}\s" -and $_ -match "LISTENING" }
        if ($netstat) {
            $pid_ = ($netstat -split '\s+' | Select-Object -Last 1)
            if ($pid_ -match '^\d+$') {
                $proc = Get-Process -Id ([int]$pid_) -ErrorAction SilentlyContinue
                if ($proc) {
                    return "$($proc.ProcessName) (PID: $pid_)"
                }
                return "PID: $pid_"
            }
        }
        # 方式 2: Docker 容器端口映射
        $dockerPorts = & docker ps --format "{{.Names}}|{{.Ports}}" 2>$null
        if ($dockerPorts) {
            foreach ($line in $dockerPorts) {
                if ($line -match ":${Port}->") {
                    $cName = ($line -split '\|')[0]
                    return "Docker 容器: $cName"
                }
            }
        }
    } catch {}
    return $null
}

function Find-AvailablePort {
    param([int]$PreferredPort, [int]$RangeStart = 18000, [int]$RangeEnd = 19000)

    # Try preferred port first
    if (Test-PortAvailable $PreferredPort) {
        return $PreferredPort
    }

    Write-Warn "端口 $PreferredPort 已被占用，正在寻找可用端口..."
    $procInfo = Get-PortProcess $PreferredPort
    if ($procInfo) {
        Write-Host "     占用进程: $procInfo" -ForegroundColor DarkGray
    }

    # Search in range
    for ($p = $RangeStart; $p -le $RangeEnd; $p++) {
        if ($p -eq $PreferredPort) { continue }
        if (Test-PortAvailable $p) {
            Write-OK "找到可用端口: $p"
            return $p
        }
    }

    # Fallback: let OS pick
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    Write-OK "使用系统分配端口: $port"
    return $port
}

function Normalize-ReleaseVersion {
    param([string]$Version)
    $v = ("$Version").Trim()
    if (-not $v) { return "" }
    return $v.TrimStart('v','V')
}

function Get-ContainerReleaseVersion {
    param(
        [string]$ContainerName,
        [string]$HomeBaseDir = ""
    )
    if (-not $ContainerName) { return "" }
    Write-Log "VersionDetect[$ContainerName]: start"

    # 与 Web 面板保持一致：优先使用容器内 /etc/openclaw-version 作为当前版本来源
    try {
        $raw = (& docker exec $ContainerName sh -lc "cat /etc/openclaw-version 2>/dev/null || true" 2>$null | Select-Object -First 1)
        if ($raw) {
            $raw = ("$raw").Trim()
            Write-Log "VersionDetect[$ContainerName]: /etc/openclaw-version => '$raw'"
            if ($raw -and $raw -ne 'unknown') {
                Write-Log "VersionDetect[$ContainerName]: choose /etc/openclaw-version => '$raw'"
                return $raw
            }
        }

        $tmpVer = Join-Path $env:TEMP ("openclaw-version-" + $ContainerName + ".txt")
        & docker cp "${ContainerName}:/etc/openclaw-version" $tmpVer 2>$null | Out-Null
        if (Test-Path $tmpVer) {
            $raw2 = (Get-Content $tmpVer -ErrorAction SilentlyContinue | Select-Object -First 1)
            Remove-Item $tmpVer -Force -ErrorAction SilentlyContinue
            if ($raw2) {
                $raw2 = ("$raw2").Trim()
                Write-Log "VersionDetect[$ContainerName]: /etc/openclaw-version (docker cp) => '$raw2'"
                if ($raw2 -and $raw2 -ne 'unknown') {
                    Write-Log "VersionDetect[$ContainerName]: choose /etc/openclaw-version via docker cp => '$raw2'"
                    return $raw2
                }
            }
        }
    } catch { }

    Write-Log "VersionDetect[$ContainerName]: no version resolved"

    return ""
}

function Get-ContainerEdition {
    param([string]$ContainerName)
    if (-not $ContainerName) { return "" }
    try {
        $ed = (& docker exec $ContainerName sh -lc "cat /etc/openclaw-edition 2>/dev/null || true" 2>$null | Select-Object -First 1)
        $ed = ("$ed").Trim().ToLower()
        if ($ed -in @('lite','full')) { return $ed }
    } catch { }
    try {
        $imgRef = (& docker inspect $ContainerName --format '{{.Config.Image}}' 2>$null | Select-Object -First 1)
        $imgRef = ("$imgRef").Trim().ToLower()
        if ($imgRef -match 'lite') { return 'lite' }
        if ($imgRef) { return 'lite' }
    } catch { }
    return ""
}

function Get-ContainerDockerfileHash {
    param([string]$ContainerName)
    if (-not $ContainerName) { return "" }
    try {
        $h = (& docker exec $ContainerName sh -lc "cat /etc/openclaw-dockerfile-hash 2>/dev/null || true" 2>$null | Select-Object -First 1)
        $h = ("$h").Trim().ToLower()
        if ($h -match '^[0-9a-f]{64}$') { return $h }
    } catch { }
    return ""
}

function Get-RemoteDockerfileHash {
    param(
        [string]$ReleaseTag,
        [string]$Edition = "lite"
    )
    $tag = ("$ReleaseTag").Trim()
    if (-not $tag) { return "" }
    $fileName = if (("$Edition").Trim().ToLower() -eq 'lite') { 'Dockerfile.lite' } else { 'Dockerfile' }
    $url = "https://raw.githubusercontent.com/$GITHUB_REPO/$tag/$fileName"
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 12 -ErrorAction Stop
        $content = [Text.Encoding]::UTF8.GetBytes([string]$resp.Content)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hashBytes = $sha.ComputeHash($content)
            return ([System.BitConverter]::ToString($hashBytes) -replace '-', '').ToLower()
        } finally {
            $sha.Dispose()
        }
    } catch { }
    return ""
}

# --- Robust Multi-threaded Chunked Download (多线程分块断点续传) --------------
# 将大文件拆成 2MB 小块，N 个线程并行下载，每块独立 HTTP Range 请求。
# 断线只影响单个块的单个线程，自动重试。支持跨次运行续传（.progress 文件）。
function Download-Robust {
    param(
        [string[]]$Urls,               # 多个下载源 URL（直连 + 代理）
        [string]$OutFile,              # 输出文件路径
        [long]$ExpectedSize,           # 预期文件大小（字节）
        [int]$ChunkSizeMB = 2,         # 每块大小（MB）
        [int]$Threads = 8,             # 并行线程数
        [int]$RetryPerChunk = 20,      # 每块最大重试次数
        [switch]$ForceFresh            # 强制全新下载（忽略/清空续传进度）
    )

    $chunkSize = [long]($ChunkSizeMB * 1024 * 1024)
    $totalChunks = [int][math]::Ceiling($ExpectedSize / $chunkSize)
    $totalMB = [math]::Round($ExpectedSize / 1MB, 1)

    # 锁定单一下载源（且必须支持 Range），避免分块重试时跨代理混用或选到不支持分块的源
    $selectedUrl = $null
    foreach ($u in $Urls) {
        try {
            $targetUrl = $u
            for ($redir = 0; $redir -lt 6; $redir++) {
                $req = [System.Net.HttpWebRequest]::Create($targetUrl)
                $req.Method = "GET"
                $req.AllowAutoRedirect = $false
                $req.Timeout = 8000
                $req.ReadWriteTimeout = 8000
                $req.UserAgent = "OpenClaw-Installer/1.0"
                $req.KeepAlive = $false
                $req.AddRange(0, 0)
                $resp = $req.GetResponse()
                if ($resp -is [System.Net.HttpWebResponse]) {
                    $code = [int]$resp.StatusCode
                    $loc = $resp.Headers["Location"]
                    if ($code -ge 300 -and $code -lt 400 -and $loc) {
                        $resp.Close()
                        $targetUrl = $loc
                        continue
                    }
                    $cr = $resp.Headers["Content-Range"]
                    $len = [long]$resp.ContentLength
                    $resp.Close()
                    if (($code -eq 206) -or ($cr -match '^bytes\s+0-0/\d+$')) {
                        # 支持 Range 分块
                        $selectedUrl = $u
                        break
                    }
                    if ($code -eq 200 -and $len -gt 0) {
                        Write-Log "Download-Robust source skipped (no range support): $u"
                        break
                    }
                }
            }
        } catch {
            Write-Log "Download-Robust source probe failed: $u ; $_"
        }
        if ($selectedUrl) { break }
    }
    if (-not $selectedUrl) {
        $selectedUrl = $Urls[0]
        Write-Warn "未探测到明确支持 Range 的下载源，仍尝试首个源进行下载"
    }
    if ($Urls.Count -gt 1 -and $selectedUrl) {
        $shortSelected = if ($selectedUrl.Length -gt 70) { $selectedUrl.Substring(0, 67) + "..." } else { $selectedUrl }
        Write-Info "已锁定下载源: $shortSelected"
        Write-Log "Download-Robust source locked: $selectedUrl"
    } elseif ($selectedUrl) {
        Write-Log "Download-Robust source locked(single): $selectedUrl"
    }
    $Urls = @($selectedUrl)

    # -- 进度文件：记录已完成的块号（支持跨次续传）--
    # 格式: 第一行 "SIZE:<ExpectedSize>" 用于校验版本，后续每行一个块号
    $progressFile = "${OutFile}.progress"
    $completedSet = [System.Collections.Concurrent.ConcurrentDictionary[int,byte]]::new()

    # -- Step 1: 检查文件是否需要（重新）预分配 --
    $needPrealloc = $false
    if ($ForceFresh) {
        $needPrealloc = $true
        if (Test-Path $OutFile) { Remove-Item $OutFile -Force -ErrorAction SilentlyContinue }
        if (Test-Path $progressFile) { Remove-Item $progressFile -Force -ErrorAction SilentlyContinue }
    } elseif (-not (Test-Path $OutFile)) {
        $needPrealloc = $true
    } elseif ((Get-Item $OutFile).Length -ne $ExpectedSize) {
        $needPrealloc = $true
    }

    # -- Step 2: 读取进度文件，校验是否匹配当前文件 --
    $progressValid = $false
    if ((Test-Path $progressFile) -and -not $needPrealloc) {
        $progressLines = Get-Content $progressFile -ErrorAction SilentlyContinue
        $sizeMatch = $false
        foreach ($line in $progressLines) {
            if ($line -match '^SIZE:(\d+)$') {
                if ([long]$Matches[1] -eq $ExpectedSize) { $sizeMatch = $true }
                continue
            }
            if ($line -match '^\d+$') {
                $chunkNo = [int]$line
                if ($chunkNo -ge 0 -and $chunkNo -lt $totalChunks) {
                    $completedSet.TryAdd($chunkNo, [byte]1) | Out-Null
                }
            }
        }
        # 无 SIZE 头的旧进度文件也接受（向后兼容），但要求文件大小正确
        if ($sizeMatch -or ($completedSet.Count -gt 0 -and -not ($progressLines | Where-Object { $_ -match '^SIZE:' }))) {
            $progressValid = $true
        } else {
            # 进度文件来自不同版本（文件大小不匹配），作废
            $completedSet.Clear()
        }
    }

    # -- Step 3: 需要预分配时，清空进度并告知用户 --
    if ($needPrealloc) {
        if ((Test-Path $progressFile) -and $completedSet.Count -eq 0) {
            # 尝试读取旧进度块数以便提示
            $oldSet = [System.Collections.Generic.HashSet[int]]::new()
            foreach ($line in (Get-Content $progressFile -ErrorAction SilentlyContinue)) {
                if ($line -match '^\d+$') {
                    $oldChunk = [int]$line
                    if ($oldChunk -ge 0 -and $oldChunk -lt $totalChunks) { [void]$oldSet.Add($oldChunk) }
                }
            }
            $oldCount = $oldSet.Count
            if ($oldCount -gt 0) {
                Write-Warn "目标文件已失效（被删除或版本变更），旧进度 ${oldCount} 块作废，将重新下载"
            }
        }
        $completedSet.Clear()
        if (Test-Path $progressFile) { Remove-Item $progressFile -Force -ErrorAction SilentlyContinue }
        Write-Info "预分配 ${totalMB}MB 磁盘空间..."
        $preallocOk = $false
        for ($pa = 1; $pa -le 12 -and -not $preallocOk; $pa++) {
            $fs = $null
            try {
                if (Test-Path $OutFile) {
                    Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
                }
                $fs = [IO.File]::Open($OutFile, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
                $fs.SetLength($ExpectedSize)
                $preallocOk = $true
            } catch {
                Write-Log "Prealloc attempt ${pa}/12 failed: $_"
                Start-Sleep -Milliseconds ([math]::Min(300 * $pa, 2000))
            } finally {
                if ($fs) { try { $fs.Close() } catch { } }
            }
        }
        if (-not $preallocOk) {
            Write-Warn "预分配文件失败（文件可能被占用），请稍后重试"
            return $false
        }
        # 写入 SIZE 头
        "SIZE:$ExpectedSize" | Set-Content $progressFile -Force
    } elseif (-not (Test-Path $progressFile)) {
        # 文件存在且大小正确，但没有进度文件 → 创建带 SIZE 头的新进度文件
        "SIZE:$ExpectedSize" | Set-Content $progressFile -Force
    }

    # 显示续传状态
    if ($completedSet.Count -gt 0) {
        $doneMB = [math]::Round([math]::Min([long]$completedSet.Count * $chunkSize, $ExpectedSize) / 1MB, 1)
        Write-Info "续传下载，已完成 $($completedSet.Count)/${totalChunks} 块 (${doneMB}MB / ${totalMB}MB)"
    }

    # 全部完成 + 文件大小正确 → 跳过
    if ($completedSet.Count -ge $totalChunks) {
        if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -eq $ExpectedSize) {
            Write-OK "镜像文件已完整下载 (${totalMB}MB)"
            Remove-Item $progressFile -Force -ErrorAction SilentlyContinue
            return $true
        }
    }

    # -- 构建待下载块队列 --
    $chunkQueue = [System.Collections.Concurrent.ConcurrentQueue[int]]::new()
    $pendingCount = 0
    for ($i = 0; $i -lt $totalChunks; $i++) {
        if (-not $completedSet.ContainsKey($i)) {
            $chunkQueue.Enqueue($i)
            $pendingCount++
        }
    }
    if ($pendingCount -eq 0) {
        Write-OK "所有块已下载完成"
        Remove-Item $progressFile -Force -ErrorAction SilentlyContinue
        return $true
    }

    # 失败块记录
    $failedChunks = [System.Collections.Concurrent.ConcurrentBag[int]]::new()

    # 实际线程数不超过待下载块数
    $actualThreads = [math]::Min($Threads, $pendingCount)
    Write-Info "${actualThreads} 线程并行下载: ${pendingCount} 块 x ${ChunkSizeMB}MB (断线自动续传)"

    # -- Worker 脚本（每个 Runspace 执行）--
    $workerScript = {
        param(
            [System.Collections.Concurrent.ConcurrentQueue[int]]$Queue,
            [string[]]$Urls,
            [string]$FilePath,
            [long]$ChunkSize,
            [long]$FileSize,
            [int]$MaxRetry,
            [System.Collections.Concurrent.ConcurrentDictionary[int,byte]]$Done,
            [string]$ProgressPath,
            [System.Collections.Concurrent.ConcurrentBag[int]]$Failed
        )

        $chunkIdx = 0
        while ($Queue.TryDequeue([ref]$chunkIdx)) {
            $rangeStart = [long]($chunkIdx * $ChunkSize)
            $rangeEnd   = [long]([math]::Min(($chunkIdx + 1) * $ChunkSize - 1, $FileSize - 1))
            $expectedLen = [long]($rangeEnd - $rangeStart + 1)

            $ok = $false
            for ($retry = 0; $retry -lt $MaxRetry -and -not $ok; $retry++) {
                $urlIdx = $retry % $Urls.Count
                $resp = $null; $netStream = $null; $fs = $null
                try {
                    # NOTE: GitHub Release 下载会 302 到对象存储；AutoRedirect 可能丢失 Range。
                    # 这里手动跟随重定向并保留 Range，保证分块下载正确。
                    $targetUrl = $Urls[$urlIdx]
                    for ($redir = 0; $redir -lt 6; $redir++) {
                        $req = [System.Net.HttpWebRequest]::Create($targetUrl)
                        $req.AllowAutoRedirect = $false
                        $req.Timeout = 30000
                        $req.ReadWriteTimeout = 30000
                        $req.UserAgent = "OpenClaw-Installer/1.0"
                        $req.KeepAlive = $false
                        $req.AddRange([long]$rangeStart, [long]$rangeEnd)

                        $resp = $req.GetResponse()
                        if ($resp -is [System.Net.HttpWebResponse]) {
                            $code = [int]$resp.StatusCode
                            $loc = $resp.Headers["Location"]
                            if ($code -ge 300 -and $code -lt 400 -and $loc) {
                                $resp.Close(); $resp = $null
                                $targetUrl = $loc
                                continue
                            }
                        }
                        break
                    }
                    if (-not $resp) { throw "No response" }
                    $netStream = $resp.GetResponseStream()

                    # 打开文件（共享读写，允许多线程同时操作）
                    $fs = [IO.File]::Open($FilePath,
                        [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
                    $fs.Seek($rangeStart, [IO.SeekOrigin]::Begin) | Out-Null

                    $buf = New-Object byte[] 65536
                    $got = [long]0
                    while ($got -lt $expectedLen) {
                        $toRead = [int][math]::Min($buf.Length, $expectedLen - $got)
                        $n = $netStream.Read($buf, 0, $toRead)
                        if ($n -eq 0) { break }
                        $fs.Write($buf, 0, $n)
                        $got += $n
                    }
                    $fs.Flush()
                    $fs.Close(); $fs = $null
                    $netStream.Close(); $netStream = $null
                    $resp.Close(); $resp = $null

                    if ($got -eq $expectedLen) {
                        $ok = $true
                        $Done.TryAdd($chunkIdx, [byte]1) | Out-Null
                        # 记录进度（追加模式，即使并发写入偶尔交错也无影响）
                        try { [IO.File]::AppendAllText($ProgressPath, "$chunkIdx`r`n") } catch {}
                    }
                } catch {
                    if ($retry -lt $MaxRetry - 1) {
                        Start-Sleep -Seconds ([math]::Min(($retry + 1) * 2, 8))
                    }
                } finally {
                    if ($fs) { try { $fs.Close() } catch {} }
                    if ($netStream) { try { $netStream.Close() } catch {} }
                    if ($resp) { try { $resp.Close() } catch {} }
                }
            }

            if (-not $ok) {
                $Failed.Add($chunkIdx)
            }
        }
    }

    # -- 启动 RunspacePool --
    $pool = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspacePool(1, $actualThreads)
    $pool.Open()

    $handles = [System.Collections.ArrayList]::new()
    for ($t = 0; $t -lt $actualThreads; $t++) {
        $ps = [PowerShell]::Create()
        $ps.RunspacePool = $pool
        $ps.AddScript($workerScript).
            AddArgument($chunkQueue).
            AddArgument($Urls).
            AddArgument($OutFile).
            AddArgument($chunkSize).
            AddArgument($ExpectedSize).
            AddArgument($RetryPerChunk).
            AddArgument($completedSet).
            AddArgument($progressFile).
            AddArgument($failedChunks) | Out-Null
        $asyncResult = $ps.BeginInvoke()
        $handles.Add(@{ PS = $ps; AR = $asyncResult }) | Out-Null
    }

    # -- 主线程：监控进度 --
    $speedTimer = [System.Diagnostics.Stopwatch]::StartNew()
    $initialDone = $completedSet.Count - $pendingCount + $pendingCount   # = total - pending at start
    $initialDone = $totalChunks - $pendingCount

    while ($handles | Where-Object { -not $_.AR.IsCompleted }) {
        Start-Sleep -Milliseconds 500
        $doneNow = $completedSet.Count
        $currentBytes = [long][math]::Min([long]$doneNow * $chunkSize, $ExpectedSize)
        $pct = [math]::Round($currentBytes * 100 / $ExpectedSize)
        $dlMB = [math]::Round($currentBytes / 1MB, 1)
        $elapsedSec = $speedTimer.Elapsed.TotalSeconds
        $newChunks = $doneNow - $initialDone
        $speedMBps = if ($elapsedSec -gt 1) {
            [math]::Round([long]$newChunks * $chunkSize / $elapsedSec / 1MB, 1)
        } else { 0 }
        $eta = ""
        if ($speedMBps -gt 0) {
            $remainMB = $totalMB - $dlMB
            $etaSec = [int]($remainMB / $speedMBps)
            if ($etaSec -gt 0) {
                $etaMin = [math]::Floor($etaSec / 60)
                $etaS = $etaSec % 60
                $eta = " ETA ${etaMin}m${etaS}s"
            }
        }
        Write-Host "`r  ${actualThreads}线程下载: ${dlMB}MB / ${totalMB}MB (${pct}%) ${speedMBps}MB/s${eta} [${doneNow}/${totalChunks}块]    " -NoNewline -ForegroundColor Cyan
    }
    Write-Host ""

    # -- 回收 Runspace --
    foreach ($h in $handles) {
        try { $h.PS.EndInvoke($h.AR) } catch {}
        $h.PS.Dispose()
    }
    $pool.Close()
    $pool.Dispose()

    # -- 失败块处理 --
    if ($failedChunks.Count -gt 0) {
        $failList = @()
        foreach ($fc in $failedChunks) { $failList += $fc }
        Write-Warn "$($failedChunks.Count) 个块下载失败 (块号: $($failList[0..([math]::Min(9, $failList.Count-1))] -join ', '))"
        Write-Warn "重新运行脚本即可自动续传剩余块"
        return $false
    }

    # -- 最终验证 --
    $finalSize = (Get-Item $OutFile).Length
    if ($finalSize -eq $ExpectedSize) {
        Remove-Item $progressFile -Force -ErrorAction SilentlyContinue
        return $true
    } else {
        Write-Warn "文件大小不匹配: ${finalSize} / ${ExpectedSize} 字节"
        return $false
    }
}

function Get-RemoteFileSize {
    param(
        [string[]]$Urls,
        [int]$TimeoutSec = 12
    )

    foreach ($u in $Urls) {
        # Try HEAD
        try {
            $targetUrl = $u
            for ($redir = 0; $redir -lt 6; $redir++) {
                $req = [System.Net.HttpWebRequest]::Create($targetUrl)
                $req.Method = "HEAD"
                $req.AllowAutoRedirect = $false
                $req.Timeout = $TimeoutSec * 1000
                $req.ReadWriteTimeout = $TimeoutSec * 1000
                $req.UserAgent = "OpenClaw-Installer/1.0"
                $req.KeepAlive = $false
                $resp = $req.GetResponse()
                if ($resp -is [System.Net.HttpWebResponse]) {
                    $code = [int]$resp.StatusCode
                    $loc = $resp.Headers["Location"]
                    if ($code -ge 300 -and $code -lt 400 -and $loc) {
                        $resp.Close()
                        $targetUrl = $loc
                        continue
                    }
                }
                $len = [long]$resp.ContentLength
                $resp.Close()
                if ($len -gt 0) { return $len }
                break
            }
        } catch { }

        # Fallback: GET with Range 0-0, parse Content-Range
        try {
            $targetUrl = $u
            for ($redir = 0; $redir -lt 6; $redir++) {
                $req = [System.Net.HttpWebRequest]::Create($targetUrl)
                $req.Method = "GET"
                $req.AllowAutoRedirect = $false
                $req.Timeout = $TimeoutSec * 1000
                $req.ReadWriteTimeout = $TimeoutSec * 1000
                $req.UserAgent = "OpenClaw-Installer/1.0"
                $req.KeepAlive = $false
                $req.AddRange(0, 0)
                $resp = $req.GetResponse()
                if ($resp -is [System.Net.HttpWebResponse]) {
                    $code = [int]$resp.StatusCode
                    $loc = $resp.Headers["Location"]
                    if ($code -ge 300 -and $code -lt 400 -and $loc) {
                        $resp.Close()
                        $targetUrl = $loc
                        continue
                    }
                }
                $cr = $resp.Headers["Content-Range"]
                $resp.Close()
                if ($cr -match '/(\d+)$') {
                    $len = [long]$Matches[1]
                    if ($len -gt 0) { return $len }
                }
                break
            }
        } catch { }
    }

    # Fallback: use curl.exe -I (often works better behind corporate proxies)
    foreach ($u in $Urls) {
        try {
            $curlOut = & curl.exe -sI -L --connect-timeout 10 --max-time 15 $u 2>&1
            $curlStr = $curlOut | Out-String
            if ($curlStr -match '(?i)content-length:\s*(\d+)') {
                $len = [long]$Matches[1]
                if ($len -gt 1000000) { return $len }   # > 1MB → valid
            }
        } catch { }
    }

    return 0
}

# --- Deploy Config: Interactive port/domain setup -----------------------------
function Get-DeployConfig {
    Write-Host ""
    Write-Host "  +==================================================+" -ForegroundColor Cyan
    Write-Host "  |       OpenClaw Pro -- Deploy Config              |" -ForegroundColor Cyan
    Write-Host "  +==================================================+" -ForegroundColor Cyan
    Write-Host ""

    $config = @{
        GatewayPort  = [int]$OPENCLAW_PORT
        WebPort      = [int]$WEB_PANEL_PORT
        HttpPort     = 0
        HttpsPort    = 0
        SshPort      = 2222
        CertMode     = "letsencrypt"
        Domain       = ""
        PortArgs     = @()
        AutoOpenFirewall = $true
        HttpsEnabled = $false
    }

    # 1. Gateway 端口
    $gwPort = Find-AvailablePort -PreferredPort ([int]$OPENCLAW_PORT)

    Write-Host "  Gateway 端口 [默认 ${gwPort}]: " -NoNewline -ForegroundColor White
    $customGw = Read-Host
    if ($customGw -match '^\d+$' -and [int]$customGw -ge 1 -and [int]$customGw -le 65535) {
        $gwPort = [int]$customGw
        # 用户手动输入的端口也需要检查占用
        if (-not (Test-PortAvailable $gwPort)) {
            $procInfo = Get-PortProcess $gwPort
            $procLabel = if ($procInfo) { " ($procInfo)" } else { "" }
            Write-Warn "端口 $gwPort 已被占用${procLabel}"
            $gwPort = Find-AvailablePort -PreferredPort $gwPort
        }
    }
    $config.GatewayPort = $gwPort

    # 2. HTTPS 域名
    Write-Host ""
    Write-Host "  💡 输入域名可启用 HTTPS（自动申请 Let's Encrypt 证书）" -ForegroundColor DarkGray
    Write-Host "     需要域名已解析到本机IP，且 80/443 端口可从外网访问" -ForegroundColor DarkGray
    Write-Host "     留空将自动使用 IP + 自签名 HTTPS（局域网/本机访问）" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  HTTPS 域名 (可选，留空使用IP自签名HTTPS): " -NoNewline -ForegroundColor White
    $domain = (Read-Host).Trim()

    if ($domain -and $domain -match '^[a-zA-Z0-9]([a-zA-Z0-9.\-]*[a-zA-Z0-9])?$') {
        # 检测输入是否为 IP 地址
        $isIpAddress = ($domain -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$')

        if ($isIpAddress) {
            # IP 地址只能使用自签证书
            $config.Domain = $domain
            $config.HttpsEnabled = $true
            $config.CertMode = "internal"
            Write-Host ""
            Write-Host "  🔐 检测到 IP 地址，将使用自签证书 HTTPS 模式" -ForegroundColor Yellow
            Write-Host "     访问时浏览器会提示「不安全」，点击「继续访问」即可正常使用" -ForegroundColor DarkGray
            Write-Host "     如需受信任的证书，请使用域名并选择 Let's Encrypt" -ForegroundColor DarkGray
        } else {
            $config.Domain = $domain
            $config.HttpsEnabled = $true

            Write-Host ""
            Write-Host "  🔐 证书模式:" -ForegroundColor White
            Write-Host "     [1] Let's Encrypt 公网证书（默认，需公网DNS+80/443可达）" -ForegroundColor Gray
            Write-Host "     [2] 自签证书（Caddy Internal，适合局域网测试）" -ForegroundColor Gray
            Write-Host ""
            Write-Host "  请选择证书模式 [1/2，默认1]: " -NoNewline -ForegroundColor White
            $certChoice = (Read-Host).Trim()
            if ($certChoice -eq '2') {
                $config.CertMode = "internal"
                Write-Info "已选择自签证书模式（Caddy Internal）"
            } else {
                $config.CertMode = "letsencrypt"
                Write-Info "已选择 Let's Encrypt 公网证书模式"
            }
        }

        # HTTP 端口 (ACME 验证 + 跳转HTTPS)
        $httpPort = [int]$DEFAULT_HTTP_PORT
        if (-not (Test-PortAvailable $httpPort)) {
            $httpPort = Find-AvailablePort -PreferredPort 8080 -RangeStart 8080 -RangeEnd 8099
            Write-Warn "端口 80 已被占用，HTTP 使用端口 $httpPort"
            if ($config.CertMode -eq "letsencrypt") {
                Write-Warn "Let's Encrypt 需要 80 端口，非标准端口可能导致证书申请失败"
            } else {
                Write-Info "自签证书模式不依赖公网 ACME 验证，可继续"
            }
        }
        $config.HttpPort = $httpPort

        # HTTPS 端口
        $httpsPort = [int]$DEFAULT_HTTPS_PORT
        if (-not (Test-PortAvailable $httpsPort)) {
            $httpsPort = Find-AvailablePort -PreferredPort 8443 -RangeStart 8443 -RangeEnd 8499
            Write-Warn "端口 443 已被占用，HTTPS 使用端口 $httpsPort"
        }
        $config.HttpsPort = $httpsPort

        # HTTPS 模式: 仅暴露 Caddy 端口到宿主机
        # Gateway/Web 走容器内回环访问，不占用宿主机 18789/3000
        if ($config.CertMode -eq "letsencrypt") {
            # Let's Encrypt 需要 80/443 暴露用于 ACME 验证
            if ($config.CertMode -eq "letsencrypt") {
                $config.PortArgs = @(
                    "-p", "$($config.HttpPort):80",
                    "-p", "$($config.HttpsPort):443"
                )
            } else {
                $config.PortArgs = @(
                    "-p", "$($config.HttpsPort):443"
                )
            }
        } else {
            # 自签证书（IP）场景：不需要在宿主机上暴露 80，仅暴露 443
            $config.PortArgs = @(
                "-p", "$($config.HttpsPort):443"
            )
        }
    } else {
        if ($domain) {
            Write-Warn "域名格式无效，将自动使用 IP 自签名 HTTPS"
        }

        # 域名为空或无效 — 自动启用 IP 自签名 HTTPS
        Write-Host ""
        Write-Host "  🔒 将启用 HTTPS（自签证书 + 本机 IP）" -ForegroundColor White
        Write-Host "     无需域名，Caddy 自动为本机 IP 生成自签名证书" -ForegroundColor DarkGray
        Write-Host "     浏览器会提示「不安全」，点击「继续访问」即可" -ForegroundColor DarkGray
        # 获取本机局域网 IP（排除虚拟网卡：WSL, Docker, Hyper-V, VPN 等）
        $localIp = ""
        try {
            $virtualKeywords = @('vEthernet', 'WSL', 'Docker', 'Hyper-V', 'VirtualBox', 'VMware', 'Loopback', 'Bluetooth')
            $allAdapters = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' }
            if (-not $allAdapters) {
                # -Physical 不可用时回退：按名称排除虚拟网卡
                $allAdapters = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | Where-Object {
                    $n = $_.Name + ' ' + $_.InterfaceDescription
                    $isVirtual = $false
                    foreach ($kw in $virtualKeywords) { if ($n -match $kw) { $isVirtual = $true; break } }
                    -not $isVirtual
                }
            }
            if ($allAdapters) {
                $localIp = ($allAdapters | ForEach-Object {
                    Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
                } | Where-Object {
                    $_.IPAddress -ne '127.0.0.1' -and
                    $_.IPAddress -notmatch '^169\.254\.' -and   # APIPA
                    $_.PrefixOrigin -ne 'WellKnown'
                } | Select-Object -First 1).IPAddress
            }
        } catch { }
        # 回退方案：排除常见虚拟网段
        if (-not $localIp) {
            try {
                $localIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
                    $_.IPAddress -ne '127.0.0.1' -and
                    $_.IPAddress -notmatch '^169\.254\.' -and
                    $_.IPAddress -notmatch '^172\.(1[6-9]|2\d|3[01])\.' -and  # Docker/WSL 常用网段
                    $_.PrefixOrigin -ne 'WellKnown'
                } | Select-Object -First 1).IPAddress
            } catch { }
        }
        # 最终回退
        if (-not $localIp) {
            try {
                $localIp = ([System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | Where-Object {
                    $_.AddressFamily -eq 'InterNetwork' -and $_.ToString() -ne '127.0.0.1' -and $_.ToString() -notmatch '^172\.(1[6-9]|2\d|3[01])\.'
                } | Select-Object -First 1).ToString()
            } catch { }
        }
        if ($localIp) {
            Write-Host "  检测到本机 IP: $localIp" -ForegroundColor Cyan
            # Prompt for IP confirmation; accept Enter or 'y' to confirm, or allow entering a new IP.
            $chosenIp = $null
            while ($true) {
                Write-Host "  使用此 IP？按回车或输入 'y' 确认，或输入其他 IP: " -NoNewline -ForegroundColor White
                $customIp = (Read-Host).Trim()
                if (-not $customIp -or $customIp.ToLower() -eq 'y') { $chosenIp = $localIp; break }
                if ($customIp -match '^\d{1,3}(?:\.\d{1,3}){3}$') {
                    $valid = $true
                    foreach ($octet in ($customIp -split '\.')) { if ([int]$octet -lt 0 -or [int]$octet -gt 255) { $valid = $false } }
                    if ($valid) { $chosenIp = $customIp; break } else { Write-Warn "IP 段必须在 0-255 之间，请重试" }
                } else {
                    Write-Warn "输入不是有效的 IP 地址，请重试，或按回车确认使用 $localIp"
                }
            }
            $localIp = $chosenIp
            $config.Domain = $localIp
            $config.HttpsEnabled = $true
            $config.CertMode = "internal"
            Write-OK "已启用 IP 自签名 HTTPS: $localIp"
        } else {
            Write-Host "  请输入本机 IP 地址: " -NoNewline -ForegroundColor White
            $manualIp = (Read-Host).Trim()
            if ($manualIp -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
                $config.Domain = $manualIp
                $config.HttpsEnabled = $true
                $config.CertMode = "internal"
                Write-OK "已启用 IP 自签名 HTTPS: $manualIp"
            } else {
                $config.Domain = '127.0.0.1'
                $config.HttpsEnabled = $true
                $config.CertMode = "internal"
                Write-Warn "IP 格式无效，已回退到 127.0.0.1 自签名 HTTPS"
            }
        }

        # IP HTTPS 模式也需要配置端口和 PortArgs
        if ($config.HttpsEnabled) {
            $httpPort = [int]$DEFAULT_HTTP_PORT
            if (-not (Test-PortAvailable $httpPort)) {
                $httpPort = Find-AvailablePort -PreferredPort 8080 -RangeStart 8080 -RangeEnd 8099
                Write-Warn "端口 80 已被占用，HTTP 使用端口 $httpPort"
            }
            $config.HttpPort = $httpPort

            $httpsPort = [int]$DEFAULT_HTTPS_PORT
            if (-not (Test-PortAvailable $httpsPort)) {
                $httpsPort = Find-AvailablePort -PreferredPort 8443 -RangeStart 8443 -RangeEnd 8499
                Write-Warn "端口 443 已被占用，HTTPS 使用端口 $httpsPort"
            }
            $config.HttpsPort = $httpsPort

            if ($config.CertMode -eq "letsencrypt") {
                $config.PortArgs = @(
                    "-p", "$($config.HttpPort):80",
                    "-p", "$($config.HttpsPort):443"
                )
            } else {
                $config.PortArgs = @(
                    "-p", "$($config.HttpsPort):443"
                )
            }
        }
    }

    if (-not $config.HttpsEnabled) {
        throw "部署配置错误：HTTPS 未启用。请重新运行安装器。"
    }

    # SSH 端口（所有模式通用）
    $sshPort = 2222
    if (-not (Test-PortAvailable $sshPort)) {
        $sshPort = Find-AvailablePort -PreferredPort 2223 -RangeStart 2223 -RangeEnd 2299
        Write-Warn "端口 2222 已被占用，SSH 使用端口 $sshPort"
    }
    $config.SshPort = $sshPort
    $config.PortArgs += @("-p", "$($config.SshPort):22")

    # 显示配置摘要
    Write-Host ""
    Write-Host "  -------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "  📝 端口映射:" -ForegroundColor White
    if ($config.CertMode -eq 'letsencrypt') {
        Write-Host "     HTTP   $($config.HttpPort) → 容器 80  (证书验证+跳转)" -ForegroundColor Gray
    }
    Write-Host "     HTTPS  $($config.HttpsPort) → 容器 443 (主入口)" -ForegroundColor Gray
    Write-Host "     SSH    $($config.SshPort) → 容器 22  (远程登录)" -ForegroundColor Gray
    if ($config.CertMode -eq "internal") {
        Write-Host "     证书: 自签证书（Caddy Internal）" -ForegroundColor Yellow
    } else {
        Write-Host "     证书: Let's Encrypt 公网证书" -ForegroundColor Gray
    }
    Write-Host "     Gateway/Web 面板: 仅容器内部访问（不占宿主机端口）" -ForegroundColor Gray
    $isIpDomain = ($config.Domain -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$')
    if ($isIpDomain) {
        Write-Host "     IP: $($config.Domain) (自签名 HTTPS)" -ForegroundColor Cyan
        Write-Host "     ⚠️  浏览器会提示不安全，点击「继续访问」即可" -ForegroundColor Yellow
    } else {
        Write-Host "     域名: $($config.Domain)" -ForegroundColor Cyan
    }
    Write-Host "  -------------------------------------------------" -ForegroundColor DarkGray
    Write-Host ""

    # 统一防火墙策略（由用户选择是否自动开放）
    $fwPortList = @()
    # Only include HTTP port for Let's Encrypt (ACME) mode
    if ($config.CertMode -eq 'letsencrypt') {
        if ($config.HttpPort -and $config.HttpPort -gt 0) { $fwPortList += $config.HttpPort }
    }
    if ($config.HttpsPort -and $config.HttpsPort -gt 0) { $fwPortList += $config.HttpsPort }
    if ($config.SshPort -and $config.SshPort -gt 0) { $fwPortList += $config.SshPort }
    $fwPortsText = ($fwPortList | Sort-Object -Unique) -join ','
    $defaultAutoOpen = "Y"
    $defaultHint = "Y/n"
    Write-Host "  🛡️  防火墙设置（目标端口: ${fwPortsText}）" -ForegroundColor White
    Write-Host "     是否自动开放上述端口？[${defaultHint}] : " -NoNewline -ForegroundColor White
    $fwChoice = (Read-Host).Trim().ToLower()
    if (-not $fwChoice) {
        $config.AutoOpenFirewall = ($defaultAutoOpen -eq "Y")
    } else {
        $config.AutoOpenFirewall = ($fwChoice -eq "y" -or $fwChoice -eq "yes")
    }
    if ($config.AutoOpenFirewall) {
        Write-Info "已选择自动开放防火墙端口 (${fwPortsText})"
    } else {
        Write-Info "已选择不自动开放防火墙端口，可在完成页复制手动命令"
    }

    return $config
}

function Write-LaunchAccessSummary {
    param(
        [bool]$IsDockerDesktop = $false,
        [int]$GatewayPort = 18789,
        [int]$PanelPort = 3000,
        [string]$Domain = "",
        [string]$CertMode = "letsencrypt",
        [int]$HttpPort = 0,
        [int]$HttpsPort = 0,
        [int]$SshPort = 2222
    )

    if ($IsDockerDesktop) {
        Write-Host "  ✅ Docker Desktop" -ForegroundColor Green
    } else {
        Write-Host "  ✅ WSL2" -ForegroundColor Green
        Write-Host "  ✅ Ubuntu ($UBUNTU_DISTRO)" -ForegroundColor Green
        Write-Host "  ✅ Docker Engine" -ForegroundColor Green
    }
    Write-Host "  🚀 OpenClaw Pro 容器已启动" -ForegroundColor Cyan
    Write-Host ""

    Write-Host "  📝 端口映射:" -ForegroundColor White
    if ($CertMode -eq "letsencrypt") {
        Write-Host "     HTTP   ${HttpPort} → 证书验证 + 跳转HTTPS" -ForegroundColor Gray
    }
    Write-Host "     HTTPS  ${HttpsPort} → 主入口（Caddy 反代）" -ForegroundColor Gray
    Write-Host "     SSH    ${SshPort} → 远程登录（密钥认证）" -ForegroundColor Gray
    if ($CertMode -eq "internal") {
        Write-Host "     证书模式: 自签证书（局域网测试）" -ForegroundColor Yellow
        Write-Host "     ⚠️  首次访问浏览器会提示「不安全」，点击「继续访问」/「高级」即可" -ForegroundColor Yellow
    } else {
        Write-Host "     证书模式: Let's Encrypt 公网证书" -ForegroundColor Gray
    }
    Write-Host "     Gateway/Web 面板 → 仅容器内部（不占宿主机端口）" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  🌐 访问地址:" -ForegroundColor White
    $httpsDomain = if ($Domain) { $Domain } else { "localhost" }
    $httpsUrl = if ($HttpsPort -eq 443) { "https://${httpsDomain}" } else { "https://${httpsDomain}:${HttpsPort}" }
    Write-Host "     🔗 主站:     $httpsUrl" -ForegroundColor Cyan
    Write-Host "     🔗 管理面板: ${httpsUrl}/admin" -ForegroundColor Cyan
    Write-Host "" 
    Write-Host "  ⏳ 访问提示: 服务启动后通常需等待 30-120 秒；首次安装可能需要 3-5 分钟" -ForegroundColor Yellow
    Write-Host "     若暂时无法访问，请稍等后刷新页面" -ForegroundColor DarkGray
    Write-Host ""
}

# --- Phase 5: Cleanup + Summary -----------------------------------------------
function Show-Completion {
    param(
        [bool]$DeployLaunched,
        [bool]$IsDockerDesktop = $false,
        [int]$GatewayPort = 18789,
        [int]$PanelPort = 3000,
        [string]$Domain = "",
        [string]$CertMode = "letsencrypt",
        [int]$HttpPort = 0,
        [int]$HttpsPort = 0,
        [int]$SshPort = 2222,
        [bool]$AutoOpenFirewall = $true
    )

    Write-Host ""
    $completionTitle = if ($script:upgradeMode) { "🎉 升级完成" } else { "🎉 安装完成" }
    if ($DeployLaunched) {
        Write-Host "  ==================================================" -ForegroundColor Green
        Write-Host "                $completionTitle" -ForegroundColor Green
        Write-Host "  ==================================================" -ForegroundColor Green
    } else {
        Write-Host "  ==================================================" -ForegroundColor Yellow
        Write-Host "             ⚠️  安装未完成" -ForegroundColor Yellow
        Write-Host "  ==================================================" -ForegroundColor Yellow
    }
    Write-Host ""

    if ($DeployLaunched) {
        Write-Host "  -------------------------------------------------" -ForegroundColor DarkGray
        Write-Host ""

        # Windows 防火墙提醒（仅实际对外暴露的端口）
        $portList = @()
        # HTTPS 模式: Gateway/Web 绑定 127.0.0.1，只需开放 HTTP/HTTPS
        if ($CertMode -eq "letsencrypt") {
            if ($HttpPort -and $HttpPort -gt 0) { $portList += $HttpPort }
        }
        if ($HttpsPort -and $HttpsPort -gt 0) { $portList += $HttpsPort }
        if ($SshPort -and $SshPort -gt 0) { $portList += $SshPort }
        if ($portList.Count -gt 0 -and $AutoOpenFirewall) {
            $ports = ($portList | Sort-Object -Unique) -join ','
            Write-Host "  防火墙端口已自动开放 (${ports})，如需重新设置:" -ForegroundColor Yellow
            Write-Host "     netsh advfirewall firewall add rule name=`"OpenClaw`" dir=in action=allow protocol=tcp localport=${ports}" -ForegroundColor White
        } else {
            $ports = ($portList | Sort-Object -Unique) -join ','
            Write-Host "  已跳过自动开放防火墙端口" -ForegroundColor Yellow
            Write-Host "     本机访问（同一台机器）通常不需要额外放行" -ForegroundColor DarkGray
            if ($ports) {
                Write-Host "     如需其他设备访问，请手动开放端口：${ports}" -ForegroundColor DarkGray
                Write-Host "     netsh advfirewall firewall add rule name=`"OpenClaw-Manual`" dir=in action=allow protocol=tcp localport=${ports}" -ForegroundColor White
            }
        }

        if ($Domain -and $CertMode -eq "internal") {
            Write-Host ""
            Write-Host "  🔒 关于 HTTPS 证书提示:" -ForegroundColor White
            Write-Host "     首次打开页面时，浏览器会显示「不安全」或「证书错误」—— 这是正常的。" -ForegroundColor DarkGray
            Write-Host "     因为证书是本机自动生成的，不是公网机构签发的。" -ForegroundColor DarkGray
            Write-Host "     点击「高级」→「继续前往」即可正常使用，不影响数据安全。" -ForegroundColor DarkGray
            Write-Host ""
            Write-Host "     如果想永久消除提示，可在管理员 PowerShell 中执行：" -ForegroundColor DarkGray
            Write-Host "     docker cp openclaw-pro:/data/caddy/pki/authorities/local/root.crt `$env:TEMP\openclaw-caddy-root.crt; certutil -addstore -f Root `$env:TEMP\openclaw-caddy-root.crt" -ForegroundColor White
            Write-Host "     局域网内其他电脑也导入这个 root.crt 文件后，同样不会再提示。" -ForegroundColor DarkGray
        }
        Write-Host ""

        Write-Host "  📝 管理命令：" -ForegroundColor White
        $showContainerName = if ($script:deployedContainerName) { $script:deployedContainerName } else { "openclaw-pro" }
        Write-Host "     docker ps                      # 查看容器状态" -ForegroundColor Gray
        Write-Host "     docker logs $showContainerName       # 查看日志" -ForegroundColor Gray
        Write-Host "     docker stop $showContainerName       # 停止服务" -ForegroundColor Gray
        Write-Host "     docker start $showContainerName      # 启动服务" -ForegroundColor Gray
        Write-Host "     docker exec -it $showContainerName bash  # 进入容器终端" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  🔐 SSH 登录信息：" -ForegroundColor White
        if ($script:sshServiceReady) {
            Write-Host "     SSH 服务: 已启动" -ForegroundColor Green
        } else {
            Write-Host "     SSH 服务: 启动状态未知，请执行 docker logs openclaw-pro 排查" -ForegroundColor Yellow
        }
        Write-Host "     密码登录: 已禁用（仅密钥登录）" -ForegroundColor Green
        Write-Host "     Root 登录: 已禁用" -ForegroundColor Green

        # 显示普通用户登录信息
        $sshUser = if ($script:hostUserForSSH) { $script:hostUserForSSH } else { $env:USERNAME }
        if ($sshUser -and $sshUser -ne "root" -and $sshUser -ne "Administrator") {
            Write-Host "     登录用户: $sshUser" -ForegroundColor Green
            Write-Host "     登录命令: ssh ${sshUser}@<host> -p ${SshPort}" -ForegroundColor Cyan
            Write-Host "     容器内提权: 登录后执行 sudo -i" -ForegroundColor DarkGray
        } else {
            Write-Host "     登录用户: 未创建普通用户（以 Administrator 运行）" -ForegroundColor Yellow
            Write-Host "     建议: 以普通用户身份重新运行安装脚本" -ForegroundColor DarkGray
        }

        if ($script:sshInjectedKeyPath) {
            Write-Host "     公钥注入: 已自动注入 $script:sshInjectedKeyPath" -ForegroundColor Green
        } else {
            Write-Host "     公钥注入: 未自动注入，请手动配置 authorized_keys" -ForegroundColor Yellow
        }
        Write-Host ""
        Write-Host "  🔄 升级到新版本：" -ForegroundColor White
        Write-Host "     重新运行安装命令即可，脚本会自动检测版本差异：" -ForegroundColor DarkGray
        Write-Host "     irm https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-windows.ps1 | iex" -ForegroundColor Cyan
        Write-Host "     数据目录（home-data/root 与 home-data/用户名）不受影响，升级后原有配置和数据保留。" -ForegroundColor DarkGray
    } else {
        Write-Host ""
        Write-Host "  -------------------------------------------------" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  📍 可能的原因:" -ForegroundColor Cyan
        Write-Host "     • 端口被其他程序占用（重新运行脚本选择其他端口）" -ForegroundColor Gray
        Write-Host "     • Docker 镜像获取失败（网络问题）" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  🔍 排查步骤:" -ForegroundColor Cyan
        Write-Host "     docker ps -a                   # 检查所有容器" -ForegroundColor Gray
        Write-Host "     docker logs openclaw-pro       # 查看日志" -ForegroundColor Gray
        Write-Host "     netstat -ano | findstr :18789  # 检查端口占用" -ForegroundColor Gray
        Write-Host ""

        # 检查镜像是否已存在
        $imageCheck = & docker image inspect openclaw-pro 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✅ 镜像已加载，重新运行脚本即可（会跳过下载）" -ForegroundColor Green
        } else {
        Write-Host "  📥 手动获取镜像:" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "     方式1: 浏览器下载（推荐）" -ForegroundColor Yellow
        $manualTag = if ($script:latestReleaseTag) { $script:latestReleaseTag } elseif ($latestReleaseTag) { $latestReleaseTag } else { "v1.0.0" }
        Write-Host "     Lite版 (~250MB): https://github.com/$GITHUB_REPO/releases/download/${manualTag}/openclaw-pro-image-lite.tar.gz" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "     方式2: aria2c 多线程下载（推荐，需先安装 aria2）" -ForegroundColor Yellow
        Write-Host "     aria2c -x 8 -s 8 -k 2M --continue=true --retry-wait=3 --max-tries=0 <上述URL>" -ForegroundColor White
        Write-Host ""
        Write-Host "     方式3: curl 命令行（网络不稳定时可能失败）" -ForegroundColor Yellow
        Write-Host "     curl.exe -L -C - --retry 200 --retry-all-errors --retry-delay 3 -o <文件名> <上述URL>" -ForegroundColor White
        Write-Host ""
        Write-Host "     下载完成后执行:" -ForegroundColor Yellow
        Write-Host "     docker load -i <下载的.tar.gz文件>" -ForegroundColor White
        Write-Host "     然后重新运行安装脚本即可（会自动检测已加载的镜像）" -ForegroundColor Gray
        }
    }

    Write-Host ""
    Write-Host "  完整日志: $LOG_FILE" -ForegroundColor DarkGray
    Write-Host ""
}

function Show-RebootMessage {
    Write-Host ""
    Write-Host "  ==================================================" -ForegroundColor Yellow
    Write-Host "             需要重启计算机" -ForegroundColor Yellow
    Write-Host "  ==================================================" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  WSL2 安装完成，需要重启才能继续。" -ForegroundColor White
    Write-Host ""
    Write-Host "  重启后安装程序将自动继续（已创建计划任务）。" -ForegroundColor White
    Write-Host ""
    Write-Host "  -------------------------------------------------" -ForegroundColor DarkGray
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
    Write-Host "  ==================================================" -ForegroundColor Red
    Write-Host "             ❌ 安装失败" -ForegroundColor Red
    Write-Host "  ==================================================" -ForegroundColor Red
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

# --- Main ---------------------------------------------------------------------
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

    # -- Phase 1: Environment Detection ----------------------------------------
    Write-Step 1 5 "检测环境..."

    Assert-Administrator

    $buildNumber = Test-WindowsVersion

    # Detect Docker Desktop and WSL
    $hasDockerDesktop = Test-DockerDesktopInstalled
    $wslInstalled     = Test-Wsl2Installed
    $dockerDesktopMode = $false
    $ubuntuPresent = $false

    if ($hasDockerDesktop) {
        Write-OK "检测到 Docker Desktop 已安装"
        if (Test-DockerDesktopRunning) {
            Write-OK "Docker Desktop 正在运行"
        } else {
            Write-Warn "Docker Desktop 已安装但未运行"
        }
        $dockerDesktopMode = $true
    }

    if ($wslInstalled) {
        Write-OK "WSL2 已安装"
        $ubuntuPresent = Test-UbuntuInstalled
        if ($ubuntuPresent) {
            Write-OK "Ubuntu 发行版已存在"
        }
    }

    # -- If neither Docker Desktop nor WSL is available, let user choose --
    if (-not $hasDockerDesktop -and -not $wslInstalled) {
        Write-Host ""
        Write-Host "  ==================================================" -ForegroundColor Yellow
        Write-Host "         未检测到 Docker Desktop 或 WSL2" -ForegroundColor Yellow
        Write-Host "  ==================================================" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  请选择安装方式:" -ForegroundColor White
        Write-Host ""
        Write-Host "  [A] 方案A: Docker Desktop (推荐)" -ForegroundColor Cyan
        Write-Host "      |- 图形化管理界面，操作简单" -ForegroundColor Gray
        Write-Host "      |- 自带 WSL2 后端，无需单独配置" -ForegroundColor Gray
        Write-Host "      \- 需要手动下载安装 Docker Desktop" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  [B] 方案B: WSL2 + Docker Engine (自动)" -ForegroundColor Cyan
        Write-Host "      |- 全自动安装，无需手动操作" -ForegroundColor Gray
        Write-Host "      |- 轻量级，资源占用少" -ForegroundColor Gray
        Write-Host "      \- 安装后可能需要重启一次" -ForegroundColor Gray
        Write-Host ""

        $choice = ""
        while ($choice -ne "A" -and $choice -ne "B") {
            $choice = (Read-Host "  请输入 A 或 B").Trim().ToUpper()
            if ($choice -ne "A" -and $choice -ne "B") {
                Write-Host "  请输入 A 或 B" -ForegroundColor Red
            }
        }

        if ($choice -eq "A") {
            $dockerDesktopMode = $true
            Write-Host ""
            Write-Host "  ------------------------------------------------" -ForegroundColor DarkGray
            Write-Host ""
            Write-Host "  请先安装 Docker Desktop:" -ForegroundColor White
            Write-Host ""
            Write-Host "     1. 打开浏览器访问:" -ForegroundColor Yellow
            Write-Host "        https://www.docker.com/products/docker-desktop/" -ForegroundColor Cyan
            Write-Host ""
            Write-Host "     2. 点击 'Download for Windows' 下载安装包" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "     3. 运行安装包，按提示完成安装" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "     4. 启动 Docker Desktop 并等待其完全启动" -ForegroundColor Yellow
            Write-Host "        (系统托盘出现 Docker 鲸鱼图标，状态为 Running)" -ForegroundColor Gray
            Write-Host ""
            Write-Host "     5. 安装完毕后，重新运行本安装命令:" -ForegroundColor Yellow
            Write-Host "        irm $SCRIPT_URL | iex" -ForegroundColor Cyan
            Write-Host ""
            Write-Host "  ------------------------------------------------" -ForegroundColor DarkGray
            Write-Host ""

            # Try to open the browser automatically
            try {
                Start-Process "https://www.docker.com/products/docker-desktop/"
                Write-OK "已自动打开浏览器下载页面"
            } catch {
                Write-Info "请手动打开上述链接"
            }

            Write-Host ""
            Read-Host "  安装 Docker Desktop 后，按回车退出，然后重新运行安装命令"
            return
        } else {
            # Option B: auto-install WSL2
            Write-Info "将自动安装 WSL2 + Docker Engine"
        }
    } elseif ($hasDockerDesktop -and $wslInstalled) {
        # Both available, prefer Docker Desktop
        $dockerDesktopMode = $true
    }

    # Display selected mode
    if ($dockerDesktopMode) {
        Write-Host ""
        Write-Host "  安装模式: 方案A - Docker Desktop (本地)" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "  安装模式: 方案B - WSL2 + Docker Engine" -ForegroundColor Green
    }

    # Report WSL/Ubuntu status for the selected mode
    if (-not $dockerDesktopMode) {
        if (-not $wslInstalled) {
            Write-Info "WSL2 未安装，将进行安装"
        } elseif (-not $ubuntuPresent) {
            Write-Info "未找到 Ubuntu 发行版，将安装 $UBUNTU_DISTRO"
        }
    } else {
        if (-not $wslInstalled) {
            Write-Info "WSL2 未安装（Docker Desktop 模式下可选）"
        } elseif (-not $ubuntuPresent) {
            Write-Info "未找到 Ubuntu 发行版（Docker Desktop 模式下可选）"
        }
    }

    Write-Log "State: wslInstalled=$wslInstalled, ubuntuPresent=$ubuntuPresent, dockerDesktopMode=$dockerDesktopMode"

    # -- Phase 2: Install WSL2 if needed ---------------------------------------
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
            return
        } elseif ($result -eq "error") {
            Show-Error `
                "WSL2 安装" `
                "wsl --install 命令失败" `
                "请访问 https://aka.ms/wsl 手动安装 WSL2，然后重新运行此脚本"
            Read-Host "按回车退出"
            return
        }

        Write-OK "WSL2 + $UBUNTU_DISTRO 安装成功"

        # Re-check
        $wslInstalled  = Test-Wsl2Installed
        $ubuntuPresent = Test-UbuntuInstalled
    } else {
        Write-Step 2 5 "WSL2 已就绪，跳过安装"
        Write-OK "WSL2 + Ubuntu 均已安装，无需重复安装"
    }

    # -- Phase 3: Configure Docker ----------------------------------------------
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
                return
            }

            $dockerOK = Install-DockerInWsl -DistroName $distroName

            if (-not $dockerOK) {
                Show-Error `
                    "Docker Engine 安装" `
                    "在 WSL 中安装 Docker 失败" `
                    "请手动运行: wsl -d $distroName，然后参考 https://docs.docker.com/engine/install/ubuntu/ 安装 Docker"
                Read-Host "按回车退出"
                return
            }
        } else {
            Write-Step 3 5 "Docker 已安装，跳过"
            Write-OK "Docker Engine 已就绪"
        }
    }

    # -- Phase 4: Prepare container deployment ----------------------------------
    Write-Step 4 5 "准备容器部署..."

    if ($dockerDesktopMode) {
        # Docker Desktop mode: default to explicit ImageOnly (no source/repo download)
        $ImageOnly = $true
        $ImageOnlyExplicit = $true
        Write-Info "Docker Desktop 模式：仅部署容器（不拉取源码/部署包）..."

        # 检测当前目录是否已是部署目录（避免嵌套创建 openclaw-pro/openclaw-pro）
        $currentDir = (Get-Location).Path
        $curLeaf = Split-Path $currentDir -Leaf
        if ($curLeaf -eq 'openclaw-pro' -or ((Test-Path (Join-Path $currentDir "Dockerfile")) -and
            (Test-Path (Join-Path $currentDir "start-services.sh")))) {
            $parentDir = Split-Path $currentDir -Parent
            Write-Host ""
            Write-Host "  ⚠️  检测到当前目录已是 OpenClaw 部署目录:" -ForegroundColor Yellow
            Write-Host "     $currentDir" -ForegroundColor DarkGray
            Write-Host ""
            Write-Host "     [1] 在当前目录运行（部署目录: $currentDir）" -ForegroundColor White
            Write-Host "     [2] 切换到上级目录运行（默认，部署目录: $(Join-Path $parentDir 'openclaw-pro')）" -ForegroundColor White
            Write-Host ""
            Write-Host "  输入选择 [1/2，默认2]: " -NoNewline -ForegroundColor White
            $dirChoice = (Read-Host).Trim()

            if ($dirChoice -eq '1') {
                $localDeployDir = $currentDir
                Write-Info "在当前目录运行: $localDeployDir"
            } else {
                Set-Location $parentDir
                $currentDir = $parentDir
                $localDeployDir = Join-Path $currentDir "openclaw-pro"
                Write-Info "已切换到上级目录: $currentDir"
            }
        } else {
            $localDeployDir = Join-Path $currentDir "openclaw-pro"
            $homeBaseDir = $localDeployDir

            if (-not ($ImageOnly -and $ImageOnlyExplicit)) {
                Write-Host ""
                Write-Host "  安装目录确认:" -ForegroundColor Cyan
                Write-Host "     数据目录: $(Join-Path $localDeployDir 'home-data[-N]')" -ForegroundColor White
                Write-Host "     结构: home-data[-N]/root 与 home-data[-N]/用户名" -ForegroundColor DarkGray
                Write-Host ""
                Write-Host "     按回车确认，或输入新路径: " -NoNewline -ForegroundColor White
                $customBaseDir = (Read-Host).Trim()
                if ($customBaseDir) {
                    if (-not (Test-Path $customBaseDir)) {
                        New-Item -ItemType Directory -Path $customBaseDir -Force | Out-Null
                    }
                    Set-Location $customBaseDir
                    $currentDir = $customBaseDir
                    $localDeployDir = Join-Path $currentDir "openclaw-pro"
                    Write-Info "已切换安装目录: $currentDir"
                }
            } else {
                if (-not (Test-Path $localDeployDir)) { New-Item -ItemType Directory -Path $localDeployDir -Force | Out-Null }
            }
        }

        # 统一目录策略：镜像文件、日志、home-data 全部放在部署目录 openclaw-pro 下
        if (-not (Test-Path $localDeployDir)) { New-Item -ItemType Directory -Path $localDeployDir -Force | Out-Null }
        $homeBaseDir = $localDeployDir
        $TMP_DIR = $localDeployDir
        $newLogFile = Join-Path $localDeployDir "install-log.txt"
        if ($LOG_FILE -and (Test-Path $LOG_FILE) -and ($LOG_FILE -ne $newLogFile)) {
            try {
                $existingContent = Get-Content $LOG_FILE -ErrorAction SilentlyContinue
                if ($existingContent) { Add-Content -Path $newLogFile -Value $existingContent -ErrorAction SilentlyContinue }
            } catch { }
        }
        $LOG_FILE = $newLogFile
        # 若安装目录残留旧日志，尽量清理（忽略失败）
        $legacyInstallLog = Join-Path $SCRIPT_DIR "install-log.txt"
        if ($legacyInstallLog -ne $LOG_FILE -and (Test-Path $legacyInstallLog)) {
            Remove-Item $legacyInstallLog -Force -ErrorAction SilentlyContinue
        }
        $latestReleaseTag = ""
        $latestReleaseInfo = $null
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $releaseApi = "https://api.github.com/repos/$GITHUB_REPO/releases/latest"
            $latestReleaseInfo = Invoke-RestMethod -Uri $releaseApi -TimeoutSec 10 -ErrorAction Stop
            $latestReleaseTag = ($latestReleaseInfo.tag_name | ForEach-Object { "$_" }).Trim()
            $latestReleaseCommit = ""
            if ($latestReleaseInfo.target_commitish) {
                $latestReleaseCommit = $latestReleaseInfo.target_commitish
            }
            if ($latestReleaseTag) {
                $latestVer = $latestReleaseTag.TrimStart('v','V')
                if ($latestVer -and $latestVer -ne $SCRIPT_VERSION) {
                    # Version mismatch detected (silent when ImageOnly or remote execution)
                    # Previously warned to console; suppress to avoid noisy output during remote runs.
                }
            }
        } catch {
            Write-Log "Fetch latest release failed: $_"
        }

        $needDeployPackageDownload = -not (Test-Path "$localDeployDir\Dockerfile")

        # ImageOnly 模式下跳过部署包/源码下载
        if ($ImageOnly -and $ImageOnlyExplicit) {
            # ImageOnly explicitly requested: skip deploy package/source downloads
            $needDeployPackageDownload = $false
        }
        if (-not $needDeployPackageDownload -and -not ($ImageOnly -and $ImageOnlyExplicit)) {
            $localDeployVersion = ""
            $localDeployCommitHash = ""
            if ($ImageOnly -and $ImageOnlyExplicit) {
                # Explicit ImageOnly: skip source/deploy package
                $needDeployPackageDownload = $false
                $hasGit = $false
            } elseif (Test-Path "$localDeployDir\.git") {
                try {
                    $localDeployVersion = (& git -C $localDeployDir describe --tags --abbrev=0 2>$null | Select-Object -First 1)
                    $localDeployCommitHash = (& git -C $localDeployDir rev-parse HEAD 2>$null | Select-Object -First 1)
                } catch { }
            }
            if (-not $localDeployVersion -and (Test-Path "$localDeployDir\.release-version")) {
                try {
                    $localDeployVersion = (Get-Content "$localDeployDir\.release-version" -ErrorAction SilentlyContinue | Select-Object -First 1)
                } catch { }
            }
            if (-not $localDeployCommitHash -and (Test-Path "$localDeployDir\.release-commit")) {
                try {
                    $localDeployCommitHash = (Get-Content "$localDeployDir\.release-commit" -ErrorAction SilentlyContinue | Select-Object -First 1)
                } catch { }
            }

            Write-OK "检测到本地部署包"
            if ($localDeployVersion) {
                Write-Info "本地部署包版本: $localDeployVersion"
            }
            if ($localDeployCommitHash) {
                Write-Info "本地 commit: $($localDeployCommitHash.Substring(0, [Math]::Min(12, $localDeployCommitHash.Length)))"
            }

            # 版本比较：tag + commit hash 双校验
            $deployTagMatch = ($latestReleaseTag -and $localDeployVersion -and $localDeployVersion -eq $latestReleaseTag)
            $deployCommitMatch = $true  # 默认为 true（无法获取远端 commit 时不影响判断）
            if ($latestReleaseCommit -and $localDeployCommitHash) {
                $deployCommitMatch = ($localDeployCommitHash.StartsWith($latestReleaseCommit) -or $latestReleaseCommit.StartsWith($localDeployCommitHash))
                if (-not $deployCommitMatch) {
                    Write-Warn "commit hash 不一致 (本地: $($localDeployCommitHash.Substring(0,7)) vs 远端: $($latestReleaseCommit.Substring(0,7)))，可能本地文件已被修改"
                }
            }

            if ($deployTagMatch -and $deployCommitMatch) {
                Write-Host "" 
                Write-Host "  本地部署包与远端版本一致 ($latestReleaseTag)" -ForegroundColor Green
                Write-Host "  请选择部署包策略:" -ForegroundColor Cyan
                Write-Host "     [1] 使用本地部署包（默认）" -ForegroundColor White
                Write-Host "     [2] 重新更新部署包" -ForegroundColor White
                Write-Host "" 
                Write-Host "  输入选择 [1/2，默认1]: " -NoNewline -ForegroundColor White
                $deployChoice = (Read-Host).Trim()
                if ($deployChoice -eq '2') {
                    $needDeployPackageDownload = $true
                    Write-Info "已选择更新部署包"
                }
            } else {
                Write-Host "" 
                Write-Host "  发现部署包版本可能落后" -ForegroundColor Yellow
                if ($latestReleaseTag) {
                    Write-Host "     远端最新: $latestReleaseTag" -ForegroundColor DarkGray
                }
                if ($localDeployVersion) {
                    Write-Host "     本地版本: $localDeployVersion" -ForegroundColor DarkGray
                }
                if (-not ($ImageOnly -and $ImageOnlyExplicit)) {
                    Write-Host "  请选择部署包策略:" -ForegroundColor Cyan
                    Write-Host "     [1] 使用本地部署包" -ForegroundColor White
                    Write-Host "     [2] 更新到最新部署包（默认）" -ForegroundColor White
                    Write-Host "" 
                    Write-Host "  输入选择 [1/2，默认2]: " -NoNewline -ForegroundColor White
                    $deployChoice = (Read-Host).Trim()
                    if ($deployChoice -ne '1') {
                        $needDeployPackageDownload = $true
                        Write-Info "已选择更新部署包"
                    }
                } else {
                    # Explicit ImageOnly: skip deploy package strategy selection (silent)
                }
            }
        }

        if ($needDeployPackageDownload) {
            Write-Info "正在下载部署包到 $localDeployDir ..."

            # Prefer git if available, otherwise download ZIP from GitHub
            $hasGit = $null -ne (Get-Command git -ErrorAction SilentlyContinue)

            if ($hasGit) {
                if (Test-Path "$localDeployDir\.git") {
                    Write-Info "检测到本地 git 仓库，正在更新..."
                    try {
                        $pushedLocal = $false
                        if (Test-Path $localDeployDir) { try { Push-Location $localDeployDir; $pushedLocal = $true } catch { $pushedLocal = $false } }
                        & git fetch --tags --depth 1 origin 2>&1 | Out-Null
                        $latestTag = if ($latestReleaseTag) { $latestReleaseTag } else { (& git tag --sort=-v:refname 2>$null | Select-Object -First 1) }
                        if ($latestTag) {
                            & git checkout $latestTag 2>&1 | Out-Null
                            Write-OK "仓库更新完成 (Release: $latestTag)"
                        } else {
                            & git pull --ff-only 2>&1 | Out-Null
                            Write-OK "仓库更新完成 (main 分支)"
                        }
                        if ($latestTag) {
                            $latestTag | Set-Content (Join-Path $localDeployDir ".release-version") -Force
                        }
                        # 保存 commit hash 用于完整性校验
                        try {
                            $commitHash = (& git rev-parse HEAD 2>$null | Select-Object -First 1)
                            if ($commitHash) {
                                $commitHash | Set-Content (Join-Path $localDeployDir ".release-commit") -Force
                            }
                        } catch { }
                        Pop-Location
                    } catch {
                        Write-Warn "git 仓库更新失败，尝试 ZIP 下载..."
                        Pop-Location -ErrorAction SilentlyContinue
                        $hasGit = $false
                    }
                } else {
                    Write-Info "使用 git clone 下载..."
                    try {
                        if (Test-Path $localDeployDir) {
                            Remove-Item $localDeployDir -Recurse -Force
                        }
                        # Clone with tags so we can checkout the latest release
                        & git clone --depth 1 https://github.com/cintia09/openclaw-pro.git "$localDeployDir" 2>&1
                        if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
                        # Try to switch to latest release tag
                        try {
                            $pushedLocal = $false
                            if (Test-Path $localDeployDir) { try { Push-Location $localDeployDir; $pushedLocal = $true } catch { $pushedLocal = $false } }
                            & git fetch --tags --depth 1 2>&1 | Out-Null
                            $latestTag = if ($latestReleaseTag) { $latestReleaseTag } else { (& git tag --sort=-v:refname 2>$null | Select-Object -First 1) }
                            if ($latestTag) {
                                & git checkout $latestTag 2>&1 | Out-Null
                                $latestTag | Set-Content (Join-Path $localDeployDir ".release-version") -Force
                                Write-OK "仓库克隆完成 (Release: $latestTag)"
                            } else {
                                Write-OK "仓库克隆完成 (main 分支)"
                            }
                            # 保存 commit hash 用于完整性校验
                            try {
                                $commitHash = (& git rev-parse HEAD 2>$null | Select-Object -First 1)
                                if ($commitHash) {
                                    $commitHash | Set-Content (Join-Path $localDeployDir ".release-commit") -Force
                                }
                            } catch { }
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

                    # -- Resume-capable download with Range header --
                    $existingSize = 0
                    if (Test-Path $zipFile) {
                        $existingSize = (Get-Item $zipFile).Length
                        if ($existingSize -gt 0) {
                            Write-Info "发现未完成的下载 ($([math]::Round($existingSize / 1MB, 1))MB)，尝试断点续传..."
                        }
                    }

                    $sw = [System.Diagnostics.Stopwatch]::StartNew()
                    $spinner = @("|","/","-","\","|","/","-","\","|","/")
                    $sidx = 0
                    $bufferSize = 65536  # 64KB

                    # Create HTTP request with Range header for resume
                    $request = [System.Net.HttpWebRequest]::Create($zipUrl)
                    $request.Timeout = 30000
                    $request.ReadWriteTimeout = 30000
                    $request.AllowAutoRedirect = $true
                    $request.UserAgent = "OpenClaw-Installer/1.0"

                    $resumed = $false
                    if ($existingSize -gt 0) {
                        $request.AddRange($existingSize)
                    }

                    $response = $request.GetResponse()
                    $totalSize = $response.ContentLength
                    $statusCode = [int]$response.StatusCode

                    if ($statusCode -eq 206 -and $existingSize -gt 0) {
                        # Server supports resume — 206 Partial Content
                        $totalSize = $existingSize + $response.ContentLength
                        $resumed = $true
                        Write-OK "服务器支持续传，从 $([math]::Round($existingSize / 1MB, 1))MB 处继续"
                    } elseif ($statusCode -eq 200) {
                        if ($existingSize -gt 0) {
                            Write-Warn "服务器不支持续传，将重新下载"
                        }
                        $existingSize = 0  # re-download from start
                        $totalSize = $response.ContentLength
                    }

                    if ($totalSize -gt 0) {
                        Write-Info "正在下载部署包... (总计 $([math]::Round($totalSize / 1MB, 1))MB)"
                    } else {
                        Write-Info "正在下载部署包..."
                    }

                    $stream = $response.GetResponseStream()
                    $fileMode = if ($resumed) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
                    $fileStream = New-Object IO.FileStream($zipFile, $fileMode, [IO.FileAccess]::Write)
                    $buffer = New-Object byte[] $bufferSize
                    $downloadedThisSession = 0

                    try {
                        while (($read = $stream.Read($buffer, 0, $bufferSize)) -gt 0) {
                            $fileStream.Write($buffer, 0, $read)
                            $downloadedThisSession += $read
                            $totalDownloaded = $existingSize + $downloadedThisSession

                            # Update progress display
                            $elapsed = $sw.Elapsed.ToString("mm\:ss")
                            $frame = $spinner[$sidx % $spinner.Count]
                            $sidx++

                            if ($totalSize -gt 0) {
                                $pct = [math]::Min(100, [math]::Floor(($totalDownloaded / $totalSize) * 100))
                                $dlMB = [math]::Round($totalDownloaded / 1MB, 1)
                                $totMB = [math]::Round($totalSize / 1MB, 1)
                                $barFill = [math]::Floor($pct / 5)
                                $bar = "[" + ("#" * $barFill) + ("-" * (20 - $barFill)) + "]"
                                Write-Host "`r  $frame $bar ${dlMB}MB / ${totMB}MB (${pct}%) $elapsed  " -NoNewline -ForegroundColor Cyan
                            } else {
                                $dlMB = [math]::Round($totalDownloaded / 1MB, 1)
                                Write-Host "`r  $frame 下载中: ${dlMB}MB ($elapsed)         " -NoNewline -ForegroundColor Yellow
                            }
                        }
                    } finally {
                        $fileStream.Close()
                        $stream.Close()
                        $response.Close()
                    }
                    Write-Host "`r$(' ' * 80)`r" -NoNewline

                    $zipSize = [math]::Round((Get-Item $zipFile).Length / 1MB, 1)
                    if ($resumed) {
                        Write-OK "续传下载完成 (${zipSize}MB)"
                    } else {
                        Write-OK "下载完成 (${zipSize}MB)"
                    }

                    # -- File integrity check --
                    Write-Info "正在验证文件完整性..."
                    try {
                        # 1. Basic size check
                        if ((Get-Item $zipFile).Length -lt 1024) {
                            throw "文件过小 (< 1KB)，可能下载不完整"
                        }

                        # 2. ZIP magic number check (PK)
                        $header = [byte[]](Get-Content $zipFile -Encoding Byte -TotalCount 4)
                        if ($header[0] -ne 0x50 -or $header[1] -ne 0x4B -or $header[2] -ne 0x03 -or $header[3] -ne 0x04) {
                            throw "文件不是有效的 ZIP 格式（文件头校验失败）"
                        }

                        # 3. Try opening as ZIP archive to validate structure
                        Add-Type -AssemblyName System.IO.Compression.FileSystem
                        $zip = [IO.Compression.ZipFile]::OpenRead($zipFile)
                        $entryCount = $zip.Entries.Count
                        $zip.Dispose()

                        if ($entryCount -eq 0) {
                            throw "ZIP 文件为空，无任何条目"
                        }

                        # 4. Check for Dockerfile in the archive
                        $zip = [IO.Compression.ZipFile]::OpenRead($zipFile)
                        $hasDockerfile = $false
                        foreach ($entry in $zip.Entries) {
                            if ($entry.Name -eq "Dockerfile") {
                                $hasDockerfile = $true
                                break
                            }
                        }
                        $zip.Dispose()

                        if (-not $hasDockerfile) {
                            Write-Warn "ZIP 包中未找到 Dockerfile，可能是错误的包"
                        }

                        $hash = (Get-FileHash $zipFile -Algorithm SHA256).Hash.Substring(0, 12)
                        Write-OK "完整性验证通过 ($entryCount 个文件, SHA256: ${hash}...)"
                    } catch {
                        Write-Err "文件完整性检查失败: $_"
                        Write-Info "删除损坏的下载文件，请重新运行安装命令"
                        Remove-Item $zipFile -Force -ErrorAction SilentlyContinue
                        Read-Host "按回车退出"
                        return
                    }

                    # Extract ZIP（home-data 已独立于部署目录，无需备份）
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
                        if ($latestReleaseTag) {
                            $latestReleaseTag | Set-Content (Join-Path $localDeployDir ".release-version") -Force
                        }
                        if ($latestReleaseCommit) {
                            $latestReleaseCommit | Set-Content (Join-Path $localDeployDir ".release-commit") -Force
                        }
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
                    return
                }
            }
        }

        # Build and run with Docker
        Write-Step 5 5 "启动 OpenClaw..."
        Remove-ResumeTask
        Remove-InstallState

        # -- 检测已有容器 --
        $containerName = "openclaw-pro"   # 默认容器名
        $script:upgradeMode = $false

        # 查找所有 openclaw-pro* 容器
        $existingContainers = & docker ps -a --filter "name=openclaw-pro" --format "{{.Names}}|{{.Status}}|{{.Ports}}" 2>&1
        Write-Log "ContainerScan raw docker ps output:`n$($existingContainers | Out-String)"
        $runningContainers = @()
        $stoppedContainers = @()
        if ($existingContainers) {
            foreach ($line in $existingContainers) {
                if ($line -match '\S') {
                    if ($line -match 'Up ') {
                        $runningContainers += $line
                    } else {
                        $stoppedContainers += $line
                    }
                }
            }
        }
        Write-Log "ContainerScan classified: running=$($runningContainers.Count), stopped=$($stoppedContainers.Count)"

        # 清理已停止的容器
        foreach ($sc in $stoppedContainers) {
            $scName = ($sc -split '\|')[0]
            Write-Info "清理已停止的容器: $scName"
            & docker rm -f $scName 2>&1 | Out-Null
        }

        if ($runningContainers.Count -gt 0) {
            Write-Host "" 
            Write-Host "  ⚠️  发现正在运行的 OpenClaw 容器:" -ForegroundColor Yellow
            Write-Host ""
            $runningContainerMeta = @()
            foreach ($rc in $runningContainers) {
                $parts = $rc -split '\|'
                $rcName = $parts[0]
                $rcStatus = if ($parts.Count -ge 2) { $parts[1] } else { "" }
                $rcPorts = if ($parts.Count -ge 3) { $parts[2] } else { "" }
                Write-Log "RunningContainer found: name=$rcName status='$rcStatus' ports='$rcPorts'"
                $rcVersion = Get-ContainerReleaseVersion -ContainerName $rcName -HomeBaseDir $homeBaseDir
                $rcVersionText = if ($rcVersion) { $rcVersion } else { "未知" }
                $runningContainerMeta += @{
                    Name = $rcName
                    Status = $rcStatus
                    Ports = $rcPorts
                    VersionRaw = $rcVersion
                    VersionNorm = (Normalize-ReleaseVersion $rcVersion)
                }
                Write-Log "RunningContainer version resolved: name=$rcName raw='$rcVersion' norm='$(Normalize-ReleaseVersion $rcVersion)'"
                Write-Host "     容器: ${rcName}  版本: ${rcVersionText}  状态: ${rcStatus}  端口: ${rcPorts}" -ForegroundColor DarkGray
            }
            Write-Host ""

            $choice = $null
            $preferredUpgradeContainer = ""
            $targetReleaseNorm = Normalize-ReleaseVersion $latestReleaseTag
            if ($targetReleaseNorm) {
                $outdated = @($runningContainerMeta | Where-Object {
                    $_.VersionNorm -and ($_.VersionNorm -ne $targetReleaseNorm)
                })
                if ($outdated.Count -gt 0) {
                    $hotUpdateEligible = @()
                    $hotUpdateReinstallConfirmed = $false
                    foreach ($item in $outdated) {
                        $ed = Get-ContainerEdition -ContainerName $item.Name
                        if (-not $ed) { $ed = 'lite' }
                        $localDfHash = Get-ContainerDockerfileHash -ContainerName $item.Name

                        $remoteCandidates = @()
                        $remotePrimary = Get-RemoteDockerfileHash -ReleaseTag $latestReleaseTag -Edition $ed
                        if ($remotePrimary) { $remoteCandidates += $remotePrimary }
                        $altEdition = if ($ed -eq 'lite') { 'full' } else { 'lite' }
                        $remoteAlt = Get-RemoteDockerfileHash -ReleaseTag $latestReleaseTag -Edition $altEdition
                        if ($remoteAlt) { $remoteCandidates += $remoteAlt }
                        $remoteCandidates = @($remoteCandidates | Select-Object -Unique)

                        $currentCandidates = @()
                        if ($localDfHash) { $currentCandidates += $localDfHash }

                        if ($currentCandidates.Count -eq 0) {
                            $itemVersionTagRaw = ("$($item.VersionRaw)").Trim()
                            $itemVersionTagNorm = Normalize-ReleaseVersion $item.VersionRaw
                            $itemVersionRefs = @()
                            if ($itemVersionTagRaw) { $itemVersionRefs += $itemVersionTagRaw }
                            if ($itemVersionTagNorm) {
                                if (-not ($itemVersionRefs -contains $itemVersionTagNorm)) { $itemVersionRefs += $itemVersionTagNorm }
                                $itemVersionTagWithV = "v$itemVersionTagNorm"
                                if (-not ($itemVersionRefs -contains $itemVersionTagWithV)) { $itemVersionRefs += $itemVersionTagWithV }
                            }

                            foreach ($itemVersionTag in $itemVersionRefs) {
                                $curPrimary = Get-RemoteDockerfileHash -ReleaseTag $itemVersionTag -Edition $ed
                                if ($curPrimary) { $currentCandidates += $curPrimary }
                                $curAlt = Get-RemoteDockerfileHash -ReleaseTag $itemVersionTag -Edition $altEdition
                                if ($curAlt) { $currentCandidates += $curAlt }
                            }
                        }
                        $currentCandidates = @($currentCandidates | Select-Object -Unique)

                        $canHotUpdate = $false
                        foreach ($ch in $currentCandidates) {
                            if ($remoteCandidates -contains $ch) {
                                $canHotUpdate = $true
                                break
                            }
                        }

                        if ($canHotUpdate) {
                            $hotUpdateEligible += $item
                        }
                    }

                    if ($hotUpdateEligible.Count -gt 0) {
                        Write-Host "  💡 检测到新 Release 且可热更新（目标版本: $latestReleaseTag，无需完整重装）:" -ForegroundColor Cyan
                        foreach ($item in $hotUpdateEligible) {
                            $oldV = if ($item.VersionRaw) { $item.VersionRaw } else { "未知" }
                            Write-Host "     $($item.Name): $oldV -> $latestReleaseTag，建议先在 Web 面板 → 系统更新 执行热更新" -ForegroundColor DarkGray
                        }
                        Write-Host ""
                        Write-Host "  推荐操作:" -ForegroundColor Cyan
                        Write-Host "     [默认 N] 先执行 Web 热更新（推荐）" -ForegroundColor White
                        Write-Host "     [输入 y] 继续完整重装流程" -ForegroundColor White
                        Write-Host "" 
                        Write-Host "  ⚠️  完整重装风险提示:" -ForegroundColor Yellow
                        Write-Host "     - 将删除并重建容器（容器文件系统会重置）" -ForegroundColor Yellow
                        Write-Host "     - 容器内手动安装的软件/临时文件可能丢失" -ForegroundColor Yellow
                        Write-Host "     - 挂载的 home-data（root/用户名）与配置会保留" -ForegroundColor Green
                        Write-Host ""
                        Write-Host "  是否继续执行安装重装流程？[y/N]: " -NoNewline -ForegroundColor White
                        $continueInstall = (Read-Host).Trim().ToLower()
                        if ($continueInstall -ne 'y' -and $continueInstall -ne 'yes') {
                            Write-Host ""
                            Write-Host "  已取消本次安装流程，请在 Web 面板执行热更新。" -ForegroundColor Yellow
                            Write-Host "  热更新后可再次运行安装脚本（如有需要）。" -ForegroundColor DarkGray
                            return
                        }
                        $hotUpdateReinstallConfirmed = $true
                    }

                    Write-Warn "检测到容器版本与目标版本不匹配（目标: $latestReleaseTag）"
                    foreach ($item in $outdated) {
                        $oldV = if ($item.VersionRaw) { $item.VersionRaw } else { "未知" }
                        Write-Host "     $($item.Name): $oldV -> $latestReleaseTag" -ForegroundColor Yellow
                    }
                    Write-Host ""
                    $doReinstall = $hotUpdateReinstallConfirmed
                    if (-not $doReinstall) {
                        Write-Host "  是否先执行升级重装（删除旧容器，保留配置和 home-data 的 root/用户名数据）？[Y/n]: " -NoNewline -ForegroundColor White
                        $upgradeFirst = (Read-Host).Trim().ToLower()
                        if (-not $upgradeFirst -or $upgradeFirst -eq 'y' -or $upgradeFirst -eq 'yes') {
                            $doReinstall = $true
                        }
                    }
                    if ($doReinstall) {
                        $choice = '2'
                        if ($outdated.Count -eq 1) {
                            $preferredUpgradeContainer = $outdated[0].Name
                        } else {
                            Write-Host ""
                            Write-Host "  请选择要升级的容器:" -ForegroundColor Cyan
                            for ($i = 0; $i -lt $outdated.Count; $i++) {
                                $item = $outdated[$i]
                                $oldV = if ($item.VersionRaw) { $item.VersionRaw } else { "未知" }
                                Write-Host "     [$($i + 1)] $($item.Name)  (版本: $oldV  端口: $($item.Ports))" -ForegroundColor White
                            }
                            Write-Host ""
                            Write-Host "  输入选择 [默认1]: " -NoNewline -ForegroundColor White
                            $upIdx = (Read-Host).Trim()
                            if ($upIdx -match '^\d+$' -and [int]$upIdx -ge 1 -and [int]$upIdx -le $outdated.Count) {
                                $preferredUpgradeContainer = $outdated[[int]$upIdx - 1].Name
                            } else {
                                $preferredUpgradeContainer = $outdated[0].Name
                            }
                        }
                        $preferredHomeDataName = "home-data"
                        if ($preferredUpgradeContainer -match '^openclaw-pro-(\d+)$') {
                            $preferredHomeDataName = "home-data-$($Matches[1])"
                        }
                        Write-Info "将优先执行升级重装（保留配置和 $preferredHomeDataName）"
                    }
                }
            }

            if (-not $choice) {
                Write-Host "  请选择操作:" -ForegroundColor White
                Write-Host "     [1] 新建一个容器（不删除旧容器）" -ForegroundColor Gray
                Write-Host "     [2] 重新安装容器（删除旧容器，保留配置和 home-data 的 root/用户名数据，默认沿用旧配置）" -ForegroundColor Gray
                Write-Host "     [3] 重新安装容器（删除旧容器 + 配置 + home-data 的 root/用户名数据）" -ForegroundColor Gray
                Write-Host ""
                Write-Host "  输入选择 [2]: " -NoNewline -ForegroundColor White
                $choice = (Read-Host).Trim()
                if (-not $choice) { $choice = '2' }
            }

            if ($choice -eq '2' -or $choice -eq '3') {
                Write-Host ""
                if ($choice -eq '3') {
                    Write-Host "  ⚠️  高风险操作：将删除旧容器 + 配置 + home-data 的 root/用户名数据（不可恢复）" -ForegroundColor Yellow
                } else {
                    Write-Host "  ⚠️  将删除并重建旧容器（配置与 home-data 的 root/用户名数据保留）" -ForegroundColor Yellow
                }
                Write-Host "  请输入 YES 确认继续: " -NoNewline -ForegroundColor White
                $confirmReinstall = (Read-Host).Trim()
                if ($confirmReinstall.ToUpperInvariant() -ne 'YES') {
                    Write-Host ""
                    Write-Host "  未输入 YES，已取消本次操作。" -ForegroundColor Yellow
                    return
                }
            }

            if ($choice -eq '1') {
                # 保留旧容器，生成新容器名和独立数据目录
                $idx = 2
                while ($true) {
                    $candidate = "openclaw-pro-$idx"
                    $existing = & docker ps -a --filter "name=$candidate" --format "{{.Names}}" 2>&1
                    if (-not ($existing -match $candidate)) {
                        $containerName = $candidate
                        break
                    }
                    $idx++
                    if ($idx -gt 20) {
                        $randId = Get-Random -Maximum 999
                        $containerName = "openclaw-pro-$randId"
                        $idx = $randId
                        break
                    }
                }
                Write-Info "将创建新容器: $containerName（数据目录: home-data-$idx，位于部署目录下）"
            } elseif ($choice -eq '2') {
                # -- 升级模式：读取旧容器对应的配置，删除旧容器后复用相同配置 --
                $upgradeContainerName = ""
                if ($preferredUpgradeContainer) {
                    $upgradeContainerName = $preferredUpgradeContainer
                } elseif ($runningContainers.Count -eq 1) {
                    $upgradeContainerName = ($runningContainers[0] -split '\|')[0]
                } else {
                    Write-Host ""
                    Write-Host "  请选择要升级的容器:" -ForegroundColor Cyan
                    $menuSource = if ($runningContainerMeta -and $runningContainerMeta.Count -gt 0) { $runningContainerMeta } else { $runningContainers }
                    for ($i = 0; $i -lt $menuSource.Count; $i++) {
                        if ($menuSource[$i] -is [hashtable]) {
                            $mv = if ($menuSource[$i].VersionRaw) { $menuSource[$i].VersionRaw } else { "未知" }
                            Write-Host "     [$($i + 1)] $($menuSource[$i].Name)  (版本: $mv  状态: $($menuSource[$i].Status)  端口: $($menuSource[$i].Ports))" -ForegroundColor White
                        } else {
                            $parts = $menuSource[$i] -split '\|'
                            Write-Host "     [$($i + 1)] $($parts[0])  (状态: $($parts[1])  端口: $($parts[2]))" -ForegroundColor White
                        }
                    }
                    Write-Host ""
                    Write-Host "  输入选择 [默认1]: " -NoNewline -ForegroundColor White
                    $upChoice = (Read-Host).Trim()
                    if ($upChoice -match '^\d+$' -and [int]$upChoice -ge 1 -and [int]$upChoice -le $menuSource.Count) {
                        if ($menuSource[[int]$upChoice - 1] -is [hashtable]) {
                            $upgradeContainerName = $menuSource[[int]$upChoice - 1].Name
                        } else {
                            $upgradeContainerName = ($menuSource[[int]$upChoice - 1] -split '\|')[0]
                        }
                    } else {
                        if ($menuSource[0] -is [hashtable]) {
                            $upgradeContainerName = $menuSource[0].Name
                        } else {
                            $upgradeContainerName = ($menuSource[0] -split '\|')[0]
                        }
                    }
                }
                $containerName = $upgradeContainerName

                # 读取旧容器的配置
                $upgradeHomeDataName = "home-data"
                if ($containerName -match '^openclaw-pro-(\d+)$') {
                    $upgradeHomeDataName = "home-data-$($Matches[1])"
                }
                $upgradeConfigFile = Join-Path $homeBaseDir "$upgradeHomeDataName\.openclaw\docker-config.json"
                $upgradeConfig = $null
                if (Test-Path $upgradeConfigFile) {
                    try {
                        $upgradeConfig = Get-Content $upgradeConfigFile -Raw | ConvertFrom-Json
                        Write-OK "读取到旧容器配置"
                    } catch {
                        Write-Warn "读取旧配置失败，将重新配置"
                    }
                }

                if ($upgradeConfig) {
                    # 显示旧配置让用户确认
                    Write-Host ""
                    Write-Host "  当前配置（将沿用）:" -ForegroundColor Cyan
                    if ($upgradeConfig.domain) {
                        $isIpDom = ($upgradeConfig.domain -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$')
                        if ($isIpDom) {
                            Write-Host "     IP: $($upgradeConfig.domain) (自签名 HTTPS)" -ForegroundColor White
                        } else {
                            Write-Host "     域名: $($upgradeConfig.domain)" -ForegroundColor White
                        }
                        Write-Host "     证书: $(if ($upgradeConfig.cert_mode -eq 'internal') { '自签证书' } else { 'Let''s Encrypt' })" -ForegroundColor White
                        Write-Host "     HTTP: $($upgradeConfig.http_port)  HTTPS: $($upgradeConfig.https_port)" -ForegroundColor White
                    } else {
                        Write-Host "     Gateway 端口: $($upgradeConfig.port)" -ForegroundColor White
                        Write-Host "     Web面板端口: $($upgradeConfig.web_port)" -ForegroundColor White
                    }
                    Write-Host "     数据目录: $(Join-Path $homeBaseDir $upgradeHomeDataName)" -ForegroundColor White
                    $upgradeSshPort = if ($upgradeConfig.ssh_port) { $upgradeConfig.ssh_port } else { 2222 }
                    Write-Host "     SSH 端口: $upgradeSshPort" -ForegroundColor White
                    Write-Host ""

                    # 构建 $deployConfig 复用旧配置
                    $script:upgradeMode = $true
                    $deployConfig = @{
                        GatewayPort  = if ($upgradeConfig.port) { [int]$upgradeConfig.port } else { [int]$OPENCLAW_PORT }
                        WebPort      = if ($upgradeConfig.web_port) { [int]$upgradeConfig.web_port } else { [int]$WEB_PANEL_PORT }
                        HttpPort     = if ($upgradeConfig.http_port) { [int]$upgradeConfig.http_port } else { 0 }
                        HttpsPort    = if ($upgradeConfig.https_port) { [int]$upgradeConfig.https_port } else { 0 }
                        SshPort      = [int]$upgradeSshPort
                        CertMode     = if ($upgradeConfig.cert_mode) { $upgradeConfig.cert_mode } else { "letsencrypt" }
                        Domain       = if ($upgradeConfig.domain) { $upgradeConfig.domain } else { "" }
                        PortArgs     = @()
                        AutoOpenFirewall = $true
                        HttpsEnabled = [bool]$upgradeConfig.domain
                    }
                    if ($deployConfig.HttpsEnabled) {
                        if ($deployConfig.CertMode -eq "letsencrypt") {
                            $deployConfig.PortArgs = @(
                                "-p", "$($deployConfig.HttpPort):80",
                                "-p", "$($deployConfig.HttpsPort):443"
                            )
                        } else {
                            $deployConfig.PortArgs = @(
                                "-p", "$($deployConfig.HttpsPort):443"
                            )
                        }
                    } else {
                        $deployConfig.PortArgs = @(
                            "-p", "$($deployConfig.GatewayPort):18789",
                            "-p", "$($deployConfig.WebPort):3000"
                        )
                    }
                    $deployConfig.PortArgs += @("-p", "$($deployConfig.SshPort):22")

                    $script:actualGatewayPort = $deployConfig.GatewayPort
                    $script:actualPanelPort   = $deployConfig.WebPort
                    $script:deployDomain      = $deployConfig.Domain
                    $script:certMode          = $deployConfig.CertMode
                    $script:httpPort          = $deployConfig.HttpPort
                    $script:httpsPort         = $deployConfig.HttpsPort
                    $script:sshPort           = $deployConfig.SshPort
                    $script:autoOpenFirewall  = $deployConfig.AutoOpenFirewall
                }

                # 停止并删除旧容器
                Write-Info "停止并删除: $containerName"
                & docker rm -f $containerName 2>&1 | Out-Null
                Start-Sleep -Seconds 2
                Write-OK "旧容器已删除"
                Write-Info "💡 数据目录 ($upgradeHomeDataName) 不会被删除，原有配置和数据均保留"
                Write-Info "   如需彻底删除数据，请手动删除目录: $(Join-Path $homeBaseDir $upgradeHomeDataName)"
            } else {
                # [3] 全量重装：删除旧容器，并删除对应配置与数据目录
                if ($runningContainers.Count -eq 1) {
                    # 只有一个，直接删除
                    $rcName = ($runningContainers[0] -split '\|')[0]
                    Write-Info "停止并删除: $rcName"
                    & docker rm -f $rcName 2>&1 | Out-Null
                    $containerName = $rcName   # 复用原容器名
                } else {
                    # 多个容器，列出让用户选择
                    Write-Host ""
                    Write-Host "  请选择要删除的容器:" -ForegroundColor Cyan
                    for ($i = 0; $i -lt $runningContainers.Count; $i++) {
                        $parts = $runningContainers[$i] -split '\|'
                        Write-Host "     [$($i + 1)] $($parts[0])  (状态: $($parts[1])  端口: $($parts[2]))" -ForegroundColor White
                    }
                    Write-Host "     [A] 全部删除" -ForegroundColor White
                    Write-Host ""
                    Write-Host "  输入选择 [编号/A，默认A]: " -NoNewline -ForegroundColor White
                    $delChoice = (Read-Host).Trim().ToUpper()

                    if ($delChoice -match '^\d+$' -and [int]$delChoice -ge 1 -and [int]$delChoice -le $runningContainers.Count) {
                        # 删除指定容器
                        $selIdx = [int]$delChoice - 1
                        $rcName = ($runningContainers[$selIdx] -split '\|')[0]
                        Write-Info "停止并删除: $rcName"
                        & docker rm -f $rcName 2>&1 | Out-Null
                        $containerName = $rcName   # 复用被删除容器的名字
                    } else {
                        # 全部删除
                        foreach ($rc in $runningContainers) {
                            $rcName = ($rc -split '\|')[0]
                            Write-Info "停止并删除: $rcName"
                            & docker rm -f $rcName 2>&1 | Out-Null
                        }
                        # 复用默认容器名 openclaw-pro
                        $containerName = "openclaw-pro"
                    }
                }
                Start-Sleep -Seconds 2  # 等待端口释放
                Write-OK "旧容器已删除"
                $delHomeDataName = "home-data"
                if ($containerName -match '^openclaw-pro-(\d+)$') {
                    $delHomeDataName = "home-data-$($Matches[1])"
                }
                $delHomeDataPath = Join-Path $homeBaseDir $delHomeDataName
                $delConfigPath = Join-Path $delHomeDataPath ".openclaw"
                if (Test-Path $delConfigPath) {
                    try { Remove-Item $delConfigPath -Recurse -Force -ErrorAction Stop; Write-Info "已删除旧配置目录: $delConfigPath" } catch { Write-Warn "删除旧配置目录失败: $delConfigPath" }
                }
                if (Test-Path $delHomeDataPath) {
                    try { Remove-Item $delHomeDataPath -Recurse -Force -ErrorAction Stop; Write-Info "已删除旧数据目录: $delHomeDataPath" } catch { Write-Warn "删除旧数据目录失败: $delHomeDataPath" }
                }
            }
        }

        if (-not $launched) {

        # Interactive port/domain configuration (upgrade mode skips this)
        if ($script:upgradeMode -and $deployConfig) {
            Write-OK "升级模式：沿用旧容器配置，跳过端口/域名配置"
        } else {
            $deployConfig = Get-DeployConfig
            $script:actualGatewayPort = $deployConfig.GatewayPort
            $script:actualPanelPort   = $deployConfig.WebPort
            $script:deployDomain      = $deployConfig.Domain
            $script:certMode          = $deployConfig.CertMode
            $script:httpPort          = $deployConfig.HttpPort
            $script:httpsPort         = $deployConfig.HttpsPort
            $script:sshPort           = $deployConfig.SshPort
            $script:autoOpenFirewall  = $deployConfig.AutoOpenFirewall
        }

        Write-Info "正在准备镜像..."
        try {
            $pushedLocal = $false
            if (Test-Path $localDeployDir) {
                try { Push-Location $localDeployDir; $pushedLocal = $true } catch { $pushedLocal = $false }
            }

            # 策略: 检查本地已有镜像 → 下载Release tar.gz → GHCR拉取 → 本地构建
            $imageReady = $false
            $forceRefreshImage = $false

            # 发布仅保留 lite 版本
            $assetName = "openclaw-pro-image-lite.tar.gz"
            Write-Host ""
            $script:imageEdition = "lite"
            $assetName = "openclaw-pro-image-lite.tar.gz"
            Write-Info "发布仅保留 Lite 镜像，已自动选择 lite"
            if ($latestReleaseTag) {
                Write-Info "远端目标版本: $latestReleaseTag ($script:imageEdition)"
            }

            # -- 尝试 0: 检查镜像是否已存在 --
            $existingImage = & docker image inspect openclaw-pro 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-OK "检测到本地镜像 openclaw-pro"
                $localImageReleaseTag = ""
                # 根据容器名确定对应的数据目录（openclaw-pro → home-data, openclaw-pro-2 → home-data-2）
                $tagHomeDataName = "home-data"
                if ($containerName -match '^openclaw-pro-(\d+)$') {
                    $tagHomeDataName = "home-data-$($Matches[1])"
                }

                # 检测本地镜像的 tag（lite/full/latest）以便与用户选择的镜像类型比对
                $localImageEdition = "unknown"
                try {
                    $localTags = (& docker images --format '{{.Repository}}:{{.Tag}}' 2>$null) -join ';'
                    if ($localTags -match 'openclaw-pro:lite') { $localImageEdition = 'lite' }
                    elseif ($localTags -match 'openclaw-pro:full') { $localImageEdition = 'full' }
                    elseif ($localTags -match 'openclaw-pro:latest') { $localImageEdition = 'latest' }
                    if ($localTags) { Write-Info "本地镜像标签: $localTags (detected edition: $localImageEdition)" }
                } catch { }

                # 若未记录本地版本标记，尝试从本地镜像 tag 反推出 release 版本
                if (-not $localImageReleaseTag -and $localTags) {
                    try {
                        $mainRepoTag = (& docker image inspect openclaw-pro:latest --format '{{index .RepoTags 0}}' 2>$null | Select-Object -First 1)
                        if ($mainRepoTag -and $mainRepoTag -match ':(v\d+\.\d+\.\d+(?:[-\w\.]*)?)$') {
                            $derived = ($Matches[1] -replace '(-lite|-full)$','')
                            if ($derived) {
                                $localImageReleaseTag = $derived
                                Write-Info "根据当前主镜像标签推断版本: $localImageReleaseTag"
                            }
                        }
                    } catch { }
                }

                # 读取保存的镜像 digest，并与当前实际镜像 ID 对比
                $localImageDigest = ""
                $imageDigestFile = Join-Path $homeBaseDir "$tagHomeDataName\.openclaw\image-digest.txt"
                if (Test-Path $imageDigestFile) {
                    $localImageDigest = (Get-Content $imageDigestFile -ErrorAction SilentlyContinue | Select-Object -First 1)
                }
                $currentImageId = (& docker image inspect openclaw-pro --format '{{.Id}}' 2>$null)
                if ($currentImageId -and $localImageDigest) {
                    if ($currentImageId -eq $localImageDigest) {
                        Write-Info "镜像 digest 校验通过"
                    } else {
                        Write-Warn "镜像 digest 不一致 — 本地镜像可能已被修改或重建"
                    }
                } elseif ($currentImageId) {
                    Write-Info "镜像 ID: $($currentImageId.Substring(0, [Math]::Min(19, $currentImageId.Length)))"
                }

                $effectiveLatestTag = $latestReleaseTag
                if (-not $effectiveLatestTag) {
                    try {
                        $releaseApi = "https://api.github.com/repos/$GITHUB_REPO/releases/latest"
                        $tmpReleaseInfo = Invoke-RestMethod -Uri $releaseApi -TimeoutSec 10 -ErrorAction Stop
                        $effectiveLatestTag = ($tmpReleaseInfo.tag_name | ForEach-Object { "$_" }).Trim()
                    } catch { }
                }

                # 自动镜像策略：不再二次询问用户
                $shouldRefreshImage = $false
                $refreshReason = ""
                if ($effectiveLatestTag -and ($localImageReleaseTag -ne $effectiveLatestTag)) {
                    $shouldRefreshImage = $true
                    $refreshReason = "远端最新: $effectiveLatestTag，本地: $(if ($localImageReleaseTag) { $localImageReleaseTag } else { '未知' })"
                }
                if ($localImageEdition -and $localImageEdition -ne 'unknown' -and $localImageEdition -ne $script:imageEdition) {
                    $shouldRefreshImage = $true
                    $refreshReason = "本地镜像版本类型: $localImageEdition，与所选 $($script:imageEdition) 不一致"
                }
                if ($localImageDigest -and $currentImageId -and $currentImageId -ne $localImageDigest) {
                    $shouldRefreshImage = $true
                    $refreshReason = "本地镜像 digest 与记录不一致"
                }

                if ($shouldRefreshImage) {
                    $forceRefreshImage = $true
                    if ($refreshReason) { Write-Info "自动判定需要刷新镜像：$refreshReason" }
                    & docker rmi -f openclaw-pro 2>&1 | Out-Null
                    Start-Sleep -Milliseconds 500
                } else {
                    Write-OK "自动判定使用本地镜像（版本一致），跳过下载/构建"
                    $imageReady = $true
                }
            }

            # -- 尝试 1: 下载预构建镜像 tar.gz（分块断点续传） --
            if (-not $imageReady) {
            Write-Info "检查 Release 预构建镜像..."

            try {
                $imageTar = Join-Path $TMP_DIR $assetName

                $imageUrl = ""
                $expectedSize = [long]0
                $tagText = if ($latestReleaseTag) { $latestReleaseTag } else { "latest" }

                # 优先尝试 GitHub API（能拿到精确 size + browser_download_url）
                try {
                    $releaseApi = "https://api.github.com/repos/$GITHUB_REPO/releases/latest"
                    $releaseInfo = Invoke-RestMethod -Uri $releaseApi -TimeoutSec 10 -ErrorAction Stop
                    $imageAsset = $releaseInfo.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
                    if ($imageAsset) {
                        $imageUrl = $imageAsset.browser_download_url
                        $expectedSize = [long]$imageAsset.size
                        $tagText = ($releaseInfo.tag_name | ForEach-Object { "$_" }).Trim()
                        Write-Info "GitHub API 返回: $tagText, $([math]::Round($expectedSize / 1MB, 1))MB"
                    }
                } catch {
                    # 很多网络环境 api.github.com 可能被拦；后面会走直链兜底
                    Write-Log "Release API fetch failed: $($_.Exception.Message)"
                    Write-Info "GitHub API 不可用，将通过代理镜像下载..."
                }

                # 构建下载源（API URL 优先；否则用 github.com 的 latest/download 直链）
                $baseUrls = @()
                if ($imageUrl) {
                    $baseUrls += $imageUrl
                } else {
                    if ($latestReleaseTag) {
                        $baseUrls += "https://github.com/$GITHUB_REPO/releases/download/$latestReleaseTag/$assetName"
                    }
                    $baseUrls += "https://github.com/$GITHUB_REPO/releases/latest/download/$assetName"
                }

                # 代理镜像列表（优先排在前面 — 国内直连 github.com/objects.githubusercontent.com 通常很慢或不通）
                $proxyPrefixes = @(
                    "https://ghfast.top/",
                    "https://mirror.ghproxy.com/",
                    "https://gh-proxy.com/",
                    "https://github.moeyy.xyz/",
                    "https://ghproxy.net/"
                )

                $downloadUrls = @()
                # 代理镜像优先
                foreach ($u in $baseUrls) {
                    foreach ($px in $proxyPrefixes) {
                        $downloadUrls += "${px}${u}"
                    }
                }
                # 直连 GitHub 放最后（国内通常很慢但偶尔可用）
                $downloadUrls += $baseUrls

                if ($expectedSize -le 0) {
                    Write-Info "检测文件大小 (探测 $($downloadUrls.Count) 个下载源)..."
                    $expectedSize = Get-RemoteFileSize -Urls $downloadUrls
                    if ($expectedSize -gt 0) {
                        Write-Info "文件大小: $([math]::Round($expectedSize / 1MB, 1))MB (通过代理探测)"
                    }
                }

                $downloadOK = $false

                # 检测上次保留的完整 tar 文件（docker load 失败时不删除，避免重新下载）
                $tagFile = "$imageTar.tag"
                $diskTag = $null
                if (Test-Path $tagFile) { try { $diskTag = (Get-Content $tagFile -ErrorAction SilentlyContinue | Select-Object -First 1) } catch { $diskTag = $null } }

                if ((Test-Path $imageTar) -and (Get-Item $imageTar).Length -gt 50MB) {
                    $existingSize = (Get-Item $imageTar).Length
                    if ($expectedSize -gt 0 -and [math]::Abs($existingSize - $expectedSize) -lt 1MB) {
                        if ($tagText -and $diskTag -and $diskTag -eq "$tagText|$script:imageEdition") {
                            Write-OK "检测到已下载的镜像文件 ($([math]::Round($existingSize / 1MB, 1))MB)，版本匹配，跳过下载"
                            $downloadOK = $true
                        } elseif ($tagText -and $diskTag -and $diskTag -ne "$tagText|$script:imageEdition") {
                            Write-Warn "本地镜像文件版本 ($diskTag) 与远端 ($tagText|$script:imageEdition) 不一致，重新下载"
                            Remove-Item $imageTar -Force -ErrorAction SilentlyContinue
                            if (Test-Path $tagFile) { Remove-Item $tagFile -Force -ErrorAction SilentlyContinue }
                            $downloadOK = $false
                        } else {
                            # 文件大小匹配但缺少 tag 元数据：无法确认版本，必须重新下载
                            Write-Warn "检测到已下载镜像缺少版本元数据，无法确认版本，重新下载"
                            Remove-Item $imageTar -Force -ErrorAction SilentlyContinue
                            if (Test-Path $tagFile) { Remove-Item $tagFile -Force -ErrorAction SilentlyContinue }
                            $downloadOK = $false
                        }
                    } elseif ($expectedSize -le 0 -and $existingSize -gt 500MB) {
                        # 无法获取远端大小时，若本地文件 > 500MB 也认为可能是完整的
                        if ($diskTag -and $tagText -and $diskTag -ne "$tagText|$script:imageEdition") {
                            Write-Warn "本地镜像文件版本 ($diskTag) 与远端 ($tagText|$script:imageEdition) 不一致，重新下载"
                            Remove-Item $imageTar -Force -ErrorAction SilentlyContinue
                            if (Test-Path $tagFile) { Remove-Item $tagFile -Force -ErrorAction SilentlyContinue }
                        } elseif ($diskTag -and $tagText -and $diskTag -eq "$tagText|$script:imageEdition") {
                            Write-OK "检测到已下载的镜像文件，版本匹配，跳过下载"
                            $downloadOK = $true
                        } else {
                            # 缺少版本元数据：无法确认版本，必须重新下载
                            Write-Warn "检测到已下载镜像缺少版本元数据，无法确认版本，重新下载"
                            Remove-Item $imageTar -Force -ErrorAction SilentlyContinue
                            if (Test-Path $tagFile) { Remove-Item $tagFile -Force -ErrorAction SilentlyContinue }
                        }
                    }
                }

                if (-not $downloadOK -and $expectedSize -le 0) {
                    Write-Warn "无法获取 Release 镜像大小（可能网络拦截），将逐个尝试直链下载..."
                    foreach ($u in $downloadUrls) {
                        try {
                            $shortUrl = if ($u.Length -gt 80) { $u.Substring(0, 77) + "..." } else { $u }
                            Write-Info "尝试: $shortUrl"
                            if (Test-Path $imageTar) { Remove-Item $imageTar -Force -ErrorAction SilentlyContinue }
                            # --connect-timeout 15: 连接15秒内无响应则放弃; --max-time 600: 单次最多10分钟
                            & curl.exe -L --fail --connect-timeout 15 --max-time 600 --retry 3 --retry-all-errors --retry-delay 3 --progress-bar -o $imageTar $u 2>&1 | ForEach-Object {
                                if ($_ -match '\d+.*%') { Write-Host "`r  $($_.Trim())" -NoNewline -ForegroundColor DarkGray }
                            }
                            Write-Host ""
                            if ((Test-Path $imageTar) -and (Get-Item $imageTar).Length -gt 50MB) {
                                # 写入 tag 元数据以便下次比较
                                try { "$tagText|$script:imageEdition" | Set-Content -Path "$imageTar.tag" -Force -ErrorAction SilentlyContinue } catch { }
                                $downloadOK = $true
                                Write-OK "直链下载成功"
                                break
                            } else {
                                Write-Info "  → 下载不完整或被拦截，换下一个源..."
                            }
                        } catch {
                            Write-Info "  → 连接失败，换下一个源..."
                        }
                    }
                } elseif (-not $downloadOK) {
                    $imageSizeMB = [math]::Round($expectedSize / 1MB, 1)
                    Write-Info "发现预构建镜像 ($tagText, ${imageSizeMB}MB)"
                    Write-Info "正在下载... (无需从 Docker Hub 拉取)"

                    # 多线程分块下载 — 8线程并行，每块 2MB，每块最多重试20次
                    $downloadOK = Download-Robust `
                        -Urls $downloadUrls `
                        -OutFile $imageTar `
                        -ExpectedSize $expectedSize `
                        -ChunkSizeMB 2 `
                        -Threads 8 `
                        -RetryPerChunk 20

                    if (-not $downloadOK) {
                        Write-Warn "首轮 8 线程下载未完成，立即按原策略重试（仅补失败块，8线程）..."
                        $downloadOK = Download-Robust `
                            -Urls $downloadUrls `
                            -OutFile $imageTar `
                            -ExpectedSize $expectedSize `
                            -ChunkSizeMB 2 `
                            -Threads 8 `
                            -RetryPerChunk 30
                    }
                }

                if ($downloadOK) {
                    try { "$tagText|$script:imageEdition" | Set-Content -Path "$imageTar.tag" -Force -ErrorAction SilentlyContinue } catch { }
                        Write-OK "镜像下载完成"
                        $loadSizeText = "未知大小"
                        if (Test-Path $imageTar) {
                            $loadSizeText = "$( [math]::Round((Get-Item $imageTar).Length / 1MB, 1) )MB"
                        }
                        Write-Info "正在加载镜像到 Docker...（$loadSizeText，通常需 1-5 分钟，请耐心等待）"

                        # 清理可能残留的 docker load 进程（上次 Ctrl+C 后遗留的 Start-Job 子进程）
                        try {
                            Get-Process | Where-Object {
                                $_.ProcessName -match 'docker' -and $_.Id -ne $PID
                            } | ForEach-Object {
                                try {
                                    $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                                    if ($cmdLine -match 'load.*tar') {
                                        Write-Log "Killing stale docker load process: PID=$($_.Id)"
                                        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                                    }
                                } catch { }
                            }
                        } catch { }

                        # 后台加载 + 前台旋转动画
                        $loadJob = Start-Job -ScriptBlock {
                            param($tar)
                            & docker load -i $tar 2>&1
                        } -ArgumentList $imageTar

                        $spinner = @('|','/','-','\','|','/','-','\','|','/','-','\','|','/','-','\')
                        $si = 0
                        $loadTimer = [System.Diagnostics.Stopwatch]::StartNew()
                        $slowLoadHintShown = $false
                        try {
                        while ($loadJob.State -eq 'Running') {
                            $elapsed = [math]::Floor($loadTimer.Elapsed.TotalSeconds)
                            $min = [math]::Floor($elapsed / 60)
                            $sec = $elapsed % 60
                            $spinChar = $spinner[$si % $spinner.Count]
                            Write-Host "`r  $spinChar 加载中... 已耗时 ${min}分${sec}秒    " -NoNewline -ForegroundColor Cyan
                            if (-not $slowLoadHintShown -and $elapsed -ge 300) {
                                $slowLoadHintShown = $true
                                Write-Host ""
                                Write-Warn "镜像加载已超过 5 分钟，可能存在磁盘/杀软扫描/后台任务竞争" 
                                Write-Host "     诊断建议: docker system df" -ForegroundColor DarkGray
                                Write-Host "     诊断建议: Get-Process docker" -ForegroundColor DarkGray
                                Write-Host "     若长时间无进展，可重启 Docker Desktop 后重试" -ForegroundColor DarkGray
                            }
                            $si++
                            Start-Sleep -Milliseconds 200
                        }
                        } finally {
                            # Ctrl+C 时确保清理 job 及其子进程
                            if ($loadJob.State -eq 'Running') {
                                Write-Host "`n  正在清理后台加载进程..." -ForegroundColor Yellow
                                Stop-Job $loadJob -ErrorAction SilentlyContinue
                            }
                        }
                        Write-Host ""
                        $loadTimer.Stop()
                        $loadOutput = Receive-Job $loadJob
                        Remove-Job $loadJob -Force

                        # 记录 docker load 输出，必要时用于自动 tag
                        $loadedRefs = @()

                        # 输出 docker load 日志
                        $loadOutput | ForEach-Object {
                            if ($_ -is [int] -or "$_" -match '^\d+$') { return }
                            Write-Log "docker load: $_"
                            if ($_ -match "Loaded image") {
                                Write-Host "  $_" -ForegroundColor DarkGray
                                if ($_ -match '^Loaded image:\s*(.+)\s*$') {
                                    $loadedRefs += $Matches[1].Trim()
                                }
                            } elseif ($_ -match '^Loaded image ID:\s*(sha256:[0-9a-f]+)\s*$') {
                                $loadedRefs += $Matches[1].Trim()
                            }
                        }

                        # 强化校验：若加载到了 lite 镜像，强制执行 lite->latest 多次修复，避免误回退 GHCR
                        $sawLiteLoaded = $false
                        if ($script:imageEdition -eq 'lite') {
                            foreach ($ref in $loadedRefs) {
                                if (("$ref").ToLower() -match 'openclaw-pro:lite$' -or ("$ref").ToLower() -match ':v\d+\.\d+\.\d+.*-lite$') {
                                    $sawLiteLoaded = $true
                                    break
                                }
                            }
                            if (-not $sawLiteLoaded) {
                                $liteProbe = & docker image inspect openclaw-pro:lite 2>$null
                                if ($LASTEXITCODE -eq 0) { $sawLiteLoaded = $true }
                            }
                        }
                        if ($sawLiteLoaded) {
                            Write-Info "检测到已加载 lite 镜像，执行强化 tag 修复（openclaw-pro:lite -> openclaw-pro:latest）..."
                            for ($ti = 1; $ti -le 3; $ti++) {
                                try { & docker tag "openclaw-pro:lite" "openclaw-pro:latest" 2>$null } catch { }
                                Start-Sleep -Milliseconds 300
                                $tagChk = & docker image inspect openclaw-pro:latest 2>$null
                                if ($LASTEXITCODE -eq 0) { break }
                            }
                        }

                        # 有些 tar 里只有 ghcr.io/... 或 openclaw-pro:lite；尝试补一个 openclaw-pro:latest
                        $preTagCheck = & docker image inspect openclaw-pro:latest 2>$null
                        if ($LASTEXITCODE -ne 0) {
                            # 优先用 docker load 输出中收集到的 refs 进行 tag
                            if ($loadedRefs.Count -gt 0) {
                                foreach ($ref in $loadedRefs) {
                                    try { & docker tag $ref "openclaw-pro:latest" 2>$null } catch { }
                                }
                            }

                            # 选择精简版时，若仅加载出 openclaw-pro:lite，显式补 latest tag
                            if ($script:imageEdition -eq 'lite') {
                                $liteCheck = & docker image inspect openclaw-pro:lite 2>$null
                                if ($LASTEXITCODE -eq 0) {
                                    try { & docker tag "openclaw-pro:lite" "openclaw-pro:latest" 2>$null } catch { }
                                }
                            }

                            # 若上一步未能创建 openclaw-pro:latest，则扫描当前已加载的 images，查找包含 openclaw-pro 的 repo:tag，并 tag 到 openclaw-pro:latest
                            $allImages = & docker images --format '{{.Repository}}:{{.Tag}}' 2>$null
                            foreach ($im in $allImages) {
                                if ($im -and $im -match 'openclaw-pro') {
                                    try { & docker tag $im "openclaw-pro:latest" 2>$null } catch { }
                                }
                            }
                        }

                        # 检查镜像是否加载成功（尝试过多种 tag 修正后再检查）
                        $loadCheck = & docker image inspect openclaw-pro:latest 2>$null
                        if ($LASTEXITCODE -eq 0) {
                            $totalSec = [math]::Floor($loadTimer.Elapsed.TotalSeconds)
                            $imageReady = $true
                            Write-OK "预构建镜像加载完成 (耗时 ${totalSec} 秒)"
                            # 保存镜像 digest 用于完整性校验
                            try {
                                $newImageId = (& docker image inspect openclaw-pro:latest --format '{{.Id}}' 2>$null)
                                if ($newImageId) {
                                    $script:loadedImageDigest = $newImageId
                                }
                            } catch { }
                        } else {
                            Write-Warn "docker load 失败，继续尝试其他方式..."
                            Write-Info "镜像文件已保留: $imageTar（下次运行可直接加载，无需重新下载）"
                        }
                        # 镜像文件始终保留在 tmp 目录（便于重试和排查）
                } else {
                    Write-Warn "Release 镜像下载失败，继续尝试其他方式..."
                    # 若是分块下载失败，会保留部分下载的文件以便续传（下次运行自动恢复）
                }
            } catch {
                Write-Log "Pre-built image download failed: $_"
                Write-Info "Release 镜像获取失败，继续尝试其他方式..."
            }
            }  # end if (-not $imageReady) for download

            # -- 尝试 2: 从 GHCR 拉取镜像 --
            if (-not $imageReady) {
                $ghcrTags = @()
                if ($script:imageEdition -eq "lite") {
                    if ($latestReleaseTag) { $ghcrTags += "$latestReleaseTag-lite" }
                    $ghcrTags += "lite"
                    if ($latestReleaseTag) { $ghcrTags += "$latestReleaseTag" }
                    $ghcrTags += "latest"
                } else {
                    if ($latestReleaseTag) { $ghcrTags += "$latestReleaseTag" }
                    $ghcrTags += "latest"
                }
                $ghcrTags = $ghcrTags | Select-Object -Unique

                foreach ($tag in $ghcrTags) {
                    if ($imageReady) { break }
                    $ghcrImage = "ghcr.io/${GITHUB_REPO}:${tag}"
                    Write-Info "尝试从 GHCR 拉取镜像: $ghcrImage ..."
                    for ($attempt = 1; $attempt -le 2 -and -not $imageReady; $attempt++) {
                        try {
                            $pullOutput = & docker pull $ghcrImage 2>&1
                            $pullExitCode = $LASTEXITCODE
                            $pullOutput | ForEach-Object {
                                if ($_ -match "Pulling|Downloading|Extracting|Pull complete|Digest|Status|Retrying") {
                                    Write-Host "  $_" -ForegroundColor DarkGray
                                }
                                Write-Log "docker pull: $_"
                            }
                            if ($pullExitCode -eq 0) {
                                $ghcrCheck = & docker image inspect $ghcrImage 2>$null
                                if ($LASTEXITCODE -eq 0) {
                                    & docker tag $ghcrImage "openclaw-pro:latest" 2>$null
                                    $tagCheck = & docker image inspect "openclaw-pro:latest" 2>$null
                                    if ($LASTEXITCODE -eq 0) {
                                        $imageReady = $true
                                        Write-OK "GHCR 镜像拉取成功（tag: $tag）"
                                        try {
                                            $pulledId = (& docker image inspect openclaw-pro --format '{{.Id}}' 2>$null)
                                            if ($pulledId) { $script:loadedImageDigest = $pulledId }
                                        } catch { }
                                    }
                                }
                            }
                            if (-not $imageReady -and $attempt -lt 2) {
                                Write-Warn "GHCR 拉取失败（tag: $tag，第 $attempt 次），2 秒后重试..."
                                Start-Sleep -Seconds 2
                            }
                        } catch {
                            Write-Log "GHCR pull failed ($tag, attempt=$attempt): $_"
                            if ($attempt -lt 2) { Start-Sleep -Seconds 2 }
                        }
                    }
                }

                if (-not $imageReady) {
                    Write-Warn "GHCR 多标签拉取均失败，继续尝试本地构建..."
                }
            }

            # -- 尝试 3: 本地构建 (fallback) --
            # 如果处于 explicit ImageOnly 模式则跳过本地构建
            if (-not $imageReady -and -not ($ImageOnly -and $ImageOnlyExplicit)) {
                Write-Info "正在本地构建镜像...（首次约需 5-10 分钟）"
                $buildOK = $false
                $dockerfilePath = Join-Path $localDeployDir "Dockerfile"
                $originalDockerfile = Get-Content $dockerfilePath -Raw
                $mirrorPrefixes = @(
                    $null,                                    # direct (Docker Hub)
                    "docker.m.daocloud.io/library/",          # DaoCloud
                    "dockerhub.icu/library/",                 # dockerhub.icu
                    "docker.1panel.live/library/"              # 1Panel
                )

                foreach ($prefix in $mirrorPrefixes) {
                    if ($prefix) {
                        Write-Warn "Docker Hub 连接失败，尝试镜像源: $prefix"
                        $mirroredContent = $originalDockerfile -replace '^FROM ubuntu:', "FROM ${prefix}ubuntu:"
                        $mirroredContent | Set-Content $dockerfilePath -Force -NoNewline
                        Write-Info "已修改 Dockerfile 使用镜像源"
                    }

                    # 重要: 不能用 | ForEach-Object，PowerShell 5.1 中 pipeline 会导致 $LASTEXITCODE 不可靠
                    $buildOutput = & docker build --no-cache -t openclaw-pro . 2>&1
                    $buildExitCode = $LASTEXITCODE
                    $buildOutput | ForEach-Object {
                        if ($_ -match "^#\d+ \[" -or $_ -match "^Step " -or $_ -match "Successfully") {
                            Write-Host "  $_" -ForegroundColor DarkGray
                        }
                        Write-Log "docker build: $_"
                    }
                    if ($buildExitCode -eq 0) {
                        $buildOK = $true
                        if ($prefix) {
                            $originalDockerfile | Set-Content $dockerfilePath -Force -NoNewline
                        }
                        break
                    }
                }

                if (-not $buildOK) {
                    $originalDockerfile | Set-Content $dockerfilePath -Force -NoNewline
                    throw "镜像获取失败 — GHCR拉取、下载和本地构建均不可用。请检查网络连接后重试。"
                }
                $imageReady = $true
                # 保存本地构建的镜像 digest
                try {
                    $builtImageId = (& docker image inspect openclaw-pro --format '{{.Id}}' 2>$null)
                    if ($builtImageId) {
                        $script:loadedImageDigest = $builtImageId
                    }
                } catch { }
            }
            Write-OK "镜像准备完成"
            Write-Log "Image ready. imageReady=$imageReady. Proceeding to pre-run checks."

            # 启动前强校验：确保 openclaw-pro:latest 标签真实存在
            $preRunImageCheck = & docker image inspect openclaw-pro 2>$null
            if ($LASTEXITCODE -ne 0) {
                Write-Warn "镜像标签 openclaw-pro:latest 缺失，尝试自动修复..."
                Write-Log "Pre-run image check FAILED. Attempting repair."

                # 优先把已存在的 GHCR 镜像重新 tag 为 openclaw-pro:latest
                try {
                    $ghcrLocalCandidates = & docker images --format "{{.Repository}}:{{.Tag}}" 2>$null | Where-Object {
                        $_ -like "ghcr.io/${GITHUB_REPO}:*"
                    }
                    if ($ghcrLocalCandidates -and $ghcrLocalCandidates.Count -gt 0) {
                        $cand = $ghcrLocalCandidates[0]
                        & docker tag $cand "openclaw-pro:latest" 2>$null
                    }
                } catch { }

                $preRunImageCheck = & docker image inspect openclaw-pro 2>$null
                if ($LASTEXITCODE -ne 0) {
                    # 仍缺失时，直接拉取 GHCR 并 tag
                    $repairTag = if ($latestReleaseTag) { $latestReleaseTag } else { "latest" }
                    $repairImage = "ghcr.io/${GITHUB_REPO}:${repairTag}"
                    Write-Info "镜像修复: 拉取 $repairImage"
                    try {
                        # 不能用 pipeline，PS 5.1 中 $LASTEXITCODE 在 | ForEach-Object 后不可靠
                        $repairPullOutput = & docker pull $repairImage 2>&1
                        $repairPullCode = $LASTEXITCODE
                        $repairPullOutput | ForEach-Object {
                            if ($_ -match "Pulling|Downloading|Extracting|Pull complete|Digest|Status") {
                                Write-Host "  $_" -ForegroundColor DarkGray
                            }
                            Write-Log "docker pull(repair): $_"
                        }
                        if ($repairPullCode -eq 0) {
                            & docker tag $repairImage "openclaw-pro:latest" 2>$null
                        } else {
                            Write-Log "Repair pull failed with exit code $repairPullCode"
                        }
                    } catch {
                        Write-Log "Image repair pull failed: $_"
                    }
                }

                $preRunImageCheck = & docker image inspect openclaw-pro 2>$null
                if ($LASTEXITCODE -ne 0) {
                    throw "镜像修复失败：未找到 openclaw-pro:latest"
                }
                Write-OK "镜像标签修复完成"
            }

            # 再次检查目标容器名是否有残留（防御性检查）
            $existing = & docker ps -a --filter "name=^${containerName}$" --format "{{.Names}}" 2>&1
            if ($existing -match $containerName) {
                & docker rm -f $containerName 2>&1 | Out-Null
                Start-Sleep -Seconds 1
            }

            # 启动前最终端口校验：避免“前面检测通过，docker run 时冲突”
            $requiredMappings = @()
            if ($deployConfig.HttpsEnabled) {
                $requiredMappings += @{ HostPort = [int]$deployConfig.HttpPort; ContainerPort = 80 }
                $requiredMappings += @{ HostPort = [int]$deployConfig.HttpsPort; ContainerPort = 443 }
            } else {
                $requiredMappings += @{ HostPort = [int]$deployConfig.GatewayPort; ContainerPort = 18789 }
                $requiredMappings += @{ HostPort = [int]$deployConfig.WebPort; ContainerPort = 3000 }
            }
            $requiredMappings += @{ HostPort = [int]$deployConfig.SshPort; ContainerPort = 22 }

            $conflicts = @()
            foreach ($m in $requiredMappings) {
                if (-not (Test-PortAvailable $m.HostPort)) {
                    $conflicts += $m
                }
            }

            if ($conflicts.Count -gt 0) {
                Write-Host ""
                Write-Warn "检测到端口冲突（启动前复检）:"
                foreach ($c in $conflicts) {
                    Write-Host "     宿主机端口 $($c.HostPort) -> 容器 $($c.ContainerPort)" -ForegroundColor DarkGray
                }
                Write-Host ""
                Write-Host "  请选择处理方式:" -ForegroundColor White
                Write-Host "     [1] 自动分配可用端口（默认）" -ForegroundColor Gray
                Write-Host "     [2] 手动输入新端口" -ForegroundColor Gray
                Write-Host "     [3] 退出并手动处理" -ForegroundColor Gray
                Write-Host ""
                Write-Host "  输入选择 [1/2/3，默认1]: " -NoNewline -ForegroundColor White
                $fixChoice = (Read-Host).Trim()
                if (-not $fixChoice) { $fixChoice = '1' }

                if ($fixChoice -eq '3') {
                    throw "port conflict detected before docker run"
                }

                foreach ($c in $conflicts) {
                    $newPort = 0
                    if ($fixChoice -eq '2') {
                        while ($true) {
                            Write-Host "  请输入容器 $($c.ContainerPort) 对应的新宿主机端口 [默认 $($c.HostPort)]: " -NoNewline -ForegroundColor White
                            $pIn = (Read-Host).Trim()
                            if (-not $pIn) { $pIn = "$($c.HostPort)" }
                            if ($pIn -notmatch '^\d+$') {
                                Write-Warn "端口必须是数字"
                                continue
                            }
                            $tryPort = [int]$pIn
                            if ($tryPort -lt 1 -or $tryPort -gt 65535) {
                                Write-Warn "端口范围应为 1-65535"
                                continue
                            }
                            if (-not (Test-PortAvailable $tryPort)) {
                                Write-Warn "端口 $tryPort 仍被占用，请换一个"
                                continue
                            }
                            $newPort = $tryPort
                            break
                        }
                    } else {
                        $newPort = Find-AvailablePort -PreferredPort ($c.HostPort + 1) -RangeStart ($c.HostPort + 1) -RangeEnd ($c.HostPort + 200)
                    }

                    if ($c.ContainerPort -eq 18789) { $deployConfig.GatewayPort = $newPort }
                    elseif ($c.ContainerPort -eq 3000) { $deployConfig.WebPort = $newPort }
                    elseif ($c.ContainerPort -eq 80) { $deployConfig.HttpPort = $newPort }
                    elseif ($c.ContainerPort -eq 443) { $deployConfig.HttpsPort = $newPort }
                    elseif ($c.ContainerPort -eq 22) { $deployConfig.SshPort = $newPort }
                }

                if ($deployConfig.HttpsEnabled) {
                    if ($deployConfig.CertMode -eq "letsencrypt") {
                        $deployConfig.PortArgs = @(
                            "-p", "$($deployConfig.HttpPort):80",
                            "-p", "$($deployConfig.HttpsPort):443"
                        )
                    } else {
                        $deployConfig.PortArgs = @(
                            "-p", "$($deployConfig.HttpsPort):443"
                        )
                    }
                } else {
                    $deployConfig.PortArgs = @(
                        "-p", "$($deployConfig.GatewayPort):18789",
                        "-p", "$($deployConfig.WebPort):3000"
                    )
                }
                $deployConfig.PortArgs += @("-p", "$($deployConfig.SshPort):22")

                $script:actualGatewayPort = $deployConfig.GatewayPort
                $script:actualPanelPort   = $deployConfig.WebPort
                $script:httpPort          = $deployConfig.HttpPort
                $script:httpsPort         = $deployConfig.HttpsPort
                $script:sshPort           = $deployConfig.SshPort

                Write-OK "端口冲突已处理，已更新端口映射"
            }

            # Create home-data directory — 容器数据目录放在用户运行脚本的目录下
            # openclaw-pro     → home-data
            # openclaw-pro-2   → home-data-2
            # openclaw-pro-N   → home-data-N
            $homeDataName = "home-data"
            if ($containerName -match '^openclaw-pro-(\d+)$') {
                $homeDataName = "home-data-$($Matches[1])"
            }
            $defaultHomeData = Join-Path $homeBaseDir $homeDataName
            $defaultRootHomeData = Join-Path $defaultHomeData "root"

            Write-Host ""
            if (-not ($ImageOnly -and $ImageOnlyExplicit)) {
                Write-Host "  容器数据目录（父目录）:" -ForegroundColor Cyan
                Write-Host "     默认路径: $defaultHomeData" -ForegroundColor White
                Write-Host "     root 数据目录: $defaultRootHomeData" -ForegroundColor DarkGray
                Write-Host ""
                Write-Host "     [1] 使用默认路径（推荐）" -ForegroundColor White
                Write-Host "     [2] 自定义路径" -ForegroundColor White
                Write-Host ""
                Write-Host "  输入选择 [1/2，默认1]: " -NoNewline -ForegroundColor White
                $homeDataChoice = (Read-Host).Trim()

                if ($homeDataChoice -eq '2') {
                    Write-Host "  请输入数据目录完整路径: " -NoNewline -ForegroundColor White
                    $customPath = (Read-Host).Trim()
                    if ($customPath) {
                        $homeData = $customPath
                        Write-Info "使用自定义数据目录: $homeData"
                    } else {
                        $homeData = $defaultHomeData
                        Write-Info "输入为空，使用默认路径: $homeData"
                    }
                } else {
                    $homeData = $defaultHomeData
                }

                Write-OK "数据目录: $homeData"
            } else {
                $homeData = $defaultHomeData
                Write-Info "ImageOnly 模式：跳过数据目录交互，使用默认路径: $homeData"
                Write-OK "数据目录: $homeData"
            }
            if (-not (Test-Path $homeData)) {
                New-Item -ItemType Directory -Path $homeData -Force | Out-Null
            }
            $rootDataDir = Join-Path $homeData "root"
            if (-not (Test-Path $rootDataDir)) {
                New-Item -ItemType Directory -Path $rootDataDir -Force | Out-Null
            }
            $configDir = Join-Path $rootDataDir ".openclaw"
            if (-not (Test-Path $configDir)) {
                New-Item -ItemType Directory -Path $configDir -Force | Out-Null
            }

            # Write config for container's start-services.sh (Caddy reads domain from here)
            $dockerConfigJson = @{
                port       = $deployConfig.GatewayPort
                web_port   = $deployConfig.WebPort
                http_port  = $deployConfig.HttpPort
                https_port = $deployConfig.HttpsPort
                ssh_port   = $deployConfig.SshPort
                cert_mode  = $deployConfig.CertMode
                domain     = $deployConfig.Domain
                browserEnabled = $false
                timezone   = "Asia/Shanghai"
                created    = (Get-Date -Format "o")
            } | ConvertTo-Json -Depth 2
            $dockerConfigJson | Set-Content (Join-Path $configDir "docker-config.json") -Force
            if ($latestReleaseTag) {
                $latestReleaseTag | Set-Content (Join-Path $configDir "image-release-tag.txt") -Force
            }
            # 保存镜像 digest 用于下次完整性校验
            if ($script:loadedImageDigest) {
                $script:loadedImageDigest | Set-Content (Join-Path $configDir "image-digest.txt") -Force
            } else {
                # 复用本地镜像时，保存当前镜像 ID
                try {
                    $curId = (& docker image inspect openclaw-pro --format '{{.Id}}' 2>$null)
                    if ($curId) {
                        $curId | Set-Content (Join-Path $configDir "image-digest.txt") -Force
                    }
                } catch { }
            }
            Write-Log "Wrote docker-config.json: domain=$($deployConfig.Domain)"

            if ($pushedLocal) { Pop-Location }

            # -- 最终镜像可用性检查 --
            $finalImageCheck = & docker image inspect openclaw-pro 2>$null
            if ($LASTEXITCODE -ne 0) {
                # 日志记录 docker images 列表以辅助诊断
                $imgList = & docker images --format "{{.Repository}}:{{.Tag}} {{.ID}}" 2>$null | Out-String
                Write-Log "FINAL IMAGE CHECK FAILED. Docker images: $imgList"
                throw "镜像 openclaw-pro:latest 不可用 — 所有获取方式均已失败。请检查网络后重新运行安装脚本。"
            }
            $finalImageId = & docker image inspect openclaw-pro --format '{{.Id}}' 2>$null
            Write-Log "Final image check OK. ID=$finalImageId"

            # ── 获取宿主机用户信息（用于容器内创建同名用户）──
            $hostUser = $env:USERNAME
            $hostUid = ""
            $hostGid = ""
            $userHomeDir = ""

            if ($hostUser -and $hostUser -ne "root" -and $hostUser -ne "Administrator") {
                # Windows 用户没有 UID/GID，容器内会自动分配
                $userHomeDir = Join-Path $homeData $hostUser

                # 创建用户持久化目录
                if (-not (Test-Path $userHomeDir)) {
                    New-Item -ItemType Directory -Path $userHomeDir -Force | Out-Null
                }
                Write-Info "创建用户持久化目录: $userHomeDir"
            }

            # Build docker run arguments
            $runArgs = @(
                "run", "-d",
                "--name", $containerName,
                "--hostname", "openclaw",
                "--dns", "8.8.8.8",
                "--dns", "8.8.4.4",
                "-v", "${rootDataDir}:/root",
                "-e", "TZ=Asia/Shanghai"
            )

            # 添加用户环境变量（用于容器内创建同名用户）
            if ($hostUser -and $hostUser -ne "root" -and $hostUser -ne "Administrator") {
                $runArgs += @("-e", "HOST_USER=$hostUser")
                # 添加用户目录挂载
                if ($userHomeDir -and (Test-Path $userHomeDir)) {
                    $runArgs += @("-v", "${userHomeDir}:/home/$hostUser")
                }
            }

            $runArgs += @("--restart", "unless-stopped")
            # 如果使用 IP 自签证书（internal），不要在宿主机上映射 HTTP 80
            $filteredPortArgs = @()
            for ($i = 0; $i -lt $deployConfig.PortArgs.Count; $i++) {
                $arg = $deployConfig.PortArgs[$i]
                if ($arg -eq '-p' -and ($i + 1) -lt $deployConfig.PortArgs.Count) {
                    $mapping = $deployConfig.PortArgs[$i + 1]
                    if ($deployConfig.CertMode -eq 'internal' -and $mapping -match ':(80)$') {
                        # skip this port mapping pair
                        $i++ ; continue
                    }
                    $filteredPortArgs += $arg
                    $filteredPortArgs += $mapping
                    $i++ ; continue
                } else {
                    $filteredPortArgs += $arg
                }
            }
            $runArgs += $filteredPortArgs
            $runArgs += "openclaw-pro"

            Write-Log "docker run args: $($runArgs -join ' ')"
            $runResult = & docker @runArgs 2>&1
            $runOutputText = $runResult | Out-String

            # Docker Desktop/Windows 偶发端口竞争：自动改端口并重试一次
            if ($LASTEXITCODE -ne 0 -and $runOutputText -match "port is already allocated" -and $runOutputText -match 'Bind for .*:(\d+)') {
                $conflictPort = [int]$Matches[1]
                Write-Warn "检测到端口冲突: $conflictPort，正在自动分配新端口并重试..."

                $newPort = Find-AvailablePort -PreferredPort ($conflictPort + 1) -RangeStart ($conflictPort + 1) -RangeEnd ($conflictPort + 200)
                Write-Info "端口 $conflictPort → $newPort"

                for ($i = 0; $i -lt $runArgs.Count; $i++) {
                    if ($runArgs[$i] -ne '-p') { continue }
                    if ($i + 1 -ge $runArgs.Count) { continue }

                    $mapping = "$($runArgs[$i + 1])"
                    if ($mapping -match '^(?<ip>[^:]+:)?(?<host>\d+):(?<container>\d+)$') {
                        $hostPort = [int]$Matches['host']
                        if ($hostPort -eq $conflictPort) {
                            $ipPrefix = $Matches['ip']
                            $containerPort = [int]$Matches['container']

                            if ($containerPort -eq 18789) { $deployConfig.GatewayPort = $newPort }
                            if ($containerPort -eq 3000)  { $deployConfig.WebPort = $newPort }
                            if ($containerPort -eq 80)    { $deployConfig.HttpPort = $newPort }
                            if ($containerPort -eq 443)   { $deployConfig.HttpsPort = $newPort }

                            $runArgs[$i + 1] = "${ipPrefix}${newPort}:${containerPort}"
                        }
                    }
                }

                # 清理可能残留的同名容器并重试
                & docker rm -f $containerName 2>$null | Out-Null
                Write-Log "docker run retry args: $($runArgs -join ' ')"
                $runResult = & docker @runArgs 2>&1
                $runOutputText = $runResult | Out-String
            }

            if ($LASTEXITCODE -eq 0) {
                Write-OK "容器已启动"
                $launched = $true
                $script:deployedContainerName = $containerName

                # 收尾：确保 SSH 服务可用、禁用密码登录状态可见、自动注入宿主机公钥、生成初始 root 密码（仅本地用途）
                try {
                    $sshReady = $false
                    for ($attempt = 1; $attempt -le 8; $attempt++) {
                        & docker exec $containerName bash -lc "pgrep -x sshd >/dev/null 2>&1" 2>$null | Out-Null
                        if ($LASTEXITCODE -eq 0) {
                            $sshReady = $true
                            break
                        }
                        & docker exec $containerName bash -lc "mkdir -p /run/sshd && (/usr/sbin/sshd >/dev/null 2>&1 || service ssh start >/dev/null 2>&1 || true)" 2>$null | Out-Null
                        Start-Sleep -Milliseconds 600
                    }
                    $script:sshServiceReady = $sshReady
                    if ($sshReady) {
                        Write-OK "SSH 服务已就绪"
                    } else {
                        Write-Warn "SSH 服务状态未确认，请稍后执行 docker logs $containerName 查看"
                    }

                    # ── SSH 安全配置：禁用密码登录，禁用 root 登录，仅密钥登录 ──
                    # 配置由 start-services.sh 自动完成，这里仅注入公钥到普通用户
                    $pubKeyCandidates = @(
                        (Join-Path $env:USERPROFILE ".ssh\id_ed25519.pub"),
                        (Join-Path $env:USERPROFILE ".ssh\id_rsa.pub"),
                        (Join-Path $env:USERPROFILE ".ssh\id_ecdsa.pub")
                    )

                    if ($env:HOME -and $env:HOME -ne $env:USERPROFILE) {
                        $pubKeyCandidates += @(
                            (Join-Path $env:HOME ".ssh\id_ed25519.pub"),
                            (Join-Path $env:HOME ".ssh\id_rsa.pub"),
                            (Join-Path $env:HOME ".ssh\id_ecdsa.pub")
                        )
                    }

                    # 管理员 PowerShell 可能读不到实际登录用户目录，补充扫描 C:\Users\*\.ssh
                    try {
                        $userRoots = Get-ChildItem "C:\Users" -Directory -ErrorAction SilentlyContinue | Where-Object {
                            $_.Name -notin @('Public', 'Default', 'Default User', 'All Users')
                        }
                        foreach ($u in $userRoots) {
                            $pubKeyCandidates += @(
                                (Join-Path $u.FullName ".ssh\id_ed25519.pub"),
                                (Join-Path $u.FullName ".ssh\id_rsa.pub"),
                                (Join-Path $u.FullName ".ssh\id_ecdsa.pub")
                            )
                        }
                    } catch { }

                    # 去重
                    $pubKeyCandidates = $pubKeyCandidates | Where-Object { $_ } | Select-Object -Unique
                    $injected = $false

                    # 注入到普通用户（如果有）
                    if ($hostUser -and $hostUser -ne "root" -and $hostUser -ne "Administrator") {
                        foreach ($keyFile in $pubKeyCandidates) {
                            if (-not (Test-Path $keyFile)) { continue }
                            Write-Info "注入公钥到用户 $hostUser : $keyFile"
                            & docker exec $containerName bash -lc "mkdir -p '/home/$hostUser/.ssh' && chmod 700 '/home/$hostUser/.ssh'" 2>$null | Out-Null
                            & docker cp $keyFile "${containerName}:/tmp/host_user_key.pub" 2>$null | Out-Null
                            if ($LASTEXITCODE -eq 0) {
                                & docker exec $containerName bash -lc "cat /tmp/host_user_key.pub >> '/home/$hostUser/.ssh/authorized_keys' && sort -u -o '/home/$hostUser/.ssh/authorized_keys' '/home/$hostUser/.ssh/authorized_keys' && chmod 600 '/home/$hostUser/.ssh/authorized_keys' && chown -R '${hostUser}:${hostUser}' '/home/$hostUser/.ssh' && rm -f /tmp/host_user_key.pub" 2>$null | Out-Null
                                if ($LASTEXITCODE -eq 0) {
                                    $script:sshInjectedKeyPath = $keyFile
                                    $injected = $true
                                    Write-OK "已自动注入宿主机 SSH 公钥到用户 $hostUser : $keyFile"
                                    break
                                }
                            }
                        }
                    }

                    if (-not $injected) {
                        # 降级：没有普通用户时，注入到 root（兼容旧行为）
                        foreach ($keyFile in $pubKeyCandidates) {
                            if (-not (Test-Path $keyFile)) { continue }
                            & docker exec $containerName bash -lc "chmod 700 /root 2>/dev/null || true; mkdir -p /root/.ssh && chmod 700 /root/.ssh" 2>$null | Out-Null
                            & docker cp $keyFile "${containerName}:/root/.ssh/authorized_keys.tmp" 2>$null | Out-Null
                            if ($LASTEXITCODE -ne 0) { continue }
                            & docker exec $containerName bash -lc "cat /root/.ssh/authorized_keys.tmp >> /root/.ssh/authorized_keys && sort -u -o /root/.ssh/authorized_keys /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && rm -f /root/.ssh/authorized_keys.tmp" 2>$null | Out-Null
                            if ($LASTEXITCODE -eq 0) {
                                $script:sshInjectedKeyPath = $keyFile
                                $injected = $true
                                Write-OK "已自动注入宿主机 SSH 公钥: $keyFile"
                                break
                            }
                        }
                    }

                    if (-not $injected) {
                        try {
                            $sshDir = Join-Path $env:USERPROFILE ".ssh"
                            if (-not (Test-Path $sshDir)) {
                                New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
                            }

                            $keyPath = Join-Path $sshDir "id_ed25519"
                            $pubPath = "$keyPath.pub"
                            if (-not (Test-Path $pubPath)) {
                                $sshKeygen = Get-Command ssh-keygen -ErrorAction SilentlyContinue
                                if ($sshKeygen) {
                                    Write-Info "未检测到宿主机公钥，正在自动生成 id_ed25519..."
                                    $sshCmd = "`"$($sshKeygen.Source)`" -q -t ed25519 -N `"`" -f `"$keyPath`""
                                    & cmd /c $sshCmd 2>$null | Out-Null
                                }
                            }

                            if (Test-Path $pubPath) {
                                & docker exec $containerName bash -lc "chmod 700 /root 2>/dev/null || true; mkdir -p /root/.ssh && chmod 700 /root/.ssh" 2>$null | Out-Null
                                & docker cp $pubPath "${containerName}:/root/.ssh/authorized_keys.tmp" 2>$null | Out-Null
                                if ($LASTEXITCODE -eq 0) {
                                    & docker exec $containerName bash -lc "cat /root/.ssh/authorized_keys.tmp >> /root/.ssh/authorized_keys && sort -u -o /root/.ssh/authorized_keys /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && rm -f /root/.ssh/authorized_keys.tmp" 2>$null | Out-Null
                                    if ($LASTEXITCODE -eq 0) {
                                        $script:sshInjectedKeyPath = $pubPath
                                        $injected = $true
                                        Write-OK "已自动生成并注入宿主机 SSH 公钥: $pubPath"
                                    }
                                }
                            }
                        } catch {
                            Write-Log "Auto-generate host SSH key failed: $_" "WARN"
                        }
                    }

                    if (-not $injected) {
                        Write-Warn "未发现可用宿主机公钥（id_ed25519/id_rsa/id_ecdsa），请手动注入 authorized_keys"
                    }

                    # 保存部署信息（供后续显示）
                    $script:sshPasswordAuthDisabled = $true
                    $script:hostUserForSSH = $hostUser
                } catch {
                    Write-Log "Post-deploy SSH/bootstrap step failed: $_" "WARN"
                    Write-Warn "安装后 SSH/公钥收尾步骤部分失败，请在完成页按提示手动处理"
                }

                if ($deployConfig.HttpsEnabled) {
                    $certModeText = if ($deployConfig.CertMode -eq "internal") { "自签证书" } else { "Let's Encrypt" }
                    Write-Info "正在初始化 HTTPS 证书（${certModeText}）..."
                    $spinner = @('|','/','-','\','|','/','-','\','|','/','-','\','|','/','-','\')
                    $si = 0
                    $tlsReady = $false
                    for ($i = 1; $i -le 30; $i++) {
                        $spinChar = $spinner[$si % $spinner.Count]
                        Write-Host "`r  $spinChar 证书处理中... ${i}s/30s" -NoNewline -ForegroundColor Cyan
                        $si++
                        try {
                            $tcp = New-Object System.Net.Sockets.TcpClient
                            $iar = $tcp.BeginConnect("127.0.0.1", [int]$deployConfig.HttpsPort, $null, $null)
                            $ok = $iar.AsyncWaitHandle.WaitOne(500)
                            if ($ok -and $tcp.Connected) {
                                $tlsReady = $true
                                $tcp.Close()
                                break
                            }
                            $tcp.Close()
                        } catch { }
                        Start-Sleep -Seconds 1
                    }
                    Write-Host ""
                    if ($tlsReady) {
                        Write-OK "HTTPS 端口已就绪，证书流程已启动"
                    } else {
                        Write-Warn "证书流程仍在后台进行，可继续等待"
                    }
                    Write-Host "     查看证书日志: docker logs $containerName | findstr /I caddy cert acme tls" -ForegroundColor DarkGray
                }

                # Windows 防火墙端口处理（按用户选择）
                try {
                    $fwPortList = @()
                    if ($deployConfig.HttpsEnabled) {
                        if ($deployConfig.CertMode -eq 'letsencrypt') {
                            if ($deployConfig.HttpPort -and $deployConfig.HttpPort -gt 0) {
                                $fwPortList += $deployConfig.HttpPort
                            }
                        }
                        if ($deployConfig.HttpsPort -and $deployConfig.HttpsPort -gt 0) {
                            $fwPortList += $deployConfig.HttpsPort
                        }
                    } else {
                        $fwPortList += $deployConfig.GatewayPort
                        $fwPortList += $deployConfig.WebPort
                    }

                    if ($fwPortList.Count -gt 0 -and $deployConfig.AutoOpenFirewall) {
                        $fwPorts = ($fwPortList | Sort-Object -Unique) -join ','

                        # 先删除旧规则（忽略错误）
                        & netsh advfirewall firewall delete rule name="OpenClaw" 2>$null | Out-Null
                        & netsh advfirewall firewall delete rule name="OpenClaw-$containerName" 2>$null | Out-Null
                        # 添加新规则（以容器名标识）
                        $fwRuleName = if ($containerName -eq 'openclaw-pro') { 'OpenClaw' } else { "OpenClaw-$containerName" }
                        & netsh advfirewall firewall add rule name=$fwRuleName dir=in action=allow protocol=tcp localport=$fwPorts 2>&1 | Out-Null
                        if ($LASTEXITCODE -eq 0) {
                            Write-OK "防火墙端口已自动开放 ($fwPorts)"
                        } else {
                            Write-Warn "防火墙设置需要管理员权限，请手动执行:"
                            Write-Host "     netsh advfirewall firewall add rule name=`"$fwRuleName`" dir=in action=allow protocol=tcp localport=$fwPorts" -ForegroundColor White
                        }
                    } else {
                        $fwPorts = ($fwPortList | Sort-Object -Unique) -join ','
                        Write-Info "已跳过自动开放防火墙端口"
                        if ($fwPorts) {
                            Write-Host "     本机访问通常不需要放行；如需其他设备访问，请手动执行:" -ForegroundColor DarkGray
                            Write-Host "     netsh advfirewall firewall add rule name=`"OpenClaw-Manual`" dir=in action=allow protocol=tcp localport=$fwPorts" -ForegroundColor White
                        }
                    }
                } catch {
                    Write-Log "Firewall auto-open failed: $_"
                }
            } else {
                # 检查是否是端口冲突
                $dockerErr = & docker logs $containerName 2>&1 | Out-String
                $runOutput = $runOutputText
                $conflictPort = if ($dockerErr -match 'Bind for.*:(\d+)') { $Matches[1] } else { "" }
                if ($runOutput -match "port is already allocated" -or $dockerErr -match "port is already allocated") {
                    if ($conflictPort) {
                        Write-Err "端口 ${conflictPort} 被占用，请关闭占用端口的程序后重试"
                        Write-Host "  💡 查看端口占用: netstat -ano | findstr :${conflictPort}" -ForegroundColor Cyan
                    } else {
                        Write-Err "端口被占用，请关闭占用端口的程序后重试"
                    }
                } else {
                    Write-Err "docker run 失败"
                }
                throw "docker run failed: $runOutputText"
            }
            Pop-Location
        } catch {
            $errMsg = "$_"
            if ($errMsg -match "port is already allocated") {
                # 从 docker 错误消息中提取端口号
                $conflictPort = if ($errMsg -match 'Bind for.*:(\d+)') { $Matches[1] } else { "?" }
                Write-Err "端口 ${conflictPort} 已被占用"
                Write-Host "" 
                Write-Host "  💡 解决方法:" -ForegroundColor Cyan
                Write-Host "     1. 查看占用: netstat -ano | findstr :${conflictPort}" -ForegroundColor White
                Write-Host "     2. 或者重新运行安装脚本，选择其他端口" -ForegroundColor White
                Write-Host "" 
            } elseif ($errMsg -match "No such image") {
                # -- 镜像缺失 — 在交互式运行时先询问用户是否尝试从 Release 下载，再尝试 GHCR 拉取 --
                $recoverOK = $false
                $doRecover = $true
                $releaseRecoverReason = ""

                # 如果是交互式运行：若前面尚未选择 edition 才提示选择；否则沿用已选版本
                if ($MyInvocation.MyCommand.Path -or $ImageOnlyDefaulted) {
                    if (-not $script:imageEdition -or $script:imageEdition -eq '') {
                        $script:imageEdition = 'lite'
                    }
                    Write-Info "发布仅保留 Lite 镜像，已选择镜像版本: $script:imageEdition"

                    Write-Host ""
                    Write-Host "  本地镜像不存在，是否尝试从 Release 下载镜像并加载？[Y/n]: " -NoNewline -ForegroundColor White
                    $recChoice = (Read-Host).Trim().ToLower()
                    if ($recChoice -eq 'n' -or $recChoice -eq 'no') {
                        $doRecover = $false
                        Write-Info "已选择跳过 Release 下载，后续将尝试 GHCR 或本地构建（如可用）"
                    }
                }

                if ($doRecover) { Write-Info "尝试自动从 Release 恢复本地镜像..." } else { Write-Info "跳过 Release 下载，继续尝试 GHCR 拉取或本地构建..." }
                if (-not $doRecover) { $releaseRecoverReason = "skipped" }

                # 恢复方式 1: Download-Robust 多线程分块下载 Release tar.gz
                $recoverTag = if ($latestReleaseTag) { $latestReleaseTag } else { "latest" }
                $recoverTagIsAliasLatest = ($recoverTag -eq "latest")
                $recoverAssetName = "openclaw-pro-image-lite.tar.gz"
                Write-Info "远端目标版本: $recoverTag ($script:imageEdition)"
                $recoverTar = Join-Path $TMP_DIR $recoverAssetName
                $releaseBaseUrl = if ($latestReleaseTag) {
                    "https://github.com/$GITHUB_REPO/releases/download/$latestReleaseTag/$recoverAssetName"
                } else {
                    "https://github.com/$GITHUB_REPO/releases/latest/download/$recoverAssetName"
                }
                # 代理镜像优先（国内直连 github.com 通常很慢或不通）
                $recoverUrls = @(
                    "https://ghfast.top/$releaseBaseUrl",
                    "https://mirror.ghproxy.com/$releaseBaseUrl",
                    "https://gh-proxy.com/$releaseBaseUrl",
                    "https://github.moeyy.xyz/$releaseBaseUrl",
                    "https://ghproxy.net/$releaseBaseUrl",
                    $releaseBaseUrl
                )
                $recoverRetryUrls = if ($recoverUrls.Count -gt 1) {
                    @($recoverUrls[1..($recoverUrls.Count - 1)] + $recoverUrls[0])
                } else {
                    $recoverUrls
                }

                Write-Info "尝试从 Release 下载镜像 (多线程分块断点续传)..."
                try {
                    $recoverDownloadOK = $false

                    # 检测上次保留的完整 tar 文件（docker load 失败时不删除）
                    $recoverTagFile = "$recoverTar.tag"
                    $recoverProgressFile = "$recoverTar.progress"
                    $hasRecoverProgress = (Test-Path $recoverProgressFile)
                    $recoverDiskTag = $null
                    if (Test-Path $recoverTagFile) { try { $recoverDiskTag = (Get-Content $recoverTagFile -ErrorAction SilentlyContinue | Select-Object -First 1) } catch { $recoverDiskTag = $null } }
                    if ((Test-Path $recoverTar) -and (Get-Item $recoverTar).Length -gt 50MB) {
                        $existRecoverSize = (Get-Item $recoverTar).Length
                        if ($recoverTag -and $recoverDiskTag -and ($recoverDiskTag -eq "$recoverTag|$script:imageEdition" -or ($recoverTagIsAliasLatest -and $recoverDiskTag -match "^.+\|$([regex]::Escape($script:imageEdition))$"))) {
                            if ($hasRecoverProgress) {
                                Write-Warn "检测到未完成分块进度文件，继续断点续传以确保完整性"
                                $recoverDownloadOK = $false
                            } else {
                            Write-OK "检测到已下载的镜像文件 ($([math]::Round($existRecoverSize / 1MB, 1))MB)，版本匹配，跳过下载"
                            $recoverDownloadOK = $true
                            }
                        } else {
                            Write-Info "检测到已下载的镜像文件 ($([math]::Round($existRecoverSize / 1MB, 1))MB)，将校验版本..."
                            if ($recoverDiskTag -and $recoverTag -and (-not $recoverTagIsAliasLatest) -and $recoverDiskTag -ne "$recoverTag|$script:imageEdition") {
                                Write-Warn "本地镜像文件版本 ($recoverDiskTag) 与远端 ($recoverTag|$script:imageEdition) 不一致，重新下载"
                                Remove-Item $recoverTar -Force -ErrorAction SilentlyContinue
                                if (Test-Path $recoverTagFile) { Remove-Item $recoverTagFile -Force -ErrorAction SilentlyContinue }
                            } else {
                                $recoverSizeHint = Get-RemoteFileSize -Urls $recoverUrls
                                if (($recoverSizeHint -gt 0 -and [math]::Abs($existRecoverSize - $recoverSizeHint) -lt 1MB) -or ($recoverSizeHint -le 0 -and $existRecoverSize -gt 200MB)) {
                                    if ($hasRecoverProgress) {
                                        Write-Warn "检测到已下载镜像缺少版本元数据，且存在分块进度，继续断点续传"
                                        $recoverDownloadOK = $false
                                    } else {
                                        Write-Warn "检测到已下载镜像缺少版本元数据，默认复用并补写元数据"
                                        if ($recoverTag) { try { "$recoverTag|$script:imageEdition" | Set-Content -Path $recoverTagFile -Force -ErrorAction SilentlyContinue } catch { } }
                                        $recoverDownloadOK = $true
                                    }
                                } else {
                                    Write-Warn "本地镜像文件大小与远端不匹配，重新下载"
                                    Remove-Item $recoverTar -Force -ErrorAction SilentlyContinue
                                    if (Test-Path $recoverTagFile) { Remove-Item $recoverTagFile -Force -ErrorAction SilentlyContinue }
                                    $recoverDownloadOK = $false
                                }
                            }
                        }
                    }

                    if (-not $recoverDownloadOK) {
                    $recoverSize = Get-RemoteFileSize -Urls $recoverUrls
                    if ($recoverSize -gt 0) {
                        $recoverMB = [math]::Round($recoverSize / 1MB, 1)
                        Write-Info "文件大小: ${recoverMB}MB，开始 8 线程下载..."
                        $recoverDownloadOK = Download-Robust `
                            -Urls $recoverUrls `
                            -OutFile $recoverTar `
                            -ExpectedSize $recoverSize `
                            -ChunkSizeMB 2 `
                            -Threads 8 `
                            -RetryPerChunk 20
                        if (-not $recoverDownloadOK) {
                            Write-Warn "首轮 8 线程下载未完成，立即按原策略重试（仅补失败块，8线程）..."
                            $recoverDownloadOK = Download-Robust `
                                -Urls $recoverUrls `
                                -OutFile $recoverTar `
                                -ExpectedSize $recoverSize `
                                -ChunkSizeMB 2 `
                                -Threads 8 `
                                -RetryPerChunk 30
                        }
                    } else {
                        Write-Warn "无法获取文件大小，尝试 curl.exe 直链下载..."
                        $recoverDownloadOK = $false
                        foreach ($ru in $recoverUrls) {
                            try {
                                $shortRu = if ($ru.Length -gt 70) { $ru.Substring(0, 67) + "..." } else { $ru }
                                Write-Info "  → $shortRu"
                                & curl.exe -L --fail --connect-timeout 15 --max-time 900 --retry 3 --retry-delay 3 --progress-bar -o $recoverTar $ru 2>&1 | ForEach-Object {
                                    if ($_ -match '\d+.*%') { Write-Host "`r  $($_.Trim())" -NoNewline -ForegroundColor DarkGray }
                                }
                                Write-Host ""
                                if ((Test-Path $recoverTar) -and (Get-Item $recoverTar).Length -gt 50MB) {
                                    try { "$recoverTag|$script:imageEdition" | Set-Content -Path "$recoverTagFile" -Force -ErrorAction SilentlyContinue } catch { }
                                    $recoverDownloadOK = $true
                                    break
                                }
                            } catch { }
                        }
                    }
                    } # end if (-not $recoverDownloadOK)

                    if ($recoverDownloadOK) {
                        try { "$recoverTag|$script:imageEdition" | Set-Content -Path "$recoverTagFile" -Force -ErrorAction SilentlyContinue } catch { }
                        Write-OK "镜像下载完成"
                    }

                    # ── 校验 + 加载循环（最多 2 轮：首次加载 + 重新下载重试） ──
                    $loadAttempt = 0
                    while ($recoverDownloadOK -and -not $recoverOK -and $loadAttempt -lt 2) {
                        $loadAttempt++

                        # ── 加载前校验 tar 完整性（快速读取归档头部条目） ──
                        Write-Info "校验镜像文件完整性..."
                        $tarValid = $false
                        $tarExitCode = -1
                        $tarErrorSample = @()
                        try {
                            & tar -tf $recoverTar *> $null
                            $tarExitCode = $LASTEXITCODE
                            if ($tarExitCode -eq 0) {
                                $tarValid = $true
                            } else {
                                try {
                                    $tarErrorSample = @(& tar -tf $recoverTar 2>&1 | Select-Object -First 6)
                                } catch { }
                            }
                        } catch {
                            $tarExitCode = if ($LASTEXITCODE) { $LASTEXITCODE } else { -1 }
                            $tarErrorSample = @("tar exception: $($_.Exception.Message)")
                        }

                        if (-not $tarValid) {
                            $tarSizeMB = -1
                            $tarSizeBytes = 0
                            $tarLastWrite = "unknown"
                            if (Test-Path $recoverTar) {
                                try {
                                    $tarItem = Get-Item $recoverTar
                                    $tarSizeBytes = [long]$tarItem.Length
                                    $tarSizeMB = [math]::Round($tarSizeBytes / 1MB, 2)
                                    $tarLastWrite = $tarItem.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
                                } catch { }
                            }
                            Write-Log "Tar validate failed: attempt=$loadAttempt exitCode=$tarExitCode file=$recoverTar sizeBytes=$tarSizeBytes sizeMB=$tarSizeMB lastWrite=$tarLastWrite targetTag=$recoverTag edition=$script:imageEdition"
                            if (Test-Path $recoverTagFile) {
                                try {
                                    $tagMeta = (Get-Content $recoverTagFile -ErrorAction SilentlyContinue | Select-Object -First 1)
                                    if ($tagMeta) { Write-Log "Tar tag metadata: $tagMeta" }
                                } catch { }
                            }
                            if ($tarErrorSample -and $tarErrorSample.Count -gt 0) {
                                foreach ($te in $tarErrorSample) {
                                    if ($te) { Write-Log "tar check stderr: $te" }
                                }
                            }
                            if ($loadAttempt -ge 2) {
                                Write-Warn "重新下载后镜像文件仍无法通过完整性校验"
                                $releaseRecoverReason = "download"
                                $recoverDownloadOK = $false
                                break
                            }
                            Write-Warn "镜像文件损坏或不完整，删除并重新下载..."
                            Remove-Item $recoverTar -Force -ErrorAction SilentlyContinue
                            if (Test-Path $recoverTagFile) { Remove-Item $recoverTagFile -Force -ErrorAction SilentlyContinue }
                            $recoverDownloadOK = $false
                            $recoverSize = Get-RemoteFileSize -Urls $recoverUrls
                            if ($recoverSize -gt 0) {
                                $recoverMB = [math]::Round($recoverSize / 1MB, 1)
                                Write-Info "完整性校验失败，切换到下一个下载源优先重试 (${recoverMB}MB)..."
                                $recoverDownloadOK = Download-Robust `
                                    -Urls $recoverRetryUrls `
                                    -OutFile $recoverTar `
                                    -ExpectedSize $recoverSize `
                                    -ChunkSizeMB 2 `
                                    -Threads 8 `
                                    -RetryPerChunk 20 `
                                    -ForceFresh
                                if (-not $recoverDownloadOK) {
                                    Write-Warn "8 线程重试未完成，继续按原策略重试（仅补失败块，8线程）..."
                                    $recoverDownloadOK = Download-Robust `
                                        -Urls $recoverRetryUrls `
                                        -OutFile $recoverTar `
                                        -ExpectedSize $recoverSize `
                                        -ChunkSizeMB 2 `
                                        -Threads 8 `
                                        -RetryPerChunk 30 `
                                        -ForceFresh
                                }
                            }
                            if (-not $recoverDownloadOK) {
                                $releaseRecoverReason = "download"
                                break
                            }
                            try { "$recoverTag|$script:imageEdition" | Set-Content -Path "$recoverTagFile" -Force -ErrorAction SilentlyContinue } catch { }
                            continue  # 回到循环顶部重新校验
                        }

                        Write-OK "镜像文件校验通过"

                        $recoverLoadSizeText = "未知大小"
                        if (Test-Path $recoverTar) {
                            $recoverLoadSizeText = "$( [math]::Round((Get-Item $recoverTar).Length / 1MB, 1) )MB"
                        }
                        Write-Info "正在加载镜像到 Docker...（$recoverLoadSizeText，通常需 1-5 分钟，请耐心等待）"

                        # 清理可能残留的 docker load 进程（上次 Ctrl+C 后遗留的 Start-Job 子进程）
                        try {
                            Get-Process | Where-Object {
                                $_.ProcessName -match 'docker' -and $_.Id -ne $PID
                            } | ForEach-Object {
                                try {
                                    $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                                    if ($cmdLine -match 'load.*tar') {
                                        Write-Log "Killing stale docker load process: PID=$($_.Id)"
                                        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                                    }
                                } catch { }
                            }
                        } catch { }

                        # 后台加载 + 前台旋转动画
                        $loadJob = Start-Job -ScriptBlock {
                            param($tar)
                            & docker load -i $tar 2>&1
                        } -ArgumentList $recoverTar

                        $spinner = @('|','/','-','\')
                        $si = 0
                        $loadTimer = [System.Diagnostics.Stopwatch]::StartNew()
                        $slowLoadHintShown = $false
                        try {
                        while ($loadJob.State -eq 'Running') {
                            $elapsed = [math]::Floor($loadTimer.Elapsed.TotalSeconds)
                            $min = [math]::Floor($elapsed / 60)
                            $sec = $elapsed % 60
                            $spinChar = $spinner[$si % $spinner.Count]
                            Write-Host "`r  $spinChar 加载中... 已耗时 ${min}分${sec}秒    " -NoNewline -ForegroundColor Cyan
                            if (-not $slowLoadHintShown -and $elapsed -ge 300) {
                                $slowLoadHintShown = $true
                                Write-Host ""
                                Write-Warn "镜像加载已超过 5 分钟，可能存在磁盘/杀软扫描/后台任务竞争"
                                Write-Host "     诊断建议: docker system df" -ForegroundColor DarkGray
                                Write-Host "     诊断建议: Get-Process docker" -ForegroundColor DarkGray
                                Write-Host "     若长时间无进展，可重启 Docker Desktop 后重试" -ForegroundColor DarkGray
                            }
                            $si++
                            Start-Sleep -Milliseconds 200
                        }
                        } finally {
                            if ($loadJob.State -eq 'Running') {
                                Write-Host "`n  正在清理后台加载进程..." -ForegroundColor Yellow
                                Stop-Job $loadJob -ErrorAction SilentlyContinue
                            }
                        }
                        Write-Host ""
                        $loadTimer.Stop()
                        $loadOutput = Receive-Job $loadJob -ErrorAction SilentlyContinue 2>&1
                        Remove-Job $loadJob -Force
                        $totalLoadSec = [math]::Floor($loadTimer.Elapsed.TotalSeconds)

                        $recoverLoadedRefs = @()

                        $loadOutput | ForEach-Object {
                            Write-Log "docker load(recover): $_"
                            if ($_ -match "Loaded image") {
                                Write-Host "  $_" -ForegroundColor DarkGray
                                if ($_ -match '^Loaded image:\s*(.+)\s*$') {
                                    $recoverLoadedRefs += $Matches[1].Trim()
                                    try { & docker tag $Matches[1].Trim() "openclaw-pro:latest" 2>$null } catch { }
                                }
                            } elseif ($_ -match '^Loaded image ID:\s*(sha256:[0-9a-f]+)\s*$') {
                                $recoverLoadedRefs += $Matches[1].Trim()
                                try { & docker tag $Matches[1].Trim() "openclaw-pro:latest" 2>$null } catch { }
                            }
                        }

                        # 强化校验：recover 路径同样对 lite->latest 做强制修复，减少误回退 GHCR
                        $recoverSawLite = $false
                        if ($script:imageEdition -eq 'lite') {
                            foreach ($ref in $recoverLoadedRefs) {
                                if (("$ref").ToLower() -match 'openclaw-pro:lite$' -or ("$ref").ToLower() -match ':v\d+\.\d+\.\d+.*-lite$') {
                                    $recoverSawLite = $true
                                    break
                                }
                            }
                            if (-not $recoverSawLite) {
                                $recoverLiteProbe = & docker image inspect openclaw-pro:lite 2>$null
                                if ($LASTEXITCODE -eq 0) { $recoverSawLite = $true }
                            }
                        }
                        if ($recoverSawLite) {
                            Write-Info "检测到已加载 lite 镜像，执行强化 tag 修复（openclaw-pro:lite -> openclaw-pro:latest）..."
                            for ($rti = 1; $rti -le 3; $rti++) {
                                try { & docker tag "openclaw-pro:lite" "openclaw-pro:latest" 2>$null } catch { }
                                Start-Sleep -Milliseconds 300
                                $recoverTagChk = & docker image inspect openclaw-pro:latest 2>$null
                                if ($LASTEXITCODE -eq 0) { break }
                            }
                        }

                        # 若上面没有成功创建 openclaw-pro:latest，继续扫描镜像列表并尝试 tag
                        $chk = & docker image inspect openclaw-pro:latest 2>$null
                        if ($LASTEXITCODE -ne 0) {
                            if ($script:imageEdition -eq 'lite') {
                                $liteChk = & docker image inspect openclaw-pro:lite 2>$null
                                if ($LASTEXITCODE -eq 0) {
                                    try { & docker tag "openclaw-pro:lite" "openclaw-pro:latest" 2>$null } catch { }
                                }
                            }
                            $allImages = & docker images --format '{{.Repository}}:{{.Tag}}' 2>$null
                            foreach ($im in $allImages) {
                                if ($im -and $im -match 'openclaw-pro') {
                                    try { & docker tag $im "openclaw-pro:latest" 2>$null } catch { }
                                }
                            }
                        }

                        $chk = & docker image inspect openclaw-pro:latest 2>$null
                        if ($LASTEXITCODE -eq 0) {
                            Write-OK "Release 镜像加载完成 (耗时 ${totalLoadSec} 秒)"
                            $recoverOK = $true
                        } else {
                            if ($loadAttempt -lt 2) {
                                Write-Warn "docker load 失败，删除镜像文件并重新下载重试..."
                                Remove-Item $recoverTar -Force -ErrorAction SilentlyContinue
                                if (Test-Path $recoverTagFile) { Remove-Item $recoverTagFile -Force -ErrorAction SilentlyContinue }
                                $recoverDownloadOK = $false
                                $recoverSize = Get-RemoteFileSize -Urls $recoverUrls
                                if ($recoverSize -gt 0) {
                                    $recoverMB = [math]::Round($recoverSize / 1MB, 1)
                                    Write-Info "加载失败后切换到下一个下载源优先重试 (${recoverMB}MB)..."
                                    $recoverDownloadOK = Download-Robust `
                                        -Urls $recoverRetryUrls `
                                        -OutFile $recoverTar `
                                        -ExpectedSize $recoverSize `
                                        -ChunkSizeMB 2 `
                                        -Threads 8 `
                                        -RetryPerChunk 20 `
                                        -ForceFresh
                                    if (-not $recoverDownloadOK) {
                                        Write-Warn "8 线程重试未完成，继续按原策略重试（仅补失败块，8线程）..."
                                        $recoverDownloadOK = Download-Robust `
                                            -Urls $recoverRetryUrls `
                                            -OutFile $recoverTar `
                                            -ExpectedSize $recoverSize `
                                            -ChunkSizeMB 2 `
                                            -Threads 8 `
                                            -RetryPerChunk 30 `
                                            -ForceFresh
                                    }
                                }
                                if (-not $recoverDownloadOK) {
                                    $releaseRecoverReason = "download"
                                    break
                                }
                                try { "$recoverTag|$script:imageEdition" | Set-Content -Path "$recoverTagFile" -Force -ErrorAction SilentlyContinue } catch { }
                                Write-Info "重新下载完成，重试加载..."
                            } else {
                                $releaseRecoverReason = "load"
                                Write-Warn "docker load 重试仍失败"
                                Write-Info "镜像文件已保留: $recoverTar（可手动执行 docker load -i 排查）"
                            }
                        }
                    }
                    if (-not $recoverDownloadOK -and -not $releaseRecoverReason) {
                        $releaseRecoverReason = "download"
                    }
                } catch {
                    if (-not $releaseRecoverReason) {
                        if ($recoverDownloadOK) { $releaseRecoverReason = "load" } else { $releaseRecoverReason = "download" }
                    }
                    Write-Log "Recovery Release step failed: $_"
                    if ($releaseRecoverReason -eq "load") {
                        Write-Warn "Release 镜像加载阶段异常，将尝试 GHCR 回退"
                    }
                }

                # 恢复方式 2: GHCR 拉取
                if (-not $recoverOK) {
                    if (-not $doRecover) {
                        Write-Info "已跳过 Release 下载，尝试从 GHCR 拉取..."
                    } elseif ($releaseRecoverReason -eq "load") {
                        Write-Info "Release 镜像已下载但加载未完成，尝试从 GHCR 拉取..."
                    } else {
                        Write-Info "Release 下载失败，尝试从 GHCR 拉取..."
                    }
                    try {
                        $recoverGhcrTag = $recoverTag
                        if ($script:imageEdition -eq "lite") {
                            $recoverGhcrTag = if ($latestReleaseTag) { "$latestReleaseTag-lite" } else { "lite" }
                        }
                        $recoverImage = "ghcr.io/${GITHUB_REPO}:${recoverGhcrTag}"
                        $pullOut = & docker pull $recoverImage 2>&1
                        $pullCode = $LASTEXITCODE
                        $pullOut | ForEach-Object {
                            if ($_ -match "Pulling|Downloading|Extracting|Pull complete|Digest|Status") {
                                Write-Host "  $_" -ForegroundColor DarkGray
                            }
                        }
                        if ($pullCode -eq 0) {
                            & docker tag $recoverImage "openclaw-pro:latest" 2>$null
                            $tagOk = & docker image inspect "openclaw-pro:latest" 2>$null
                            if ($LASTEXITCODE -eq 0) {
                                Write-OK "GHCR 镜像拉取成功"
                                $recoverOK = $true
                            }
                        }
                    } catch {
                        Write-Log "GHCR recovery failed: $_"
                    }
                }

                # 恢复后重试启动容器
                if ($recoverOK) {
                    Write-Info "正在重试启动容器..."
                    $retryHomeData = if ([string]::IsNullOrWhiteSpace("$homeData")) { $defaultHomeData } else { $homeData }
                    if ([string]::IsNullOrWhiteSpace("$retryHomeData")) {
                        $retryHomeDataName = "home-data"
                        if ($containerName -match '^openclaw-pro-(\d+)$') {
                            $retryHomeDataName = "home-data-$($Matches[1])"
                        }
                        $retryHomeData = Join-Path $homeBaseDir $retryHomeDataName
                        Write-Info "检测到数据目录变量为空，回退到默认数据目录: $retryHomeData"
                    }
                    if (-not (Test-Path $retryHomeData)) {
                        New-Item -ItemType Directory -Path $retryHomeData -Force | Out-Null
                    }
                    $retryRootData = Join-Path $retryHomeData "root"
                    if (-not (Test-Path $retryRootData)) {
                        New-Item -ItemType Directory -Path $retryRootData -Force | Out-Null
                    }
                    try {
                        $containerExists = (& docker ps -a --filter "name=^/$containerName$" --format "{{.Names}}" 2>$null | Select-Object -First 1)
                        if ($containerExists -eq $containerName) {
                            & docker rm -f $containerName 2>$null | Out-Null
                        }
                    } catch {
                        Write-Log "Ignore container cleanup error before retry: $_"
                    }
                    Start-Sleep -Seconds 1
                    try {
                        $pushedLocal = $false
                        if (Test-Path $localDeployDir) { try { Push-Location $localDeployDir; $pushedLocal = $true } catch { $pushedLocal = $false } }
                        $retryArgs = @(
                            "run", "-d",
                            "--name", $containerName,
                            "--hostname", "openclaw",
                            "--dns", "8.8.8.8",
                            "--dns", "8.8.4.4",
                            "-v", "${retryRootData}:/root",
                            "-e", "TZ=Asia/Shanghai",
                            "--restart", "unless-stopped"
                        )
                        $retryArgs += $deployConfig.PortArgs
                        $retryArgs += "openclaw-pro:latest"
                        $retryResult = & docker @retryArgs 2>&1
                        $retryCode = $LASTEXITCODE
                        if ($retryCode -eq 0) {
                            Write-OK "容器启动成功"
                            $launched = $true
                            $script:deployedContainerName = $containerName
                        } else {
                            Write-Log "retry docker run failed: $($retryResult | Out-String)"
                        }
                        if ($pushedLocal) { Pop-Location }
                    } catch {
                        Write-Log "retry start container exception: $_"
                        Pop-Location -ErrorAction SilentlyContinue
                    }
                }

                if (-not $launched) {
                    Write-Err "镜像获取失败"
                    Write-Host ""
                    Write-Host "  💡 请手动执行以下命令后重新运行安装脚本:" -ForegroundColor Cyan
                    Write-Host "     docker pull ghcr.io/${GITHUB_REPO}:latest" -ForegroundColor White
                    Write-Host "     docker tag ghcr.io/${GITHUB_REPO}:latest openclaw-pro:latest" -ForegroundColor White
                    Write-Host ""
                }
            } else {
                Write-Err "Docker 操作失败: $_"
            }
            Pop-Location -ErrorAction SilentlyContinue
        }
        }  # end if (-not $launched)
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
                return
            }
        } else {
            Write-OK "部署包已存在，跳过复制"
        }

        # -- Phase 5: Cleanup + Launch ------------------------------------------
        Write-Step 5 5 "启动 OpenClaw..."

        # Remove scheduled task if it exists
        Remove-ResumeTask
        Remove-InstallState

        # Launch deploy in WSL terminal
        $launched = Start-OpenClawDeploy -DistroName $distroName
    }

    Write-Log "Deploy launched: $launched"

    $gwPort = if ($script:actualGatewayPort) { $script:actualGatewayPort } else { [int]$OPENCLAW_PORT }
    $wpPort = if ($script:actualPanelPort) { $script:actualPanelPort } else { [int]$WEB_PANEL_PORT }
    $dom    = if ($script:deployDomain) { $script:deployDomain } else { "" }
    $cmode  = if ($script:certMode) { $script:certMode } else { "letsencrypt" }
    $hPort  = if ($script:httpPort) { $script:httpPort } else { 0 }
    $hsPort = if ($script:httpsPort) { $script:httpsPort } else { 0 }
    $sPort  = if ($script:sshPort) { $script:sshPort } else { 2222 }
    $autoFw = if ($null -ne $script:autoOpenFirewall) { [bool]$script:autoOpenFirewall } else { $true }
    Show-Completion -DeployLaunched $launched -IsDockerDesktop $dockerDesktopMode -GatewayPort $gwPort -PanelPort $wpPort -Domain $dom -CertMode $cmode -HttpPort $hPort -HttpsPort $hsPort -SshPort $sPort -AutoOpenFirewall $autoFw

    if ($launched) {
        $enterContainerName = if ($script:deployedContainerName) { $script:deployedContainerName } else { "openclaw-pro" }
        Write-LaunchAccessSummary -IsDockerDesktop $dockerDesktopMode -GatewayPort $gwPort -PanelPort $wpPort -Domain $dom -CertMode $cmode -HttpPort $hPort -HttpsPort $hsPort -SshPort $sPort
        Write-Host "  ==================================================" -ForegroundColor DarkCyan
        Write-Host "  🚪 默认进入容器终端（输入 exit 返回）" -ForegroundColor Cyan
        Write-Host "     docker exec -it $enterContainerName bash" -ForegroundColor Yellow
        Write-Host "  ==================================================" -ForegroundColor DarkCyan
        Write-Host ""
        try {
            & docker exec -it $enterContainerName bash
        } catch {
            Write-Warn "自动进入容器失败，请手动执行: docker exec -it $enterContainerName bash"
        }
    }

    Read-Host "按回车关闭此窗口"
}

# --- Entry Point --------------------------------------------------------------
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
    return
}
