<#
.SYNOPSIS
    OpenClaw Pro - Quick Update Script
    快速更新 OpenClaw Pro 容器到最新版本

.DESCRIPTION
    读取现有容器配置，拉取最新镜像，重建容器（保留所有数据和配置）
    等效于运行安装脚本并选择"升级"，但跳过所有交互。
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$GITHUB_REPO = "cintia09/openclaw-pro"
$CONTAINER_NAME = "openclaw-pro"
$IMAGE_NAME = "openclaw-pro"

function Write-Step($msg) { Write-Host "`n  ▸ $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "  ❌ $msg" -ForegroundColor Red }
function Write-Dim($msg)  { Write-Host "    $msg" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║     OpenClaw Pro - Quick Updater         ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── 1. 检查 Docker ──
Write-Step "检查 Docker..."
try {
    $dockerVer = (& docker version --format '{{.Server.Version}}' 2>$null)
    if (-not $dockerVer) { throw "no docker" }
    Write-OK "Docker $dockerVer"
} catch {
    Write-Err "未检测到 Docker，请先安装 Docker Desktop"
    Read-Host "按回车退出"
    exit 1
}

# ── 2. 检查现有容器 ──
Write-Step "检查现有容器..."
$existingId = (& docker ps -aq --filter "name=^${CONTAINER_NAME}$" 2>$null)
if (-not $existingId) {
    Write-Err "未找到容器 '$CONTAINER_NAME'，请先运行安装脚本"
    Write-Dim "irm https://raw.githubusercontent.com/$GITHUB_REPO/main/install-windows.ps1 | iex"
    Read-Host "按回车退出"
    exit 1
}
Write-OK "找到容器: $($existingId.Substring(0, 12))"

# ── 3. 读取现有配置 ──
Write-Step "读取容器配置..."

# 从容器获取 docker-config.json
$configJson = ""
try {
    $configJson = (& docker exec $CONTAINER_NAME cat /root/.openclaw/docker-config.json 2>$null) | Out-String
} catch {}

if (-not $configJson.Trim()) {
    Write-Err "无法读取容器配置文件"
    Read-Host "按回车退出"
    exit 1
}

$config = $configJson | ConvertFrom-Json
Write-Dim "域名: $($config.domain)"
Write-Dim "HTTP 端口: $($config.http_port)  HTTPS 端口: $($config.https_port)"

# 获取挂载点（home-data 路径）
$homeDataMount = ""
try {
    $mounts = (& docker inspect $CONTAINER_NAME --format '{{json .Mounts}}' 2>$null) | ConvertFrom-Json
    foreach ($m in $mounts) {
        if ($m.Destination -eq "/root") {
            $homeDataMount = $m.Source
            break
        }
    }
} catch {}

if (-not $homeDataMount) {
    Write-Err "无法获取 home-data 挂载路径"
    Read-Host "按回车退出"
    exit 1
}
Write-Dim "数据目录: $homeDataMount"

# 获取端口映射
$portMappings = @()
try {
    $inspect = (& docker inspect $CONTAINER_NAME 2>$null) | ConvertFrom-Json
    $ports = $inspect[0].NetworkSettings.Ports
    foreach ($containerPort in $ports.PSObject.Properties.Name) {
        $bindings = $ports.$containerPort
        if ($bindings) {
            foreach ($b in $bindings) {
                $hostPort = $b.HostPort
                $cPort = $containerPort -replace '/tcp$', '' -replace '/udp$', ''
                $portMappings += "-p"
                $portMappings += "${hostPort}:${cPort}"
            }
        }
    }
} catch {}

if ($portMappings.Count -eq 0) {
    Write-Err "无法获取端口映射"
    Read-Host "按回车退出"
    exit 1
}
Write-Dim "端口映射: $($portMappings -join ' ')"

# ── 4. 获取当前版本 ──
$currentVersion = "unknown"
try {
    $currentVersion = (& docker exec $CONTAINER_NAME cat /etc/openclaw-version 2>$null).Trim()
} catch {}
Write-Dim "当前版本: $currentVersion"

# ── 5. 检查最新版本 ──
Write-Step "检查最新版本..."
$latestVersion = ""
$downloadUrl = ""
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GITHUB_REPO/releases/latest" -UseBasicParsing -TimeoutSec 15
    $latestVersion = $release.tag_name
    foreach ($asset in $release.assets) {
        if ($asset.name -eq "openclaw-pro-image.tar.gz") {
            $downloadUrl = $asset.browser_download_url
            break
        }
    }
} catch {
    Write-Dim "无法获取最新版本信息: $_"
}

if ($latestVersion -and $latestVersion -eq $currentVersion) {
    Write-Host ""
    Write-OK "当前已是最新版本 ($currentVersion)"
    Write-Host ""
    $forceUpdate = Read-Host "  仍然要重新安装吗？[y/N]"
    if ($forceUpdate -notin @("y", "Y", "yes")) {
        exit 0
    }
} elseif ($latestVersion) {
    Write-OK "最新版本: $latestVersion"
}

# ── 6. 下载最新镜像 ──
Write-Step "下载最新镜像..."
$downloadDir = Join-Path $env:TEMP "openclaw-update"
if (-not (Test-Path $downloadDir)) { New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null }

$tarPath = Join-Path $downloadDir "openclaw-pro-image.tar.gz"
$downloaded = $false

if ($downloadUrl) {
    Write-Dim "从 GitHub Release 下载..."
    try {
        $webClient = New-Object System.Net.WebClient
        $webClient.DownloadFile($downloadUrl, $tarPath)
        $downloaded = $true
        Write-OK "下载完成: $([Math]::Round((Get-Item $tarPath).Length / 1MB, 1)) MB"
    } catch {
        Write-Dim "下载失败: $_, 尝试 GHCR..."
    }
}

if (-not $downloaded) {
    # Try GHCR
    Write-Dim "从 GHCR 拉取镜像..."
    try {
        $pullTag = if ($latestVersion) { $latestVersion } else { "latest" }
        & docker pull "ghcr.io/${GITHUB_REPO}:${pullTag}" 2>&1
        if ($LASTEXITCODE -eq 0) {
            & docker tag "ghcr.io/${GITHUB_REPO}:${pullTag}" "${IMAGE_NAME}:latest"
            $downloaded = $true
            Write-OK "GHCR 拉取完成"
        }
    } catch {}
}

if (-not $downloaded) {
    Write-Err "无法获取最新镜像"
    Read-Host "按回车退出"
    exit 1
}

# ── 7. 加载镜像 ──
if (Test-Path $tarPath) {
    Write-Step "加载镜像..."
    & docker rmi -f $IMAGE_NAME 2>$null | Out-Null
    & docker load -i $tarPath 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "docker load 失败"
        Read-Host "按回车退出"
        exit 1
    }
    Write-OK "镜像加载完成"
    Remove-Item $tarPath -Force -ErrorAction SilentlyContinue
}

# ── 8. 停止并删除旧容器 ──
Write-Step "停止旧容器..."
& docker stop $CONTAINER_NAME 2>$null | Out-Null
& docker rm -f $CONTAINER_NAME 2>$null | Out-Null
Write-OK "旧容器已删除"

# ── 9. 启动新容器 ──
Write-Step "启动新容器..."
$runArgs = @(
    "run", "-d",
    "--name", $CONTAINER_NAME,
    "--hostname", "openclaw",
    "-v", "${homeDataMount}:/root",
    "-e", "TZ=Asia/Shanghai",
    "--restart", "unless-stopped"
)
$runArgs += $portMappings
$runArgs += $IMAGE_NAME

Write-Dim "docker $($runArgs -join ' ')"
$result = & docker @runArgs 2>&1
$output = $result | Out-String

if ($LASTEXITCODE -ne 0) {
    Write-Err "启动失败: $output"
    Read-Host "按回车退出"
    exit 1
}
Write-OK "新容器已启动"

# ── 10. 等待服务就绪 ──
Write-Step "等待服务就绪..."
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep 2
    try {
        $health = (& docker exec $CONTAINER_NAME curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>$null)
        if ($health -in @("200", "302", "401")) {
            $ready = $true
            break
        }
    } catch {}
    Write-Host "." -NoNewline
}
Write-Host ""

if ($ready) {
    Write-OK "所有服务已就绪"
} else {
    Write-Dim "服务仍在启动中，请稍等几秒再访问"
}

# ── 完成 ──
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║          更新完成！                      ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

$newVersion = "unknown"
try {
    $newVersion = (& docker exec $CONTAINER_NAME cat /etc/openclaw-version 2>$null).Trim()
} catch {}

Write-Host "  版本: $currentVersion → $newVersion" -ForegroundColor Cyan
Write-Host ""

# 显示访问地址
$domain = $config.domain
if ($domain) {
    $httpsPort = $config.https_port
    if ($httpsPort -and $httpsPort -ne 443) {
        Write-Host "  🔗 https://${domain}:${httpsPort}" -ForegroundColor White
    } elseif ($httpsPort) {
        Write-Host "  🔗 https://${domain}" -ForegroundColor White
    }
} else {
    $webPort = 3000
    foreach ($i in 0..($portMappings.Count - 1)) {
        if ($portMappings[$i] -eq '-p' -and ($i + 1) -lt $portMappings.Count) {
            $mapping = $portMappings[$i + 1]
            if ($mapping -match ':3000$') {
                $webPort = ($mapping -split ':')[0]
            }
        }
    }
    Write-Host "  🔗 http://localhost:${webPort}" -ForegroundColor White
}
Write-Host ""

Read-Host "按回车退出"
