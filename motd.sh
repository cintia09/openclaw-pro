#!/bin/bash
# ============================================================
# motd.sh — 容器登录欢迎界面
# 每次 bash -l 进入时显示状态和配置菜单
# 支持 root 和普通用户登录
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# 系统配置文件（由 root 管理）
CONFIG_FILE="/root/.openclaw/docker-config.json"
# 用户登录日志（放在用户目录）
LOGIN_LOG="$HOME/.openclaw/logs/login.log"
mkdir -p "$HOME/.openclaw/logs"

# 当前用户
CURRENT_USER=$(whoami)
IS_SUDOER="false"

# 检查是否有 sudo 权限
if [ "$CURRENT_USER" != "root" ]; then
    if sudo -n true 2>/dev/null || groups 2>/dev/null | grep -q '\bsudo\b'; then
        IS_SUDOER="true"
    fi
fi

# 记录登录
echo "$(date '+%Y-%m-%d %H:%M:%S') | 用户: $CURRENT_USER | IP: ${SSH_CLIENT%% *} | TTY: $(tty)" >> "$LOGIN_LOG" 2>/dev/null

# 检查服务状态
check_service() {
    # 首先尝试通过进程名检测
    if pgrep -f "$1" | grep -qv $$ 2>/dev/null; then
        printf "${GREEN}● 在线${NC}"
        return 0
    fi
    # 备用：通过端口检测（对于 Gateway）
    if [[ "$1" == *"gateway"* ]]; then
        if curl --noproxy '*' -s -o /dev/null --connect-timeout 1 --max-time 2 http://127.0.0.1:18789/health 2>/dev/null; then
            printf "${GREEN}● 在线${NC}"
            return 0
        fi
    fi
    # 备用：通过端口检测（对于 Web）
    if [[ "$1" == *"server.js"* ]]; then
        if curl -s -o /dev/null --connect-timeout 1 --max-time 2 http://127.0.0.1:3000/ 2>/dev/null; then
            printf "${GREEN}● 在线${NC}"
            return 0
        fi
    fi
    # 备用：通过端口检测（对于 Caddy）
    if [[ "$1" == *"caddy"* ]]; then
        if ss -ltn 2>/dev/null | grep -q ":443 " || netstat -ltn 2>/dev/null | grep -q ":443 "; then
            printf "${GREEN}● 在线${NC}"
            return 0
        fi
    fi
    printf "${RED}● 离线${NC}"
}

GATEWAY_STATUS=$(check_service "openclaw-gatewa|openclaw\\.mjs gateway|openclaw .*gateway run")
WEB_STATUS=$(check_service "node.*server\.js")
CADDY_STATUS=$(check_service "caddy run")

# 读取配置（普通用户需要 sudo 读取）
DOMAIN=""
_cfg_exists() { if [ "$CURRENT_USER" = "root" ]; then [ -f "$1" ]; else sudo test -f "$1" 2>/dev/null; fi; }
if _cfg_exists "$CONFIG_FILE"; then
    if [ "$CURRENT_USER" = "root" ]; then
        DOMAIN=$(jq -r '.domain // empty' "$CONFIG_FILE" 2>/dev/null)
    else
        DOMAIN=$(sudo cat "$CONFIG_FILE" 2>/dev/null | jq -r '.domain // empty' 2>/dev/null)
    fi
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

# 读取端口配置
if _cfg_exists "$CONFIG_FILE"; then
    if [ "$CURRENT_USER" = "root" ]; then
        GW_PORT=$(jq -r '.port // 18789' "$CONFIG_FILE" 2>/dev/null)
        WEB_PORT=$(jq -r '.web_port // 3000' "$CONFIG_FILE" 2>/dev/null)
        HTTPS_PORT=$(jq -r '.https_port // 8443' "$CONFIG_FILE" 2>/dev/null)
        SSH_PORT=$(jq -r '.ssh_port // 2222' "$CONFIG_FILE" 2>/dev/null)
    else
        CFG_CONTENT=$(sudo cat "$CONFIG_FILE" 2>/dev/null)
        GW_PORT=$(echo "$CFG_CONTENT" | jq -r '.port // 18789' 2>/dev/null)
        WEB_PORT=$(echo "$CFG_CONTENT" | jq -r '.web_port // 3000' 2>/dev/null)
        HTTPS_PORT=$(echo "$CFG_CONTENT" | jq -r '.https_port // 8443' 2>/dev/null)
        SSH_PORT=$(echo "$CFG_CONTENT" | jq -r '.ssh_port // 2222' 2>/dev/null)
    fi
else
    GW_PORT=18789
    WEB_PORT=3000
    HTTPS_PORT=8443
    SSH_PORT=2222
fi

# 获取 SSH 用户（从持久化状态）
SSH_USER_FILE="/root/.openclaw/users/ssh_user"
if _cfg_exists "$SSH_USER_FILE"; then
    SSH_USER=$(sudo cat "$SSH_USER_FILE" 2>/dev/null | head -1)
fi
[ -z "$SSH_USER" ] && SSH_USER=$(awk -F: '$3>=1000 && $1!="nobody" {print $1; exit}' /etc/passwd 2>/dev/null)
[ -z "$SSH_USER" ] && SSH_USER="root"

if [ -n "$DOMAIN" ]; then
    echo -e "${CYAN}║${NC}  🌐 Web管理: ${BLUE}https://${DOMAIN}:${HTTPS_PORT}${NC}"
else
    echo -e "${CYAN}║${NC}  🌐 Web管理: ${BLUE}http://localhost:${WEB_PORT}${NC}"
fi
echo -e "${CYAN}║${NC}  🔐 SSH登录: ${BLUE}ssh ${SSH_USER}@<host> -p ${SSH_PORT}${NC}"

# 显示当前用户和提权提示
if [ "$CURRENT_USER" = "root" ]; then
    echo -e "${CYAN}║${NC}  👤 当前用户: ${GREEN}root${NC}"
elif [ "$IS_SUDOER" = "true" ]; then
    echo -e "${CYAN}║${NC}  👤 当前用户: ${GREEN}${CURRENT_USER}${NC} (可提权: ${BLUE}sudo -i${NC})"
else
    echo -e "${CYAN}║${NC}  👤 当前用户: ${YELLOW}${CURRENT_USER}${NC} (无 sudo 权限)"
fi

echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# 交互式菜单（仅 root 用户可用）
if [ -t 0 ] && [ "$CURRENT_USER" = "root" ]; then
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
elif [ -t 0 ] && [ "$IS_SUDOER" = "true" ]; then
    # 普通用户但有 sudo 权限
    echo -e "${YELLOW}提示: 执行 ${CYAN}sudo -i${NC}${YELLOW} 切换到 root 用户使用配置菜单${NC}"
fi

# Docker 进入容器命令提示
echo -e "${CYAN}┌──────────────────────────────────────────────────┐${NC}"
echo -e "${CYAN}│${NC}  🐳 ${BOLD}Docker 进入容器${NC}:                                ${CYAN}│${NC}"
echo -e "${CYAN}│${NC}     ${YELLOW}docker exec -it openclaw-pro bash${NC}            ${CYAN}│${NC}"
echo -e "${CYAN}└──────────────────────────────────────────────────┘${NC}"
echo ""
