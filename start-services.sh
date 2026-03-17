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

strip_utf8_bom() {
    local file="$1"
    [ -f "$file" ] || return 0

    python3 - "$file" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
data = path.read_bytes()
if data.startswith(b'\xef\xbb\xbf'):
    path.write_bytes(data[3:])
PY
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

# 确保容器内本地环回访问不走代理（与 Windows 行为对齐）
ensure_local_no_proxy() {
    local merged="${no_proxy:-${NO_PROXY:-}}"
    local host
    for host in 127.0.0.1 localhost ::1; do
        case ",${merged}," in
            *",${host},"*) ;;
            *)
                if [ -n "$merged" ]; then
                    merged="${merged},${host}"
                else
                    merged="${host}"
                fi
                ;;
        esac
    done
    export no_proxy="$merged"
    export NO_PROXY="$merged"
}
ensure_local_no_proxy

enable_node_env_proxy_if_configured() {
    if [ -n "${http_proxy:-}" ] || [ -n "${HTTP_PROXY:-}" ] || [ -n "${https_proxy:-}" ] || [ -n "${HTTPS_PROXY:-}" ]; then
        export NODE_USE_ENV_PROXY=1
        case " ${NODE_OPTIONS:-} " in
            *" --disable-warning=UNDICI-EHPA "*) ;;
            *)
                export NODE_OPTIONS="--disable-warning=UNDICI-EHPA${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
                ;;
        esac
        echo "[start-services] NODE_USE_ENV_PROXY enabled"
    fi
}
enable_node_env_proxy_if_configured

# 确保 pnpm 在运行时可用（/root 挂载可能覆盖 /root/.npm-global）
ensure_pnpm_runtime() {
    if command -v pnpm >/dev/null 2>&1; then
        return 0
    fi

    if [ -x /usr/local/bin/pnpm ]; then
        export PATH="/usr/local/bin:$PATH"
        if command -v pnpm >/dev/null 2>&1; then
            echo "[start-services] pnpm available from /usr/local/bin"
            return 0
        fi
    fi

    if command -v corepack >/dev/null 2>&1; then
        corepack enable >/dev/null 2>&1 || true
        if corepack pnpm -v >/dev/null 2>&1; then
            cat > /usr/local/bin/pnpm << 'PNPM_WRAPPER'
#!/bin/sh
exec corepack pnpm "$@"
PNPM_WRAPPER
            chmod +x /usr/local/bin/pnpm
            export PATH="/usr/local/bin:$PATH"
            echo "[start-services] pnpm restored via corepack wrapper"
            return 0
        fi
    fi

    echo "[start-services] WARN: pnpm still unavailable (source fallback build may fail)"
    return 1
}
ensure_pnpm_runtime || true

# ── 恢复 OpenClaw 源码安装目录（持久化在 /root 下）──
PERSIST_OPENCLAW_SRC="/root/.openclaw/openclaw-source"
WORK_OPENCLAW_SRC="/root/.openclaw/openclaw"
if [ -f "$PERSIST_OPENCLAW_SRC/openclaw.mjs" ]; then
    mkdir -p /root/.openclaw
    if [ -L "$WORK_OPENCLAW_SRC" ] || [ ! -e "$WORK_OPENCLAW_SRC" ]; then
        ln -sfn "$PERSIST_OPENCLAW_SRC" "$WORK_OPENCLAW_SRC"
        echo "[start-services] Restored OpenClaw source symlink: $WORK_OPENCLAW_SRC -> $PERSIST_OPENCLAW_SRC"
    fi
fi

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

echo "[start-services] HOST_USER=$HOST_USER HOST_UID=${HOST_UID:-auto} HOST_GID=${HOST_GID:-auto}"

ensure_user_account_active() {
    local username="$1"
    [ -z "$username" ] && return 1
    id -u "$username" >/dev/null 2>&1 || return 1

    usermod -U "$username" 2>/dev/null || true
    usermod -s /bin/bash "$username" 2>/dev/null || true
    passwd -d "$username" 2>/dev/null || true
    chage -E -1 "$username" 2>/dev/null || true
    chage -I -1 -m 0 -M 99999 "$username" 2>/dev/null || true
    return 0
}

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
        ensure_user_account_active "$username"
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

    ensure_user_account_active "$username"

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
    if [ -n "$saved_user" ]; then
        if id -u "$saved_user" >/dev/null 2>&1; then
            ensure_user_account_active "$saved_user"
            SSH_USER="$saved_user"
            echo "[start-services] Restored SSH user from persistent state: $SSH_USER"
        else
            echo "[start-services] Recreating persisted SSH user: $saved_user"
            if create_host_user "$saved_user" "" ""; then
                SSH_USER="$saved_user"
                echo "[start-services] Recreated SSH user from persistent state: $SSH_USER"
            fi
        fi
    fi
fi

sync_root_authorized_keys_to_ssh_user() {
    local username="$1"
    [ -n "$username" ] || return 0
    [ "$username" = "root" ] && return 0
    id -u "$username" >/dev/null 2>&1 || return 0

    local root_keys="/root/.ssh/authorized_keys"
    [ -s "$root_keys" ] || return 0

    local user_home user_ssh user_keys
    user_home=$(getent passwd "$username" | cut -d: -f6)
    [ -n "$user_home" ] || user_home="/home/$username"
    user_ssh="$user_home/.ssh"
    user_keys="$user_ssh/authorized_keys"

    mkdir -p "$user_ssh" 2>/dev/null || return 0
    chmod 700 "$user_ssh" 2>/dev/null || true
    touch "$user_keys" 2>/dev/null || return 0
    cat "$root_keys" >> "$user_keys" 2>/dev/null || true
    sort -u -o "$user_keys" "$user_keys" 2>/dev/null || true
    chmod 600 "$user_keys" 2>/dev/null || true
    chown -R "$username:$username" "$user_ssh" 2>/dev/null || true
}

normalize_ssh_user_keys_and_permissions() {
    local username="$1"
    [ -n "$username" ] || return 0
    id -u "$username" >/dev/null 2>&1 || return 0

    local user_home user_ssh user_keys
    user_home=$(getent passwd "$username" | cut -d: -f6)
    [ -n "$user_home" ] || user_home="/home/$username"
    user_ssh="$user_home/.ssh"
    user_keys="$user_ssh/authorized_keys"

    mkdir -p "$user_ssh" 2>/dev/null || return 0
    touch "$user_keys" 2>/dev/null || return 0

    # 统一去除 Windows CRLF/BOM，避免 sshd 解析公钥失败
    sed -i 's/\r$//' "$user_keys" 2>/dev/null || true
    sed -i '1s/^\xEF\xBB\xBF//' "$user_keys" 2>/dev/null || true
    awk 'NF{print}' "$user_keys" 2>/dev/null | sort -u > "${user_keys}.tmp" 2>/dev/null || true
    if [ -s "${user_keys}.tmp" ]; then
        mv -f "${user_keys}.tmp" "$user_keys" 2>/dev/null || true
    else
        rm -f "${user_keys}.tmp" 2>/dev/null || true
    fi

    chown "$username:$username" "$user_home" 2>/dev/null || true
    chmod 755 "$user_home" 2>/dev/null || true
    chown -R "$username:$username" "$user_ssh" 2>/dev/null || true
    chmod 700 "$user_ssh" 2>/dev/null || true
    chmod 600 "$user_keys" 2>/dev/null || true
}

# 兼容安装器先向 root 注入公钥、再由普通用户登录的场景
if [ -n "$SSH_USER" ]; then
    sync_root_authorized_keys_to_ssh_user "$SSH_USER"
    normalize_ssh_user_keys_and_permissions "$SSH_USER"
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
    set_or_append "StrictModes" "no"

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
    echo "[start-services] SSH configured for user: $SSH_USER (root login disabled, AllowUsers enforced)"
else
    echo "[start-services] SSH configured for root (key-only auth fallback)"
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
CERT_MODE="letsencrypt"
CADDY_PID=""
GATEWAY_WATCHDOG_SCRIPT="/usr/local/bin/openclaw-gateway-watchdog.sh"
OPENCLAW_STATE_ROOT="/root/.openclaw"
OPENCLAW_PERSIST_SOURCE_DIR="$OPENCLAW_STATE_ROOT/openclaw-source"
OPENCLAW_SOURCE_DIR="$OPENCLAW_PERSIST_SOURCE_DIR"
OPENCLAW_RUNTIME_TMP_ROOT="${OPENCLAW_RUNTIME_TMP_ROOT:-/tmp/openclaw-runtime}"
OPENCLAW_RUNTIME_JS="$OPENCLAW_SOURCE_DIR/openclaw.mjs"
OPENCLAW_RUNTIME_VERSION=""

collect_watchdog_pids() {
    pgrep -f "[o]penclaw-gateway-watchdog.sh" 2>/dev/null || true
}

collect_primary_watchdog_pids() {
    local pid ppid
    for pid in $(collect_watchdog_pids); do
        ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
        if [ "$ppid" = "1" ]; then
            echo "$pid"
        fi
    done
}

describe_watchdog_pids() {
    local input_pids="$1"
    local pid ppid etimes args rows
    rows=""
    for pid in $input_pids; do
        ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
        etimes=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
        args=$(ps -o args= -p "$pid" 2>/dev/null | sed 's/[[:space:]]\+/ /g' | sed 's/^ //; s/ $//')
        [ -n "$rows" ] && rows="$rows | "
        rows="${rows}pid=${pid},ppid=${ppid:-?},etimes=${etimes:-?},args=${args:-unknown}"
    done
    [ -n "$rows" ] && echo "$rows" || echo "none"
}

is_primary_watchdog_running() {
    [ -n "$(collect_primary_watchdog_pids)" ]
}

detect_mount_fstype() {
    local target="$1"
    df -T "$target" 2>/dev/null | awk 'NR==2 {print $2}' | head -1
}

path_requires_local_runtime() {
    local fstype
    fstype=$(detect_mount_fstype "$1")
    case "$fstype" in
        9p|drvfs|virtiofs|fuse.osxfs|fuse.portal)
            return 0
            ;;
    esac
    return 1
}

sync_runtime_source_to_local() {
    local src="$1"
    local dst="$2"
    if command -v rsync >/dev/null 2>&1; then
        mkdir -p "$dst"
        rsync -a --delete "$src/" "$dst/"
        return $?
    fi

    rm -rf "$dst"
    mkdir -p "$dst"
    cp -a "$src/." "$dst/"
}

runtime_source_mirror_is_current() {
    local src="$1"
    local dst="$2"
    [ -f "$src/package.json" ] || return 1
    [ -f "$dst/package.json" ] || return 1
    [ -f "$dst/openclaw.mjs" ] || return 1
    cmp -s "$src/package.json" "$dst/package.json"
}

prepare_runtime_source_root() {
    OPENCLAW_SOURCE_DIR="$OPENCLAW_PERSIST_SOURCE_DIR"
    OPENCLAW_RUNTIME_JS="$OPENCLAW_SOURCE_DIR/openclaw.mjs"

    if [ ! -f "$OPENCLAW_PERSIST_SOURCE_DIR/openclaw.mjs" ]; then
        return 0
    fi

    mkdir -p "$OPENCLAW_RUNTIME_TMP_ROOT/tmp"
    export TMPDIR="$OPENCLAW_RUNTIME_TMP_ROOT/tmp"

    if ! path_requires_local_runtime "$OPENCLAW_PERSIST_SOURCE_DIR"; then
        return 0
    fi

    local runtime_source_dir="$OPENCLAW_RUNTIME_TMP_ROOT/openclaw-source"
    if runtime_source_mirror_is_current "$OPENCLAW_PERSIST_SOURCE_DIR" "$runtime_source_dir"; then
        OPENCLAW_SOURCE_DIR="$runtime_source_dir"
        OPENCLAW_RUNTIME_JS="$OPENCLAW_SOURCE_DIR/openclaw.mjs"
        echo "[start-services] Reusing local runtime source mirror: $OPENCLAW_SOURCE_DIR"
        return 0
    fi

    if sync_runtime_source_to_local "$OPENCLAW_PERSIST_SOURCE_DIR" "$runtime_source_dir"; then
        OPENCLAW_SOURCE_DIR="$runtime_source_dir"
        OPENCLAW_RUNTIME_JS="$OPENCLAW_SOURCE_DIR/openclaw.mjs"
        echo "[start-services] Using local runtime source mirror: $OPENCLAW_SOURCE_DIR"
        return 0
    fi

    echo "[start-services] WARN: failed to mirror OpenClaw source locally, fallback to persistent source"
    return 0
}

ensure_openclaw_source_from_global_package() {
    mkdir -p "$OPENCLAW_STATE_ROOT" "$OPENCLAW_STATE_ROOT/logs" "$OPENCLAW_STATE_ROOT/cache/openclaw" "$OPENCLAW_STATE_ROOT/locks" "$OPENCLAW_STATE_ROOT/home"
    if [ -f "$OPENCLAW_PERSIST_SOURCE_DIR/openclaw.mjs" ]; then
        return 0
    fi
    if ! command -v npm >/dev/null 2>&1; then
        return 0
    fi
    local npm_root pkg_dir
    npm_root=$(npm root -g 2>/dev/null || true)
    pkg_dir="$npm_root/openclaw"
    if [ -d "$pkg_dir" ] && [ -f "$pkg_dir/openclaw.mjs" ]; then
        echo "[start-services] Seeding OpenClaw source from global npm package into $OPENCLAW_PERSIST_SOURCE_DIR"
        rm -rf "$OPENCLAW_PERSIST_SOURCE_DIR"
        mkdir -p "$OPENCLAW_PERSIST_SOURCE_DIR"
        cp -a "$pkg_dir"/. "$OPENCLAW_PERSIST_SOURCE_DIR"/
        ln -sfn "$OPENCLAW_PERSIST_SOURCE_DIR" "$OPENCLAW_STATE_ROOT/openclaw"
    fi
}

ensure_openclaw_cli_wrapper() {
    local wrapper_path="/usr/local/bin/openclaw"
    local runtime_js=""

    if command -v openclaw >/dev/null 2>&1 && [ "$(command -v openclaw)" != "$wrapper_path" ]; then
        return 0
    fi

    if [ -f "$OPENCLAW_RUNTIME_JS" ]; then
        runtime_js="$OPENCLAW_RUNTIME_JS"
    elif [ -f "$OPENCLAW_PERSIST_SOURCE_DIR/openclaw.mjs" ]; then
        runtime_js="$OPENCLAW_PERSIST_SOURCE_DIR/openclaw.mjs"
    else
        return 0
    fi

    if ! command -v node >/dev/null 2>&1; then
        return 0
    fi

    mkdir -p /usr/local/bin
    cat > "$wrapper_path" <<EOF
#!/bin/sh
set -eu
if [ -f "$runtime_js" ]; then
    exec node "$runtime_js" "\$@"
fi
if [ -f "$OPENCLAW_PERSIST_SOURCE_DIR/openclaw.mjs" ]; then
    exec node "$OPENCLAW_PERSIST_SOURCE_DIR/openclaw.mjs" "\$@"
fi
echo "openclaw runtime not found" >&2
exit 127
EOF
    chmod +x "$wrapper_path"
}

has_openclaw_cli() {
    [ -f "$OPENCLAW_PERSIST_SOURCE_DIR/openclaw.mjs" ] || command -v openclaw >/dev/null 2>&1 || [ -x "/root/.npm-global/bin/openclaw" ] || [ -x "/usr/local/bin/openclaw" ]
}

refresh_openclaw_availability() {
    if has_openclaw_cli; then
        HAS_OPENCLAW="true"
    else
        HAS_OPENCLAW="false"
    fi
}

detect_openclaw_runtime_version() {
    local candidates=""
    candidates="$OPENCLAW_SOURCE_DIR/package.json $OPENCLAW_PERSIST_SOURCE_DIR/package.json /root/.npm-global/lib/node_modules/openclaw/package.json /usr/local/lib/node_modules/openclaw/package.json /usr/lib/node_modules/openclaw/package.json"
    local f v
    for f in $candidates; do
        [ -f "$f" ] || continue
        v=$(grep -m1 '"version"' "$f" 2>/dev/null | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' | tr -d '\r\n ')
        if [ -n "$v" ] && [ "$v" != "dev" ] && [ "$v" != "unknown" ]; then
            OPENCLAW_RUNTIME_VERSION="$v"
            export OPENCLAW_VERSION="$OPENCLAW_RUNTIME_VERSION"
            export OPENCLAW_SERVICE_VERSION="$OPENCLAW_RUNTIME_VERSION"
            return 0
        fi
    done
    return 1
}

_PROXY_COMPAT_LAST_MTIME=""
_PROXY_COMPAT_APPLIED=false

ensure_gateway_proxy_compat_config() {
    local cfg_file="/root/.openclaw/openclaw.json"
    [ -f "$cfg_file" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0

    # 如果已经应用过且文件没变(mtime相同)，跳过检查（避免频繁运行 jq）
    local cur_mtime
    cur_mtime=$(stat -c %Y "$cfg_file" 2>/dev/null || echo "0")
    if [ "$_PROXY_COMPAT_APPLIED" = "true" ] && [ "$cur_mtime" = "$_PROXY_COMPAT_LAST_MTIME" ]; then
        return 0
    fi

    local domain=""
    if [ -f "$CONFIG_FILE" ]; then
        domain=$(jq -r '.domain // empty' "$CONFIG_FILE" 2>/dev/null || true)
    fi

    local host_candidates="localhost 127.0.0.1"
    if [ -n "$domain" ]; then
        host_candidates="$host_candidates $domain"
    fi

    local local_ip
    local_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
    if [ -n "$local_ip" ]; then
        host_candidates="$host_candidates $local_ip"
    fi

    local allowed_json
    allowed_json=$(for h in $host_candidates; do
        [ -n "$h" ] || continue
        printf '"https://%s"\n"http://%s"\n' "$h" "$h"
    done | awk '!seen[$0]++' | jq -s '.')

    local trusted_json='["127.0.0.1","127.0.0.0/8","::1","::ffff:127.0.0.1","::ffff:127.0.0.0/104","172.17.0.1","172.17.0.0/16"]'
    local tmp_file
    tmp_file=$(mktemp)

    if jq --argjson allowed "$allowed_json" --argjson trusted "$trusted_json" '
      .gateway = (.gateway // {})
      | .gateway.controlUi = (.gateway.controlUi // {})
      | .gateway.trustedProxies = ((.gateway.trustedProxies // []) + $trusted | unique)
      | .gateway.controlUi.allowedOrigins = ((.gateway.controlUi.allowedOrigins // []) + $allowed | unique)
    ' "$cfg_file" > "$tmp_file" 2>/dev/null; then
        if ! cmp -s "$cfg_file" "$tmp_file"; then
            cp "$cfg_file" "$cfg_file.before-proxy-compat.$(date +%Y%m%d-%H%M%S).bak" 2>/dev/null || true
            mv "$tmp_file" "$cfg_file"
            echo "[start-services] Updated openclaw.json: added gateway.trustedProxies + gateway.controlUi.allowedOrigins"
            # 更新 mtime 缓存为新文件的 mtime
            _PROXY_COMPAT_LAST_MTIME=$(stat -c %Y "$cfg_file" 2>/dev/null || echo "0")
        else
            rm -f "$tmp_file"
        fi
        _PROXY_COMPAT_APPLIED=true
        [ -z "$_PROXY_COMPAT_LAST_MTIME" ] || _PROXY_COMPAT_LAST_MTIME=$(stat -c %Y "$cfg_file" 2>/dev/null || echo "0")
    else
        rm -f "$tmp_file"
    fi
}

HAS_OPENCLAW="false"
refresh_openclaw_availability

start_gateway() {
    ensure_openclaw_source_from_global_package
    prepare_runtime_source_root
    ensure_openclaw_cli_wrapper
    refresh_openclaw_availability
    detect_openclaw_runtime_version >/dev/null 2>&1 || true
    if [ "$HAS_OPENCLAW" != "true" ]; then
        echo "[start-services] openclaw CLI not installed, skipping Gateway"
        return 0
    fi
    echo "[start-services] Starting OpenClaw Gateway (foreground mode)..."
    [ -n "$OPENCLAW_RUNTIME_VERSION" ] && echo "[start-services] OpenClaw runtime version: $OPENCLAW_RUNTIME_VERSION"
    if command -v node >/dev/null 2>&1 && [ -f "$OPENCLAW_RUNTIME_JS" ]; then
        nohup env HOME="$OPENCLAW_STATE_ROOT/home" OPENCLAW_VERSION="$OPENCLAW_RUNTIME_VERSION" OPENCLAW_SERVICE_VERSION="$OPENCLAW_RUNTIME_VERSION" node "$OPENCLAW_RUNTIME_JS" gateway run --allow-unconfigured --force >> "$LOG_DIR/openclaw-gateway.log" 2>&1 &
    else
        nohup env HOME="$OPENCLAW_STATE_ROOT/home" OPENCLAW_VERSION="$OPENCLAW_RUNTIME_VERSION" OPENCLAW_SERVICE_VERSION="$OPENCLAW_RUNTIME_VERSION" openclaw gateway run --allow-unconfigured --force >> "$LOG_DIR/openclaw-gateway.log" 2>&1 &
    fi
    GATEWAY_PID=$!
}

start_gateway_watchdog() {
    ensure_openclaw_source_from_global_package
    prepare_runtime_source_root
    ensure_openclaw_cli_wrapper
    detect_openclaw_runtime_version >/dev/null 2>&1 || true
    if [ ! -x "$GATEWAY_WATCHDOG_SCRIPT" ]; then
        echo "[start-services] watchdog script missing ($GATEWAY_WATCHDOG_SCRIPT), fallback to direct gateway start"
        start_gateway
        return 0
    fi

    local wd_pids
    wd_pids=$(collect_primary_watchdog_pids)
    if [ -n "$wd_pids" ]; then
        echo "[start-services] Gateway watchdog already running: $(describe_watchdog_pids "$wd_pids")"
        return 0
    fi

    echo "[start-services] Starting Gateway watchdog..."
    setsid nohup env OPENCLAW_VERSION="$OPENCLAW_RUNTIME_VERSION" OPENCLAW_SERVICE_VERSION="$OPENCLAW_RUNTIME_VERSION" bash "$GATEWAY_WATCHDOG_SCRIPT" >> "$LOG_DIR/gateway-watchdog.log" 2>&1 &
    GATEWAY_WATCHDOG_PID=$!
    echo "[start-services] Gateway watchdog PID: $GATEWAY_WATCHDOG_PID"
}

ensure_gateway_watchdog_running() {
    local wd_pids all_wd_pids
    wd_pids=$(collect_primary_watchdog_pids)
    if [ -n "$wd_pids" ]; then
        return 0
    fi

    all_wd_pids=$(collect_watchdog_pids)
    if [ -n "$all_wd_pids" ]; then
        echo "[start-services] WARNING: only nested watchdog-like processes detected, primary missing: $(describe_watchdog_pids "$all_wd_pids")"
    fi

    echo "[start-services] WARNING: watchdog process not detected, trying to start now..."
    start_gateway_watchdog
    sleep 1

    wd_pids=$(collect_primary_watchdog_pids)
    if [ -n "$wd_pids" ]; then
        echo "[start-services] watchdog recovered: $(describe_watchdog_pids "$wd_pids")"
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

dedupe_gateway_watchdogs() {
    local pids count keep current_op
    pids=$(collect_primary_watchdog_pids)
    [ -z "$pids" ] && return 0
    count=$(echo "$pids" | wc -w | tr -d ' ')
    if [ "$count" -le 1 ]; then
        return 0
    fi

    current_op="$(current_operation_type)"
    if is_openclaw_operation_active "$current_op"; then
        echo "[start-services] WARNING: detected ${count} primary watchdog processes during operation=$current_op, skip dedupe: $(describe_watchdog_pids "$pids")"
        return 0
    fi

    keep=$(echo "$pids" | awk '{print $1}')
    echo "[start-services] WARNING: detected ${count} primary watchdog processes, keeping pid=${keep}: $(describe_watchdog_pids "$pids")"
    for pid in $pids; do
        [ "$pid" = "$keep" ] && continue
        kill -USR2 "$pid" 2>/dev/null || true
    done
    sleep 1
    for pid in $pids; do
        [ "$pid" = "$keep" ] && continue
        kill -KILL "$pid" 2>/dev/null || true
    done
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
    web_code=$(curl --noproxy '*' -sS --connect-timeout 2 --max-time 4 -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null)
    if [ "$web_code" = "200" ] || [ "$web_code" = "302" ] || [ "$web_code" = "401" ]; then
        return 0
    fi
    return 1
}

WEB_UNHEALTHY_STREAK=0
WEB_RESTART_THRESHOLD="${WEB_RESTART_THRESHOLD:-3}"
WEB_CONSECUTIVE_RESTART_FAILURES=0
WEB_ROLLBACK_THRESHOLD="${WEB_ROLLBACK_THRESHOLD:-3}"
WEB_PANEL_BACKUP_DIR="/root/.openclaw/web-panel-backup"
ROLLBACK_COOLDOWN_UNTIL=0

current_operation_type() {
    local lock_file="/root/.openclaw/locks/operation.lock"
    local op
    if [ ! -f "$lock_file" ]; then
        echo "idle"
        return 0
    fi
    op=$(grep -o '"type":"[^"]*"' "$lock_file" 2>/dev/null | head -1 | cut -d':' -f2 | tr -d '"')
    [ -n "$op" ] || op="idle"
    echo "$op"
}

is_openclaw_operation_active() {
    local op="$1"
    case "$op" in
        installing|updating|uninstalling|repairing_config|restarting_gateway)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

stop_web_panel_processes() {
    local pids pid
    pids=$(pgrep -f "node server.js" 2>/dev/null || true)
    [ -z "$pids" ] && return 0

    for pid in $pids; do
        kill -TERM "$pid" 2>/dev/null || true
    done
    sleep 2
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done
}

restart_web_panel() {
    if [ -n "${WEB_PID:-}" ] && kill -0 "$WEB_PID" 2>/dev/null; then
        kill -TERM "$WEB_PID" 2>/dev/null || true
        sleep 2
        if kill -0 "$WEB_PID" 2>/dev/null; then
            kill -KILL "$WEB_PID" 2>/dev/null || true
        fi
    fi
    stop_web_panel_processes
    start_web_panel
}

# 等待面板启动成功（最多 15 秒）
web_panel_started_ok() {
    local i
    for i in 1 2 3 4 5; do
        sleep 3
        if web_is_healthy; then
            return 0
        fi
    done
    return 1
}

# 从备份回退 Web 面板文件
rollback_web_panel() {
    local backup_dir="$WEB_PANEL_BACKUP_DIR"
    local meta_file="$backup_dir/.backup-meta"

    if [ ! -f "$meta_file" ]; then
        echo "[health] ROLLBACK: 无可用备份（$meta_file 不存在）"
        return 1
    fi

    local backup_version
    backup_version=$(jq -r '.version // "unknown"' "$meta_file" 2>/dev/null || echo "unknown")
    echo "[health] ROLLBACK: 尝试回退到备份版本 $backup_version..."

    # 最关键的是 server.js
    local server_backup="$backup_dir/server.js"
    if [ -f "$server_backup" ]; then
        if node -c "$server_backup" 2>/dev/null; then
            cp "$server_backup" /opt/openclaw-web/server.js
            echo "[health] ROLLBACK: server.js 已恢复"
        else
            echo "[health] ROLLBACK: 备份的 server.js 也有语法错误，无法回退"
            return 1
        fi
    else
        echo "[health] ROLLBACK: 备份中无 server.js"
        return 1
    fi

    # 恢复其他前端文件
    local f target
    for f in app.js index.html login.html login.js style.css; do
        if [ -f "$backup_dir/$f" ]; then
            target=$(jq -r ".files[\"$f\"] // empty" "$meta_file" 2>/dev/null)
            if [ -n "$target" ] && [ -f "$target" ] || [ -n "$target" ]; then
                cp "$backup_dir/$f" "$target" 2>/dev/null && echo "[health] ROLLBACK: $f 已恢复"
            fi
        fi
    done

    # 恢复版本号
    if [ "$backup_version" != "unknown" ]; then
        echo "$backup_version" > /etc/openclaw-version
        echo "[health] ROLLBACK: 版本号恢复为 $backup_version"
    fi

    echo "[health] ROLLBACK: 文件恢复完成，重启面板..."
    stop_web_panel_processes
    start_web_panel

    if web_panel_started_ok; then
        echo "[health] ROLLBACK: ✅ 面板回退成功，服务已恢复"
        return 0
    else
        echo "[health] ROLLBACK: ❌ 回退后面板仍无法启动"
        return 1
    fi
}

gateway_is_healthy() {
    # 优先用健康检查接口判断（进程存在但卡死也能识别）
    local code
    code=$(curl --noproxy '*' -sS --connect-timeout 2 --max-time 4 -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/health 2>/dev/null)
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
    strip_utf8_bom "$CONFIG_FILE"
    raw_cert_mode=$(jq -r '.cert_mode // "letsencrypt"' "$CONFIG_FILE" 2>/dev/null)
    if [ "$raw_cert_mode" = "internal" ]; then
        CERT_MODE="internal"
    fi
fi

echo "[start-services] Starting OpenClaw services..."

ensure_gateway_proxy_compat_config

# --- 1. 启动 Gateway Watchdog（由 watchdog 管理 Gateway 生命周期） ---
start_gateway_watchdog
dedupe_gateway_watchdogs
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
    web_code=$(curl --noproxy '*' -sS --connect-timeout 2 --max-time 4 -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null)
    if [ "$web_code" = "200" ] || [ "$web_code" = "302" ] || [ "$web_code" = "401" ]; then
        echo "[start-services] Web panel healthy (attempt $i, code=$web_code)"
        break
    fi
    [ "$i" = "10" ] && echo "[start-services] Web panel not ready yet (last code=${web_code:-none}), continue in background"
    sleep 1
done

# --- 3. 启动 Caddy (如果配置了HTTPS) ---
if [ -f "$CONFIG_FILE" ]; then
    strip_utf8_bom "$CONFIG_FILE"
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
        # 只替换我们定义的四个变量，避免 envsubst 误替换模板中的其他 $ 符号
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
            # 防止重复启动：先杀掉已有的 Caddy 进程
            pkill -f 'caddy run' 2>/dev/null || true
            sleep 1
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
    ensure_gateway_proxy_compat_config
    sync_root_authorized_keys_to_ssh_user "$SSH_USER"
    normalize_ssh_user_keys_and_permissions "$SSH_USER"

    # 检查 Gateway watchdog（始终保持 watchdog 进程在线）
    dedupe_gateway_watchdogs
    if ! pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1; then
        echo "[health] WARNING: Gateway watchdog not found, restarting watchdog..."
        ensure_gateway_watchdog_running || true
    fi

    if [ "$HAS_OPENCLAW" != "true" ]; then
        echo "[health] INFO: openclaw CLI not found yet; watchdog is running and will retry"
    fi

    # 检查 Web 面板（避免单次抖动导致误重启）
    if web_is_healthy; then
        WEB_UNHEALTHY_STREAK=0
        WEB_CONSECUTIVE_RESTART_FAILURES=0
    else
        WEB_UNHEALTHY_STREAK=$((WEB_UNHEALTHY_STREAK + 1))
        current_op="$(current_operation_type)"
        if is_openclaw_operation_active "$current_op"; then
            echo "[health] WARNING: Web panel unhealthy, but operation=$current_op active; defer restart (streak=$WEB_UNHEALTHY_STREAK)"
        elif [ "$WEB_UNHEALTHY_STREAK" -lt "$WEB_RESTART_THRESHOLD" ]; then
            echo "[health] WARNING: Web panel unhealthy, retry later (streak=$WEB_UNHEALTHY_STREAK/$WEB_RESTART_THRESHOLD)"
        else
            echo "[health] WARNING: Web panel unhealthy for $WEB_UNHEALTHY_STREAK checks, restarting..."
            WEB_UNHEALTHY_STREAK=0
            restart_web_panel

            # 检查重启是否成功（8秒内）
            sleep 8
            if web_is_healthy; then
                WEB_CONSECUTIVE_RESTART_FAILURES=0
                echo "[health] Web panel 重启成功"
            else
                WEB_CONSECUTIVE_RESTART_FAILURES=$((WEB_CONSECUTIVE_RESTART_FAILURES + 1))
                echo "[health] WARNING: 重启后面板仍不健康 (连续失败 $WEB_CONSECUTIVE_RESTART_FAILURES/$WEB_ROLLBACK_THRESHOLD)"

                if [ "$WEB_CONSECUTIVE_RESTART_FAILURES" -ge "$WEB_ROLLBACK_THRESHOLD" ]; then
                    now=$(date +%s)
                    if [ "$now" -lt "$ROLLBACK_COOLDOWN_UNTIL" ]; then
                        echo "[health] CRITICAL: 回退冷却中，距下次尝试还有 $((ROLLBACK_COOLDOWN_UNTIL - now)) 秒"
                    else
                        echo "[health] CRITICAL: 面板连续 $WEB_CONSECUTIVE_RESTART_FAILURES 次重启失败，尝试版本回退..."
                        if rollback_web_panel; then
                            WEB_CONSECUTIVE_RESTART_FAILURES=0
                        else
                            echo "[health] CRITICAL: 版本回退失败，300 秒后重试"
                            ROLLBACK_COOLDOWN_UNTIL=$((now + 300))
                            WEB_CONSECUTIVE_RESTART_FAILURES=0
                        fi
                    fi
                fi
            fi
        fi
    fi

    # 检查 Caddy
    if [ -n "$CADDY_PID" ] && ! kill -0 $CADDY_PID 2>/dev/null; then
        echo "[health] WARNING: Caddy died, restarting..."
        pkill -f 'caddy run' 2>/dev/null || true
        sleep 1
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
