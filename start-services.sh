#!/bin/bash
# ============================================================
# start-services.sh — 容器内入口脚本
# 启动 OpenClaw Gateway、Web管理面板、Caddy(可选)
# ============================================================

# 不使用 set -e，因为健康检查循环中的命令失败不应该终止容器

CONFIG_FILE="/root/.openclaw/docker-config.json"
LOG_DIR="/root/.openclaw/logs"
mkdir -p "$LOG_DIR" /root/.openclaw

GATEWAY_PID=""
BROWSER_ENABLED="false"
CERT_MODE="letsencrypt"
NOVNC_PID=""
CHROME_PID=""
CADDY_PID=""

start_gateway() {
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
        export DOMAIN
        if [ "$CERT_MODE" = "internal" ]; then
            TLS_BLOCK="tls internal"
            export TLS_BLOCK
            echo "[start-services] Using self-signed certificate (Caddy Internal CA)"
        else
            TLS_BLOCK=""
            export TLS_BLOCK
            echo "[start-services] Using Let's Encrypt certificate"
        fi
        envsubst < /etc/caddy/Caddyfile.template > /tmp/Caddyfile
        caddy run --config /tmp/Caddyfile >> "$LOG_DIR/caddy.log" 2>&1 &
        CADDY_PID=$!
        echo "[start-services] Caddy PID: $CADDY_PID"
    fi
fi

echo "[start-services] All services started."

# --- 4. 健康检查循环 ---
while true; do
    sleep 30

    # 检查 Gateway
    if ! gateway_is_healthy; then
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
