#!/bin/bash
# ============================================================
# start-services.sh — 容器内入口脚本
# 启动 OpenClaw Gateway、Web管理面板、Caddy(可选)
# ============================================================

# 不使用 set -e，因为健康检查循环中的命令失败不应该终止容器

# ── dnsmasq 本地 DNS 缓存：让容器拥有独立的 DNS 解析能力 ──
echo "[start-services] Setting up dnsmasq local DNS cache..."

DNSMASQ_OK="false"
RESOLV_BACKUP="/tmp/openclaw-resolv.conf.bak"
cp /etc/resolv.conf "$RESOLV_BACKUP" 2>/dev/null || true

# 1) 从当前 resolv.conf 提取原始上游 DNS（Docker 分配的 nameserver）
ORIG_NS=$(grep '^nameserver' /etc/resolv.conf 2>/dev/null | awk '{print $2}' | head -3)

# 2) 写 dnsmasq 配置
cat > /etc/dnsmasq.conf << 'DNSMASQ_CONF'
# OpenClaw dnsmasq config — 本地 DNS 缓存 + 多上游
listen-address=127.0.0.1
bind-interfaces
no-resolv
cache-size=2000
no-negcache
dns-forward-max=150
min-cache-ttl=300
DNSMASQ_CONF

# 添加原始上游 DNS（通常是 Docker Desktop 的 192.168.65.7）
for ns in $ORIG_NS; do
    echo "server=$ns" >> /etc/dnsmasq.conf
done
# 添加公共 DNS 作为后备
echo "server=8.8.8.8" >> /etc/dnsmasq.conf
echo "server=8.8.4.4" >> /etc/dnsmasq.conf
echo "server=1.1.1.1" >> /etc/dnsmasq.conf

# 3) 启动 dnsmasq（必须确认真实启动成功）
if command -v dnsmasq >/dev/null 2>&1 && dnsmasq --test >/dev/null 2>&1; then
    pkill -x dnsmasq >/dev/null 2>&1 || true
    dnsmasq >/tmp/openclaw-dnsmasq.err 2>&1 || true
    sleep 0.2
    if pgrep -x dnsmasq >/dev/null 2>&1; then
        DNSMASQ_OK="true"
        echo "[start-services] dnsmasq started on 127.0.0.1:53"
    else
        echo "[start-services] dnsmasq failed to start, fallback to direct DNS"
        if [ -s /tmp/openclaw-dnsmasq.err ]; then
            echo "[start-services] dnsmasq error: $(tail -1 /tmp/openclaw-dnsmasq.err)"
        fi
    fi
else
    echo "[start-services] dnsmasq unavailable or config invalid, fallback to direct DNS"
fi

# 4) 仅在 dnsmasq 可用时将 resolv.conf 指向本地 DNS
if [ "$DNSMASQ_OK" = "true" ]; then
    echo "nameserver 127.0.0.1" > /etc/resolv.conf
else
    if [ -s "$RESOLV_BACKUP" ]; then
        cp "$RESOLV_BACKUP" /etc/resolv.conf 2>/dev/null || true
    fi
    if ! grep -q '^nameserver ' /etc/resolv.conf 2>/dev/null; then
        {
            echo "nameserver 1.1.1.1"
            echo "nameserver 8.8.8.8"
            echo "nameserver 8.8.4.4"
        } > /etc/resolv.conf
    fi
fi

# ── DNS 保障：确保容器能解析外部域名 ──
# DNS-over-HTTPS 解析函数：通过 HTTPS 查询 Cloudflare DoH（绕过传统 DNS）
doh_resolve() {
    local domain="$1"
    local ip
    ip=$(curl -sf --connect-timeout 5 -H 'accept: application/dns-json' \
        "https://1.1.1.1/dns-query?name=${domain}&type=A" 2>/dev/null \
        | sed -n 's/.*"data":"\([0-9.]*\)".*/\1/p' | head -1)
    [ -n "$ip" ] && echo "$ip"
}

# 向 /etc/hosts 添加域名解析（如果尚未存在）
add_host_entry() {
    local ip="$1" domain="$2"
    if [ -n "$ip" ] && ! grep -q "$domain" /etc/hosts 2>/dev/null; then
        echo "$ip $domain" >> /etc/hosts
        echo "[start-services] DNS: $domain -> $ip"
    fi
}

# 始终预写 GitHub 域名到 /etc/hosts（避免 V2RayN TUN 延迟接管导致 Node.js fetch 失败）
echo "[start-services] Pre-resolving GitHub domains to /etc/hosts..."
PREWRITE_DOMAINS="github.com api.github.com raw.githubusercontent.com objects.githubusercontent.com"
prewrite_ok=0

for domain in $PREWRITE_DOMAINS; do
    # 优先用 nslookup（如果 DNS 当前可用）
    resolved_ip=$(nslookup "$domain" 2>/dev/null | awk '/^Address: / && !/#/ {print $2; exit}')
    # 降级用 DoH
    if [ -z "$resolved_ip" ]; then
        resolved_ip=$(doh_resolve "$domain")
    fi
    if [ -n "$resolved_ip" ]; then
        add_host_entry "$resolved_ip" "$domain"
        prewrite_ok=$((prewrite_ok + 1))
    fi
done

# 如果都没解析到，用静态 IP 兜底
if [ $prewrite_ok -eq 0 ]; then
    echo "[start-services] All DNS methods failed, using static GitHub IPs"
    grep -q "raw.githubusercontent.com" /etc/hosts 2>/dev/null || cat >> /etc/hosts << 'DNSEOF'
# GitHub hosts fallback (static IPs)
185.199.108.133 raw.githubusercontent.com
185.199.109.133 raw.githubusercontent.com
140.82.114.3 github.com
140.82.114.3 api.github.com
DNSEOF
else
    echo "[start-services] Pre-resolved $prewrite_ok domains"
fi

# DNS nameserver 保障（通过 dnsmasq 测试，如果 dnsmasq 也不行则直连公共 DNS）
if [ "$DNSMASQ_OK" = "true" ] && ! nslookup google.com 127.0.0.1 > /dev/null 2>&1; then
    echo "[start-services] dnsmasq upstream unreachable, adding direct public DNS as fallback"
    # 在 dnsmasq 后面追加直连 DNS，作为最后兜底
    echo "nameserver 8.8.8.8" >> /etc/resolv.conf
    echo "nameserver 8.8.4.4" >> /etc/resolv.conf
fi

CONFIG_FILE="/root/.openclaw/docker-config.json"
LOG_DIR="/root/.openclaw/logs"
mkdir -p "$LOG_DIR" /root/.openclaw

# ── 首次启动：补全被卷挂载覆盖的默认 shell 配置 ──
for f in .bashrc .profile .bash_logout; do
    if [ ! -f "/root/$f" ] && [ -f "/etc/skel/$f" ]; then
        cp "/etc/skel/$f" "/root/$f"
        echo "[start-services] Copied default $f to /root/"
    fi
done

# ── 创建普通用户（从环境变量 HOST_USER 获取宿主机用户名）──
# 持久化目录：/root/.openclaw/users/ 保存用户创建状态
USERS_PERSIST_DIR="/root/.openclaw/users"
mkdir -p "$USERS_PERSIST_DIR"

HOST_USER="${HOST_USER:-}"
HOST_UID="${HOST_UID:-}"
HOST_GID="${HOST_GID:-}"
SSH_USER=""

create_host_user() {
    local username="$1"
    local uid="$2"
    local gid="$3"

    [ -z "$username" ] && return 1

    # 验证用户名合法性
    if ! [[ "$username" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
        echo "[start-services] Invalid username: $username, skipping user creation"
        return 1
    fi

    # 检查用户是否已存在
    if id -u "$username" >/dev/null 2>&1; then
        echo "[start-services] User $username already exists"
        SSH_USER="$username"
        return 0
    fi

    echo "[start-services] Creating user: $username"

    # 创建用户
    if [ -n "$uid" ] && [ -n "$gid" ]; then
        # 创建与宿主机 UID/GID 一致的用户
        # 先创建组
        if ! getent group "$gid" >/dev/null 2>&1; then
            groupadd -g "$gid" "$username" 2>/dev/null || groupadd -g "$gid" "oc_$username" 2>/dev/null || true
        fi
        # 再创建用户
        useradd -m -u "$uid" -g "$gid" -s /bin/bash "$username" 2>/dev/null || \
            useradd -m -u "$uid" -g "$gid" -s /bin/bash -d "/home/$username" "$username" 2>/dev/null || \
            useradd -m -s /bin/bash "$username" 2>/dev/null || true
    else
        # 使用系统自动分配 UID/GID
        useradd -m -s /bin/bash "$username" 2>/dev/null || \
            adduser --disabled-password --gecos '' "$username" 2>/dev/null || true
    fi

    # 确保用户创建成功
    if ! id -u "$username" >/dev/null 2>&1; then
        echo "[start-services] Failed to create user $username"
        return 1
    fi

    # 添加到 sudo 组并配置免密 sudo
    usermod -aG sudo "$username" 2>/dev/null || true
    echo "$username ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-openclaw-$username"
    chmod 440 "/etc/sudoers.d/90-openclaw-$username"

    # 创建用户 .ssh 目录
    local user_home
    user_home=$(getent passwd "$username" | cut -d: -f6)
    mkdir -p "$user_home/.ssh"
    chmod 700 "$user_home/.ssh"
    chown -R "$username:$username" "$user_home/.ssh"

    # 复制默认 shell 配置
    for f in .bashrc .profile .bash_logout; do
        if [ ! -f "$user_home/$f" ] && [ -f "/etc/skel/$f" ]; then
            cp "/etc/skel/$f" "$user_home/$f"
            chown "$username:$username" "$user_home/$f"
        fi
    done

    SSH_USER="$username"
    echo "[start-services] User $username created successfully (sudo enabled)"
    echo "$username" > "$USERS_PERSIST_DIR/ssh_user"
    return 0
}

# 尝试创建普通用户
if [ -n "$HOST_USER" ] && [ "$HOST_USER" != "root" ]; then
    create_host_user "$HOST_USER" "$HOST_UID" "$HOST_GID"
fi

# 如果用户创建失败或未提供，尝试从持久化状态恢复
if [ -z "$SSH_USER" ] && [ -f "$USERS_PERSIST_DIR/ssh_user" ]; then
    saved_user=$(cat "$USERS_PERSIST_DIR/ssh_user" 2>/dev/null | head -1)
    if [ -n "$saved_user" ] && id -u "$saved_user" >/dev/null 2>&1; then
        SSH_USER="$saved_user"
        echo "[start-services] Restored SSH user from persistent state: $SSH_USER"
    fi
fi

# ── SSH 持久化：host keys 和 sshd_config 保存到 /root/.openclaw/ssh/ ──
SSH_PERSIST_DIR="/root/.openclaw/ssh"
mkdir -p "$SSH_PERSIST_DIR"

harden_sshd_config() {
    local cfg="/etc/ssh/sshd_config"
    [ -f "$cfg" ] || return 0

    set_or_append() {
        local key="$1"
        local value="$2"
        if grep -Eq "^[#[:space:]]*${key}[[:space:]]+" "$cfg"; then
            sed -i -E "s|^[#[:space:]]*${key}[[:space:]]+.*|${key} ${value}|" "$cfg"
        else
            printf "\n%s %s\n" "$key" "$value" >> "$cfg"
        fi
    }

    # SSH 安全配置：禁用密码登录，仅密钥认证
    # 如果有普通用户，禁用 root 登录；否则允许 root 密钥登录
    if [ -n "$SSH_USER" ]; then
        set_or_append "PermitRootLogin" "no"
    else
        set_or_append "PermitRootLogin" "prohibit-password"
    fi
    set_or_append "PasswordAuthentication" "no"
    set_or_append "KbdInteractiveAuthentication" "no"
    set_or_append "ChallengeResponseAuthentication" "no"
    set_or_append "PubkeyAuthentication" "yes"

    # 如果有普通用户，配置 AllowUsers 只允许该用户 SSH 登录
    if [ -n "$SSH_USER" ]; then
        # 移除旧的 AllowUsers 配置
        sed -i '/^AllowUsers/d' "$cfg" 2>/dev/null || true
        sed -i '/^# *AllowUsers/d' "$cfg" 2>/dev/null || true
        # 添加新的 AllowUsers
        echo "AllowUsers $SSH_USER" >> "$cfg"
    fi
}

if [ -f "$SSH_PERSIST_DIR/sshd_config" ]; then
    # 恢复持久化的 SSH 配置和 host keys
    cp "$SSH_PERSIST_DIR"/ssh_host_* /etc/ssh/ 2>/dev/null
    cp "$SSH_PERSIST_DIR/sshd_config" /etc/ssh/sshd_config
    harden_sshd_config
    cp /etc/ssh/sshd_config "$SSH_PERSIST_DIR/sshd_config"
    echo "[start-services] Restored SSH host keys and config from persistent storage"
else
    # 首次：生成 host keys（如未生成），并保存
    ssh-keygen -A 2>/dev/null
    cp /etc/ssh/ssh_host_* "$SSH_PERSIST_DIR/" 2>/dev/null
    harden_sshd_config
    cp /etc/ssh/sshd_config "$SSH_PERSIST_DIR/sshd_config"
    echo "[start-services] Generated and persisted SSH host keys"
fi

# 显示 SSH 登录信息
if [ -n "$SSH_USER" ]; then
    echo "[start-services] SSH configured for user: $SSH_USER (root login disabled)"
else
    echo "[start-services] SSH configured for root (key-only auth)"
fi

# 启动 sshd
mkdir -p /run/sshd
/usr/sbin/sshd 2>/dev/null
if [ $? -eq 0 ]; then
    echo "[start-services] sshd started (port 22)"
else
    echo "[start-services] sshd failed to start (non-critical, continuing)"
fi

# ── 初始化持久化环境 + 恢复用户安装的组件 ──
# Python venv
if [ ! -f "/root/.venv/bin/python3" ]; then
    echo "[start-services] Initializing Python venv at /root/.venv ..."
    python3 -m venv /root/.venv 2>/dev/null && \
        /root/.venv/bin/pip install --upgrade pip -q 2>/dev/null || true
fi

# npm global prefix
if [ ! -d "/root/.npm-global" ]; then
    mkdir -p /root/.npm-global
    npm config set prefix /root/.npm-global 2>/dev/null || true
fi

# Ensure npm global bin is in PATH for non-login shell (PID 1)
if [[ ":$PATH:" != *":/root/.npm-global/bin:"* ]]; then
    export PATH="$PATH:/root/.npm-global/bin"
fi

# 恢复用户安装的组件（从 post-install.json 清单）
if [ -f /opt/post-install-restore.sh ]; then
    echo "[start-services] Running post-install restore..."
    bash /opt/post-install-restore.sh restore
fi

GATEWAY_PID=""
GATEWAY_WATCHDOG_PID=""
BROWSER_ENABLED="false"
CERT_MODE="letsencrypt"
NOVNC_PID=""
CHROME_PID=""
CADDY_PID=""
GATEWAY_WATCHDOG_SCRIPT="/usr/local/bin/openclaw-gateway-watchdog.sh"
OPENCLAW_RUNTIME_JS="/opt/openclaw-runtime/node_modules/openclaw/openclaw.mjs"

has_openclaw_cli() {
    command -v openclaw >/dev/null 2>&1 || [ -x "/root/.npm-global/bin/openclaw" ] || [ -x "/usr/local/bin/openclaw" ] || { command -v node >/dev/null 2>&1 && [ -f "$OPENCLAW_RUNTIME_JS" ]; }
}

refresh_openclaw_availability() {
    if has_openclaw_cli; then
        HAS_OPENCLAW="true"
    else
        HAS_OPENCLAW="false"
    fi
}

HAS_OPENCLAW="false"
refresh_openclaw_availability

start_gateway() {
    refresh_openclaw_availability
    if [ "$HAS_OPENCLAW" != "true" ]; then
        echo "[start-services] openclaw CLI not installed, skipping Gateway"
        return 0
    fi
    echo "[start-services] Starting OpenClaw Gateway (foreground mode)..."
    if command -v node >/dev/null 2>&1 && [ -f "$OPENCLAW_RUNTIME_JS" ]; then
        nohup env HOME=/opt/openclaw-home node "$OPENCLAW_RUNTIME_JS" gateway run --allow-unconfigured --force >> "$LOG_DIR/gateway.log" 2>&1 &
    else
        nohup openclaw gateway run --allow-unconfigured --force >> "$LOG_DIR/gateway.log" 2>&1 &
    fi
    GATEWAY_PID=$!
}

start_gateway_watchdog() {
    if [ ! -x "$GATEWAY_WATCHDOG_SCRIPT" ]; then
        echo "[start-services] watchdog script missing ($GATEWAY_WATCHDOG_SCRIPT), fallback to direct gateway start"
        start_gateway
        return 0
    fi

    if pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1; then
        echo "[start-services] Gateway watchdog already running"
        return 0
    fi

    echo "[start-services] Starting Gateway watchdog..."
    nohup bash "$GATEWAY_WATCHDOG_SCRIPT" >> "$LOG_DIR/gateway-watchdog.log" 2>&1 &
    GATEWAY_WATCHDOG_PID=$!
    echo "[start-services] Gateway watchdog PID: $GATEWAY_WATCHDOG_PID"
}

ensure_gateway_watchdog_running() {
    if pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1; then
        return 0
    fi

    echo "[start-services] WARNING: watchdog process not detected, trying to start now..."
    start_gateway_watchdog
    sleep 1

    if pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1; then
        local wd_pid
        wd_pid=$(pgrep -f "[o]penclaw-gateway-watchdog.sh" | head -1)
        echo "[start-services] watchdog recovered, pid=$wd_pid"
        return 0
    fi

    echo "[start-services] ERROR: watchdog still not running after retry"
    if [ ! -f "$GATEWAY_WATCHDOG_SCRIPT" ]; then
        echo "[start-services] reason: watchdog script file not found ($GATEWAY_WATCHDOG_SCRIPT)"
    elif [ ! -x "$GATEWAY_WATCHDOG_SCRIPT" ]; then
        echo "[start-services] reason: watchdog script is not executable ($GATEWAY_WATCHDOG_SCRIPT)"
    fi

    if [ -f "$LOG_DIR/gateway-watchdog.log" ]; then
        echo "[start-services] watchdog last log lines:"
        tail -n 15 "$LOG_DIR/gateway-watchdog.log" 2>/dev/null | sed 's/^/[start-services]   /'
    else
        echo "[start-services] reason: watchdog log file not found ($LOG_DIR/gateway-watchdog.log)"
    fi

    return 1
}

start_web_panel() {
    echo "[start-services] Starting Web management panel on port 3000..."
    cd /opt/openclaw-web || {
        echo "[start-services] ERROR: /opt/openclaw-web not found"
        return 1
    }
    nohup node server.js >> "$LOG_DIR/web-panel.log" 2>&1 &
    WEB_PID=$!
    echo "[start-services] Web panel PID: $WEB_PID"
    return 0
}

web_is_healthy() {
    local web_code
    web_code=$(curl -sS --connect-timeout 2 --max-time 4 -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null)
    if [ "$web_code" = "200" ] || [ "$web_code" = "302" ] || [ "$web_code" = "401" ]; then
        return 0
    fi
    return 1
}

gateway_is_healthy() {
    # 优先用健康检查接口判断（进程存在但卡死也能识别）
    local code
    code=$(curl -sS --connect-timeout 2 --max-time 4 -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/health 2>/dev/null)
    if [ "$code" = "200" ] || [ "$code" = "401" ] || [ "$code" = "403" ]; then
        return 0
    fi

    # 回退到进程检查（避免健康接口短暂不可用导致误判）
    if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
        return 0
    fi
    pgrep -f "[o]penclaw.*gateway" > /dev/null 2>&1
}

if [ -f "$CONFIG_FILE" ]; then
    raw_browser_enabled=$(jq -r '.browserEnabled // "false"' "$CONFIG_FILE" 2>/dev/null)
    raw_cert_mode=$(jq -r '.cert_mode // "letsencrypt"' "$CONFIG_FILE" 2>/dev/null)
    if [ "$raw_browser_enabled" = "true" ]; then
        BROWSER_ENABLED="true"
    fi
    if [ "$raw_cert_mode" = "internal" ]; then
        CERT_MODE="internal"
    fi
fi

echo "[start-services] Starting OpenClaw services..."

# --- 1. 启动 Gateway Watchdog（由 watchdog 管理 Gateway 生命周期） ---
start_gateway_watchdog
ensure_gateway_watchdog_running || echo "[start-services] WARNING: watchdog hard fallback failed; health loop will retry"
# 等待 gateway 实际就绪
for i in 1 2 3 4 5 6 7 8 9 10; do
    if gateway_is_healthy; then
        echo "[start-services] Gateway started (attempt $i)"
        break
    fi
    sleep 2
done

# --- 2. 启动 Web 管理面板 ---
start_web_panel

# 等待 Web 面板就绪（仅用于日志诊断，不阻塞启动）
for i in 1 2 3 4 5 6 7 8 9 10; do
    web_code=$(curl -sS --connect-timeout 2 --max-time 4 -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null)
    if [ "$web_code" = "200" ] || [ "$web_code" = "302" ] || [ "$web_code" = "401" ]; then
        echo "[start-services] Web panel healthy (attempt $i, code=$web_code)"
        break
    fi
    [ "$i" = "10" ] && echo "[start-services] Web panel not ready yet (last code=${web_code:-none}), continue in background"
    sleep 1
done

# --- 3. 启动浏览器服务（可选） ---
if [ "$BROWSER_ENABLED" = "true" ]; then
    echo "[start-services] Browser enabled: starting noVNC/Chromium..."
    Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
    sleep 1
    x11vnc -display :99 -nopw -listen 127.0.0.1 -forever -shared -bg -o "$LOG_DIR/x11vnc.log"

    # 找到 noVNC web 目录
    NOVNC_DIR="/usr/share/novnc"
    [ -d "$NOVNC_DIR" ] || NOVNC_DIR="/usr/share/javascript/novnc"

    websockify --web "$NOVNC_DIR" 6080 127.0.0.1:5900 >> "$LOG_DIR/novnc.log" 2>&1 &
    NOVNC_PID=$!
    echo "[start-services] noVNC PID: $NOVNC_PID (port 6080)"

    # 启动 Chromium（Cookie 持久化到 /root/.chromium-data）
    CHROME_BIN=$(which chromium-browser 2>/dev/null || which chromium 2>/dev/null || which google-chrome-stable 2>/dev/null || echo "chromium-browser")
    DISPLAY=:99 "$CHROME_BIN" --no-sandbox --disable-gpu --disable-dev-shm-usage --window-size=1280,720 --user-data-dir=/root/.chromium-data "about:blank" >> "$LOG_DIR/chromium.log" 2>&1 &
    CHROME_PID=$!
    echo "[start-services] Chromium PID: $CHROME_PID"
else
    echo "[start-services] Browser disabled by config (browserEnabled=false), skipping noVNC/Chromium"
fi

# --- 4. 启动 Caddy (如果配置了HTTPS) ---
if [ -f "$CONFIG_FILE" ]; then
    DOMAIN=$(jq -r '.domain // empty' "$CONFIG_FILE" 2>/dev/null)
    AUTH_USER=$(jq -r '.auth_user // empty' "$CONFIG_FILE" 2>/dev/null)
    AUTH_HASH=$(jq -r '.auth_hash // empty' "$CONFIG_FILE" 2>/dev/null)

    if [ -n "$DOMAIN" ]; then
        echo "[start-services] HTTPS domain configured: $DOMAIN"
        echo "[start-services] Certificate mode: $CERT_MODE"

        DOMAIN_HTTP="$DOMAIN"

        # IP 地址需要加 https:// 前缀，Caddy 才会为其启用 HTTPS
        GLOBAL_OPTIONS=""
        if echo "$DOMAIN" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
            GLOBAL_OPTIONS=$(printf '{\n    default_sni %s\n}' "$DOMAIN")
            DOMAIN="https://$DOMAIN"
            CERT_MODE="internal"  # IP 地址只能使用自签证书
            echo "[start-services] IP address detected, using https:// prefix with default_sni"
        fi

        export DOMAIN
        export DOMAIN_HTTP
        export GLOBAL_OPTIONS
        if [ "$CERT_MODE" = "internal" ]; then
            TLS_BLOCK="tls internal"
            export TLS_BLOCK
            echo "[start-services] Using self-signed certificate (Caddy Internal CA)"
        else
            TLS_BLOCK=""
            export TLS_BLOCK
            echo "[start-services] Using Let's Encrypt certificate"
        fi
        # 只替换我们定义的三个变量，避免 envsubst 误替换模板中的其他 $ 符号
        envsubst '${DOMAIN} ${DOMAIN_HTTP} ${GLOBAL_OPTIONS} ${TLS_BLOCK}' \
            < /etc/caddy/Caddyfile.template > /tmp/Caddyfile

        # 验证渲染结果非空
        if [ ! -s /tmp/Caddyfile ]; then
            echo "[start-services] ERROR: Caddyfile is empty after envsubst!"
            echo "[start-services] Template content:"
            cat /etc/caddy/Caddyfile.template >> "$LOG_DIR/caddy.log" 2>&1
            echo "[start-services] Env: DOMAIN=$DOMAIN DOMAIN_HTTP=$DOMAIN_HTTP GLOBAL_OPTIONS=$GLOBAL_OPTIONS TLS_BLOCK=$TLS_BLOCK"
            # 直接用 sed 做变量替换作为兜底
            echo "[start-services] Falling back to sed-based substitution..."
            sed -e "s|\${DOMAIN}|${DOMAIN}|g" \
                -e "s|\${DOMAIN_HTTP}|${DOMAIN_HTTP}|g" \
                -e "s|\${TLS_BLOCK}|${TLS_BLOCK}|g" \
                -e "s|\${GLOBAL_OPTIONS}|${GLOBAL_OPTIONS}|g" \
                /etc/caddy/Caddyfile.template > /tmp/Caddyfile
        fi

        if [ -s /tmp/Caddyfile ]; then
            echo "[start-services] Caddyfile rendered OK ($(wc -c < /tmp/Caddyfile) bytes)"
            caddy run --config /tmp/Caddyfile >> "$LOG_DIR/caddy.log" 2>&1 &
            CADDY_PID=$!
            echo "[start-services] Caddy PID: $CADDY_PID"
        else
            echo "[start-services] ERROR: Caddyfile still empty, Caddy not started"
        fi
    fi
fi

echo "[start-services] All services started."

# --- 4. 健康检查循环 ---
while true; do
    sleep 10

    refresh_openclaw_availability

    # 检查 Gateway watchdog（始终保持 watchdog 进程在线）
    if ! pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1; then
        echo "[health] WARNING: Gateway watchdog not found, restarting watchdog..."
        ensure_gateway_watchdog_running || true
    fi

    if [ "$HAS_OPENCLAW" != "true" ]; then
        echo "[health] INFO: openclaw CLI not found yet; watchdog is running and will retry"
    fi

    # 检查 Web 面板
    if ! web_is_healthy; then
        echo "[health] WARNING: Web panel unhealthy or down, restarting..."
        if [ -n "${WEB_PID:-}" ]; then
            kill -9 "$WEB_PID" 2>/dev/null || true
        fi
        pkill -f "node server.js" 2>/dev/null || true
        start_web_panel
    fi

    # 检查 Caddy
    if [ -n "$CADDY_PID" ] && ! kill -0 $CADDY_PID 2>/dev/null; then
        echo "[health] WARNING: Caddy died, restarting..."
        caddy run --config /tmp/Caddyfile >> "$LOG_DIR/caddy.log" 2>&1 &
        CADDY_PID=$!
    fi

    # 检查 noVNC
    if [ "$BROWSER_ENABLED" = "true" ] && [ -n "${NOVNC_PID:-}" ] && ! kill -0 $NOVNC_PID 2>/dev/null; then
        echo "[health] WARNING: noVNC died, restarting..."
        websockify --web "$NOVNC_DIR" 6080 127.0.0.1:5900 >> "$LOG_DIR/novnc.log" 2>&1 &
        NOVNC_PID=$!
    fi

    # 检查 Chromium
    if [ "$BROWSER_ENABLED" = "true" ] && [ -n "${CHROME_PID:-}" ] && ! kill -0 $CHROME_PID 2>/dev/null; then
        echo "[health] WARNING: Chromium died, restarting..."
        DISPLAY=:99 "$CHROME_BIN" --no-sandbox --disable-gpu --disable-dev-shm-usage --window-size=1280,720 --user-data-dir=/root/.chromium-data "about:blank" >> "$LOG_DIR/chromium.log" 2>&1 &
        CHROME_PID=$!
    fi
done
