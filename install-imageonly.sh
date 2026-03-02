#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# OpenClaw Pro — Image-Only Linux Installer
# 完全对齐 Windows install-windows.ps1 行为：
#   - HTTPS / 域名 / 证书模式配置
#   - 防火墙 & fail2ban 自动配置
#   - 已有容器升级检测 / 重装 / 保留选择
#   - 端口冲突自动发现与调整
#   - SSH 仅密钥登录 + 公钥注入
#   - 自动生成 root 密码（不弹密码输入）
# ──────────────────────────────────────────────────────────────

CONTAINER_NAME="openclaw-pro"
IMAGE_NAME="openclaw-pro:latest"
GITHUB_REPO="cintia09/openclaw-pro"
IMAGE_TARBALL_LITE="openclaw-pro-image-lite.tar.gz"

TARGET_DIR="${TARGET_DIR:-$(pwd)}"
BASE_DIR="${TARGET_DIR}/openclaw-pro"
TMP_DIR="$BASE_DIR"
HOME_DIR="$BASE_DIR/home-data"
CONFIG_FILE="$HOME_DIR/.openclaw/docker-config.json"
LOG_FILE="$BASE_DIR/install.log"
ROOT_PASSWORD_FILE="$BASE_DIR/root-initial-password.txt"

PROXY_PREFIXES=(
  "https://ghfast.top/"
  "https://gh-proxy.com/"
  "https://ghproxy.net/"
  "https://mirror.ghproxy.com/"
  "https://github.moeyy.xyz/"
)

TTY_IN="/dev/tty"
has_tty(){ [ -r "$TTY_IN" ] && [ -w "$TTY_IN" ]; }

TAG=""
IMAGE_TARBALL="$IMAGE_TARBALL_LITE"

GW_PORT="${GW_PORT:-18789}"
WEB_PORT="${WEB_PORT:-3000}"
SSH_PORT="${SSH_PORT:-2222}"
HTTP_PORT="${HTTP_PORT:-0}"
HTTPS_PORT="${HTTPS_PORT:-0}"
DOMAIN="${DOMAIN:-}"
CERT_MODE="${CERT_MODE:-letsencrypt}"
TZ_VALUE="${TZ_VALUE:-Asia/Shanghai}"
HTTPS_ENABLED="false"
ROOT_PASS="${ROOT_PASS:-}"
DO_FIREWALL="${DO_FIREWALL:-}"
UPGRADE_MODE="false"

# ─── helpers ──────────────────────────────────────────────────

init_dirs(){
  mkdir -p "$TMP_DIR" "$HOME_DIR" "$HOME_DIR/.openclaw"
  touch "$LOG_FILE" 2>/dev/null || true
}

log(){
  local level="$1"; shift
  local msg="$*"
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$level] $msg"
  echo "[$ts] [$level] $msg" >> "$LOG_FILE" 2>/dev/null || true
}
info(){ log INFO "$*"; }
warn(){ log WARN "$*"; }
success(){ log OK "$*"; }

prompt(){
  local text="$1"
  if has_tty; then
    printf "%s" "$text" > "$TTY_IN"
    local answer=""
    IFS= read -r answer < "$TTY_IN" || true
    printf '%s' "$answer"
  else
    printf ''
  fi
}

# ─── prerequisites ────────────────────────────────────────────

ensure_docker(){
  if command -v docker &>/dev/null; then return 0; fi
  warn "未检测到 Docker，请先安装 Docker 并重试"
  exit 1
}

# ─── port helpers ─────────────────────────────────────────────

is_port_available(){
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ! ss -ltn | awk '{print $4}' | grep -qE "(^|:)${port}$"
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    ! netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "(^|:)${port}$"
    return $?
  fi
  return 0
}

find_available_port(){
  local preferred="$1" start="$2" end="$3" p
  if is_port_available "$preferred"; then echo "$preferred"; return 0; fi
  p="$start"
  while [ "$p" -le "$end" ]; do
    if is_port_available "$p"; then echo "$p"; return 0; fi
    p=$((p+1))
  done
  echo "$preferred"
}

prompt_port_or_default(){
  local label="$1" default_port="$2" answer trimmed
  answer="$(prompt "${label} (默认 ${default_port}): ")"
  trimmed="$(printf '%s' "$answer" | tr -d '[:space:]')"
  if [ -z "$trimmed" ]; then
    printf '%s' "$default_port"
    return 0
  fi
  if [[ "$trimmed" =~ ^[0-9]+$ ]] && [ "$trimmed" -ge 1 ] && [ "$trimmed" -le 65535 ]; then
    printf '%s' "$trimmed"
    return 0
  fi
  warn "${label} 输入无效（${answer}），使用默认值 ${default_port}"
  printf '%s' "$default_port"
}

apply_port_conflicts(){
  local ng nw ns nh np

  ng="$(find_available_port "$GW_PORT" 18790 18999)"
  if [ "$ng" != "$GW_PORT" ]; then
    warn "Gateway 端口 ${GW_PORT} 已占用，自动调整为 ${ng}"
    GW_PORT="$ng"
  fi

  nw="$(find_available_port "$WEB_PORT" 3001 3099)"
  if [ "$nw" != "$WEB_PORT" ]; then
    warn "Web 端口 ${WEB_PORT} 已占用，自动调整为 ${nw}"
    WEB_PORT="$nw"
  fi

  ns="$(find_available_port "$SSH_PORT" 2223 2299)"
  if [ "$ns" != "$SSH_PORT" ]; then
    warn "SSH 端口 ${SSH_PORT} 已占用，自动调整为 ${ns}"
    SSH_PORT="$ns"
  fi

  if [ "$HTTPS_ENABLED" = "true" ] && [ "$CERT_MODE" = "letsencrypt" ] && [ "$HTTP_PORT" -gt 0 ] 2>/dev/null; then
    nh="$(find_available_port "$HTTP_PORT" 8080 8099)"
    if [ "$nh" != "$HTTP_PORT" ]; then
      warn "HTTP 端口 ${HTTP_PORT} 已占用，自动调整为 ${nh}"
      HTTP_PORT="$nh"
    fi
  fi

  if [ "$HTTPS_ENABLED" = "true" ] && [ "$HTTPS_PORT" -gt 0 ] 2>/dev/null; then
    np="$(find_available_port "$HTTPS_PORT" 8443 8499)"
    if [ "$np" != "$HTTPS_PORT" ]; then
      warn "HTTPS 端口 ${HTTPS_PORT} 已占用，自动调整为 ${np}"
      HTTPS_PORT="$np"
    fi
  fi
}

# ─── config persistence ──────────────────────────────────────

safe_json_value(){
  local key="$1"
  [ ! -f "$CONFIG_FILE" ] && return 0
  grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"${key}\"[[:space:]]*:[[:space:]]*[0-9]+|\"${key}\"[[:space:]]*:[[:space:]]*(true|false)" \
    "$CONFIG_FILE" 2>/dev/null | head -1 | sed -E 's/^.*:[[:space:]]*//; s/^"//; s/"$//' || true
}

load_existing_config(){
  [ ! -f "$CONFIG_FILE" ] && return 1
  local v
  v="$(safe_json_value port)";       [ -n "$v" ] && GW_PORT="$v"
  v="$(safe_json_value web_port)";   [ -n "$v" ] && WEB_PORT="$v"
  v="$(safe_json_value ssh_port)";   [ -n "$v" ] && SSH_PORT="$v"
  v="$(safe_json_value http_port)";  [ -n "$v" ] && HTTP_PORT="$v"
  v="$(safe_json_value https_port)"; [ -n "$v" ] && HTTPS_PORT="$v"
  v="$(safe_json_value domain)";     DOMAIN="$v"
  v="$(safe_json_value cert_mode)";  [ -n "$v" ] && CERT_MODE="$v"
  v="$(safe_json_value timezone)";   [ -n "$v" ] && TZ_VALUE="$v"
  if [ -n "$DOMAIN" ]; then HTTPS_ENABLED="true"; else HTTPS_ENABLED="false"; HTTP_PORT=0; HTTPS_PORT=0; fi
  return 0
}

write_config(){
  mkdir -p "$(dirname "$CONFIG_FILE")"
  cat > "$CONFIG_FILE" <<EOF
{
  "port": ${GW_PORT},
  "web_port": ${WEB_PORT},
  "ssh_port": ${SSH_PORT},
  "http_port": ${HTTP_PORT},
  "https_port": ${HTTPS_PORT},
  "domain": "${DOMAIN}",
  "cert_mode": "${CERT_MODE}",
  "timezone": "${TZ_VALUE}",
  "https_enabled": ${HTTPS_ENABLED},
  "release_tag": "${TAG:-unknown}"
}
EOF
}

# ─── release / tag ────────────────────────────────────────────

get_latest_tag(){
  local t
  # 1st: /releases/latest
  t="$(curl -fsSL --connect-timeout 8 --max-time 15 \
    "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)"
  if [ -n "$t" ]; then printf '%s' "$t"; return 0; fi
  # 2nd: /releases?per_page=1
  t="$(curl -fsSL --connect-timeout 8 --max-time 15 \
    "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=1" 2>/dev/null \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)"
  if [ -n "$t" ]; then printf '%s' "$t"; return 0; fi
  # 3rd: git ls-remote
  t="$(git ls-remote --tags --sort=-v:refname "https://github.com/${GITHUB_REPO}.git" 2>/dev/null \
    | head -1 | sed 's|.*refs/tags/||; s|\^{}$||' || true)"
  [ -n "$t" ] && printf '%s' "$t"
}

ensure_latest_tag(){
  TAG="$(get_latest_tag)"
  if [ -z "$TAG" ]; then
    warn "无法获取最新 Release tag，跳过 release 直链下载，将在本地镜像失败后自动回退 GHCR"
  else
    info "检测到最新 release: $TAG"
  fi
}

# ─── image download / load ────────────────────────────────────

build_download_urls(){
  local primary="$1"
  local out=("$primary")
  for p in "${PROXY_PREFIXES[@]}"; do out+=("${p}${primary}"); done
  printf '%s\n' "${out[@]}"
}

check_local_tarball(){
  local target="$TMP_DIR/$IMAGE_TARBALL"
  [ ! -f "$target" ] && return 1
  if gzip -t "$target" >/dev/null 2>&1; then
    info "检测到本地镜像且校验通过：$target"
    return 0
  fi
  warn "检测到本地镜像损坏（gzip 校验失败），将自动删除并重新下载"
  rm -f "$target" || true
  return 1
}

download_tarball(){
  local target="$TMP_DIR/$IMAGE_TARBALL"
  local part="$target.part"
  local total_bytes=""
  local cached_bytes="0"
  local cached_mib="0"
  local total_mib="0"
  local total_pct="0"
  if [ -z "$TAG" ]; then
    warn "缺少有效 release tag，跳过 release 资产下载"
    return 1
  fi
  local primary_url="https://github.com/${GITHUB_REPO}/releases/download/${TAG}/${IMAGE_TARBALL}"

  if check_local_tarball; then return 0; fi

  while IFS= read -r u; do
    [ -z "$u" ] && continue
    info "尝试下载：$u"
    if [ -f "$part" ]; then
      cached_bytes="$(wc -c < "$part" 2>/dev/null | tr -d '[:space:]' || echo 0)"
      cached_mib="$(awk -v n="$cached_bytes" 'BEGIN{printf "%.2f", n/1024/1024}')"
      if [[ "$total_bytes" =~ ^[0-9]+$ ]] && [ "$total_bytes" -gt 0 ]; then
        total_mib="$(awk -v n="$total_bytes" 'BEGIN{printf "%.2f", n/1024/1024}')"
        total_pct=$(( cached_bytes * 100 / total_bytes ))
        info "检测到断点缓存：已缓存 ${cached_mib} MiB / 估算总大小 ${total_mib} MiB（总体约 ${total_pct}%）"
      else
        info "检测到断点缓存：已缓存 ${cached_mib} MiB（总大小暂不可得）"
      fi
      info "说明：下面 curl 百分比显示的是本次新增下载进度，不是总体百分比。"
    fi
    if curl -C - --progress-bar -fL --connect-timeout 15 --max-time 1800 --retry 3 --retry-delay 3 -o "$part" "$u"; then
      echo ""
      if gzip -t "$part" >/dev/null 2>&1; then
        mv -f "$part" "$target"
        success "镜像下载并校验成功"
        return 0
      fi
      warn "下载完成但校验失败，删除损坏分片并切换下一个源"
      rm -f "$part" || true
    else
      echo ""
      warn "该下载源失败：$u（保留当前分片供下次继续）"
    fi
  done < <(build_download_urls "$primary_url")

  if command -v aria2c >/dev/null 2>&1; then
    info "curl 源均失败，尝试 aria2c 多线程下载"
    aria2c -c -x 8 -s 8 -d "$TMP_DIR" -o "${IMAGE_TARBALL}.part" "$primary_url" || true
    if [ -f "$part" ] && gzip -t "$part" >/dev/null 2>&1; then
      mv -f "$part" "$target"
      success "aria2c 下载并校验成功"
      return 0
    fi
    rm -f "$part" || true
  fi

  return 1
}

tag_loaded_image_if_needed(){
  if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then return 0; fi
  local loaded_ref
  loaded_ref=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -i openclaw | head -1 || true)
  if [ -n "$loaded_ref" ]; then docker tag "$loaded_ref" "$IMAGE_NAME" || true; fi
}

load_image(){
  local f="$TMP_DIR/$IMAGE_TARBALL"
  local load_log="$TMP_DIR/.docker-load.log"
  local load_pid start_ts elapsed spin_i rc
  local spinner='|/-\\'
  if ! check_local_tarball; then return 1; fi

  info "正在导入镜像（docker load）: $f"
  rm -f "$load_log" || true
  docker load < "$f" >"$load_log" 2>&1 &
  load_pid=$!
  start_ts="$(date +%s)"
  spin_i=0
  while kill -0 "$load_pid" >/dev/null 2>&1; do
    elapsed=$(( $(date +%s) - start_ts ))
    printf "\r[INFO] 正在导入镜像（docker load） %s 已耗时 %ss" "${spinner:$((spin_i%4)):1}" "$elapsed"
    sleep 1
    spin_i=$((spin_i+1))
  done
  wait "$load_pid" || rc=$?
  rc="${rc:-0}"
  printf "\r\033[K"

  if [ "$rc" -eq 0 ]; then
    cat "$load_log"
    tag_loaded_image_if_needed
    success "镜像导入完成"
    rm -f "$load_log" || true
    return 0
  fi

  warn "docker load 失败，尝试流式解压导入"
  cat "$load_log" || true
  rm -f "$load_log" || true
  if command -v unpigz >/dev/null 2>&1; then
    if unpigz -c "$f" | docker load; then tag_loaded_image_if_needed; success "流式解压导入成功"; return 0; fi
  elif command -v gunzip >/dev/null 2>&1; then
    if gunzip -c "$f" | docker load; then tag_loaded_image_if_needed; success "流式解压导入成功"; return 0; fi
  fi

  warn "本地镜像导入失败"
  return 1
}

pull_from_ghcr(){
  info "尝试从 GHCR 拉取镜像（自动回退）"
  if [ -n "$TAG" ] && docker pull "ghcr.io/${GITHUB_REPO}:${TAG}-lite"; then
    docker tag "ghcr.io/${GITHUB_REPO}:${TAG}-lite" "$IMAGE_NAME" || true
    success "GHCR 拉取成功"; return 0
  fi
  if docker pull "ghcr.io/${GITHUB_REPO}:lite" 2>/dev/null || docker pull "ghcr.io/${GITHUB_REPO}:latest" 2>/dev/null; then
    if docker image inspect "ghcr.io/${GITHUB_REPO}:lite" >/dev/null 2>&1; then
      docker tag "ghcr.io/${GITHUB_REPO}:lite" "$IMAGE_NAME" || true
    else
      docker tag "ghcr.io/${GITHUB_REPO}:latest" "$IMAGE_NAME" || true
    fi
    success "GHCR 拉取成功"; return 0
  fi
  return 1
}

# ─── password ─────────────────────────────────────────────────

generate_strong_password(){
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -d '\n' | cut -c1-20
  else
    tr -dc 'A-Za-z0-9!@#%^*_-+=' < /dev/urandom | head -c 20
  fi
}

ensure_root_password(){
  if [ -n "$ROOT_PASS" ]; then
    info "检测到 ROOT_PASS 环境变量"; return 0
  fi
  ROOT_PASS=""
  info "默认不生成 root 密码文件（SSH key-only）；如需设置请传入 ROOT_PASS"
}

# ─── detect local IP ─────────────────────────────────────────

detect_local_ip(){
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}' || true)"
  fi
  [ -z "$ip" ] && ip="127.0.0.1"
  printf '%s' "$ip"
}

# ─── HTTPS / domain / cert config ────────────────────────────

prompt_deploy_config(){
  if has_tty; then
    local t

    GW_PORT="$(prompt_port_or_default "Gateway 端口" "$GW_PORT")"

    HTTPS_ENABLED="true"
    printf "HTTPS 域名 (可选，留空使用本机IP自签名HTTPS): " > "$TTY_IN"
    IFS= read -r DOMAIN < "$TTY_IN" || true
    DOMAIN="${DOMAIN:-}"

    if [ -z "$DOMAIN" ]; then
      DOMAIN="$(detect_local_ip)"
      CERT_MODE="internal"
      HTTP_PORT=0
      info "域名留空，自动启用 IP 自签名 HTTPS：$DOMAIN"
    elif echo "$DOMAIN" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      CERT_MODE="internal"
      HTTP_PORT=0
    else
      if echo "$DOMAIN" | grep -Eq '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$'; then
        t="$(prompt "证书模式 [1=Let's Encrypt, 2=自签名]（默认1）: ")"
        if [ "$t" = "2" ]; then
          CERT_MODE="internal"
          HTTP_PORT=0
        else
          CERT_MODE="letsencrypt"
          HTTP_PORT="${HTTP_PORT:-80}"
        fi
      else
        warn "域名格式无效，自动回退到 IP 自签名 HTTPS"
        DOMAIN="$(detect_local_ip)"
        CERT_MODE="internal"
        HTTP_PORT=0
      fi
    fi
  else
    if [ -z "$DOMAIN" ]; then
      DOMAIN="$(detect_local_ip)"
      CERT_MODE="internal"
    fi
    HTTPS_ENABLED="true"
    [ "$CERT_MODE" = "letsencrypt" ] && HTTP_PORT="${HTTP_PORT:-80}" || HTTP_PORT=0
  fi

  if [ "$CERT_MODE" = "letsencrypt" ]; then
    [ "$HTTP_PORT" -eq 0 ] && HTTP_PORT=80
    HTTP_PORT="$(find_available_port "$HTTP_PORT" 8080 8099)"
  else
    HTTP_PORT=0
  fi

  HTTPS_PORT="${HTTPS_PORT:-443}"
  [ "$HTTPS_PORT" -eq 0 ] && HTTPS_PORT=443
  if has_tty; then
    HTTPS_PORT="$(prompt_port_or_default "HTTPS 端口" "$HTTPS_PORT")"
  fi
  HTTPS_PORT="$(find_available_port "$HTTPS_PORT" 8443 8499)"

  SSH_PORT="${SSH_PORT:-2222}"
  [ "$SSH_PORT" -eq 0 ] && SSH_PORT=2222
  SSH_PORT="$(find_available_port "$SSH_PORT" 2223 2299)"

  apply_port_conflicts
  info "最终端口：Gateway=${GW_PORT}, Web=${WEB_PORT}, SSH=${SSH_PORT}, HTTPS=${HTTPS_PORT}（HTTPS 留空或冲突会自动调整）"
}

# ─── upgrade detection ────────────────────────────────────────

show_upgrade_detection(){
  local installed_tag container_version
  installed_tag="$(safe_json_value release_tag)"
  container_version="$(docker exec "$CONTAINER_NAME" sh -lc 'cat /etc/openclaw-version 2>/dev/null || true' 2>/dev/null | head -1 | tr -d '\r' || true)"
  [ -z "$installed_tag" ] && [ -n "$container_version" ] && installed_tag="$container_version"

  if [ -z "$installed_tag" ]; then
    info "升级检测：未发现已安装版本标记，将执行全量镜像更新。"
  elif [ -n "$TAG" ] && [ "$installed_tag" = "$TAG" ]; then
    info "升级检测：当前版本 ${installed_tag} 与最新版本一致。"
  elif [ -n "$TAG" ]; then
    info "升级检测：当前 ${installed_tag} → 最新 ${TAG}，将执行升级。"
  else
    info "升级检测：当前版本 ${installed_tag}（无法获取远程最新 tag）。"
  fi
}


get_installed_release_tag(){
  local installed_tag container_version
  installed_tag="$(safe_json_value release_tag)"
  container_version="$(docker exec "$CONTAINER_NAME" sh -lc 'cat /etc/openclaw-version 2>/dev/null || true' 2>/dev/null | head -1 | tr -d '\r' || true)"
  [ -z "$installed_tag" ] && [ -n "$container_version" ] && installed_tag="$container_version"
  printf '%s' "$installed_tag"
}

can_hotpatch_current_container(){
  docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | head -1 | grep -q "^${CONTAINER_NAME}$" || return 1
  docker exec "$CONTAINER_NAME" sh -lc "command -v curl >/dev/null 2>&1" >/dev/null 2>&1 || return 1
  docker exec "$CONTAINER_NAME" sh -lc "curl -sS -f --connect-timeout 3 --max-time 8 http://127.0.0.1:3000/api/update/hotpatch/status >/dev/null" >/dev/null 2>&1
}

prompt_hotpatch_first_if_applicable(){
  local installed_tag continue_install
  installed_tag="$(get_installed_release_tag)"
  [ -z "$installed_tag" ] && return 0
  [ -z "$TAG" ] && return 0
  [ "$installed_tag" = "$TAG" ] && return 0

  if can_hotpatch_current_container; then
    printf "\n💡 检测到新 Release 且可热更新（目标版本: %s，无需完整重装）\n" "$TAG" > "$TTY_IN"
    printf "   当前版本: %s\n" "$installed_tag" > "$TTY_IN"
    printf "   建议先在 Web 面板 → 系统更新 执行热更新。\n\n" > "$TTY_IN"
    printf "推荐操作：\n" > "$TTY_IN"
    printf "  [默认 N] 先执行 Web 热更新（推荐）\n" > "$TTY_IN"
    printf "  [输入 y] 继续完整重装流程\n\n" > "$TTY_IN"
    printf "⚠️  完整重装风险提示：\n" > "$TTY_IN"
    printf "  - 将删除并重建容器（容器文件系统会重置）\n" > "$TTY_IN"
    printf "  - 容器内手工安装的软件/临时文件可能丢失\n" > "$TTY_IN"
    printf "  - 挂载的 home-data 与配置会保留\n\n" > "$TTY_IN"
    continue_install="$(prompt "是否继续执行安装重装流程？[y/N]: ")"
    continue_install="$(echo "$continue_install" | tr '[:upper:]' '[:lower:]')"
    if [ "$continue_install" != "y" ] && [ "$continue_install" != "yes" ]; then
      warn "已取消本次安装流程，请在 Web 面板执行热更新。"
      info "热更新后可再次运行安装脚本（如有需要）。"
      exit 0
    fi
  fi
}


reset_home_data_dir(){
  if rm -rf "$HOME_DIR" 2>/dev/null; then
    mkdir -p "$HOME_DIR/.openclaw"
    return 0
  fi

  warn "普通权限删除 home-data 失败，尝试通过 Docker 提权清理..."
  if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    if docker run --rm -v "$BASE_DIR:/work" --entrypoint sh "$IMAGE_NAME" -lc 'rm -rf /work/home-data' >/dev/null 2>&1; then
      mkdir -p "$HOME_DIR/.openclaw"
      return 0
    fi
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    if sudo rm -rf "$HOME_DIR" >/dev/null 2>&1; then
      sudo mkdir -p "$HOME_DIR/.openclaw" >/dev/null 2>&1 || true
      sudo chown -R "$(id -u):$(id -g)" "$HOME_DIR" >/dev/null 2>&1 || true
      return 0
    fi
  fi

  warn "未能完全清理 home-data（权限受限），将保留目录继续。"
  mkdir -p "$HOME_DIR/.openclaw"
}


# ─── existing container handling ──────────────────────────────

handle_existing_installation(){
  local exists running choice installed_tag latest_matched
  exists="$(docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | head -1 || true)"
  running="$(docker ps   --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | head -1 || true)"
  [ -z "$exists" ] && [ ! -f "$CONFIG_FILE" ] && return 0

  warn "检测到已有安装（容器或配置已存在）。"
  show_upgrade_detection

  installed_tag="$(get_installed_release_tag)"
  latest_matched="false"
  if [ -n "$installed_tag" ] && [ -n "$TAG" ] && [ "$installed_tag" = "$TAG" ]; then
    latest_matched="true"
  fi

  if has_tty; then
    prompt_hotpatch_first_if_applicable
  fi

  if has_tty; then
    printf "处理方式：
" > "$TTY_IN"
    if [ "$latest_matched" = "true" ]; then
      printf "  [1] 重装（保留数据，重新配置端口/HTTPS）
" > "$TTY_IN"
      printf "  [2] 全新重装（删除旧数据）
" > "$TTY_IN"
      printf "  [3] 退出
" > "$TTY_IN"
      choice="$(prompt "当前已是最新版本，请选择 1/2/3（默认1）: ")"
    else
      printf "  [1] 升级（默认，保留数据与配置）
" > "$TTY_IN"
      printf "  [2] 重装（保留数据，重新配置端口/HTTPS）
" > "$TTY_IN"
      printf "  [3] 全新重装（删除旧数据）
" > "$TTY_IN"
      printf "  [4] 退出
" > "$TTY_IN"
      choice="$(prompt "请选择 1/2/3/4（默认1）: ")"
    fi
  else
    choice="1"
  fi

  if [ "$latest_matched" = "true" ]; then
    case "${choice:-1}" in
      3) warn "用户取消安装。"; exit 0 ;;
      2) info "全新重装：删除旧容器与数据"
         docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
         reset_home_data_dir
         UPGRADE_MODE="false" ;;
      *) info "重装（保留数据目录）"
         docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
         UPGRADE_MODE="false" ;;
    esac
  else
    case "${choice:-1}" in
      4) warn "用户取消安装。"; exit 0 ;;
      3) info "全新重装：删除旧容器与数据"
         docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
         reset_home_data_dir
         UPGRADE_MODE="false" ;;
      2) info "重装（保留数据目录）"
         docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
         UPGRADE_MODE="false" ;;
      *) info "升级模式（保留数据与配置）"
         load_existing_config || true
         docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
         UPGRADE_MODE="true" ;;
    esac
  fi

  [ -n "$running" ] && info "已停止并替换运行中的容器：$CONTAINER_NAME"
}

# ─── firewall & fail2ban ─────────────────────────────────────

configure_firewall_and_fail2ban(){
  if [ "$(id -u)" -ne 0 ]; then
    warn "未以 root 运行，跳过宿主机 ufw/fail2ban 配置（不影响容器运行）。"
    return 0
  fi

  if [ -z "$DO_FIREWALL" ] && has_tty; then
    local ans
    ans="$(prompt "是否自动配置防火墙和 fail2ban？[Y/n]: ")"
    ans="$(echo "$ans" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$ans" ] || [ "$ans" = "y" ] || [ "$ans" = "yes" ]; then
      DO_FIREWALL="y"
    else
      DO_FIREWALL="n"
    fi
  fi
  [ -z "$DO_FIREWALL" ] && DO_FIREWALL="y"
  [ "$DO_FIREWALL" != "y" ] && { info "跳过防火墙配置"; return 0; }

  # ufw
  if ! command -v ufw >/dev/null 2>&1; then
    info "安装 ufw..."; apt-get update -y >/dev/null 2>&1 || true; apt-get install -y ufw >/dev/null 2>&1 || true
  fi
  if command -v ufw >/dev/null 2>&1; then
    ufw default deny incoming  >/dev/null 2>&1 || true
    ufw default allow outgoing >/dev/null 2>&1 || true
    ufw allow 22/tcp >/dev/null 2>&1 || true
    ufw allow "${SSH_PORT}/tcp" >/dev/null 2>&1 || true
    if [ "$HTTPS_ENABLED" = "true" ] && [ "$CERT_MODE" = "letsencrypt" ]; then
      [ "$HTTP_PORT"  -gt 0 ] 2>/dev/null && ufw allow "${HTTP_PORT}/tcp"  >/dev/null 2>&1 || true
      [ "$HTTPS_PORT" -gt 0 ] 2>/dev/null && ufw allow "${HTTPS_PORT}/tcp" >/dev/null 2>&1 || true
      success "ufw 放行: 22/${SSH_PORT}/${HTTP_PORT}/${HTTPS_PORT}"
    elif [ "$HTTPS_ENABLED" = "true" ]; then
      [ "$HTTPS_PORT" -gt 0 ] 2>/dev/null && ufw allow "${HTTPS_PORT}/tcp" >/dev/null 2>&1 || true
      success "ufw 放行: 22/${SSH_PORT}/${HTTPS_PORT}"
    else
      ufw allow "${GW_PORT}/tcp"  >/dev/null 2>&1 || true
      ufw allow "${WEB_PORT}/tcp" >/dev/null 2>&1 || true
      success "ufw 放行: 22/${SSH_PORT}/${GW_PORT}/${WEB_PORT}"
    fi
    ufw --force enable >/dev/null 2>&1 || true
    success "ufw 防火墙已启用"
  else
    warn "ufw 不可用，跳过防火墙配置"
  fi

  # fail2ban
  if ! command -v fail2ban-client >/dev/null 2>&1; then
    apt-get install -y fail2ban >/dev/null 2>&1 || true
  fi
  if command -v fail2ban-client >/dev/null 2>&1; then
    mkdir -p /etc/fail2ban
    cat > /etc/fail2ban/jail.local <<'F2B'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 30m
F2B
    systemctl enable --now fail2ban >/dev/null 2>&1 || true
    success "fail2ban 已启用（sshd: 5 次失败封 30 分钟）"
  else
    warn "fail2ban 不可用，跳过"
  fi
}

# ─── container create & start ─────────────────────────────────

create_and_start(){
  local host_user host_user_created key_injected
  host_user="$(id -un 2>/dev/null || true)"
  host_user_created="false"
  key_injected="false"

  mkdir -p "$HOME_DIR/.openclaw"
  chmod 700 "$HOME_DIR" || true
  write_config

  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

  # Build port arguments
  local port_args=()
  if [ "$HTTPS_ENABLED" = "true" ] && [ "$CERT_MODE" = "letsencrypt" ]; then
    port_args+=(-p "${HTTP_PORT}:80" -p "${HTTPS_PORT}:443" -p "127.0.0.1:${GW_PORT}:18789" -p "127.0.0.1:${WEB_PORT}:3000" -p "${SSH_PORT}:22")
  elif [ "$HTTPS_ENABLED" = "true" ]; then
    port_args+=(-p "${HTTPS_PORT}:443" -p "127.0.0.1:${GW_PORT}:18789" -p "127.0.0.1:${WEB_PORT}:3000" -p "${SSH_PORT}:22")
  else
    port_args+=(-p "${GW_PORT}:18789" -p "${WEB_PORT}:3000" -p "${SSH_PORT}:22")
  fi

  info "创建容器..."
  docker create --name "$CONTAINER_NAME" \
    --hostname openclaw \
    --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
    --cap-add NET_BIND_SERVICE --cap-add KILL --cap-add DAC_OVERRIDE \
    --cap-add FOWNER --cap-add SYS_CHROOT --cap-add AUDIT_WRITE \
    --security-opt no-new-privileges \
    -v "$HOME_DIR:/root" \
    "${port_args[@]}" \
    -e "TZ=${TZ_VALUE}" -e "DOMAIN=${DOMAIN}" -e "CERT_MODE=${CERT_MODE}" \
    --restart unless-stopped \
    "$IMAGE_NAME"

  info "启动容器..."
  docker start "$CONTAINER_NAME"
  sleep 2
  if [ -n "$ROOT_PASS" ]; then
    info "检测到 ROOT_PASS，设置容器内 root 密码"
    echo "root:${ROOT_PASS}" | docker exec -i "$CONTAINER_NAME" chpasswd || true
  fi

  # SSH hardening
  docker exec "$CONTAINER_NAME" bash -lc "mkdir -p /run/sshd && (/usr/sbin/sshd >/dev/null 2>&1 || service ssh start >/dev/null 2>&1 || true)" >/dev/null 2>&1 || true
  docker exec "$CONTAINER_NAME" bash -lc "mkdir -p /etc/ssh/sshd_config.d && printf '%s\n' \
    'PermitRootLogin no' \
    'PasswordAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'ChallengeResponseAuthentication no' \
    'PubkeyAuthentication yes' \
    > /etc/ssh/sshd_config.d/99-openclaw-security.conf" >/dev/null 2>&1 || true
  docker exec "$CONTAINER_NAME" bash -lc "
    if [ -f /etc/ssh/sshd_config ]; then
      sed -i -E 's|^[#[:space:]]*PermitRootLogin[[:space:]]+.*|PermitRootLogin no|' /etc/ssh/sshd_config
      sed -i -E 's|^[#[:space:]]*PasswordAuthentication[[:space:]]+.*|PasswordAuthentication no|' /etc/ssh/sshd_config
      sed -i -E 's|^[#[:space:]]*KbdInteractiveAuthentication[[:space:]]+.*|KbdInteractiveAuthentication no|' /etc/ssh/sshd_config
      sed -i -E 's|^[#[:space:]]*ChallengeResponseAuthentication[[:space:]]+.*|ChallengeResponseAuthentication no|' /etc/ssh/sshd_config
    fi" >/dev/null 2>&1 || true
  docker exec "$CONTAINER_NAME" bash -lc "mkdir -p /run/sshd; pkill -x sshd >/dev/null 2>&1 || true; (/usr/sbin/sshd >/dev/null 2>&1 || service ssh restart >/dev/null 2>&1 || true)" >/dev/null 2>&1 || true

  # Create host-mapped normal user (optional best-effort)
  if [ -n "$host_user" ] && [ "$host_user" != "root" ]; then
    if [[ "$host_user" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
      if docker exec "$CONTAINER_NAME" bash -lc "id -u '$host_user' >/dev/null 2>&1 || (useradd -m -s /bin/bash '$host_user' >/dev/null 2>&1 || adduser --disabled-password --gecos '' '$host_user' >/dev/null 2>&1)"; then
        docker exec "$CONTAINER_NAME" bash -lc "usermod -aG sudo '$host_user' >/dev/null 2>&1 || true" >/dev/null 2>&1
        docker exec "$CONTAINER_NAME" bash -lc "printf '%s\n' '$host_user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-openclaw-host-user && chmod 440 /etc/sudoers.d/90-openclaw-host-user" || true
        host_user_created="true"
        info "已在容器中创建同名用户：$host_user"
      fi
    fi
  fi

  # Public key injection
  for keyfile in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub" "$HOME/.ssh/id_ecdsa.pub"; do
    if [ -f "$keyfile" ]; then
      key_injected="true"
      info "注入公钥 $(basename "$keyfile") 到容器"
      docker exec "$CONTAINER_NAME" bash -lc "mkdir -p /root/.ssh && chmod 700 /root/.ssh" >/dev/null 2>&1
      docker cp "$keyfile" "$CONTAINER_NAME":/root/.ssh/authorized_keys.tmp >/dev/null 2>&1
      docker exec "$CONTAINER_NAME" bash -lc "cat /root/.ssh/authorized_keys.tmp >> /root/.ssh/authorized_keys && sort -u -o /root/.ssh/authorized_keys /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && rm -f /root/.ssh/authorized_keys.tmp" >/dev/null 2>&1

      if [ "$host_user_created" = "true" ]; then
        docker exec "$CONTAINER_NAME" bash -lc "mkdir -p '/home/$host_user/.ssh' && chmod 700 '/home/$host_user/.ssh' && chown -R '$host_user:$host_user' '/home/$host_user/.ssh'" >/dev/null 2>&1
        docker cp "$keyfile" "$CONTAINER_NAME":/tmp/host_user_authorized_keys.tmp >/dev/null 2>&1
        docker exec "$CONTAINER_NAME" bash -lc "cat /tmp/host_user_authorized_keys.tmp >> '/home/$host_user/.ssh/authorized_keys' && sort -u -o '/home/$host_user/.ssh/authorized_keys' '/home/$host_user/.ssh/authorized_keys' && chmod 600 '/home/$host_user/.ssh/authorized_keys' && chown '$host_user:$host_user' '/home/$host_user/.ssh/authorized_keys' && rm -f /tmp/host_user_authorized_keys.tmp" >/dev/null 2>&1
      fi
      break
    fi
  done

  configure_firewall_and_fail2ban

  success "容器已部署并启动"
  if [ "$HTTPS_ENABLED" = "true" ]; then
    local url_suffix=""
    [ "$HTTPS_PORT" != "443" ] && url_suffix=":${HTTPS_PORT}"
    info "访问：主站 https://${DOMAIN}${url_suffix}  管理面板 https://${DOMAIN}${url_suffix}/admin"
  else
    info "访问：Gateway http://<host>:${GW_PORT}  管理面板 http://<host>:${WEB_PORT}"
  fi
  info "SSH 密码登录：已禁用（仅密钥登录）"
  if [ "$host_user_created" = "true" ] && [ "$key_injected" = "true" ]; then
    info "同名用户登录：SSH ${host_user}@<host> -p ${SSH_PORT}"
    info "容器内提权：ssh 登录后执行 sudo -i"
  else
    info "SSH 登录：请使用已注入公钥登录，端口 ${SSH_PORT}"
  fi
  if [ -n "$ROOT_PASS" ]; then
    info "root 密码由 ROOT_PASS 提供（未写入本地文件）"
  fi
  info "日志文件：$LOG_FILE"
}

# ─── main ─────────────────────────────────────────────────────

main(){
  init_dirs
  ensure_docker
  ensure_latest_tag

  info "Image-only 安装（仅下载 release 镜像，不克隆源码）"
  info "工作目录：$BASE_DIR"

  handle_existing_installation
  ensure_root_password

  if [ "$UPGRADE_MODE" = "true" ]; then
    info "升级模式：沿用已有配置（可通过环境变量覆盖端口/域名）"
    apply_port_conflicts
  else
    prompt_deploy_config
  fi

  if ! load_image; then
    warn "本地镜像不可用，开始自动下载修复"
    if download_tarball && load_image; then
      info "自动下载修复成功"
    else
      warn "自动下载修复失败，尝试 GHCR 回退"
      if ! pull_from_ghcr; then
        warn "GHCR 回退也失败，请检查网络后重试"
        exit 1
      fi
    fi
  fi

  create_and_start
}

main "$@"
