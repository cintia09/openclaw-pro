#!/bin/bash
# ============================================================
# motd.sh — 容器登录欢迎界面
# 每次 bash -l 进入时显示状态和配置菜单
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

CONFIG_FILE="/root/.openclaw/docker-config.json"
LOGIN_LOG="/root/.openclaw/logs/login.log"
mkdir -p /root/.openclaw/logs

# 记录登录
echo "$(date '+%Y-%m-%d %H:%M:%S') | IP: ${SSH_CLIENT%% *} | TTY: $(tty)" >> "$LOGIN_LOG" 2>/dev/null

# 检查服务状态
check_service() {
    if pgrep -f "$1" | grep -qv $$ 2>/dev/null; then
        printf "${GREEN}● 在线${NC}"
    else
        printf "${RED}● 离线${NC}"
    fi
}

GATEWAY_STATUS=$(check_service "openclaw.*gateway")
WEB_STATUS=$(check_service "node.*server\.js")
CADDY_STATUS=$(check_service "caddy run")

# 读取配置
DOMAIN=""
if [ -f "$CONFIG_FILE" ]; then
    DOMAIN=$(jq -r '.domain // empty' "$CONFIG_FILE" 2>/dev/null)
fi

# 显示欢迎信息
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}            ${BOLD}🐾 OpenClaw Pro v1.0${NC}                  ${CYAN}║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════════╣${NC}"
printf "${CYAN}║${NC}  %-10s %b %28s ${CYAN}║${NC}\n" "Gateway:" "$GATEWAY_STATUS" ""
printf "${CYAN}║${NC}  %-10s %b %28s ${CYAN}║${NC}\n" "Web面板:" "$WEB_STATUS" ""
printf "${CYAN}║${NC}  %-10s %b %28s ${CYAN}║${NC}\n" "Caddy:" "$CADDY_STATUS" ""
echo -e "${CYAN}╠══════════════════════════════════════════════════╣${NC}"
if [ -f "$CONFIG_FILE" ]; then
    GW_PORT=$(jq -r '.port // 18789' "$CONFIG_FILE" 2>/dev/null)
    WEB_PORT=$(jq -r '.web_port // 3000' "$CONFIG_FILE" 2>/dev/null)
    HTTPS_PORT=$(jq -r '.https_port // 8443' "$CONFIG_FILE" 2>/dev/null)
else
    GW_PORT=18789
    WEB_PORT=3000
    HTTPS_PORT=8443
fi

if [ -n "$DOMAIN" ]; then
    echo -e "${CYAN}║${NC}  🌐 Web管理: ${BLUE}https://${DOMAIN}:${HTTPS_PORT}${NC}"
    echo -e "${CYAN}║${NC}  📋 Gateway: ${BLUE}https://${DOMAIN}:${HTTPS_PORT}/gateway${NC}"
else
    echo -e "${CYAN}║${NC}  🌐 Web管理: ${BLUE}http://localhost:${WEB_PORT}${NC}"
    echo -e "${CYAN}║${NC}  📋 Gateway: ${BLUE}http://localhost:${GW_PORT}${NC}"
fi
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# 交互式菜单（仅在交互终端）
if [ -t 0 ]; then
    echo -e "${YELLOW}[C]${NC} 配置菜单  ${YELLOW}[回车/10秒]${NC} 跳过"
    read -t 10 -n 1 CHOICE 2>/dev/null || CHOICE=""
    echo ""

    if [[ "$CHOICE" == "c" || "$CHOICE" == "C" ]]; then
        echo -e "\n${BOLD}━━━ 配置菜单 ━━━${NC}"
        echo -e "  ${CYAN}1.${NC} 修改root密码"
        echo -e "  ${CYAN}2.${NC} 修改Gateway端口"
        echo -e "  ${CYAN}3.${NC} 配置HTTPS域名"
        echo -e "  ${CYAN}4.${NC} AI Provider设置"
        echo -e "  ${CYAN}5.${NC} 交易系统配置"
        echo -e "  ${CYAN}0.${NC} 返回"
        echo ""
        read -p "选择 [0-5]: " MENU_CHOICE

        case "$MENU_CHOICE" in
            1)
                echo -e "${BLUE}修改root密码:${NC}"
                passwd root
                ;;
            2)
                read -p "新Gateway端口 [当前: $(jq -r '.port // 18789' "$CONFIG_FILE" 2>/dev/null)]: " NEW_PORT
                if [ -n "$NEW_PORT" ]; then
                    if ! [[ "$NEW_PORT" =~ ^[0-9]+$ ]] || [ "$NEW_PORT" -lt 1024 ] || [ "$NEW_PORT" -gt 65535 ]; then
                        echo -e "${RED}端口无效，需要 1024-65535 之间的数字${NC}"
                    else
                        jq ".port = $NEW_PORT" "$CONFIG_FILE" > /tmp/cfg.tmp && mv /tmp/cfg.tmp "$CONFIG_FILE"
                        echo -e "${GREEN}端口已更新为 $NEW_PORT，重启容器生效${NC}"
                    fi
                fi
                ;;
            3)
                read -p "HTTPS域名 [留空禁用]: " NEW_DOMAIN
                # 基本格式校验
                if [ -n "$NEW_DOMAIN" ] && ! echo "$NEW_DOMAIN" | grep -qP '^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$'; then
                    echo -e "${RED}域名格式无效${NC}"
                else
                    jq --arg d "$NEW_DOMAIN" '.domain = $d' "$CONFIG_FILE" > /tmp/cfg.tmp && mv /tmp/cfg.tmp "$CONFIG_FILE"
                    echo -e "${GREEN}域名已更新，重启容器生效${NC}"
                fi
                ;;
            4)
                echo -e "${BLUE}请通过Web管理面板配置AI Provider${NC}"
                ;;
            5)
                echo -e "${BLUE}请通过Web管理面板配置交易系统${NC}"
                ;;
            *)
                echo -e "${GREEN}已跳过${NC}"
                ;;
        esac
        echo ""
    fi
fi
