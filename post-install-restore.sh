#!/bin/bash
# ============================================================
# post-install-restore.sh — 容器启动时自动恢复用户安装的组件
#
# 读取 /root/.openclaw/post-install.json，检查已安装组件是否存在，
# 若缺失则自动重新安装。支持 apt 包、pip 包、npm 全局包。
#
# 持久化策略：
#   /root/.venv/          — Python 虚拟环境（pip 包持久化）
#   /root/.npm-global/    — npm 全局包持久化
#   /root/.openclaw/post-install.json — 安装清单
#
# 所有安装操作的日志写入 /root/.openclaw/logs/post-install.log
# ============================================================

POST_INSTALL_FILE="/root/.openclaw/post-install.json"
LOG_FILE="/root/.openclaw/logs/post-install.log"
mkdir -p /root/.openclaw/logs

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$msg" >> "$LOG_FILE"
    echo "[post-install] $1"
}

# ── 初始化 Python 虚拟环境（如果还不存在）──
init_venv() {
    if [ ! -f "/root/.venv/bin/python3" ]; then
        log "Initializing Python venv at /root/.venv ..."
        python3 -m venv /root/.venv 2>> "$LOG_FILE"
        if [ $? -eq 0 ]; then
            log "Python venv created"
            # 升级 pip
            /root/.venv/bin/pip install --upgrade pip 2>> "$LOG_FILE" || true
        else
            log "ERROR: Failed to create Python venv"
            return 1
        fi
    fi
}

# ── 初始化 npm global 目录 ──
init_npm_global() {
    if [ ! -d "/root/.npm-global" ]; then
        mkdir -p /root/.npm-global
        npm config set prefix /root/.npm-global 2>> "$LOG_FILE" || true
        log "npm global prefix set to /root/.npm-global"
    fi
}

# ── 安装 apt 包组 ──
install_apt_group() {
    local group_name="$1"
    shift
    local packages=("$@")

    log "Installing apt group [$group_name]: ${packages[*]}"
    apt-get update -qq >> "$LOG_FILE" 2>&1
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${packages[@]}" >> "$LOG_FILE" 2>&1
    local rc=$?
    rm -rf /var/lib/apt/lists/*
    if [ $rc -eq 0 ]; then
        log "apt group [$group_name] installed successfully"
    else
        log "ERROR: apt group [$group_name] installation failed (exit $rc)"
    fi
    return $rc
}

# ── 安装 pip 包 ──
install_pip_packages() {
    local packages=("$@")
    init_venv || return 1
    log "Installing pip packages: ${packages[*]}"
    /root/.venv/bin/pip install "${packages[@]}" >> "$LOG_FILE" 2>&1
    local rc=$?
    if [ $rc -eq 0 ]; then
        log "pip packages installed successfully"
    else
        log "ERROR: pip install failed (exit $rc)"
    fi
    return $rc
}

# ── 安装 npm 全局包 ──
install_npm_packages() {
    local packages=("$@")
    init_npm_global
    log "Installing npm global packages: ${packages[*]}"
    npm install -g "${packages[@]}" >> "$LOG_FILE" 2>&1
    local rc=$?
    if [ $rc -eq 0 ]; then
        log "npm packages installed successfully"
    else
        log "ERROR: npm install failed (exit $rc)"
    fi
    return $rc
}

# ── 检查组件是否已安装 ──
check_component() {
    local type="$1"
    local name="$2"

    case "$type" in
        apt)
            # 检查关键可执行文件是否存在
            case "$name" in
                browser)
                    which google-chrome-stable >/dev/null 2>&1 || which chromium-browser >/dev/null 2>&1 || which chromium >/dev/null 2>&1
                    ;;
                novnc)
                    which Xvfb >/dev/null 2>&1 && which x11vnc >/dev/null 2>&1
                    ;;
                *)
                    dpkg -l | grep -q "^ii.*$name " 2>/dev/null
                    ;;
            esac
            ;;
        pip)
            [ -f "/root/.venv/bin/python3" ] && /root/.venv/bin/pip show "$name" >/dev/null 2>&1
            ;;
        npm)
            [ -d "/root/.npm-global/lib/node_modules/$name" ]
            ;;
    esac
}

# ── 主逻辑：读取清单并恢复 ──
restore_components() {
    if [ ! -f "$POST_INSTALL_FILE" ]; then
        log "No post-install manifest found, skipping restore"
        return 0
    fi

    local total=$(jq '.components | length' "$POST_INSTALL_FILE" 2>/dev/null)
    if [ -z "$total" ] || [ "$total" = "0" ] || [ "$total" = "null" ]; then
        log "Empty manifest, nothing to restore"
        return 0
    fi

    log "Found $total components in manifest, checking..."
    local restored=0
    local skipped=0
    local failed=0

    for i in $(seq 0 $((total - 1))); do
        local comp_name=$(jq -r ".components[$i].name" "$POST_INSTALL_FILE")
        local comp_type=$(jq -r ".components[$i].type" "$POST_INSTALL_FILE")
        local comp_check=$(jq -r ".components[$i].check // empty" "$POST_INSTALL_FILE")

        # 检查是否已安装
        if check_component "$comp_type" "${comp_check:-$comp_name}"; then
            skipped=$((skipped + 1))
            continue
        fi

        log "Component [$comp_name] missing, restoring..."

        case "$comp_type" in
            apt)
                local packages=$(jq -r ".components[$i].packages[]" "$POST_INSTALL_FILE" 2>/dev/null)
                if [ -n "$packages" ]; then
                    install_apt_group "$comp_name" $packages
                    if [ $? -eq 0 ]; then
                        restored=$((restored + 1))
                    else
                        failed=$((failed + 1))
                    fi
                fi

                # 特殊后处理
                local post_script=$(jq -r ".components[$i].post_install // empty" "$POST_INSTALL_FILE")
                if [ -n "$post_script" ] && [ -f "$post_script" ]; then
                    log "Running post-install script: $post_script"
                    bash "$post_script" >> "$LOG_FILE" 2>&1
                fi
                ;;
            pip)
                local packages=$(jq -r ".components[$i].packages[]" "$POST_INSTALL_FILE" 2>/dev/null)
                if [ -n "$packages" ]; then
                    install_pip_packages $packages
                    if [ $? -eq 0 ]; then
                        restored=$((restored + 1))
                    else
                        failed=$((failed + 1))
                    fi
                fi
                ;;
            npm)
                local packages=$(jq -r ".components[$i].packages[]" "$POST_INSTALL_FILE" 2>/dev/null)
                if [ -n "$packages" ]; then
                    install_npm_packages $packages
                    if [ $? -eq 0 ]; then
                        restored=$((restored + 1))
                    else
                        failed=$((failed + 1))
                    fi
                fi
                ;;
            script)
                local script_path=$(jq -r ".components[$i].script // empty" "$POST_INSTALL_FILE")
                if [ -n "$script_path" ] && [ -f "$script_path" ]; then
                    log "Running custom install script: $script_path"
                    bash "$script_path" >> "$LOG_FILE" 2>&1
                    if [ $? -eq 0 ]; then
                        restored=$((restored + 1))
                    else
                        failed=$((failed + 1))
                    fi
                else
                    log "ERROR: Script not found: $script_path"
                    failed=$((failed + 1))
                fi
                ;;
        esac
    done

    log "Restore complete: $restored restored, $skipped already present, $failed failed (of $total total)"
}

# ── 辅助函数：添加组件到清单 ──
# 用法: add_component '{"name":"browser","type":"apt","check":"browser","packages":["google-chrome-stable"]}'
add_component() {
    local json_entry="$1"
    mkdir -p /root/.openclaw

    if [ ! -f "$POST_INSTALL_FILE" ]; then
        echo '{"components":[]}' > "$POST_INSTALL_FILE"
    fi

    # 检查是否已在清单中
    local comp_name=$(echo "$json_entry" | jq -r '.name')
    local exists=$(jq --arg name "$comp_name" '.components[] | select(.name == $name) | .name' "$POST_INSTALL_FILE" 2>/dev/null)
    if [ -n "$exists" ]; then
        # 更新已有条目
        local tmp=$(jq --arg name "$comp_name" --argjson entry "$json_entry" \
            '.components = [.components[] | if .name == $name then $entry else . end]' \
            "$POST_INSTALL_FILE")
        echo "$tmp" > "$POST_INSTALL_FILE"
        log "Updated component [$comp_name] in manifest"
    else
        # 添加新条目
        local tmp=$(jq --argjson entry "$json_entry" '.components += [$entry]' "$POST_INSTALL_FILE")
        echo "$tmp" > "$POST_INSTALL_FILE"
        log "Added component [$comp_name] to manifest"
    fi
}

# ── 辅助函数：从清单移除组件 ──
remove_component() {
    local comp_name="$1"
    if [ -f "$POST_INSTALL_FILE" ]; then
        local tmp=$(jq --arg name "$comp_name" '.components = [.components[] | select(.name != $name)]' "$POST_INSTALL_FILE")
        echo "$tmp" > "$POST_INSTALL_FILE"
        log "Removed component [$comp_name] from manifest"
    fi
}

# ── 预定义组件安装函数（供 Web 面板调用）──

# 安装 Chrome 浏览器 + noVNC 远程桌面
install_browser() {
    log "=== Installing Browser (Chrome + noVNC) ==="

    # apt 包: noVNC 相关
    install_apt_group "novnc" xvfb x11vnc novnc websockify supervisor \
        fonts-noto-cjk fonts-noto-color-emoji || return 1

    # Chrome
    log "Installing Google Chrome..."
    wget -q --tries=3 --retry-connrefused https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb 2>> "$LOG_FILE"
    (dpkg -i /tmp/chrome.deb || apt-get -f install -y) >> "$LOG_FILE" 2>&1
    rm -f /tmp/chrome.deb
    rm -rf /var/lib/apt/lists/*

    if which google-chrome-stable >/dev/null 2>&1; then
        log "Chrome installed successfully"
    else
        log "ERROR: Chrome installation failed"
        return 1
    fi

    # 写入清单
    add_component '{"name":"browser","type":"apt","check":"browser","packages":["xvfb","x11vnc","novnc","websockify","supervisor","fonts-noto-cjk","fonts-noto-color-emoji","google-chrome-stable"]}'
    add_component '{"name":"novnc","type":"apt","check":"novnc","packages":["xvfb","x11vnc","novnc","websockify"]}'

    log "=== Browser installation complete ==="
}

# 安装 LightGBM + 数据分析套件
install_lightgbm() {
    log "=== Installing LightGBM + data analysis ==="
    init_venv || return 1
    install_pip_packages lightgbm pandas numpy baostock || return 1

    add_component '{"name":"lightgbm","type":"pip","check":"lightgbm","packages":["lightgbm","pandas","numpy","baostock"]}'
    log "=== LightGBM installation complete ==="
}

# 安装 OpenClaw CLI
install_openclaw() {
    log "=== Installing OpenClaw CLI ==="
    init_npm_global
    install_npm_packages openclaw || return 1

    add_component '{"name":"openclaw","type":"npm","check":"openclaw","packages":["openclaw"]}'
    log "=== OpenClaw installation complete ==="
}

# 如果直接运行此脚本（非 source），执行恢复
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    case "${1:-restore}" in
        restore)
            restore_components
            ;;
        install-browser)
            install_browser
            ;;
        install-lightgbm)
            install_lightgbm
            ;;
        install-openclaw)
            install_openclaw
            ;;
        *)
            echo "Usage: $0 {restore|install-browser|install-lightgbm|install-openclaw}"
            exit 1
            ;;
    esac
fi
