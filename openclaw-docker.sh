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
HOME_DIR="$SCRIPT_DIR/home-data"
CONFIG_FILE="$HOME_DIR/.openclaw/docker-config.json"

# ---- 工具函数 ----
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

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

# GitHub Release 配置
GITHUB_REPO="cintia09/openclaw-pro"
GHCR_IMAGE="ghcr.io/${GITHUB_REPO}"
IMAGE_TARBALL="openclaw-pro-image.tar.gz"

# 获取远端最新 Release tag
get_latest_release_tag() {
    local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
    curl -sL "$api_url" 2>/dev/null | grep '"tag_name"' | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true
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
    if docker image inspect "$IMAGE_NAME" &>/dev/null; then
        # 镜像已存在，检查是否有新版本
        local local_tag remote_tag
        local_tag=$(get_local_image_tag)
        remote_tag=$(get_latest_release_tag)

        if [ -n "$remote_tag" ] && [ -n "$local_tag" ] && [ "$remote_tag" != "$local_tag" ]; then
            warn "发现新版本镜像: 远端 $remote_tag，本地 $local_tag"
            echo -e "  ${CYAN}[1]${NC} 使用本地镜像（默认）"
            echo -e "  ${CYAN}[2]${NC} 下载最新镜像"
            local img_choice=""
            read -t 10 -p "请选择 [1/2，默认1，10秒超时自动选择1]: " img_choice 2>/dev/null || true
            echo ""
            if [ "$img_choice" = "2" ]; then
                info "将下载最新镜像..."
                docker rmi "$IMAGE_NAME" 2>/dev/null || true
            else
                return 0
            fi
        elif [ -n "$remote_tag" ] && [ -z "$local_tag" ]; then
            info "本地镜像版本未知，远端最新: $remote_tag"
            return 0
        else
            return 0
        fi
    fi

    # 方式1: 本地已有导出的 tar.gz（手动下载或 install.sh 已下载）
    if [ -f "$SCRIPT_DIR/$IMAGE_TARBALL" ]; then
        info "发现本地镜像包 $IMAGE_TARBALL，正在导入..."
        if docker load < "$SCRIPT_DIR/$IMAGE_TARBALL"; then
            success "镜像导入完成"
            return 0
        fi
        warn "镜像导入失败，尝试其他方式..."
    fi

    # 方式2: 从 GHCR 拉取
    info "尝试从 GHCR 拉取镜像..."
    if docker pull "$GHCR_IMAGE:latest" 2>/dev/null; then
        docker tag "$GHCR_IMAGE:latest" "$IMAGE_NAME:latest" 2>/dev/null
        success "镜像拉取完成 (GHCR)"
        return 0
    fi
    warn "GHCR 拉取失败，尝试从 GitHub Release 下载..."

    # 方式3: 从 GitHub Release 下载 tar.gz
    if download_release_image; then
        return 0
    fi

    # 方式4: 本地构建（最后手段）
    warn "预构建镜像获取失败，将从 Dockerfile 本地构建（需要较长时间）..."
    info "构建 Docker 镜像..."
    docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"
    success "镜像构建完成"
}

# 从 GitHub Release 下载镜像 tar.gz
download_release_image() {
    local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
    local download_url=""

    # 获取下载链接
    if command -v curl &>/dev/null; then
        download_url=$(curl -sL "$api_url" 2>/dev/null | \
            grep -o '"browser_download_url":\s*"[^"]*openclaw-pro-image\.tar\.gz"' | \
            head -1 | sed 's/.*"\(http[^"]*\)"/\1/')
    fi

    if [ -z "$download_url" ]; then
        warn "无法获取 Release 下载链接"
        return 1
    fi

    local target="$SCRIPT_DIR/$IMAGE_TARBALL"
    info "正在从 GitHub Release 下载镜像 (~1.6GB)..."
    info "下载地址: $download_url"

    if curl -fL -C - --retry 5 --retry-delay 3 --progress-bar -o "$target" "$download_url"; then
        info "下载完成，正在导入镜像..."
        if docker load < "$target"; then
            # 记录镜像版本标记
            local release_tag
            release_tag=$(get_latest_release_tag)
            if [ -n "$release_tag" ]; then
                save_image_tag "$release_tag"
            fi
            success "镜像导入完成 (GitHub Release)"
            # 保留 tar.gz 以便后续离线使用，用户可手动删除
            return 0
        fi
        warn "镜像导入失败"
        rm -f "$target"
        return 1
    fi

    warn "下载失败"
    rm -f "$target"
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

# 端口选择：检测→告知→5秒给用户自定义机会
# 用法: pick_port <默认端口> <备用起始端口> <端口描述>
# 返回值写入全局变量 PICKED_PORT
pick_port() {
    local default_port="$1"
    local fallback_start="$2"
    local desc="$3"

    if is_port_used "$default_port"; then
        local auto_port
        auto_port=$(find_free_port "$fallback_start")
        echo -e "${YELLOW}[WARN]${NC} 端口 ${RED}${default_port}${NC} 已被占用，已自动选择端口 ${GREEN}${auto_port}${NC}（${desc}）"
        echo -e "      ${CYAN}5秒内按 C 可手动输入端口，否则使用 ${auto_port}...${NC}"

        local choice=""
        read -t 5 -n 1 choice 2>/dev/null || true
        echo ""

        if [[ "$choice" == "c" || "$choice" == "C" ]]; then
            read -p "$(echo -e "${YELLOW}请输入自定义端口 [${auto_port}]: ${NC}")" custom_port
            custom_port="${custom_port:-$auto_port}"
            PICKED_PORT="$custom_port"
        else
            PICKED_PORT="$auto_port"
        fi
    else
        PICKED_PORT="$default_port"
    fi
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

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║${NC}              ${BOLD}🎉 OpenClaw Pro 安装完成！${NC}                          ${GREEN}║${NC}"
    echo -e "${GREEN}╠══════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  ${BOLD}端口映射：${NC}                                                    ${GREEN}║${NC}"
    if [ -n "$domain" ]; then
        echo -e "${GREEN}║${NC}    HTTP  ${YELLOW}${http_port}${NC}  → 证书验证 + 跳转HTTPS               ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    HTTPS ${YELLOW}${https_port}${NC} → 主入口（反代 Gateway）              ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    Gateway ${YELLOW}127.0.0.1:${gw_port}${NC} → 容器内部（不对外）     ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}  ${BOLD}访问地址：${NC}                                                    ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    🌐 主站:     ${CYAN}https://${domain}:${https_port}${NC}"
        echo -e "${GREEN}║${NC}    🔧 管理面板: ${CYAN}https://${domain}:${https_port}/admin${NC}"
    else
        echo -e "${GREEN}║${NC}    Gateway ${YELLOW}${gw_port}${NC} → 主入口                           ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    Web面板 ${YELLOW}${https_port}${NC} → 管理面板（直连）                    ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}  ${BOLD}访问地址：${NC}                                                    ${GREEN}║${NC}"
        echo -e "${GREEN}║${NC}    🌐 主站:     ${CYAN}http://<服务器IP>:${gw_port}${NC}"
        echo -e "${GREEN}║${NC}    🔧 管理面板: ${CYAN}http://<服务器IP>:${https_port}${NC}"
    fi
    echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  ${BOLD}账号信息：${NC}                                                    ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}    容器用户: ${YELLOW}root${NC}（密码为您刚才设置的密码）            ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}    时区: ${YELLOW}${tz}${NC}                                          ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}  ${BOLD}💡 提示：${NC}                                                      ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}    访问 Web 管理面板可修改所有配置（端口/AI Key/平台等）   ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}    或运行: ${CYAN}./openclaw-docker.sh config${NC}                       ${GREEN}║${NC}"
    echo -e "${GREEN}║${NC}                                                                  ${GREEN}║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}"

    # WSL2提醒
    if is_wsl2; then
        if [ -n "$domain" ]; then
            show_wsl2_firewall_warning "$http_port" "$https_port"
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

    # 1. Root密码（唯一必填项）
    while true; do
        read -sp "$(echo -e "${YELLOW}设置容器 root 密码 (必填):${NC} ")" ROOT_PASS
        echo ""
        if [ -n "$ROOT_PASS" ]; then
            break
        fi
        error "密码不能为空"
    done

    # 默认配置值（尽量少问）
    GW_PORT=18789
    WEB_PORT=3000
    DOMAIN=""
    TZ_VAL="Asia/Shanghai"
    PICKED_PORT=""
    HTTP_PORT=0
    HTTPS_PORT=0

    echo ""
    echo -e "${BLUE}[INFO]${NC} 正在检测端口占用情况..."

    # Gateway 端口
    pick_port 18789 18790 "Gateway"
    GW_PORT="$PICKED_PORT"

    # HTTPS（可选）
    read -p "HTTPS域名（可选，留空=不启用HTTPS）: " DOMAIN

    CERT_MODE="letsencrypt"  # 默认证书模式

    if [ -n "$DOMAIN" ]; then
        pick_port 80 8080 "HTTP"
        HTTP_PORT="$PICKED_PORT"

        pick_port 8443 8444 "HTTPS"
        HTTPS_PORT="$PICKED_PORT"

        # 证书模式选择（参考 Windows Get-DeployConfig）
        echo ""
        echo -e "${BOLD}━━━ HTTPS 证书模式 ━━━${NC}"
        echo -e "  ${CYAN}[1]${NC} Let's Encrypt 自动证书（推荐，需域名解析到本机）"
        echo -e "  ${CYAN}[2]${NC} 内置自签证书（内网/测试用，浏览器会提示不安全）"
        local cert_choice=""
        read -t 15 -p "请选择 [1/2，默认1，15秒超时自动选择1]: " cert_choice 2>/dev/null || true
        echo ""
        if [ "$cert_choice" = "2" ]; then
            CERT_MODE="internal"
            info "将使用内置自签证书"
        else
            CERT_MODE="letsencrypt"
            info "将使用 Let's Encrypt 自动证书"
        fi

        # HTTPS 模式：80/443 对外；Gateway/Web 仅本机（通过 Caddy 反代访问）
        PORT_ARGS="-p ${HTTP_PORT}:80 -p ${HTTPS_PORT}:443 -p 127.0.0.1:${GW_PORT}:18789 -p 127.0.0.1:${WEB_PORT}:3000"
    else
        # 内网/直连模式：Gateway + Web 面板直接暴露
        pick_port 3000 3001 "Web管理面板"
        WEB_PORT="$PICKED_PORT"
        PORT_ARGS="-p ${GW_PORT}:18789 -p ${WEB_PORT}:3000"
    fi

    # 保存配置
    mkdir -p "$HOME_DIR/.openclaw"
    cat > "$CONFIG_FILE" << EOF
{
    "port": $GW_PORT,
    "web_port": $WEB_PORT,
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
        read -t 15 -p "请选择 [1/2，默认1，15秒超时自动选择1]: " fw_choice 2>/dev/null || true
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

            if [ -n "$DOMAIN" ]; then
                ufw allow "${HTTP_PORT}/tcp"
                ufw allow "${HTTPS_PORT}/tcp"
                success "ufw 将放行: 22/${HTTP_PORT}/${HTTPS_PORT}"
            else
                ufw allow "${GW_PORT}/tcp"
                ufw allow "${WEB_PORT}/tcp"
                success "ufw 将放行: 22/${GW_PORT}/${WEB_PORT}"
            fi

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

    # 创建容器
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
        --security-opt no-new-privileges \
        -v "$HOME_DIR:/root" \
        $PORT_ARGS \
        -e "TZ=$TZ_VAL" \
        -e "CERT_MODE=$CERT_MODE" \
        -e "DOMAIN=$DOMAIN" \
        --restart unless-stopped \
        "$IMAGE_NAME"

    # 启动并设密码
    docker start "$CONTAINER_NAME"
    sleep 2
    echo "root:${ROOT_PASS}" | docker exec -i "$CONTAINER_NAME" chpasswd
    success "容器已创建并启动"

    # 显示安装完成摘要
    if [ -n "$DOMAIN" ]; then
        show_install_summary "$GW_PORT" "$HTTP_PORT" "$HTTPS_PORT" "$DOMAIN" "$TZ_VAL"
    else
        show_install_summary "$GW_PORT" "$HTTP_PORT" "$WEB_PORT" "$DOMAIN" "$TZ_VAL"
    fi

    # 进入容器
    docker exec -it "$CONTAINER_NAME" bash -l
}

# 显示再次运行面板
show_running_panel() {
    DOMAIN=""
    if [ -f "$CONFIG_FILE" ]; then
        DOMAIN=$(jq -r '.domain // empty' "$CONFIG_FILE" 2>/dev/null)
    fi

    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}            ${BOLD}🐾 OpenClaw Pro v1.0${NC}                  ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}                                                  ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  状态: ${GREEN}● 运行中${NC}    容器: ${BOLD}$CONTAINER_NAME${NC}        ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}                                                  ${CYAN}║${NC}"
    if [ -n "$DOMAIN" ]; then
        HTTPS_PORT=$(jq -r '.https_port // 8443' "$CONFIG_FILE" 2>/dev/null)
        echo -e "${CYAN}║${NC}  🌐 Web管理: ${BLUE}https://${DOMAIN}:${HTTPS_PORT}${NC}"
        echo -e "${CYAN}║${NC}  📋 OpenClaw: ${BLUE}https://${DOMAIN}:${HTTPS_PORT}/gateway${NC}"
    else
        GW_PORT=$(jq -r '.port // 18789' "$CONFIG_FILE" 2>/dev/null)
        WEB_PORT=$(jq -r '.web_port // 3000' "$CONFIG_FILE" 2>/dev/null)
        echo -e "${CYAN}║${NC}  🌐 Web管理: ${BLUE}http://localhost:${WEB_PORT}${NC}              ${CYAN}║${NC}"
        echo -e "${CYAN}║${NC}  📋 OpenClaw: ${BLUE}http://localhost:${GW_PORT}${NC}           ${CYAN}║${NC}"
    fi
    echo -e "${CYAN}║${NC}                                                  ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  ${YELLOW}[C]${NC} 配置  ${YELLOW}[回车/10秒]${NC} 直接进入              ${CYAN}║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
    echo ""

    # 10秒倒计时
    read -t 10 -n 1 CHOICE 2>/dev/null || CHOICE=""
    echo ""

    if [[ "$CHOICE" == "c" || "$CHOICE" == "C" ]]; then
        cmd_config
    else
        docker exec -it "$CONTAINER_NAME" bash -l
    fi
}

# ---- 命令实现 ----

cmd_run() {
    ensure_docker
    ensure_jq
    ensure_image
    ensure_home

    # 检查容器状态
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        # 容器存在
        if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
            # 运行中
            show_running_panel
        else
            # 已停止
            info "容器已停止，正在启动..."
            docker start "$CONTAINER_NAME"
            success "容器已启动"
            sleep 2
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
            read -t 10 -p "请选择 [1/2，默认1，10秒超时自动选择1]: " choice 2>/dev/null || true
            echo ""
            if [ "$choice" = "2" ]; then
                local first_container
                first_container=$(echo "$stopped_containers" | head -1 | cut -d'|' -f1)
                info "启动容器 $first_container ..."
                docker start "$first_container"
                success "容器已启动"
                sleep 2
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
            success "密码已修改"
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

cmd_logs() {
    docker logs --tail 100 -f "$CONTAINER_NAME"
}

# ---- 主入口 ----
case "${1:-run}" in
    run)     cmd_run ;;
    stop)    cmd_stop ;;
    status)  cmd_status ;;
    config)  cmd_config ;;
    shell)   cmd_shell ;;
    rebuild) cmd_rebuild ;;
    logs)    cmd_logs ;;
    *)
        echo -e "${BOLD}用法:${NC} $0 {run|stop|status|config|shell|rebuild|logs}"
        echo ""
        echo "  run      启动容器（首次运行进入配置向导）"
        echo "  stop     停止容器"
        echo "  status   查看状态"
        echo "  config   修改配置"
        echo "  shell    进入容器终端"
        echo "  rebuild  重建镜像"
        echo "  logs     查看日志"
        exit 1
        ;;
esac
