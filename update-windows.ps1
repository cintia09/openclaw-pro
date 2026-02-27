# OpenClaw Pro - Quick Update Script
# 快速更新 OpenClaw Pro 容器到最新版本
# 读取现有容器配置，拉取最新镜像，重建容器（保留所有数据和配置）

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# PowerShell 5.1 默认不启用 TLS 1.2，导致无法连接 GitHub
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$GITHUB_REPO = "cintia09/openclaw-pro"
$CONTAINER_NAME = "openclaw-pro"
$IMAGE_NAME = "openclaw-pro"

function Write-Step($msg) { Write-Host "`n  ➡️  $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "  ❌ $msg" -ForegroundColor Red }
function Write-Dim($msg)  { Write-Host "    $msg" -ForegroundColor DarkGray }
function Write-Warn($msg) { Write-Host "  ⚠️  $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor Cyan }

# --- Robust Multi-threaded Chunked Download (多线程分块断点续传) --------------
function Download-Robust {
    param(
        [string[]]$Urls,
        [string]$OutFile,
        [long]$ExpectedSize,
        [int]$ChunkSizeMB = 2,
        [int]$Threads = 8,
        [int]$RetryPerChunk = 20
    )

    $chunkSize = [long]($ChunkSizeMB * 1024 * 1024)
    $totalChunks = [int][math]::Ceiling($ExpectedSize / $chunkSize)
    $totalMB = [math]::Round($ExpectedSize / 1MB, 1)

    $progressFile = "${OutFile}.progress"
    $completedSet = [System.Collections.Concurrent.ConcurrentDictionary[int,byte]]::new()

    $needPrealloc = $false
    if (-not (Test-Path $OutFile)) { $needPrealloc = $true }
    elseif ((Get-Item $OutFile).Length -ne $ExpectedSize) { $needPrealloc = $true }

    $progressValid = $false
    if ((Test-Path $progressFile) -and -not $needPrealloc) {
        $progressLines = Get-Content $progressFile -ErrorAction SilentlyContinue
        $sizeMatch = $false
        foreach ($line in $progressLines) {
            if ($line -match '^SIZE:(\d+)$') {
                if ([long]$Matches[1] -eq $ExpectedSize) { $sizeMatch = $true }
                continue
            }
            if ($line -match '^\d+$') { $completedSet.TryAdd([int]$line, [byte]1) | Out-Null }
        }
        if ($sizeMatch -or ($completedSet.Count -gt 0 -and -not ($progressLines | Where-Object { $_ -match '^SIZE:' }))) {
            $progressValid = $true
        } else { $completedSet.Clear() }
    }

    if ($needPrealloc) {
        if ((Test-Path $progressFile) -and $completedSet.Count -eq 0) {
            $oldCount = (Get-Content $progressFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' }).Count
            if ($oldCount -gt 0) { Write-Warn "目标文件已失效，旧进度 ${oldCount} 块作废，将重新下载" }
        }
        $completedSet.Clear()
        if (Test-Path $progressFile) { Remove-Item $progressFile -Force -ErrorAction SilentlyContinue }
        Write-Info "预分配 ${totalMB}MB 磁盘空间..."
        $fs = [IO.File]::Create($OutFile); $fs.SetLength($ExpectedSize); $fs.Close()
        "SIZE:$ExpectedSize" | Set-Content $progressFile -Force
    } elseif (-not (Test-Path $progressFile)) {
        "SIZE:$ExpectedSize" | Set-Content $progressFile -Force
    }

    if ($completedSet.Count -gt 0) {
        $doneMB = [math]::Round([math]::Min([long]$completedSet.Count * $chunkSize, $ExpectedSize) / 1MB, 1)
        Write-Info "续传下载，已完成 $($completedSet.Count)/${totalChunks} 块 (${doneMB}MB / ${totalMB}MB)"
    }

    if ($completedSet.Count -ge $totalChunks) {
        if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -eq $ExpectedSize) {
            Write-OK "镜像文件已完整下载 (${totalMB}MB)"
            Remove-Item $progressFile -Force -ErrorAction SilentlyContinue
            return $true
        }
    }

    $chunkQueue = [System.Collections.Concurrent.ConcurrentQueue[int]]::new()
    $pendingCount = 0
    for ($i = 0; $i -lt $totalChunks; $i++) {
        if (-not $completedSet.ContainsKey($i)) { $chunkQueue.Enqueue($i); $pendingCount++ }
    }
    if ($pendingCount -eq 0) {
        Write-OK "所有块已下载完成"
        Remove-Item $progressFile -Force -ErrorAction SilentlyContinue
        return $true
    }

    $failedChunks = [System.Collections.Concurrent.ConcurrentBag[int]]::new()
    $actualThreads = [math]::Min($Threads, $pendingCount)
    Write-Info "${actualThreads} 线程并行下载: ${pendingCount} 块 x ${ChunkSizeMB}MB (断线自动续传)"

    $workerScript = {
        param($Queue, [string[]]$Urls, [string]$FilePath, [long]$ChunkSize, [long]$FileSize,
              [int]$MaxRetry, $Done, [string]$ProgressPath, $Failed)

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
                    $req = [System.Net.HttpWebRequest]::Create($Urls[$urlIdx])
                    $req.AllowAutoRedirect = $true
                    $req.Timeout = 30000; $req.ReadWriteTimeout = 30000
                    $req.UserAgent = "OpenClaw-Updater/1.0"
                    $req.KeepAlive = $false
                    $req.AddRange([long]$rangeStart, [long]$rangeEnd)
                    $resp = $req.GetResponse()
                    $netStream = $resp.GetResponseStream()
                    $fs = [IO.File]::Open($FilePath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
                    $fs.Seek($rangeStart, [IO.SeekOrigin]::Begin) | Out-Null
                    $buf = New-Object byte[] 65536
                    $got = [long]0
                    while ($got -lt $expectedLen) {
                        $n = $netStream.Read($buf, 0, [int][math]::Min($buf.Length, $expectedLen - $got))
                        if ($n -eq 0) { break }
                        $fs.Write($buf, 0, $n); $got += $n
                    }
                    $fs.Flush(); $fs.Close(); $fs = $null
                    $netStream.Close(); $netStream = $null
                    $resp.Close(); $resp = $null
                    if ($got -eq $expectedLen) {
                        $ok = $true
                        $Done.TryAdd($chunkIdx, [byte]1) | Out-Null
                        try { [IO.File]::AppendAllText($ProgressPath, "$chunkIdx`r`n") } catch {}
                    }
                } catch {
                    if ($retry -lt $MaxRetry - 1) { Start-Sleep -Seconds ([math]::Min(($retry + 1) * 2, 8)) }
                } finally {
                    if ($fs) { try { $fs.Close() } catch {} }
                    if ($netStream) { try { $netStream.Close() } catch {} }
                    if ($resp) { try { $resp.Close() } catch {} }
                }
            }
            if (-not $ok) { $Failed.Add($chunkIdx) }
        }
    }

    $pool = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspacePool(1, $actualThreads)
    $pool.Open()
    $handles = [System.Collections.ArrayList]::new()
    for ($t = 0; $t -lt $actualThreads; $t++) {
        $ps = [PowerShell]::Create()
        $ps.RunspacePool = $pool
        $ps.AddScript($workerScript).
            AddArgument($chunkQueue).AddArgument($Urls).AddArgument($OutFile).
            AddArgument($chunkSize).AddArgument($ExpectedSize).AddArgument($RetryPerChunk).
            AddArgument($completedSet).AddArgument($progressFile).AddArgument($failedChunks) | Out-Null
        $handles.Add(@{ PS = $ps; AR = $ps.BeginInvoke() }) | Out-Null
    }

    $speedTimer = [System.Diagnostics.Stopwatch]::StartNew()
    $initialDone = $totalChunks - $pendingCount
    while ($handles | Where-Object { -not $_.AR.IsCompleted }) {
        Start-Sleep -Milliseconds 500
        $doneNow = $completedSet.Count
        $currentBytes = [long][math]::Min([long]$doneNow * $chunkSize, $ExpectedSize)
        $pct = [math]::Round($currentBytes * 100 / $ExpectedSize)
        $dlMB = [math]::Round($currentBytes / 1MB, 1)
        $elapsedSec = $speedTimer.Elapsed.TotalSeconds
        $newChunks = $doneNow - $initialDone
        $speedMBps = if ($elapsedSec -gt 1) { [math]::Round([long]$newChunks * $chunkSize / $elapsedSec / 1MB, 1) } else { 0 }
        $eta = ""
        if ($speedMBps -gt 0) {
            $remainMB = $totalMB - $dlMB; $etaSec = [int]($remainMB / $speedMBps)
            if ($etaSec -gt 0) { $eta = " ETA $([math]::Floor($etaSec/60))m$($etaSec%60)s" }
        }
        Write-Host "`r  ⏳ ${actualThreads}线程下载: ${dlMB}MB / ${totalMB}MB (${pct}%) ${speedMBps}MB/s${eta} [${doneNow}/${totalChunks}块]    " -NoNewline -ForegroundColor Cyan
    }
    Write-Host ""

    foreach ($h in $handles) { try { $h.PS.EndInvoke($h.AR) } catch {}; $h.PS.Dispose() }
    $pool.Close(); $pool.Dispose()

    if ($failedChunks.Count -gt 0) {
        $failList = @(); foreach ($fc in $failedChunks) { $failList += $fc }
        Write-Warn "$($failedChunks.Count) 个块下载失败"
        Write-Warn "重新运行脚本即可自动续传剩余块"
        return $false
    }

    $finalSize = (Get-Item $OutFile).Length
    if ($finalSize -eq $ExpectedSize) {
        Remove-Item $progressFile -Force -ErrorAction SilentlyContinue
        return $true
    } else {
        Write-Warn "文件大小不匹配: ${finalSize} / ${ExpectedSize} 字节"
        return $false
    }
}

Write-Host ""
Write-Host "  +==========================================+" -ForegroundColor Cyan
Write-Host "  |     OpenClaw Pro - Quick Updater         |" -ForegroundColor Cyan
Write-Host "  +==========================================+" -ForegroundColor Cyan
Write-Host ""

# -- 0. 智能检测更新类型 --
$recommendFull = $false
$recommendMsg = ""
$containerRunning = $false
$containerExists = $false
try {
    $runningId = (& docker ps -q --filter "name=^${CONTAINER_NAME}$" 2>$null)
    $anyId = (& docker ps -aq --filter "name=^${CONTAINER_NAME}$" 2>$null)
    if ($runningId) {
        $containerRunning = $true
        $containerExists = $true
    } elseif ($anyId) {
        $containerExists = $true
        # 容器存在但未运行，尝试启动以便检测
        Write-Host "  容器已停止，正在启动..." -ForegroundColor DarkGray -NoNewline
        & docker start $CONTAINER_NAME 2>$null | Out-Null
        Start-Sleep 3
        $runningId = (& docker ps -q --filter "name=^${CONTAINER_NAME}$" 2>$null)
        if ($runningId) {
            $containerRunning = $true
            Write-Host " OK" -ForegroundColor Green
        } else {
            Write-Host " 启动失败" -ForegroundColor Yellow
        }
    }

    if ($containerRunning) {
        Write-Host "  检测更新类型..." -ForegroundColor DarkGray -NoNewline

        # 方法1：直接检查容器内是否有 Dockerfile hash 文件（不依赖网络）
        & docker exec $CONTAINER_NAME test -f /etc/openclaw-dockerfile-hash 2>$null
        if ($LASTEXITCODE -ne 0) {
            $recommendFull = $true
            $recommendMsg = "  ⚠️  检测到旧版镜像，建议完整更新以获取最新系统包（如 dnsmasq）"
            Write-Host " 旧版镜像" -ForegroundColor Yellow
        } else {
            # 方法2：通过 API 对比远程 Dockerfile hash（需要网络）
            $rawJson = & docker exec $CONTAINER_NAME curl -sf --max-time 15 http://127.0.0.1:3000/api/update/check?force=1 2>$null
            if ($rawJson) {
                $checkResult = $rawJson | ConvertFrom-Json
                $requiresFull = "$($checkResult.requiresFullUpdate)" -eq "True" -or "$($checkResult.requiresFullUpdate)" -eq "true"
                if ($requiresFull) {
                    $recommendFull = $true
                    $recommendMsg = "  ⚠️  检测到需要完整更新（Dockerfile 或底层变更），建议完整更新"
                    Write-Host " 需要完整更新" -ForegroundColor Yellow
                } else {
                    Write-Host " OK" -ForegroundColor Green
                }
            } else {
                Write-Host " (API 检测跳过)" -ForegroundColor DarkGray
            }
        }
    } elseif ($containerExists) {
        # 容器存在但无法启动 → 推荐完整更新
        $recommendFull = $true
        $recommendMsg = "  ⚠️  容器无法启动，建议完整更新重建容器"
    } else {
        # 容器不存在 → 提示安装
        Write-Host ""
        Write-Err "未找到容器 '$CONTAINER_NAME'"
        Write-Host ""
        Write-Host "  容器不存在，更新脚本无法使用。" -ForegroundColor Yellow
        Write-Host "  请使用安装脚本重新创建容器：" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  方法1（推荐）：双击运行 install-windows.bat" -ForegroundColor White
        Write-Host "  方法2：在 PowerShell 中执行：" -ForegroundColor White
        Write-Host "  irm https://raw.githubusercontent.com/$GITHUB_REPO/main/install-windows.ps1 | iex" -ForegroundColor Cyan
        Write-Host ""
        Read-Host "按回车退出"
        return
    }
} catch {
    Write-Host " (检测跳过)" -ForegroundColor DarkGray
}

# 显示更新菜单
Write-Host "  请选择更新方式:" -ForegroundColor White
    if ($recommendMsg) {
        Write-Host ""
        Write-Host $recommendMsg -ForegroundColor Yellow
    }
    Write-Host ""
    if ($recommendFull) {
        Write-Host "  [1] 📦 完整更新（推荐）" -ForegroundColor Yellow
        Write-Host "      下载完整镜像并重建容器（~1GB，需几分钟）" -ForegroundColor DarkGray
        Write-Host "      适合：系统包/Node.js 升级、大版本更新" -ForegroundColor DarkGray
    } else {
        Write-Host "  [1] ⚡ 热更新（推荐）" -ForegroundColor Yellow
        Write-Host "      只更新 Web 面板、配置模板等文件，无需下载镜像/重启容器" -ForegroundColor DarkGray
        Write-Host "      适合：前端修复、配置变更、小版本更新" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  [2] 📦 完整更新" -ForegroundColor Cyan
        Write-Host "      下载完整镜像并重建容器（~1GB，需几分钟）" -ForegroundColor DarkGray
        Write-Host "      适合：系统包/Node.js 升级、大版本更新" -ForegroundColor DarkGray
    }
    Write-Host ""
    # 当检测到需要完整更新时，热更新选项已隐藏，默认选择为完整更新
    $defaultChoice = if ($recommendFull) { "1" } else { "1" }
    Write-Host "  选择 [1/2，默认${defaultChoice}]: " -NoNewline -ForegroundColor White
    $updateChoice = (Read-Host).Trim()
    if (-not $updateChoice) { $updateChoice = $defaultChoice }

# 当 $recommendFull 为真时，菜单只显示完整更新，故选择 1 时应走完整更新分支
if ($updateChoice -eq "1" -and -not $recommendFull) {
    # =============== 热更新模式 ===============
    Write-Host ""
    Write-Step "热更新模式：检查容器..."
    
    $existingId = (& docker ps -q --filter "name=^${CONTAINER_NAME}$" 2>$null)
    if (-not $existingId) {
        # 容器未运行，尝试启动
        $stoppedId = (& docker ps -aq --filter "name=^${CONTAINER_NAME}$" 2>$null)
        if ($stoppedId) {
            Write-Dim "容器已停止，正在启动..."
            & docker start $CONTAINER_NAME 2>$null | Out-Null
            Start-Sleep 5
            $existingId = (& docker ps -q --filter "name=^${CONTAINER_NAME}$" 2>$null)
        }
        if (-not $existingId) {
            Write-Err "容器 '$CONTAINER_NAME' 未在运行且无法启动"
            Write-Dim "请选择完整更新（选项 2）来重建容器"
            Write-Host ""
            Read-Host "按回车退出"
            return
        }
    }
    Write-OK "容器运行中: $($existingId.Substring(0, 12))"

    Write-Step "触发热更新..."
    
    # Call the hotpatch API inside the container
    $hotpatchResult = & docker exec $CONTAINER_NAME curl -s -X POST http://127.0.0.1:3000/api/update/hotpatch -H "Content-Type: application/json" -d '{"branch":"main"}' 2>$null
    
    # Poll for completion
    # Note: if server.js is updated, the web panel auto-restarts, which means:
    #   - curl requests fail during restart (catch handles this)
    #   - after restart, status resets to 'idle' (new process)
    # We track consecutive failures to detect a restart cycle.
    # Also track from the very start — if POST succeeded, update was triggered.
    Write-Host "  " -NoNewline
    $done = $false
    $wasRunning = $false
    $postOk = ($hotpatchResult -and ($hotpatchResult -match '"success"' -or $hotpatchResult -match '"ok"'))
    $failCount = 0
    $idleAfterPostCount = 0
    $lastLog = ""
    if ($postOk) { Write-Dim "热更新已触发，等待完成..." }
    for ($i = 1; $i -le 180; $i++) {
        Start-Sleep 1
        try {
            $statusJson = & docker exec $CONTAINER_NAME curl -sf http://127.0.0.1:3000/api/update/hotpatch/status 2>$null
            if (-not $statusJson) { throw "empty" }
            $status = $statusJson | ConvertFrom-Json
            
            if ($status.status -eq "running") {
                $wasRunning = $true
                $failCount = 0
                # Show real-time progress from log
                if ($status.log -and $status.log -ne $lastLog) {
                    $newLines = $status.log.Replace($lastLog, "").Trim()
                    if ($newLines) {
                        Write-Host ""
                        $newLines -split "`n" | ForEach-Object {
                            if ($_) { Write-Host "    $_" -ForegroundColor DarkGray }
                        }
                        Write-Host "  " -NoNewline
                    }
                    $lastLog = $status.log
                }
            }
            elseif ($status.status -eq "done" -or $status.status -eq "error") {
                $done = $true
                Write-Host ""
                Write-Host ""
                
                # Show log
                if ($status.log) {
                    $status.log -split "`n" | ForEach-Object {
                        if ($_) { Write-Host "    $_" -ForegroundColor DarkGray }
                    }
                }
                Write-Host ""
                
                if ($status.status -eq "done") {
                    $updatedCount = if ($status.updated) { $status.updated.Count } else { 0 }
                    Write-OK "热更新完成: $updatedCount 个文件已更新"
                } else {
                    Write-Err "热更新失败"
                }
                break
            }
            elseif ($status.status -eq "idle" -and $wasRunning) {
                # Server restarted (was running, now idle = new process after server.js update)
                $done = $true
                Write-Host ""
                Write-Host ""
                Write-OK "热更新完成（Web 面板已自动重启）"
                break
            }
            elseif ($status.status -eq "idle" -and $postOk -and -not $wasRunning) {
                # POST succeeded but we never saw "running" — update may have finished very fast
                # or server restarted before we could poll. Wait a few cycles then declare done.
                $idleAfterPostCount++
                if ($idleAfterPostCount -ge 8) {
                    $done = $true
                    Write-Host ""
                    Write-Host ""
                    Write-OK "热更新完成"
                    break
                }
            }
            $failCount = 0
        } catch {
            $failCount++
            # If we saw it running (or POST was ok) and now can't connect, server is restarting
            if (($wasRunning -or $postOk) -and $failCount -ge 5) {
                # Wait a few more seconds for server to come back up
                Write-Host "" 
                Write-Host "    等待 Web 面板重启..." -ForegroundColor DarkGray
                Start-Sleep 5
                $done = $true
                Write-Host ""
                Write-OK "热更新完成（Web 面板已重启）"
                break
            }
        }
        Write-Host "." -NoNewline
    }
    
    if (-not $done) { Write-Err "热更新超时" }
    
    Write-Host ""
    Read-Host "按回车退出"
    return
}

# =============== 完整更新模式 (原逻辑) ===============

# -- 1. 检查 Docker --
Write-Step "检查 Docker..."
try {
    $dockerVer = (& docker version --format '{{.Server.Version}}' 2>$null)
    if (-not $dockerVer) { throw "no docker" }
    Write-OK "Docker $dockerVer"
} catch {
    Write-Err "未检测到 Docker，请先安装 Docker Desktop"
    Read-Host "按回车退出"
    return
}

# -- 2. 检查现有容器 --
Write-Step "检查现有容器..."
$existingId = (& docker ps -aq --filter "name=^${CONTAINER_NAME}$" 2>$null)
if (-not $existingId) {
    Write-Err "未找到容器 '$CONTAINER_NAME'"
    Write-Host ""
    Write-Dim "更新脚本需要现有容器来读取配置。"
    Write-Dim "请使用安装脚本重新安装："
    Write-Host ""
    Write-Host "  irm https://raw.githubusercontent.com/$GITHUB_REPO/main/install-windows.ps1 | iex" -ForegroundColor Cyan
    Write-Host ""
    Read-Host "按回车退出"
    return
}
Write-OK "找到容器: $($existingId.Substring(0, 12))"

# 确保容器在运行（读取配置需要 docker exec）
$isRunning = (& docker ps -q --filter "name=^${CONTAINER_NAME}$" 2>$null)
if (-not $isRunning) {
    Write-Dim "容器已停止，正在启动..."
    & docker start $CONTAINER_NAME 2>$null | Out-Null
    Start-Sleep 5
    $isRunning = (& docker ps -q --filter "name=^${CONTAINER_NAME}$" 2>$null)
    if (-not $isRunning) {
        Write-Warn "容器无法启动，将使用 docker inspect 读取配置"
    }
}

# -- 3. 读取现有配置 --
Write-Step "读取容器配置..."

# 从容器获取 docker-config.json（优先 exec，降级 cp）
$configJson = ""
if ($isRunning) {
    try { $configJson = (& docker exec $CONTAINER_NAME cat /root/.openclaw/docker-config.json 2>$null) | Out-String } catch {}
}
if (-not $configJson.Trim()) {
    # 容器未运行或 exec 失败，尝试 docker cp
    $tmpConfig = Join-Path $env:TEMP "openclaw-docker-config.json"
    & docker cp "${CONTAINER_NAME}:/root/.openclaw/docker-config.json" $tmpConfig 2>$null
    if (Test-Path $tmpConfig) {
        $configJson = Get-Content $tmpConfig -Raw
        Remove-Item $tmpConfig -Force -ErrorAction SilentlyContinue
    }
}

if (-not $configJson.Trim()) {
    Write-Err "无法读取容器配置文件"
    Read-Host "按回车退出"
    return
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
    return
}
Write-Dim "数据目录: $homeDataMount"

# 获取端口映射（去重）
$portMappings = @()
$seenMappings = @{}
try {
    $inspect = (& docker inspect $CONTAINER_NAME 2>$null) | ConvertFrom-Json
    $ports = $inspect[0].NetworkSettings.Ports
    foreach ($containerPort in $ports.PSObject.Properties.Name) {
        $bindings = $ports.$containerPort
        if ($bindings) {
            foreach ($b in $bindings) {
                $hostPort = $b.HostPort
                $cPort = $containerPort -replace '/tcp$', '' -replace '/udp$', ''
                $mappingKey = "${hostPort}:${cPort}"
                if (-not $seenMappings.ContainsKey($mappingKey)) {
                    $seenMappings[$mappingKey] = $true
                    $portMappings += "-p"
                    $portMappings += $mappingKey
                }
            }
        }
    }
} catch {}

if ($portMappings.Count -eq 0) {
    # 降级：从 config 中构建端口映射
    if ($config.http_port -and $config.https_port) {
        $portMappings = @("-p", "$($config.https_port):443", "-p", "$($config.http_port):80")
        Write-Dim "端口映射（从配置恢复）: $($portMappings -join ' ')"
    } else {
        Write-Err "无法获取端口映射"
        Read-Host "按回车退出"
        return
    }
} else {
    Write-Dim "端口映射: $($portMappings -join ' ')"
}

# -- 4. 获取当前版本 --
$currentVersion = "unknown"
try {
    if ($isRunning) {
        $currentVersion = (& docker exec $CONTAINER_NAME cat /etc/openclaw-version 2>$null).Trim()
    }
    if ($currentVersion -eq "unknown" -or -not $currentVersion) {
        $tmpVer = Join-Path $env:TEMP "openclaw-version.tmp"
        & docker cp "${CONTAINER_NAME}:/etc/openclaw-version" $tmpVer 2>$null
        if (Test-Path $tmpVer) {
            $currentVersion = (Get-Content $tmpVer -Raw).Trim()
            Remove-Item $tmpVer -Force -ErrorAction SilentlyContinue
        }
    }
} catch {}
if (-not $currentVersion) { $currentVersion = "unknown" }
Write-Dim "当前版本: $currentVersion"

# 检测当前镜像版本类型（lite / full）
$currentEdition = "full"  # 默认假定完整版（向后兼容旧镜像）
try {
    if ($isRunning) {
        $editionStr = (& docker exec $CONTAINER_NAME cat /etc/openclaw-edition 2>$null)
        if ($editionStr -and $editionStr.Trim() -eq "lite") { $currentEdition = "lite" }
    }
    if ($currentEdition -eq "full") {
        $tmpEd = Join-Path $env:TEMP "openclaw-edition.tmp"
        & docker cp "${CONTAINER_NAME}:/etc/openclaw-edition" $tmpEd 2>$null
        if (Test-Path $tmpEd) {
            $edStr = (Get-Content $tmpEd -Raw).Trim()
            if ($edStr -eq "lite") { $currentEdition = "lite" }
            Remove-Item $tmpEd -Force -ErrorAction SilentlyContinue
        }
    }
} catch {}
Write-Dim "镜像类型: $currentEdition"

# -- 5. 检查最新版本 --
Write-Step "检查最新版本..."
$latestVersion = ""
$downloadUrl = ""
$imageSize = 0
$release = $null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GITHUB_REPO/releases/latest" -UseBasicParsing -TimeoutSec 15
    $latestVersion = $release.tag_name
    $updateAssetName = if ($currentEdition -eq "lite") { "openclaw-pro-image-lite.tar.gz" } else { "openclaw-pro-image.tar.gz" }
    $imageAsset = $release.assets | Where-Object { $_.name -eq $updateAssetName } | Select-Object -First 1
    if ($imageAsset) {
        $downloadUrl = $imageAsset.browser_download_url
        $imageSize = [long]$imageAsset.size
    }
} catch {
    Write-Dim "无法获取最新版本信息: $_"
}

if ($latestVersion -and $latestVersion -eq $currentVersion -and -not $recommendFull) {
    Write-Host ""
    Write-OK "当前已是最新版本 ($currentVersion)"
    Write-Host ""
    $forceUpdate = Read-Host "  仍然要重新安装吗？[y/N]"
    if ($forceUpdate -notin @("y", "Y", "yes")) {
        return
    }
} elseif ($recommendFull) {
    Write-OK "镜像需要重建（Dockerfile 已变更）"
} elseif ($latestVersion) {
    Write-OK "最新版本: $latestVersion"
}

# -- 6. 下载最新镜像 --
Write-Step "下载最新镜像..."
# tmp 目录与 openclaw-pro 平级（如 C:\Mydata\docker-openclaw\tmp）
$scriptDir = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PWD.Path }
$downloadDir = Join-Path (Split-Path $scriptDir -Parent) "tmp"
if (-not (Test-Path $downloadDir)) { New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null }

$tarPath = Join-Path $downloadDir $updateAssetName
$downloaded = $false

if ($downloadUrl -and $imageSize -gt 0) {
    $sizeMB = [math]::Round($imageSize / 1MB, 1)
    Write-Info "发现预构建镜像 ($latestVersion, ${sizeMB}MB)"
    Write-Info "正在下载... (8线程并行，断线自动续传)"

    # 多下载源（代理镜像优先 — 国内直连 github.com 通常很慢或不通）
    $downloadUrls = @(
        "https://ghfast.top/$downloadUrl",
        "https://mirror.ghproxy.com/$downloadUrl",
        "https://gh-proxy.com/$downloadUrl",
        "https://github.moeyy.xyz/$downloadUrl",
        "https://ghproxy.net/$downloadUrl",
        $downloadUrl
    )

    $downloadOK = Download-Robust `
        -Urls $downloadUrls `
        -OutFile $tarPath `
        -ExpectedSize $imageSize `
        -ChunkSizeMB 2 `
        -Threads 8 `
        -RetryPerChunk 20

    if ($downloadOK) {
        $downloaded = $true
        Write-OK "镜像下载完成 (${sizeMB}MB)"
    } else {
        Write-Dim "分块下载未完成，尝试 GHCR..."
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
    return
}

# -- 7. 加载镜像 --
if (Test-Path $tarPath) {
    Write-Step "加载镜像到 Docker...（约 1-3 分钟，请耐心等待）"
    & docker rmi -f $IMAGE_NAME 2>$null | Out-Null

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

    $loadJob = Start-Job -ScriptBlock {
        param($tar, $img)
        & docker load -i $tar 2>&1
        return $LASTEXITCODE
    } -ArgumentList $tarPath, $IMAGE_NAME

    $spinner = @('|','/','-','\','|','/','-','\','|','/','-','\','|','/','-','\')
    $si = 0
    $loadTimer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
    while ($loadJob.State -eq 'Running') {
        $elapsed = [math]::Floor($loadTimer.Elapsed.TotalSeconds)
        $min = [math]::Floor($elapsed / 60); $sec = $elapsed % 60
        $spinChar = $spinner[$si % $spinner.Count]
        Write-Host "`r  $spinChar 加载中... 已耗时 ${min}分${sec}秒    " -NoNewline -ForegroundColor Cyan
        $si++; Start-Sleep -Milliseconds 200
    }
    } finally {
        if ($loadJob.State -eq 'Running') {
            Write-Host "`n  正在清理后台加载进程..." -ForegroundColor Yellow
            Stop-Job $loadJob -ErrorAction SilentlyContinue
        }
    }
    Write-Host ""
    $loadTimer.Stop()
    $loadOutput = Receive-Job $loadJob
    Remove-Job $loadJob -Force

    $loadOutput | ForEach-Object {
        if ($_ -match "Loaded image") { Write-Host "  $_" -ForegroundColor DarkGray }
    }

    if (-not ($loadOutput | Out-String) -or ($loadOutput | Out-String) -match "Error") {
        Write-Err "docker load 失败"
        Read-Host "按回车退出"
        return
    }
    Write-OK "镜像加载完成"
    # 镜像文件始终保留在 tmp 目录（便于重试和排查）
}

# -- 8. 停止并删除旧容器 --
Write-Step "停止旧容器..."
& docker stop $CONTAINER_NAME 2>$null | Out-Null
& docker rm -f $CONTAINER_NAME 2>$null | Out-Null
Write-OK "旧容器已删除"

# -- 9. 启动新容器 --
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
    return
}
Write-OK "新容器已启动"

# -- 10. 等待服务就绪 --
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

# -- 完成 --
Write-Host ""
Write-Host "  +==========================================+" -ForegroundColor Green
Write-Host "  |       🎉 Update Complete!               |" -ForegroundColor Green
Write-Host "  +==========================================+" -ForegroundColor Green
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
        Write-Host "  🔗 URL: https://${domain}:${httpsPort}" -ForegroundColor White
    } elseif ($httpsPort) {
        Write-Host "  🔗 URL: https://${domain}" -ForegroundColor White
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
    Write-Host "  🔗 URL: http://localhost:${webPort}" -ForegroundColor White
}
Write-Host ""

Read-Host "按回车退出"
