#!/bin/bash
# ============================================================
# start-services.sh — 容器内入口脚本
# 启动 OpenClaw Gateway、Web管理面板、Caddy(可选)
# ============================================================

# 不使用 set -e，因为健康检查循环中的命令失败不应该终止容器

# ── dnsmasq 本地 DNS 缓存：让容器拥有独立的 DNS 解析能力 ──
echo "[start-services] Setting up dnsmasq local DNS cache..."

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

# 3) 启动 dnsmasq
dnsmasq --test 2>/dev/null && {
    dnsmasq
    echo "[start-services] dnsmasq started on 127.0.0.1:53"
} || {
    echo "[start-services] dnsmasq config error, skipping"
}

# 4) 将 resolv.conf 指向本地 dnsmasq
echo "nameserver 127.0.0.1" > /etc/resolv.conf

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
if ! nslookup google.com 127.0.0.1 > /dev/null 2>&1; then
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

    # 强制仅密钥登录：禁用 SSH 密码登录
    set_or_append "PermitRootLogin" "prohibit-password"
    set_or_append "PasswordAuthentication" "no"
    set_or_append "KbdInteractiveAuthentication" "no"
    set_or_append "ChallengeResponseAuthentication" "no"
    set_or_append "PubkeyAuthentication" "yes"
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

# 恢复用户安装的组件（从 post-install.json 清单）
if [ -f /opt/post-install-restore.sh ]; then
    echo "[start-services] Running post-install restore..."
    bash /opt/post-install-restore.sh restore
fi

GATEWAY_PID=""
BROWSER_ENABLED="false"
CERT_MODE="letsencrypt"
NOVNC_PID=""
CHROME_PID=""
CADDY_PID=""

HAS_OPENCLAW="false"
if command -v openclaw >/dev/null 2>&1; then
    HAS_OPENCLAW="true"
fi

start_gateway() {
    if [ "$HAS_OPENCLAW" != "true" ]; then
        echo "[start-services] openclaw CLI not installed, skipping Gateway"
        return 0
    fi
    echo "[start-services] Starting OpenClaw Gateway (foreground mode)..."
    nohup openclaw gateway run --allow-unconfigured >> "$LOG_DIR/gateway.log" 2>&1 &
    GATEWAY_PID=$!
}

gateway_is_healthy() {
    # 优先用健康检查接口判断（进程存在但卡死也能识别）
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/health 2>/dev/null)
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

# --- 1. 启动 OpenClaw Gateway ---
start_gateway
# 等待 gateway 实际就绪
for i in 1 2 3 4 5 6 7 8 9 10; do
    if gateway_is_healthy; then
        echo "[start-services] Gateway started (attempt $i)"
        break
    fi
    sleep 2
done

# --- 2. 启动 Web 管理面板 ---
echo "[start-services] Starting Web management panel on port 3000..."
cd /opt/openclaw-web
node server.js >> "$LOG_DIR/web-panel.log" 2>&1 &
WEB_PID=$!
echo "[start-services] Web panel PID: $WEB_PID"

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

        # IP 地址需要加 https:// 前缀，Caddy 才会为其启用 HTTPS
        GLOBAL_OPTIONS=""
        if echo "$DOMAIN" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
            GLOBAL_OPTIONS=$(printf '{\n    default_sni %s\n}' "$DOMAIN")
            DOMAIN="https://$DOMAIN"
            CERT_MODE="internal"  # IP 地址只能使用自签证书
            echo "[start-services] IP address detected, using https:// prefix with default_sni"
        fi

        export DOMAIN
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
        envsubst '${DOMAIN} ${GLOBAL_OPTIONS} ${TLS_BLOCK}' \
            < /etc/caddy/Caddyfile.template > /tmp/Caddyfile

        # 验证渲染结果非空
        if [ ! -s /tmp/Caddyfile ]; then
            echo "[start-services] ERROR: Caddyfile is empty after envsubst!"
            echo "[start-services] Template content:"
            cat /etc/caddy/Caddyfile.template >> "$LOG_DIR/caddy.log" 2>&1
            echo "[start-services] Env: DOMAIN=$DOMAIN GLOBAL_OPTIONS=$GLOBAL_OPTIONS TLS_BLOCK=$TLS_BLOCK"
            # 直接用 sed 做变量替换作为兜底
            echo "[start-services] Falling back to sed-based substitution..."
            sed -e "s|\${DOMAIN}|${DOMAIN}|g" \
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
    sleep 30

    # 检查 Gateway（仅在 openclaw 已安装时）
    if [ "$HAS_OPENCLAW" = "true" ] && ! gateway_is_healthy; then
        echo "[health] WARNING: Gateway process not found, restarting..."
        start_gateway
    fi

    # 检查 Web 面板
    if ! kill -0 $WEB_PID 2>/dev/null; then
        echo "[health] WARNING: Web panel died, restarting..."
        cd /opt/openclaw-web
        node server.js >> "$LOG_DIR/web-panel.log" 2>&1 &
        WEB_PID=$!
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
