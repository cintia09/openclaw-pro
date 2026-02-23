#!/bin/bash
# ============================================================
# start-services.sh — 容器内入口脚本
# 启动 OpenClaw Gateway、Web管理面板、Caddy(可选)
# ============================================================

# 不使用 set -e，因为健康检查循环中的命令失败不应该终止容器

CONFIG_FILE="/root/.openclaw/docker-config.json"
LOG_DIR="/root/.openclaw/logs"
mkdir -p "$LOG_DIR" /root/.openclaw

echo "[start-services] Starting OpenClaw services..."

# --- 1. 启动 OpenClaw Gateway ---
echo "[start-services] Starting OpenClaw Gateway..."
openclaw gateway start >> "$LOG_DIR/gateway-start.log" 2>&1
# 等待 gateway 实际就绪
for i in 1 2 3 4 5; do
    if pgrep -f "openclaw.*gateway" > /dev/null 2>&1; then
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

# --- 3. 启动浏览器服务（noVNC） ---
echo "[start-services] Starting browser service (noVNC)..."
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

# --- 4. 启动 Caddy (如果配置了HTTPS) ---
if [ -f "$CONFIG_FILE" ]; then
    DOMAIN=$(jq -r '.domain // empty' "$CONFIG_FILE" 2>/dev/null)
    AUTH_USER=$(jq -r '.auth_user // empty' "$CONFIG_FILE" 2>/dev/null)
    AUTH_HASH=$(jq -r '.auth_hash // empty' "$CONFIG_FILE" 2>/dev/null)

    if [ -n "$DOMAIN" ]; then
        echo "[start-services] HTTPS domain configured: $DOMAIN"
        export DOMAIN
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
    if ! pgrep -f "openclaw.*gateway" > /dev/null 2>&1; then
        echo "[health] WARNING: Gateway process not found, restarting..."
        openclaw gateway start 2>&1 &
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
    if [ -n "${NOVNC_PID:-}" ] && ! kill -0 $NOVNC_PID 2>/dev/null; then
        echo "[health] WARNING: noVNC died, restarting..."
        websockify --web "$NOVNC_DIR" 6080 127.0.0.1:5900 >> "$LOG_DIR/novnc.log" 2>&1 &
        NOVNC_PID=$!
    fi
done
