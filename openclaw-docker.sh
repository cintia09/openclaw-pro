#!/bin/bash
# ============================================================
# openclaw-docker.sh — OpenClaw Pro Docker 管理脚本
# 用法: ./openclaw-docker.sh [run|stop|status|config|shell|rebuild|logs]
# ============================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

CONTAINER_NAME="openclaw-pro"
IMAGE_NAME="openclaw-pro"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/tmp"
HOME_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/home-data"
CONFIG_FILE="$HOME_DIR/.openclaw/docker-config.json"

# ---- 工具函数 ----
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

# 构建代理环境变量参数（自动继承宿主机代理配置到容器）
build_proxy_args() {
    PROXY_ARGS=""
    for var in http_proxy HTTP_PROXY https_proxy HTTPS_PROXY no_proxy NO_PROXY; do
        local val="${!var:-}"
        if [ -n "$val" ]; then
            PROXY_ARGS="$PROXY_ARGS -e $var=$val"
        fi
    done
}

# 容器启动后修复：检查并补装缺失依赖、修复 sshd 配置
fix_container_env() {
    local cname="${1:-$CONTAINER_NAME}"
    # 修复 sshd StrictModes（volume mount 导致 /root 属主为实机 UID）
    docker exec "$cname" bash -c '
        if ! grep -q "^StrictModes no" /etc/ssh/sshd_config; then
            echo "StrictModes no" >> /etc/ssh/sshd_config
            pkill -HUP sshd 2>/dev/null || true
        fi
    ' 2>/dev/null || true
    # 检查并安装 envsubst（Caddy 配置模板渲染依赖）
    if ! docker exec "$cname" command -v envsubst &>/dev/null; then
        info "容器缺少 envsubst，正在补装..."
        local installed=false
        # 方法1: apt-get（容器可正常联网时）
        docker exec "$cname" bash -c 'apt-get update -qq 2>/dev/null && apt-get install -y -qq gettext-base 2>/dev/null' &>/dev/null
        docker exec "$cname" command -v envsubst &>/dev/null && installed=true
        # 方法2: curl 直接下载 deb（企业透明代理环境，apt不通但curl能通）
        if ! $installed; then
            docker exec "$cname" bash -c '
                curl -fsSL --connect-timeout 10 -o /tmp/gettext-base.deb \
                    http://archive.ubuntu.com/ubuntu/pool/main/g/gettext/gettext-base_0.21-14ubuntu2_amd64.deb 2>/dev/null \
                && dpkg -i /tmp/gettext-base.deb 2>/dev/null \
                && rm -f /tmp/gettext-base.deb
            ' &>/dev/null
            docker exec "$cname" command -v envsubst &>/dev/null && installed=true
        fi
        # 方法3: 从宿主机拷贝二进制
        if ! $installed; then
            local host_envsubst
            host_envsubst=$(command -v envsubst 2>/dev/null || true)
            if [ -n "$host_envsubst" ]; then
                info "从宿主机拷贝 envsubst..."
                docker cp "$host_envsubst" "$cname":/usr/bin/envsubst
                docker exec "$cname" command -v envsubst &>/dev/null && installed=true
            fi
        fi
        if $installed; then
            success "envsubst 就绪，重启容器使 Caddy 生效..."
            docker restart "$cname" &>/dev/null
            sleep 3
        else
            warn "envsubst 安装失败，请手动处理"
            warn "容器内执行: curl -fSL -o /tmp/g.deb http://archive.ubuntu.com/ubuntu/pool/main/g/gettext/gettext-base_0.21-14ubuntu2_amd64.deb && dpkg -i /tmp/g.deb"
        fi
    fi
}

# 检查 jq 是否安装（配置管理需要）
ensure_jq() {
    if command -v jq &>/dev/null; then
        return 0
    fi
    warn "jq 未安装，正在自动安装..."
    if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq jq
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y -q jq
    elif command -v yum &>/dev/null; then
        sudo yum install -y -q jq
    elif command -v brew &>/dev/null; then
        brew install jq
    else
        warn "无法自动安装 jq，config/status 等命令可能不可用"
        return 1
    fi
    success "jq 安装完成"
}

# 检查Docker是否安装
ensure_docker() {
    if command -v docker &>/dev/null; then
        return 0
    fi
    warn "Docker 未安装，正在自动安装..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
    success "Docker 安装完成"
}

# 日志持久化（与 Windows 一致，放在 openclaw-pro 同级 tmp 目录）
LOG_DIR="$TMP_DIR"
LOG_FILE="$LOG_DIR/openclaw-docker.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true
log_msg() {
    local ts
    ts=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$ts] $*" >> "$LOG_FILE" 2>/dev/null || true
}

# GitHub Release 配置
GITHUB_REPO="cintia09/openclaw-pro"
GHCR_IMAGE="ghcr.io/${GITHUB_REPO}"
IMAGE_TARBALL="openclaw-pro-image.tar.gz"
IMAGE_EDITION="full"  # 默认完整版，用户可在首次安装时选择

# 代理镜像列表（对齐 Windows Download-Robust，国内直连 github.com 通常很慢）
# 先尝试直连，再逐个尝试代理；每个源快速探测可达性后再下载
PROXY_PREFIXES=(
    "https://ghfast.top/"
    "https://gh-proxy.com/"
    "https://ghproxy.net/"
    "https://mirror.ghproxy.com/"
    "https://github.moeyy.xyz/"
)

# 获取远端最新 Release tag
get_latest_release_tag() {
    local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
    local tag
    tag=$(curl -sL --max-time 15 "$api_url" 2>/dev/null | grep '"tag_name"' | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true)
    log_msg "get_latest_release_tag: $tag"
    echo "$tag"
}

# 获取 Release asset 的下载URL和文件大小
# 返回格式: URL|SIZE
get_release_asset_info() {
    local asset_name="${1:-$IMAGE_TARBALL}"
    local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
    local response
    response=$(curl -sL --max-time 15 "$api_url" 2>/dev/null) || true
    if [ -z "$response" ]; then
        return 1
    fi
    local url size
    url=$(echo "$response" | grep -o '"browser_download_url":\s*"[^"]*'"$asset_name"'"' | head -1 | sed 's/.*"\(http[^"]*\)"/\1/')
    size=$(echo "$response" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for a in data.get('assets', []):
        if a['name'] == '$asset_name':
            print(a['size'])
            break
except: pass
" 2>/dev/null || true)
    if [ -n "$url" ]; then
        echo "${url}|${size:-0}"
    else
        return 1
    fi
}

# 快速探测 URL 是否可达（HEAD 请求，5秒超时）
# 返回 0=可达 1=不可达
_probe_url() {
    local url="$1"
    local http_code
    http_code=$(curl -sI -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 8 -L "$url" 2>/dev/null || echo "000")
    # 2xx/3xx/4xx(GitHub returns 403 for direct asset but redirect works) 都算可达
    [[ "$http_code" =~ ^[2345] ]] && return 0
    return 1
}

# 构建带代理镜像的下载URL列表
# 参数: 原始 GitHub URL
# 输出: 直连URL（优先尝试）+ 代理URLs
build_download_urls() {
    local base_url="$1"
    local urls=()
    # 直连优先：很多环境可以直连 GitHub（只是慢而已）
    urls+=("$base_url")
    for prefix in "${PROXY_PREFIXES[@]}"; do
        urls+=("${prefix}${base_url}")
    done
    echo "${urls[@]}"
}

# 读取本地镜像版本标记
get_local_image_tag() {
    local tag_file="$HOME_DIR/.openclaw/image-release-tag.txt"
    if [ -f "$tag_file" ]; then
        cat "$tag_file" 2>/dev/null
    fi
}

# 保存镜像版本标记
save_image_tag() {
    local tag="$1"
    mkdir -p "$HOME_DIR/.openclaw"
    echo "$tag" > "$HOME_DIR/.openclaw/image-release-tag.txt"
}

# 获取镜像（优先下载预构建，回退到本地构建）
ensure_image() {
    local asset_name="$IMAGE_TARBALL"
    if [ "$IMAGE_EDITION" = "lite" ]; then
        asset_name="openclaw-pro-image-lite.tar.gz"
    fi

    if docker image inspect "$IMAGE_NAME" &>/dev/null; then
        # 镜像已存在，检查是否有新版本
        local local_tag remote_tag
        local_tag=$(get_local_image_tag)
        # 回退：从容器内读取版本号
        if [ -z "$local_tag" ]; then
            local_tag=$(docker exec "$CONTAINER_NAME" cat /etc/openclaw-version 2>/dev/null || true)
            # 补写 tag 文件供下次使用
            if [ -n "$local_tag" ]; then
                save_image_tag "$local_tag"
            fi
        fi
        remote_tag=$(get_latest_release_tag)

        if [ -n "$remote_tag" ] && [ -n "$local_tag" ] && [ "$remote_tag" != "$local_tag" ]; then
            warn "发现新版本镜像: 远端 $remote_tag，本地 $local_tag"
            echo -e "  ${CYAN}[1]${NC} 使用本地镜像（默认）"
            echo -e "  ${CYAN}[2]${NC} 下载最新镜像"
            local img_choice=""
            read -t 10 -p "请选择 [1/2，默认1，10秒超时自动选择1]: " img_choice || true
            echo ""
            if [ "$img_choice" = "2" ]; then
                info "将下载最新镜像..."
                log_msg "User chose to download new image: $remote_tag (was $local_tag)"
                docker rmi "$IMAGE_NAME" 2>/dev/null || true
            else
                return 0
            fi
        elif [ -n "$remote_tag" ] && [ -z "$local_tag" ]; then
            # 仍无法确定本地版本，记下远端版本供参考
            save_image_tag "$remote_tag"
            return 0
        else
            return 0
        fi
    fi

    # 方式1: 本地已有导出的 tar.gz（手动下载或 install.sh 已下载）
    local local_tar=""
    for f in "$TMP_DIR/$asset_name" "$TMP_DIR/$IMAGE_TARBALL" "$SCRIPT_DIR/$asset_name" "$SCRIPT_DIR/$IMAGE_TARBALL"; do
        if [ -f "$f" ]; then
            local_tar="$f"
            break
        fi
    done
    if [ -n "$local_tar" ]; then
        info "发现本地镜像包 $(basename "$local_tar")，正在导入..."
        log_msg "Loading local tarball: $local_tar"
        if docker load < "$local_tar"; then
            success "镜像导入完成"
            return 0
        fi
        warn "镜像导入失败，尝试其他方式..."
    fi

    # 方式2: 从 GitHub Release 下载 tar.gz（多源代理+断点续传）
    if download_release_image "$asset_name"; then
        return 0
    fi

    # 方式3: 从 GHCR 拉取
    info "尝试从 GHCR 拉取镜像..."
    if docker pull "$GHCR_IMAGE:latest" 2>/dev/null; then
        docker tag "$GHCR_IMAGE:latest" "$IMAGE_NAME:latest" 2>/dev/null
        success "镜像拉取完成 (GHCR)"
        return 0
    fi
    warn "GHCR 拉取失败..."

    # 方式4: 本地构建（最后手段）
    warn "预构建镜像获取失败，将从 Dockerfile 本地构建（需要较长时间）..."
    info "构建 Docker 镜像..."
    log_msg "Falling back to docker build"
    docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"
    success "镜像构建完成"
}

# 从 GitHub Release 下载镜像 tar.gz（对齐 Windows Download-Robust）
# 支持: 多代理镜像源、aria2c多线程、curl断点续传、文件大小校验
download_release_image() {
    local asset_name="${1:-$IMAGE_TARBALL}"
    local target="$TMP_DIR/$asset_name"
    mkdir -p "$TMP_DIR" 2>/dev/null || true

    # 获取下载链接和预期大小
    local asset_info download_url expected_size=0
    asset_info=$(get_release_asset_info "$asset_name" 2>/dev/null) || true
    if [ -n "$asset_info" ]; then
        download_url=$(echo "$asset_info" | cut -d'|' -f1)
        expected_size=$(echo "$asset_info" | cut -d'|' -f2)
    fi

    # 回退: 构造直链
    if [ -z "$download_url" ]; then
        local latest_tag
        latest_tag=$(get_latest_release_tag)
        if [ -n "$latest_tag" ]; then
            download_url="https://github.com/${GITHUB_REPO}/releases/download/${latest_tag}/${asset_name}"
        else
            download_url="https://github.com/${GITHUB_REPO}/releases/latest/download/${asset_name}"
        fi
        warn "无法通过 API 获取下载链接，使用直链: $download_url"
    fi

    local size_mb="?"
    if [ "$expected_size" -gt 0 ] 2>/dev/null; then
        size_mb=$(echo "$expected_size" | awk '{printf "%.1f", $1/1048576}')
        info "发现预构建镜像 (${size_mb}MB)"
    fi
    log_msg "download_release_image: url=$download_url size=$expected_size asset=$asset_name"

    # 检查本地已有完整文件（跳过下载）
    if [ -f "$target" ] && [ "$expected_size" -gt 0 ] 2>/dev/null; then
        local local_size
        local_size=$(stat -c%s "$target" 2>/dev/null || stat -f%z "$target" 2>/dev/null || echo 0)
        if [ "$local_size" = "$expected_size" ]; then
            info "检测到已下载的完整镜像文件 (${size_mb}MB)，跳过下载"
            log_msg "Skipping download: local file matches expected size"
        else
            info "本地文件不完整 (${local_size}/${expected_size})，继续下载..."
        fi
    fi

    # 构建多源下载URL列表
    local -a download_urls
    IFS=' ' read -r -a download_urls <<< "$(build_download_urls "$download_url")"

    # 方式A: 优先使用 aria2c（多线程分块下载，对齐 Windows 8线程）
    if command -v aria2c &>/dev/null; then
        info "使用 aria2c 多线程下载 (8线程, 自动断点续传)..."
        log_msg "Using aria2c for download"

        # 构建 aria2c input file（多源）
        local aria_input
        aria_input=$(mktemp /tmp/aria2-input.XXXXXX)
        for url in "${download_urls[@]}"; do
            echo "$url" >> "$aria_input"
            echo "  out=$asset_name" >> "$aria_input"
            echo "  dir=$TMP_DIR" >> "$aria_input"
            echo "" >> "$aria_input"
        done

        if aria2c \
            -x 8 -s 8 -k 2M \
            --continue=true \
            --retry-wait=3 \
            --max-tries=5 \
            --connect-timeout=10 \
            --timeout=30 \
            --auto-file-renaming=false \
            --allow-overwrite=true \
            --console-log-level=notice \
            --summary-interval=5 \
            -d "$TMP_DIR" \
            -o "$asset_name" \
            -i "$aria_input" 2>&1 | tail -5; then
            rm -f "$aria_input"
            # 文件大小校验
            if _validate_download "$target" "$expected_size"; then
                _load_and_tag_image "$target"
                return $?
            fi
        fi
        rm -f "$aria_input"
        warn "aria2c 下载未完成，回退到 curl..."
    fi

    # 方式B: curl 逐源尝试（带代理镜像、断点续传、重试）
    info "正在下载镜像 (~${size_mb}MB)..."
    info "使用代理镜像加速，支持断点续传 (Ctrl+C 中断后重运行自动恢复)"

    local attempt=0
    for url in "${download_urls[@]}"; do
        attempt=$((attempt + 1))
        local short_url
        short_url=$(echo "$url" | head -c 80)

        # 快速探测源是否可达（避免在坏源上浪费大量重试时间）
        info "[$attempt/${#download_urls[@]}] 探测: ${short_url}..."
        if ! _probe_url "$url"; then
            warn "此源不可达，跳过"
            log_msg "curl probe failed: $url"
            continue
        fi
        info "[$attempt/${#download_urls[@]}] 下载中: ${short_url}..."
        log_msg "curl attempt $attempt: $url"

        if curl -fL \
            -C - \
            --retry 3 \
            --retry-all-errors \
            --retry-delay 3 \
            --retry-max-time 120 \
            --connect-timeout 10 \
            --max-time 1800 \
            --progress-bar \
            -o "$target" \
            "$url" 2>&1; then
            # 文件大小校验
            if _validate_download "$target" "$expected_size"; then
                _load_and_tag_image "$target"
                return $?
            fi
        fi
        warn "此源下载失败，切换下一个..."
    done

    warn "所有下载源均失败"
    log_msg "All download sources failed"
    echo ""
    echo -e "  ${YELLOW}💡 手动下载方法:${NC}"
    echo -e "  ${CYAN}1. 浏览器打开: https://github.com/${GITHUB_REPO}/releases/latest${NC}"
    echo -e "  ${CYAN}2. 下载 ${asset_name} 到 ${TMP_DIR}/${NC}"
    echo -e "  ${CYAN}3. 重新运行: ./openclaw-docker.sh run${NC}"
    echo ""
    if command -v aria2c &>/dev/null; then
        echo -e "  ${CYAN}或使用 aria2c:${NC}"
        echo -e "  ${CYAN}aria2c -x 8 -s 8 -k 2M --continue=true -d $TMP_DIR ${download_urls[0]}${NC}"
    else
        echo -e "  ${CYAN}💡 安装 aria2c 可获得8线程下载: sudo apt-get install -y aria2${NC}"
    fi
    echo ""
    return 1
}

# 验证下载文件完整性
_validate_download() {
    local file="$1"
    local expected_size="$2"

    if [ ! -f "$file" ]; then
        warn "下载文件不存在"
        return 1
    fi

    local actual_size
    actual_size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)

    # 基本大小检查（至少 1MB）
    if [ "$actual_size" -lt 1048576 ]; then
        warn "文件过小 (${actual_size} bytes)，可能下载不完整"
        rm -f "$file"
        return 1
    fi

    # 精确大小校验
    if [ "$expected_size" -gt 0 ] 2>/dev/null; then
        if [ "$actual_size" != "$expected_size" ]; then
            local actual_mb expected_mb
            actual_mb=$(echo "$actual_size" | awk '{printf "%.1f", $1/1048576}')
            expected_mb=$(echo "$expected_size" | awk '{printf "%.1f", $1/1048576}')
            warn "文件大小不匹配: ${actual_mb}MB / ${expected_mb}MB"
            log_msg "Size mismatch: actual=$actual_size expected=$expected_size"
            # 不删除——保留以便续传
            return 1
        fi
        local actual_mb
        actual_mb=$(echo "$actual_size" | awk '{printf "%.1f", $1/1048576}')
        success "文件大小校验通过 (${actual_mb}MB)"
    fi

    # gzip 魔数检查
    local magic
    magic=$(xxd -l 2 "$file" 2>/dev/null | awk '{print $2}')
    if [ "$magic" != "1f8b" ]; then
        warn "文件不是有效的 gzip 格式（可能被CDN拦截返回HTML）"
        log_msg "Invalid gzip magic: $magic"
        rm -f "$file"
        return 1
    fi

    log_msg "Download validated: size=$actual_size"
    return 0
}

# 加载 tar.gz 到 Docker 并打 tag
_load_and_tag_image() {
    local tarball="$1"
    info "下载完成，正在导入镜像..."
    log_msg "Loading image from $tarball"

    if docker load < "$tarball"; then
        # 确保 tag 为 openclaw-pro:latest
        # docker load 可能只有 ghcr.io/... 的 tag
        if ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
            local loaded_ref
            loaded_ref=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -i openclaw | head -1)
            if [ -n "$loaded_ref" ]; then
                docker tag "$loaded_ref" "$IMAGE_NAME:latest" 2>/dev/null || true
            fi
        fi

        # 记录镜像版本标记
        local release_tag
        release_tag=$(get_latest_release_tag)
        if [ -n "$release_tag" ]; then
            save_image_tag "$release_tag"
        fi
        # 保存镜像 digest
        local img_id
        img_id=$(docker image inspect "$IMAGE_NAME" --format '{{.Id}}' 2>/dev/null || true)
        if [ -n "$img_id" ]; then
            echo "$img_id" > "$HOME_DIR/.openclaw/image-digest.txt" 2>/dev/null || true
        fi

        success "镜像导入完成 (GitHub Release)"
        log_msg "Image loaded successfully: $img_id"
        return 0
    fi
    warn "镜像导入失败 (docker load)"
    log_msg "docker load failed for $tarball"
    return 1
}

# 确保home目录存在
ensure_home() {
    if [ ! -d "$HOME_DIR" ]; then
        mkdir -p "$HOME_DIR/.openclaw"
        chmod 700 "$HOME_DIR"
        info "创建 home 目录: $HOME_DIR"
    fi
    mkdir -p "$HOME_DIR/.openclaw"
}

# ---- 端口工具 ----

# 检查端口是否被占用（宿主机）
is_port_used() {
    local port="$1"
    # 优先用 ss，回退到 netstat
    if command -v ss &>/dev/null; then
        ss -tlnp 2>/dev/null | grep -q ":${port} " && return 0
    fi
    if command -v netstat &>/dev/null; then
        netstat -tlnp 2>/dev/null | grep -q ":${port} " && return 0
    fi
    return 1
}

# 找到从 start_port 开始的第一个可用端口
find_free_port() {
    local port="$1"
    while is_port_used "$port"; do
        port=$((port + 1))
    done
    echo "$port"
}

# 端口选择：先问用户 → 留空则自动检测可用端口
# 用法: ask_port <默认端口> <备用起始端口> <端口描述>
# 返回值写入全局变量 PICKED_PORT
ask_port() {
    local default_port="$1"
    local fallback_start="$2"
    local desc="$3"
    local container_port="$4"  # 容器内部端口

    # 先计算推荐端口（默认端口可用则用它，否则自动寻找）
    local recommended="$default_port"
    if is_port_used "$default_port"; then
        recommended=$(find_free_port "$fallback_start")
    fi

    local input=""
    read -p "$(echo -e "  ${CYAN}${desc}${NC} 实机端口 → 容器${container_port} [${GREEN}${recommended}${NC}，回车自动]: ")" input || true

    if [ -z "$input" ]; then
        PICKED_PORT="$recommended"
    elif [[ "$input" =~ ^[0-9]+$ ]]; then
        if is_port_used "$input"; then
            warn "端口 $input 已被占用，自动切换到 $recommended"
            PICKED_PORT="$recommended"
        else
            PICKED_PORT="$input"
        fi
    else
        warn "输入无效，使用推荐端口 $recommended"
        PICKED_PORT="$recommended"
    fi
    echo -e "    → ${desc}: ${GREEN}${PICKED_PORT}${NC} → 容器 ${container_port}"
}

# 检测是否在 WSL2 环境
is_wsl2() {
    grep -qi "microsoft" /proc/version 2>/dev/null
}

# 显示 WSL2/Windows 防火墙提醒
show_wsl2_firewall_warning() {
    local http_port="$1"
    local https_port="$2"
    echo ""
    echo -e "${RED}╔══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║${NC}  ${YELLOW}⚠️  检测到 WSL2 环境 — 需要配置 Windows 防火墙！${NC}               ${RED}║${NC}"
    echo -e "${RED}║${NC}                                                                  ${RED}║${NC}"
    echo -e "${RED}║${NC}  ${BOLD}在 Windows 中以管理员身份运行 PowerShell，执行：${NC}               ${RED}║${NC}"
    echo -e "${RED}║${NC}                                                                  ${RED}║${NC}"
    echo -e "${RED}║${NC}  ${CYAN}netsh advfirewall firewall add rule name=\"OpenClaw\" \\${NC}       ${RED}║${NC}"
    echo -e "${RED}║${NC}  ${CYAN}    dir=in action=allow protocol=tcp \\${NC}                      ${RED}║${NC}"
    echo -e "${RED}║${NC}  ${CYAN}    localport=${http_port},${https_port}${NC}                                      ${RED}║${NC}"
    echo -e "${RED}║${NC}                                                                  ${RED}║${NC}"
    echo -e "${RED}║${NC}  ${YELLOW}否则外网无法访问容器端口！${NC}                                   ${RED}║${NC}"
    echo -e "${RED}╚══════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# 显示安装完成摘要信息卡
show_install_summary() {
    local gw_port="$1"
    local http_port="$2"
    local https_port="$3"
    local domain="$4"
    local tz="$5"
    local ssh_port="${6:-2222}"
    local cert_mode="${7:-}"

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║${NC}              ${BOLD}🎉 OpenClaw Pro 安装完成！${NC}                          ${GREEN}║${NC}"
    echo -e "${GREEN}╠══════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  ${BOLD}端口映射：${NC}                                                    ${GREEN}║${NC}"

    if [ -n "$domain" ] && [ "$cert_mode" = "letsencrypt" ]; then
        # 域名 + Let's Encrypt
        echo -e "${GREEN}║${NC}    HTTP  ${YELLOW}${http_port}${NC} → 容器 80（证书验证 + 跳转HTTPS）          ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    HTTPS ${YELLOW}${https_port}${NC} → 容器 443（主入口）                     ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    SSH   ${YELLOW}${ssh_port}${NC} → 容器 22（远程登录）                  ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    Gateway ${YELLOW}127.0.0.1:${gw_port}${NC} → 容器内部（不对外）     ${GREEN}║${NC}"
    elif [ -n "$domain" ]; then
        # IP + 自签名
        echo -e "${GREEN}║${NC}    HTTPS ${YELLOW}${https_port}${NC} → 容器 443（自签证书）                 ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    SSH   ${YELLOW}${ssh_port}${NC} → 容器 22（远程登录）                  ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    Gateway ${YELLOW}127.0.0.1:${gw_port}${NC} → 容器内部（不对外）     ${GREEN}║${NC}"
    else
        # HTTP 直连
        echo -e "${GREEN}║${NC}    Gateway ${YELLOW}${gw_port}${NC} → 容器 18789（主入口）               ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    Web面板 ${YELLOW}${https_port}${NC} → 容器 3000（管理面板）             ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    SSH    ${YELLOW}${ssh_port}${NC} → 容器 22（远程登录）                ${GREEN}║${NC}"
    fi

    echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  ${BOLD}访问地址：${NC}                                                    ${GREEN}║${NC}"
    if [ -n "$domain" ]; then
        echo -e "${GREEN}║${NC}    🌐 主站:     ${CYAN}https://${domain}:${https_port}${NC}"
        echo -e "${GREEN}║${NC}    🔧 管理面板: ${CYAN}https://${domain}:${https_port}/admin${NC}"
    else
        echo -e "${GREEN}║${NC}    🌐 主站:     ${CYAN}http://<服务器IP>:${gw_port}${NC}"
        echo -e "${GREEN}║${NC}    🔧 管理面板: ${CYAN}http://<服务器IP>:${https_port}${NC}"
    fi
    echo -e "${GREEN}║${NC}    🔑 SSH:      ${CYAN}ssh root@localhost -p ${ssh_port}${NC}"
    echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  ${BOLD}账号信息：${NC}                                                    ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}    容器用户: ${YELLOW}root${NC}（密码为您刚才设置的密码）            ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}    时区: ${YELLOW}${tz}${NC}                                          ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  ${BOLD}数据目录：${NC}                                                    ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}    📂 挂载: ${CYAN}${HOME_DIR}${NC} → 容器 /root"
    echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  ${BOLD}💡 提示：${NC}                                                      ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}    访问 Web 管理面板可修改所有配置（端口/AI Key/平台等）   ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}    或运行: ${CYAN}./openclaw-docker.sh config${NC}                       ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}"

    # WSL2提醒
    if is_wsl2; then
        if [ -n "$domain" ] && [ "$cert_mode" = "letsencrypt" ]; then
            show_wsl2_firewall_warning "$http_port" "$https_port"
        elif [ -n "$domain" ]; then
            show_wsl2_firewall_warning "$https_port" "$https_port"
        else
            show_wsl2_firewall_warning "$gw_port" "$https_port"
        fi
    fi
    echo ""
}

# 首次配置交互
first_time_setup() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}       ${BOLD}🐾 OpenClaw Pro — 首次安装${NC}                ${CYAN}║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${BLUE}只需设置一个密码，其他全部使用默认值。${NC}"
    echo -e "  ${BLUE}安装后可在 Web 管理面板中修改所有配置。${NC}"
    echo ""

    # 1. Root密码（唯一必填项，强密码检查）
    echo -e "  ${CYAN}密码要求: 至少8位，包含大写字母、小写字母、数字和特殊字符${NC}"
    echo ""
    while true; do
        read -sp "$(echo -e "${YELLOW}设置容器 root 密码 (必填):${NC} ")" ROOT_PASS
        echo ""
        if [ -z "$ROOT_PASS" ]; then
            error "密码不能为空"
            continue
        fi
        # 强密码校验
        local pw_errors=""
        if [ ${#ROOT_PASS} -lt 8 ]; then
            pw_errors="${pw_errors}\n  ✗ 长度不足8位（当前${#ROOT_PASS}位）"
        fi
        if ! echo "$ROOT_PASS" | grep -q '[A-Z]'; then
            pw_errors="${pw_errors}\n  ✗ 缺少大写字母"
        fi
        if ! echo "$ROOT_PASS" | grep -q '[a-z]'; then
            pw_errors="${pw_errors}\n  ✗ 缺少小写字母"
        fi
        if ! echo "$ROOT_PASS" | grep -q '[0-9]'; then
            pw_errors="${pw_errors}\n  ✗ 缺少数字"
        fi
        if ! echo "$ROOT_PASS" | grep -q '[^A-Za-z0-9]'; then
            pw_errors="${pw_errors}\n  ✗ 缺少特殊字符（如 !@#$%^&*）"
        fi
        if [ -n "$pw_errors" ]; then
            echo -e "${RED}[ERROR] 密码强度不足:${NC}${pw_errors}"
            echo ""
            continue
        fi
        # 确认密码
        read -sp "$(echo -e "${YELLOW}确认密码:${NC} ")" ROOT_PASS2
        echo ""
        if [ "$ROOT_PASS" != "$ROOT_PASS2" ]; then
            error "两次输入不一致，请重试"
            echo ""
            continue
        fi
        success "密码设置成功"
        break
    done

    # 默认配置值
    GW_PORT=18789
    WEB_PORT=3000
    SSH_PORT=2222
    DOMAIN=""
    TZ_VAL="Asia/Shanghai"
    PICKED_PORT=""
    HTTP_PORT=0
    HTTPS_PORT=0
    CERT_MODE="letsencrypt"

    # ============================================
    # 第一步：确定部署模式（域名/IP/HTTP直连）
    # ============================================
    echo ""
    echo -e "${BOLD}━━━ 部署模式 ━━━${NC}"
    echo -e "  ${CYAN}[1]${NC} HTTP 直连（默认，内网/本地测试用）"
    echo -e "  ${CYAN}[2]${NC} 域名 + Let's Encrypt 自动 HTTPS（推荐公网）"
    echo -e "  ${CYAN}[3]${NC} IP + 自签名 HTTPS（内网 HTTPS）"
    local mode_choice=""
    read -p "$(echo -e "请选择部署模式 [${GREEN}1${NC}/2/3]: ")" mode_choice || true
    echo ""

    case "$mode_choice" in
        2)
            read -p "请输入域名（如 git.example.com）: " DOMAIN || true
            if [ -z "$DOMAIN" ]; then
                warn "未输入域名，回退到 HTTP 直连模式"
                CERT_MODE=""
            else
                CERT_MODE="letsencrypt"
                info "模式: 域名 + Let's Encrypt (${DOMAIN})"
            fi
            ;;
        3)
            # 自动检测本机 IP（排除 docker/虚拟网卡）
            local local_ip=""
            local_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
            if [ -z "$local_ip" ]; then
                local_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
            fi

            if [ -n "$local_ip" ]; then
                echo -e "  检测到本机 IP: ${CYAN}${local_ip}${NC}"
                read -p "  使用此 IP？按回车确认，或输入其他 IP: " custom_ip || true
                if [ -n "$custom_ip" ] && echo "$custom_ip" | grep -qE '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'; then
                    local_ip="$custom_ip"
                fi
            else
                read -p "  请输入本机 IP 地址: " local_ip || true
            fi

            if echo "$local_ip" | grep -qE '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'; then
                DOMAIN="$local_ip"
                CERT_MODE="internal"
                info "模式: IP 自签名 HTTPS (${DOMAIN})"
                echo -e "  ${YELLOW}访问时浏览器会提示「不安全」，点击「继续访问」即可${NC}"
            else
                warn "IP 格式无效，回退到 HTTP 直连模式"
                CERT_MODE=""
            fi
            ;;
        *)
            info "模式: HTTP 直连"
            CERT_MODE=""
            ;;
    esac

    # ============================================
    # 第二步：根据模式逐个询问端口
    # ============================================
    echo ""
    echo -e "${BOLD}━━━ 端口配置（实机端口 → 容器端口，回车使用推荐值）━━━${NC}"

    # 所有模式都需要 Gateway 和 SSH
    ask_port 18789 18790 "Gateway" 18789
    GW_PORT="$PICKED_PORT"

    ask_port 2222 2223 "SSH" 22
    SSH_PORT="$PICKED_PORT"

    if [ -n "$DOMAIN" ] && [ "$CERT_MODE" = "letsencrypt" ]; then
        # 域名+LE: HTTP(80) + HTTPS(443) + 内部GW/Web
        ask_port 80 8080 "HTTP(ACME验证)" 80
        HTTP_PORT="$PICKED_PORT"

        ask_port 8443 8444 "HTTPS" 443
        HTTPS_PORT="$PICKED_PORT"

        PORT_ARGS="-p ${HTTP_PORT}:80 -p ${HTTPS_PORT}:443 -p 127.0.0.1:${GW_PORT}:18789 -p 127.0.0.1:${WEB_PORT}:3000 -p ${SSH_PORT}:22"

    elif [ -n "$DOMAIN" ] && [ "$CERT_MODE" = "internal" ]; then
        # IP+自签名: HTTPS(443) + 内部GW/Web
        ask_port 8443 8444 "HTTPS" 443
        HTTPS_PORT="$PICKED_PORT"

        PORT_ARGS="-p ${HTTPS_PORT}:443 -p 127.0.0.1:${GW_PORT}:18789 -p 127.0.0.1:${WEB_PORT}:3000 -p ${SSH_PORT}:22"

    else
        # HTTP 直连: GW + Web + SSH
        ask_port 3000 3001 "Web管理面板" 3000
        WEB_PORT="$PICKED_PORT"

        PORT_ARGS="-p ${GW_PORT}:18789 -p ${WEB_PORT}:3000 -p ${SSH_PORT}:22"
    fi

    echo ""
    success "端口配置完成"

    # 保存配置
    mkdir -p "$HOME_DIR/.openclaw"
    cat > "$CONFIG_FILE" << EOF
{
    "port": $GW_PORT,
    "web_port": $WEB_PORT,
    "ssh_port": $SSH_PORT,
    "http_port": $HTTP_PORT,
    "https_port": $HTTPS_PORT,
    "domain": "${DOMAIN}",
    "cert_mode": "${CERT_MODE}",
    "timezone": "${TZ_VAL}",
    "created": "$(date -Iseconds)"
}
EOF
    chmod 600 "$CONFIG_FILE"

    # 安全加固（用户确认后开启）
    echo ""
    echo -e "${BOLD}━━━ 宿主机安全加固 ━━━${NC}"

    if [ "$(id -u)" != "0" ]; then
        warn "未以 root 运行，跳过宿主机 ufw/fail2ban 自动配置（不影响容器运行）。"
    else
        local do_firewall="n"
        echo -e "  是否自动配置防火墙和 fail2ban？"
        echo -e "  ${CYAN}[1]${NC} 是，自动开启 ufw + fail2ban（推荐公网服务器）"
        echo -e "  ${CYAN}[2]${NC} 否，跳过（内网/已有防火墙策略）"
        local fw_choice=""
        read -t 15 -p "请选择 [1/2，默认1，15秒超时自动选择1]: " fw_choice || true
        echo ""
        if [ "$fw_choice" = "2" ]; then
            do_firewall="n"
            info "跳过防火墙配置"
        else
            do_firewall="y"
        fi

      if [ "$do_firewall" = "y" ]; then
        # ufw 防火墙
        if ! command -v ufw &>/dev/null; then
            info "安装 ufw..."
            apt-get install -y ufw >/dev/null 2>&1 || true
        fi

        if command -v ufw &>/dev/null; then
            # 不做 reset，仅追加规则，避免清除用户已有防火墙配置
            ufw default deny incoming 2>/dev/null || true
            ufw default allow outgoing 2>/dev/null || true
            ufw allow 22/tcp

            if [ -n "$DOMAIN" ] && [ "$CERT_MODE" = "letsencrypt" ]; then
                ufw allow "${HTTP_PORT}/tcp"
                ufw allow "${HTTPS_PORT}/tcp"
                success "ufw 将放行: 22/${HTTP_PORT}/${HTTPS_PORT}/${SSH_PORT}"
            elif [ -n "$DOMAIN" ]; then
                ufw allow "${HTTPS_PORT}/tcp"
                success "ufw 将放行: 22/${HTTPS_PORT}/${SSH_PORT}"
            else
                ufw allow "${GW_PORT}/tcp"
                ufw allow "${WEB_PORT}/tcp"
                success "ufw 将放行: 22/${GW_PORT}/${WEB_PORT}/${SSH_PORT}"
            fi
            ufw allow "${SSH_PORT}/tcp"

            ufw --force enable
            success "ufw 防火墙已启用"
        else
            warn "ufw 安装失败或不可用，跳过"
        fi

        # fail2ban（仅保护 sshd；Web 面板自身有登录限流）
        if ! command -v fail2ban-client &>/dev/null; then
            apt-get install -y fail2ban >/dev/null 2>&1 || true
        fi
        if command -v fail2ban-client &>/dev/null; then
            mkdir -p /etc/fail2ban
            cat > /etc/fail2ban/jail.local << F2B
[sshd]
enabled = true
port = ssh
maxretry = 5
bantime = 1800
findtime = 600
F2B
            systemctl enable --now fail2ban 2>/dev/null || true
            success "fail2ban 已启用 (sshd: 5次失败封30分钟)"
        else
            warn "fail2ban 安装失败或不可用，跳过"
        fi
      fi  # do_firewall
    fi

    # 镜像版本选择（对齐 Windows 安装器的 lite/full 选择）
    echo ""
    echo -e "${BOLD}━━━ 镜像版本选择 ━━━${NC}"
    echo -e "  ${CYAN}[1]${NC} 精简版（推荐，~250MB，约5分钟下载）"
    echo -e "      包含: Ubuntu + Node.js + Caddy + Web面板 + Python3"
    echo -e "      Chrome/noVNC/LightGBM 等可后期通过 Web 面板安装"
    echo -e "  ${CYAN}[2]${NC} 完整版（~1.6GB，约30分钟下载）"
    echo -e "      包含全部组件: Chrome、noVNC、LightGBM、openclaw 等"
    local edition_choice=""
    read -t 15 -p "请选择 [1/2，默认1，15秒超时自动选择1]: " edition_choice || true
    echo ""
    if [ "$edition_choice" = "2" ]; then
        IMAGE_EDITION="full"
        info "已选择完整版镜像"
    else
        IMAGE_EDITION="lite"
        info "已选择精简版镜像"
    fi
    log_msg "Image edition: $IMAGE_EDITION"

    # 获取镜像（配置完成后再下载，与 Windows 安装器流程对齐）
    ensure_image

    # 清除旧 SSH host key（容器重建后 key 会变）
    ssh-keygen -R "[localhost]:${SSH_PORT}" 2>/dev/null || true
    ssh-keygen -R "[127.0.0.1]:${SSH_PORT}" 2>/dev/null || true

    # 创建容器
    build_proxy_args
    info "创建容器..."
    docker create \
        --name "$CONTAINER_NAME" \
        --hostname openclaw \
        --cap-drop ALL \
        --cap-add CHOWN \
        --cap-add SETUID \
        --cap-add SETGID \
        --cap-add NET_BIND_SERVICE \
        --cap-add KILL \
        --cap-add DAC_OVERRIDE \
        --cap-add SYS_CHROOT \
        --cap-add AUDIT_WRITE \
        --security-opt no-new-privileges \
        -v "$HOME_DIR:/root" \
        $PORT_ARGS \
        -e "TZ=$TZ_VAL" \
        -e "CERT_MODE=$CERT_MODE" \
        -e "DOMAIN=$DOMAIN" \
        $PROXY_ARGS \
        --restart unless-stopped \
        "$IMAGE_NAME"

    # 启动并设密码
    docker start "$CONTAINER_NAME"
    sleep 2
    echo "root:${ROOT_PASS}" | docker exec -i "$CONTAINER_NAME" chpasswd

    # 容器环境修复（sshd StrictModes + 缺失依赖如 envsubst）
    fix_container_env

    # SSH key 注入：将実机公钥自动复制到容器（密码登录已禁用，仅允许 key 登录）
    local host_pubkey=""
    for keyfile in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub" "$HOME/.ssh/id_ecdsa.pub"; do
        if [ -f "$keyfile" ]; then
            host_pubkey=$(cat "$keyfile")
            break
        fi
    done
    if [ -n "$host_pubkey" ]; then
        docker exec "$CONTAINER_NAME" bash -c "mkdir -p /root/.ssh && chmod 700 /root/.ssh && echo '$host_pubkey' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && sort -u -o /root/.ssh/authorized_keys /root/.ssh/authorized_keys"
        success "容器已创建并启动（已自动注入实机SH公钥）"
    else
        success "容器已创建并启动"
        warn "未找到实机 SSH 公钥，请进入容器后手动配置 authorized_keys"
    fi

    # 显示安装完成摘要
    if [ -n "$DOMAIN" ]; then
        show_install_summary "$GW_PORT" "$HTTP_PORT" "$HTTPS_PORT" "$DOMAIN" "$TZ_VAL" "$SSH_PORT" "$CERT_MODE"
    else
        show_install_summary "$GW_PORT" "$HTTP_PORT" "$WEB_PORT" "" "$TZ_VAL" "$SSH_PORT" ""
    fi

    # 进入容器
    show_command_hint
    docker exec -it "$CONTAINER_NAME" bash -l
}

# 进入容器前的命令提示
show_command_hint() {
    local script_name ssh_port_val
    script_name=$(basename "$0")
    ssh_port_val=$(jq -r '.ssh_port // 2222' "$CONFIG_FILE" 2>/dev/null || echo 2222)
    echo -e "${CYAN}────────────────────────────────────────────────${NC}"
    echo -e "  🔑 SSH: ${BLUE}ssh root@localhost -p ${ssh_port_val}${NC} (仅Key登录)"
    echo -e "  添加公钥: ${CYAN}./${script_name} sshkey [~/.ssh/id_rsa.pub]${NC}"
    echo -e "  退出容器后可用: ${BOLD}./${script_name}${NC} <命令>"
    echo -e "  ${YELLOW}stop${NC} 停止  ${YELLOW}status${NC} 状态  ${YELLOW}config${NC} 配置  ${YELLOW}update${NC} 更新"
    echo -e "  ${YELLOW}remove${NC} 删除容器  ${YELLOW}clean${NC} 完全清理  ${YELLOW}logs${NC} 日志"
    echo -e "${CYAN}────────────────────────────────────────────────${NC}"
}

# 容器已运行时的入口
show_running_panel() {
    local current_ver update_hint=""
    current_ver=$(docker exec "$CONTAINER_NAME" cat /etc/openclaw-version 2>/dev/null || echo "")

    # 轻量级更新检查（最多等 5 秒，不阻塞）
    local check_json
    check_json=$(docker exec "$CONTAINER_NAME" curl -sf --max-time 5 http://127.0.0.1:3000/api/update/check 2>/dev/null || true)
    if [ -n "$check_json" ]; then
        local has_upd remote_ver df_changed
        has_upd=$(echo "$check_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('hasUpdate', d.get('updateAvailable', False)) else 'false')" 2>/dev/null || echo "false")
        remote_ver=$(echo "$check_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('remoteVersion', d.get('latestVersion', '')))" 2>/dev/null || true)
        df_changed=$(echo "$check_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('dockerfileChanged') else 'false')" 2>/dev/null || echo "false")
        if [ "$has_upd" = "true" ] || [ "$df_changed" = "true" ]; then
            update_hint="${YELLOW}⬆ 有新版本可用${remote_ver:+ ($remote_ver)}${NC}  运行 ${CYAN}./openclaw-docker.sh update${NC} 更新"
        fi
    fi

    echo ""
    echo -e "  ${GREEN}●${NC} 容器 ${BOLD}${CONTAINER_NAME}${NC} 已运行中${current_ver:+  (${current_ver})}"
    if [ -n "$update_hint" ]; then
        echo -e "  $update_hint"
    fi
    echo -e "  ${YELLOW}[C]${NC} 配置菜单  ${YELLOW}[U]${NC} 更新  ${YELLOW}[回车/10秒]${NC} 进入容器"
    echo ""

    read -t 10 -n 1 CHOICE 2>/dev/null || CHOICE=""
    echo ""

    if [[ "$CHOICE" == "c" || "$CHOICE" == "C" ]]; then
        cmd_config
    elif [[ "$CHOICE" == "u" || "$CHOICE" == "U" ]]; then
        cmd_update
    else
        show_command_hint
        docker exec -it "$CONTAINER_NAME" bash -l
    fi
}

# ---- 命令实现 ----

cmd_run() {
    ensure_docker
    ensure_jq
    ensure_home

    # 检查容器状态
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        # 容器存在
        if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
            # 运行中
            ensure_image
            show_running_panel
        else
            # 已停止
            ensure_image
            info "容器已停止，正在启动..."
            docker start "$CONTAINER_NAME"
            sleep 2
            fix_container_env
            success "容器已启动"
            show_command_hint
            docker exec -it "$CONTAINER_NAME" bash -l
        fi
    else
        # 检查是否有同名前缀的已停止容器残留
        local stopped_containers
        stopped_containers=$(docker ps -a --filter "name=openclaw" --format '{{.Names}}|{{.Status}}' 2>/dev/null || true)
        if [ -n "$stopped_containers" ]; then
            echo -e "${YELLOW}发现已停止的 OpenClaw 容器：${NC}"
            echo "$stopped_containers" | while IFS='|' read -r name status; do
                echo -e "  ${CYAN}$name${NC} ($status)"
            done
            echo ""
            echo -e "  ${CYAN}[1]${NC} 清除旧容器，重新配置（默认）"
            echo -e "  ${CYAN}[2]${NC} 启动已有容器"
            local choice=""
            read -t 10 -p "请选择 [1/2，默认1，10秒超时自动选择1]: " choice || true
            echo ""
            if [ "$choice" = "2" ]; then
                local first_container
                first_container=$(echo "$stopped_containers" | head -1 | cut -d'|' -f1)
                info "启动容器 $first_container ..."
                docker start "$first_container"
                sleep 2
                fix_container_env "$first_container"
                success "容器已启动"
                sleep 2
                show_command_hint
                docker exec -it "$first_container" bash -l
                return
            else
                # 清理旧容器
                echo "$stopped_containers" | while IFS='|' read -r name status; do
                    info "删除旧容器: $name"
                    docker rm -f "$name" 2>/dev/null || true
                done
            fi
        fi
        # 首次运行
        first_time_setup
    fi
}

cmd_stop() {
    info "停止容器..."
    docker stop "$CONTAINER_NAME" 2>/dev/null && success "容器已停止" || error "容器未运行"
}

cmd_status() {
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo -e "${GREEN}● 运行中${NC}"
        docker ps --filter "name=$CONTAINER_NAME" --format "table {{.Status}}\t{{.Ports}}"
    elif docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo -e "${YELLOW}● 已停止${NC}"
    else
        echo -e "${RED}● 未创建${NC}"
    fi
}

cmd_config() {
    echo -e "\n${BOLD}━━━ OpenClaw Pro 配置 ━━━${NC}"
    echo -e "  ${CYAN}1.${NC} 修改root密码"
    echo -e "  ${CYAN}2.${NC} 修改Gateway端口"
    echo -e "  ${CYAN}3.${NC} 配置HTTPS域名"
    echo -e "  ${CYAN}4.${NC} 修改时区"
    echo -e "  ${CYAN}0.${NC} 返回"
    echo ""
    read -p "选择 [0-4]: " MENU

    case "$MENU" in
        1)
            read -sp "新密码: " NEW_PASS; echo ""
            echo "root:${NEW_PASS}" | docker exec -i "$CONTAINER_NAME" chpasswd
            success "密码已修改（仅用于 docker exec / 容器内 su，SSH 仅允许 Key 登录）"
            ;;
        2)
            read -p "新端口: " NEW_PORT
            if [ -n "$NEW_PORT" ]; then
                # 校验端口号是纯数字
                if ! echo "$NEW_PORT" | grep -qE '^[0-9]+$'; then
                    error "端口必须是数字"
                elif [ "$NEW_PORT" -lt 1 ] || [ "$NEW_PORT" -gt 65535 ]; then
                    error "端口范围: 1-65535"
                else
                    jq ".port = $NEW_PORT" "$CONFIG_FILE" > /tmp/cfg.tmp && mv /tmp/cfg.tmp "$CONFIG_FILE"
                    warn "端口已更新，需要重建容器: $0 rebuild"
                fi
            fi
            ;;
        3)
            read -p "HTTPS域名 [留空禁用]: " NEW_DOMAIN
            # 域名格式校验，防止 jq 注入
            if [ -n "$NEW_DOMAIN" ] && ! echo "$NEW_DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9.\-]*[a-zA-Z0-9])?$'; then
                error "域名格式无效"
            else
                jq --arg d "$NEW_DOMAIN" '.domain = $d' "$CONFIG_FILE" > /tmp/cfg.tmp && mv /tmp/cfg.tmp "$CONFIG_FILE"
                warn "域名已更新，需要重建容器: $0 rebuild"
            fi
            ;;
        4)
            read -p "时区 [当前: $(jq -r '.timezone' "$CONFIG_FILE" 2>/dev/null)]: " NEW_TZ
            if [ -n "$NEW_TZ" ]; then
                jq --arg tz "$NEW_TZ" '.timezone = $tz' "$CONFIG_FILE" > /tmp/cfg.tmp && mv /tmp/cfg.tmp "$CONFIG_FILE"
                warn "时区已更新，需要重建容器: $0 rebuild"
            fi
            ;;
    esac
}

cmd_shell() {
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        show_command_hint
        docker exec -it "$CONTAINER_NAME" bash -l
    else
        error "容器未运行，请先执行: $0 run"
    fi
}

cmd_rebuild() {
    warn "重建容器（数据不会丢失）..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
    docker rmi "$IMAGE_NAME" 2>/dev/null || true
    ensure_image
    success "镜像重建完成，请运行: $0 run"
}

cmd_remove() {
    echo -e "${BOLD}━━━ 删除容器 ━━━${NC}"
    echo -e "  容器: ${CYAN}${CONTAINER_NAME}${NC}"
    echo -e "  ${YELLOW}⚠ 容器内未持久化的数据将丢失${NC}"
    echo -e "  ${GREEN}✓ 已挂载的数据卷不受影响${NC}"
    echo ""
    local confirm=""
    read -p "确认删除容器？[y/N]: " confirm
    if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker rm "$CONTAINER_NAME" 2>/dev/null || true
        success "容器已删除"
        echo -e "  重新部署: ${CYAN}$0 run${NC}"
    else
        info "已取消"
    fi
}

cmd_clean() {
    echo -e "${RED}━━━ 完全清理 ━━━${NC}"
    echo -e "  ${RED}将删除以下内容：${NC}"
    echo -e "    • 容器: ${CYAN}${CONTAINER_NAME}${NC}"
    echo -e "    • 镜像: ${CYAN}${IMAGE_NAME}${NC}"
    echo -e "    • 配置: ${CYAN}${CONFIG_FILE}${NC}"
    echo -e "    • 版本标记: ${CYAN}${HOME_DIR}/.openclaw/${NC}"
    echo -e "  ${YELLOW}⚠ 此操作不可逆！${NC}"
    echo ""
    local confirm=""
    read -p "输入 YES 确认完全清理: " confirm
    if [ "$confirm" = "YES" ]; then
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker rm "$CONTAINER_NAME" 2>/dev/null || true
        docker rmi "$IMAGE_NAME" 2>/dev/null || true
        rm -f "$CONFIG_FILE" 2>/dev/null || true
        rm -rf "$HOME_DIR/.openclaw" 2>/dev/null || true
        success "已完全清理"
        echo -e "  重新安装: ${CYAN}$0 run${NC}"
    else
        info "已取消（需输入大写 YES 确认）"
    fi
}

cmd_logs() {
    docker logs --tail 100 -f "$CONTAINER_NAME"
}

cmd_sshkey() {
    local keyfile="${2:-}"
    if [ -z "$keyfile" ]; then
        # 自动查找实机公钥
        for f in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub" "$HOME/.ssh/id_ecdsa.pub"; do
            if [ -f "$f" ]; then
                keyfile="$f"
                break
            fi
        done
    fi

    if [ -z "$keyfile" ] || [ ! -f "$keyfile" ]; then
        error "未找到 SSH 公钥文件"
        echo -e "  用法: ${CYAN}$0 sshkey [/path/to/id_rsa.pub]${NC}"
        echo -e "  或先生成: ${CYAN}ssh-keygen -t ed25519${NC}"
        return 1
    fi

    info "注入公钥: $keyfile"
    docker exec "$CONTAINER_NAME" bash -c "mkdir -p /root/.ssh && chmod 700 /root/.ssh"
    docker exec -i "$CONTAINER_NAME" bash -c 'cat >> /root/.ssh/authorized_keys && sort -u -o /root/.ssh/authorized_keys /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys' < "$keyfile"
    success "SSH 公钥已注入容器"

    local ssh_port_val
    ssh_port_val=$(jq -r '.ssh_port // 2222' "$CONFIG_FILE" 2>/dev/null || echo 2222)
    echo -e "  现在可以连接: ${CYAN}ssh root@localhost -p ${ssh_port_val}${NC}"
}

# 更新命令（对齐 Windows update-windows.ps1）
# 智能检测 → 热更新 / 完整更新
cmd_update() {
    ensure_docker
    ensure_jq
    log_msg "cmd_update started"

    # 检查容器是否存在
    if ! docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        error "未找到容器 '$CONTAINER_NAME'"
        echo -e "  请使用 ${CYAN}$0 run${NC} 创建容器"
        return 1
    fi

    # 确保容器运行中
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        info "容器已停止，正在启动..."
        docker start "$CONTAINER_NAME" 2>/dev/null || true
        sleep 3
        fix_container_env
    fi

    # 智能检测更新类型（对齐 Windows 逻辑: Dockerfile hash 检查）
    local recommend_full=false
    local recommend_msg=""
    local has_update=true  # 默认认为有更新（API 不可用时不阻挡）
    local current_ver="" remote_ver=""
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        info "检测更新类型..."
        current_ver=$(docker exec "$CONTAINER_NAME" cat /etc/openclaw-version 2>/dev/null || echo "unknown")
        # 检查容器内是否有 Dockerfile hash 文件
        if ! docker exec "$CONTAINER_NAME" test -f /etc/openclaw-dockerfile-hash 2>/dev/null; then
            recommend_full=true
            recommend_msg="检测到旧版镜像，建议完整更新以获取最新系统包"
        else
            # 通过 API 检查远程 Dockerfile hash
            local check_json
            check_json=$(docker exec "$CONTAINER_NAME" curl -sf --max-time 15 http://127.0.0.1:3000/api/update/check?force=1 2>/dev/null || true)
            if [ -n "$check_json" ]; then
                local df_changed
                df_changed=$(echo "$check_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('dockerfileChanged') else 'false')" 2>/dev/null || echo "false")
                if [ "$df_changed" = "true" ]; then
                    recommend_full=true
                    recommend_msg="检测到 Dockerfile 已变更，建议完整更新"
                fi
                # 检查是否有任何更新可用
                local update_available
                update_available=$(echo "$check_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('hasUpdate', d.get('updateAvailable', True)) else 'false')" 2>/dev/null || echo "true")
                remote_ver=$(echo "$check_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('remoteVersion', d.get('latestVersion', '')))" 2>/dev/null || true)
                if [ "$update_available" = "false" ]; then
                    has_update=false
                fi
            fi
        fi
    fi

    # 如果没有更新，提示已是最新，但仍允许强制更新
    if ! $has_update; then
        echo ""
        echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║${NC}  ✅ 当前已是最新版本${current_ver:+ (${current_ver})}              ${GREEN}║${NC}"
        echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
        echo ""
        local force_choice=""
        read -p "是否仍要强制检查更新？[y/N]: " force_choice || true
        if [[ ! "$force_choice" =~ ^[yY] ]]; then
            return 0
        fi
        echo ""
    fi

    # 显示更新菜单
    echo ""
    echo -e "${BOLD}━━━ OpenClaw Pro 更新 ━━━${NC}"
    if [ -n "$recommend_msg" ]; then
        echo -e "  ${YELLOW}⚠️  $recommend_msg${NC}"
    fi
    echo ""
    if $recommend_full; then
        echo -e "  ${CYAN}[1]${NC} ⚡ 热更新"
        echo -e "      只更新 Web 面板、配置模板等文件，无需下载镜像/重启容器"
        echo ""
        echo -e "  ${YELLOW}[2]${NC} 📦 完整更新（推荐）"
        echo -e "      下载完整镜像并重建容器（保留所有数据和配置）"
    else
        echo -e "  ${YELLOW}[1]${NC} ⚡ 热更新（推荐）"
        echo -e "      只更新 Web 面板、配置模板等文件，无需下载镜像/重启容器"
        echo ""
        echo -e "  ${CYAN}[2]${NC} 📦 完整更新"
        echo -e "      下载完整镜像并重建容器（保留所有数据和配置）"
    fi
    echo ""
    local default_choice
    default_choice=$($recommend_full && echo "2" || echo "1")
    read -p "请选择 [1/2，默认$default_choice]: " update_choice || true
    update_choice="${update_choice:-$default_choice}"

    if [ "$update_choice" = "1" ]; then
        _do_hotpatch
    else
        _do_full_update
    fi
}

# 热更新（触发容器内 hotpatch API）
_do_hotpatch() {
    info "执行热更新..."
    log_msg "hotpatch started"

    # 确保容器在运行
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        error "容器未运行"
        return 1
    fi

    # 触发 hotpatch
    local result
    result=$(docker exec "$CONTAINER_NAME" curl -s -X POST http://127.0.0.1:3000/api/update/hotpatch -H "Content-Type: application/json" -d '{"branch":"main"}' 2>/dev/null || true)

    if [ -z "$result" ]; then
        error "无法连接到 Web 面板 API"
        return 1
    fi

    info "热更新已触发，等待完成..."

    # 轮询状态（对齐 Windows 的 hotpatch 轮询逻辑）
    local done=false was_running=false
    local post_ok=false idle_count=0 fail_count=0
    echo "$result" | grep -q '"success"\|"ok"' && post_ok=true

    for i in $(seq 1 180); do
        sleep 1
        local status_json
        status_json=$(docker exec "$CONTAINER_NAME" curl -sf http://127.0.0.1:3000/api/update/hotpatch/status 2>/dev/null || true)
        if [ -z "$status_json" ]; then
            fail_count=$((fail_count + 1))
            if ($was_running || $post_ok) && [ "$fail_count" -ge 5 ]; then
                info "Web 面板正在重启..."
                sleep 5
                success "热更新完成（Web 面板已重启）"
                done=true
                break
            fi
            printf "."
            continue
        fi
        fail_count=0

        local status
        status=$(echo "$status_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || true)

        case "$status" in
            running)
                was_running=true
                printf "."
                ;;
            done)
                echo ""
                success "热更新完成"
                done=true
                break
                ;;
            error)
                echo ""
                error "热更新失败"
                local err_log
                err_log=$(echo "$status_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('log',''))" 2>/dev/null || true)
                [ -n "$err_log" ] && echo "$err_log" | tail -5
                done=true
                break
                ;;
            idle)
                if $was_running; then
                    echo ""
                    success "热更新完成（服务已重启）"
                    done=true
                    break
                fi
                if $post_ok; then
                    idle_count=$((idle_count + 1))
                    [ "$idle_count" -ge 8 ] && { echo ""; success "热更新完成"; done=true; break; }
                fi
                printf "."
                ;;
        esac
    done
    echo ""

    if ! $done; then
        error "热更新超时"
    fi
    log_msg "hotpatch done=$done"
}

# 完整更新（对齐 Windows update-windows.ps1 的完整更新流程）
_do_full_update() {
    log_msg "full update started"

    # 读取现有容器配置
    info "读取容器配置..."
    local config_json=""
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        config_json=$(docker exec "$CONTAINER_NAME" cat /root/.openclaw/docker-config.json 2>/dev/null || true)
    fi
    if [ -z "$config_json" ] && [ -f "$CONFIG_FILE" ]; then
        config_json=$(cat "$CONFIG_FILE" 2>/dev/null || true)
    fi
    if [ -z "$config_json" ]; then
        error "无法读取容器配置，请使用 $0 rebuild + $0 run"
        return 1
    fi

    # 解析配置
    local domain gw_port web_port http_port https_port cert_mode tz
    domain=$(echo "$config_json" | jq -r '.domain // empty' 2>/dev/null)
    gw_port=$(echo "$config_json" | jq -r '.port // 18789' 2>/dev/null)
    web_port=$(echo "$config_json" | jq -r '.web_port // 3000' 2>/dev/null)
    ssh_port=$(echo "$config_json" | jq -r '.ssh_port // 2222' 2>/dev/null)
    http_port=$(echo "$config_json" | jq -r '.http_port // 0' 2>/dev/null)
    https_port=$(echo "$config_json" | jq -r '.https_port // 0' 2>/dev/null)
    cert_mode=$(echo "$config_json" | jq -r '.cert_mode // "letsencrypt"' 2>/dev/null)
    tz=$(echo "$config_json" | jq -r '.timezone // "Asia/Shanghai"' 2>/dev/null)

    info "域名: ${domain:-无}"
    info "端口: Gateway=$gw_port Web=$web_port SSH=$ssh_port HTTP=$http_port HTTPS=$https_port"

    # 获取当前版本
    local current_ver
    current_ver=$(docker exec "$CONTAINER_NAME" cat /etc/openclaw-version 2>/dev/null || echo "unknown")
    info "当前版本: $current_ver"

    # 检查最新版本
    local latest_tag
    latest_tag=$(get_latest_release_tag)
    if [ -n "$latest_tag" ] && [ "$latest_tag" = "$current_ver" ]; then
        warn "当前已是最新版本 ($current_ver)"
        read -p "仍然要重新安装吗？[y/N] " force_update
        if [[ ! "$force_update" =~ ^[yY] ]]; then
            return 0
        fi
    elif [ -n "$latest_tag" ]; then
        info "最新版本: $latest_tag"
    fi

    # 下载最新镜像
    info "下载最新镜像..."
    ensure_image

    # 停止并删除旧容器
    info "停止旧容器..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
    success "旧容器已删除"

    # 构建端口映射
    local PORT_ARGS=""
    if [ -n "$domain" ] && [ "$cert_mode" = "letsencrypt" ]; then
        PORT_ARGS="-p ${http_port}:80 -p ${https_port}:443 -p 127.0.0.1:${gw_port}:18789 -p 127.0.0.1:${web_port}:3000 -p ${ssh_port}:22"
    elif [ -n "$domain" ]; then
        # IP+自签名: 不需要 80
        PORT_ARGS="-p ${https_port}:443 -p 127.0.0.1:${gw_port}:18789 -p 127.0.0.1:${web_port}:3000 -p ${ssh_port}:22"
    else
        PORT_ARGS="-p ${gw_port}:18789 -p ${web_port}:3000 -p ${ssh_port}:22"
    fi

    # 清除旧 SSH host key（容器重建后 key 会变）
    ssh-keygen -R "[localhost]:${ssh_port}" 2>/dev/null || true
    ssh-keygen -R "[127.0.0.1]:${ssh_port}" 2>/dev/null || true

    # 启动新容器
    build_proxy_args
    info "启动新容器..."
    docker run -d \
        --name "$CONTAINER_NAME" \
        --hostname openclaw \
        --cap-drop ALL \
        --cap-add CHOWN \
        --cap-add SETUID \
        --cap-add SETGID \
        --cap-add NET_BIND_SERVICE \
        --cap-add KILL \
        --cap-add DAC_OVERRIDE \
        --cap-add SYS_CHROOT \
        --cap-add AUDIT_WRITE \
        --security-opt no-new-privileges \
        -v "$HOME_DIR:/root" \
        $PORT_ARGS \
        -e "TZ=$tz" \
        -e "CERT_MODE=$cert_mode" \
        -e "DOMAIN=$domain" \
        $PROXY_ARGS \
        --restart unless-stopped \
        "$IMAGE_NAME"

    # 容器环境修复
    sleep 1
    fix_container_env

    # 等待服务就绪
    info "等待服务就绪..."
    local ready=false
    for i in $(seq 1 30); do
        sleep 2
        local health
        health=$(docker exec "$CONTAINER_NAME" curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null || true)
        if [ "$health" = "200" ] || [ "$health" = "302" ] || [ "$health" = "401" ]; then
            ready=true
            break
        fi
        printf "."
    done
    echo ""

    local new_ver
    new_ver=$(docker exec "$CONTAINER_NAME" cat /etc/openclaw-version 2>/dev/null || echo "unknown")

    if $ready; then
        success "所有服务已就绪"
    else
        warn "服务仍在启动中，请稍等几秒再访问"
    fi

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║${NC}         ${BOLD}🎉 更新完成！${NC}                        ${GREEN}║${NC}"
    echo -e "${GREEN}╠══════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║${NC}  版本: ${YELLOW}${current_ver}${NC} → ${GREEN}${new_ver}${NC}"
    if [ -n "$domain" ]; then
        local url="https://${domain}"
        [ "$https_port" != "443" ] && url="${url}:${https_port}"
        echo -e "${GREEN}║${NC}  🔗 URL: ${CYAN}${url}${NC}"
    else
        echo -e "${GREEN}║${NC}  🔗 Gateway: ${CYAN}http://localhost:${gw_port}${NC}"
        echo -e "${GREEN}║${NC}  🔗 管理面板: ${CYAN}http://localhost:${web_port}${NC}"
    fi
    echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    log_msg "full update complete: $current_ver -> $new_ver"
}

# ---- 主入口 ----
case "${1:-run}" in
    run)      cmd_run ;;
    stop)     cmd_stop ;;
    status)   cmd_status ;;
    config)   cmd_config ;;
    shell)    cmd_shell ;;
    sshkey)   cmd_sshkey "$@" ;;
    rebuild)  cmd_rebuild ;;
    remove)   cmd_remove ;;
    clean)    cmd_clean ;;
    logs)     cmd_logs ;;
    update)   cmd_update ;;
    hotpatch) _do_hotpatch ;;
    *)
        echo -e "${BOLD}用法:${NC} $0 <命令>"
        echo ""
        echo -e "${BOLD}常用命令:${NC}"
        echo "  run      启动容器（首次运行进入配置向导）"
        echo "  stop     停止容器"
        echo "  status   查看状态"
        echo "  shell    进入容器终端"
        echo "  sshkey   注入 SSH 公钥到容器"
        echo ""
        echo -e "${BOLD}管理命令:${NC}"
        echo "  config   修改配置（密码/端口/域名/时区）"
        echo "  update   更新（智能检测热更新/完整更新）"
        echo "  hotpatch 仅热更新（Web面板等文件）"
        echo "  rebuild  重建容器+镜像（保留数据卷）"
        echo "  logs     查看容器日志"
        echo ""
        echo -e "${BOLD}清理命令:${NC}"
        echo "  remove   删除容器（保留镜像和配置）"
        echo "  clean    完全清理（容器+镜像+配置）"
        exit 1
        ;;
esac
