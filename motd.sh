#!/bin/bash
# ============================================================
# motd.sh — 容器登录欢迎界面（精简版）
# 每次 bash -l 进入时显示简洁状态摘要
# ============================================================

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

CONFIG_FILE="/root/.openclaw/docker-config.json"
CURRENT_USER=$(whoami)

# 记录登录
mkdir -p "$HOME/.openclaw/logs"
echo "$(date '+%Y-%m-%d %H:%M:%S') | 用户: $CURRENT_USER | IP: ${SSH_CLIENT%% *}" >> "$HOME/.openclaw/logs/login.log" 2>/dev/null

# 简洁状态检测
_ok() { printf "${GREEN}●${NC}"; }
_off() { printf "${RED}●${NC}"; }
gw_s=$( (pgrep -f "openclaw-gatewa|openclaw\\.mjs gateway|openclaw .*gateway run" | grep -qv $$ 2>/dev/null || curl --noproxy '*' -sf --connect-timeout 1 --max-time 2 http://127.0.0.1:18789/health >/dev/null 2>&1) && _ok || _off )
web_s=$( (pgrep -f "node.*server\.js" | grep -qv $$ 2>/dev/null || curl -sf --connect-timeout 1 --max-time 2 http://127.0.0.1:3000/ >/dev/null 2>&1) && _ok || _off )

# 读取配置
_cfg_exists() { if [ "$CURRENT_USER" = "root" ]; then [ -f "$1" ]; else sudo test -f "$1" 2>/dev/null; fi; }
WEB_PORT=3000; HTTPS_PORT=8443
DOMAIN=""
if _cfg_exists "$CONFIG_FILE"; then
    CFG=$(if [ "$CURRENT_USER" = "root" ]; then cat "$CONFIG_FILE"; else sudo cat "$CONFIG_FILE" 2>/dev/null; fi)
    WEB_PORT=$(echo "$CFG" | jq -r '.web_port // 3000' 2>/dev/null)
    HTTPS_PORT=$(echo "$CFG" | jq -r '.https_port // 8443' 2>/dev/null)
    DOMAIN=$(echo "$CFG" | jq -r '.domain // empty' 2>/dev/null)
fi

# 访问地址
if [ -n "$DOMAIN" ]; then
    URL="https://${DOMAIN}:${HTTPS_PORT}"
else
    URL="http://localhost:${WEB_PORT}"
fi

echo ""
echo -e "  ${BOLD}🐾 ClawNook${NC}  Gateway ${gw_s}  Web ${web_s}  ${BLUE}${URL}${NC}"
if [ "$CURRENT_USER" != "root" ]; then
    echo -e "  👤 ${CYAN}${CURRENT_USER}${NC}  提权: sudo -i"
fi
echo ""
