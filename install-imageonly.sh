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
DEFAULT_BASE_DIR_NAME=".openclaw-pro"
TARGET_DIR="$HOME"

BASE_DIR="${TARGET_DIR}/${DEFAULT_BASE_DIR_NAME}"
TMP_DIR="$BASE_DIR"
STATE_VOLUME_NAME="${STATE_VOLUME_NAME:-openclaw-pro-state}"
STATE_MOUNT_POINT="/root/.openclaw"
CONFIG_CACHE_FILE="$BASE_DIR/.docker-config.cache.json"
LEGACY_HOME_DIR="$BASE_DIR/home-data"
LEGACY_ROOT_HOME_DIR="$LEGACY_HOME_DIR/root"
CONFIG_FILE_LEGACY_ROOT="$LEGACY_ROOT_HOME_DIR/.openclaw/docker-config.json"
CONFIG_FILE_LEGACY="$LEGACY_HOME_DIR/.openclaw/docker-config.json"
LOG_FILE="$BASE_DIR/install.log"
ROOT_PASSWORD_FILE="$BASE_DIR/root-initial-password.txt"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

PROXY_PREFIXES=(
  "https://ghfast.top/"
  "https://gh-proxy.com/"
  "https://ghproxy.net/"
  "https://mirror.ghproxy.com/"
)

TTY_IN="/dev/tty"
has_tty(){ [ -r "$TTY_IN" ] && [ -w "$TTY_IN" ]; }

if [ -t 1 ]; then
  NC='\033[0m'
  DIM='\033[2m'
  CYAN='\033[1;36m'
  GREEN='\033[1;32m'
  YELLOW='\033[1;33m'
  RED='\033[1;31m'
  WHITE='\033[1;37m'
else
  NC=''
  DIM=''
  CYAN=''
  GREEN=''
  YELLOW=''
  RED=''
  WHITE=''
fi

TAG=""
IMAGE_TARBALL="$IMAGE_TARBALL_LITE"
GW_PORT="${GW_PORT:-18789}"
GW_TLS_PORT="${GW_TLS_PORT:-18790}"
WEB_PORT="${WEB_PORT:-3000}"
SSH_PORT="${SSH_PORT:-2222}"
HTTP_PORT="${HTTP_PORT:-0}"
HTTPS_PORT="${HTTPS_PORT:-0}"
DOMAIN="${DOMAIN:-}"
CERT_MODE="${CERT_MODE:-letsencrypt}"
TZ_VALUE="${TZ_VALUE:-Asia/Shanghai}"
HTTPS_ENABLED="true"
ROOT_PASS="${ROOT_PASS:-}"
DO_FIREWALL="${DO_FIREWALL:-}"
BROWSER_BRIDGE_ENABLED="${BROWSER_BRIDGE_ENABLED:-}"
BRIDGE_PORT="${BRIDGE_PORT:-0}"
UPGRADE_MODE="false"

ensure_state_volume(){
  docker volume inspect "$STATE_VOLUME_NAME" >/dev/null 2>&1 || docker volume create "$STATE_VOLUME_NAME" >/dev/null
}

run_state_helper(){
  local script="$1"
  ensure_state_volume
  docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 || return 1

  docker run --rm \
    --platform "$DOCKER_PLATFORM" \
    -v "$STATE_VOLUME_NAME:$STATE_MOUNT_POINT" \
    --entrypoint bash \
    "$IMAGE_NAME" \
    -lc "mkdir -p '$STATE_MOUNT_POINT' && $script"
}

read_state_file(){
  local relpath="$1"
  run_state_helper "test -f '$STATE_MOUNT_POINT/$relpath' && cat '$STATE_MOUNT_POINT/$relpath' || true"
}

write_state_file(){
  local relpath="$1"
  local mode="${2:-600}"
  local dirpart tmpfile
  dirpart="$(dirname "$relpath")"
  tmpfile="$(mktemp)"
  cat > "$tmpfile"

  ensure_state_volume
  if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    rm -f "$tmpfile"
    return 1
  fi

  docker run --rm \
    --platform "$DOCKER_PLATFORM" \
    -v "$STATE_VOLUME_NAME:$STATE_MOUNT_POINT" \
    -v "$tmpfile:/tmp/openclaw-state-input:ro" \
    --entrypoint bash \
    "$IMAGE_NAME" \
    -lc "mkdir -p '$STATE_MOUNT_POINT/$dirpart' && cat /tmp/openclaw-state-input > '$STATE_MOUNT_POINT/$relpath' && chmod $mode '$STATE_MOUNT_POINT/$relpath'"
  local rc=$?
  rm -f "$tmpfile"
  return $rc
}

refresh_config_cache(){
  local tmpfile=""
  rm -f "$CONFIG_CACHE_FILE" 2>/dev/null || true

  if docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' 2>/dev/null | head -1 | grep -q "^${CONTAINER_NAME}$"; then
    tmpfile="$(mktemp)"
    if docker exec "$CONTAINER_NAME" sh -c 'cat /root/.openclaw/docker-config.json 2>/dev/null || true' > "$tmpfile" 2>/dev/null && [ -s "$tmpfile" ]; then
      mv -f "$tmpfile" "$CONFIG_CACHE_FILE"
      return 0
    fi
    rm -f "$tmpfile"
  fi

  if docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' 2>/dev/null | head -1 | grep -q "^${CONTAINER_NAME}$"; then
    tmpfile="$(mktemp)"
    if docker cp "${CONTAINER_NAME}:/root/.openclaw/docker-config.json" "$tmpfile" >/dev/null 2>&1 && [ -s "$tmpfile" ]; then
      mv -f "$tmpfile" "$CONFIG_CACHE_FILE"
      return 0
    fi
    rm -f "$tmpfile"
  fi

  if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 && docker volume inspect "$STATE_VOLUME_NAME" >/dev/null 2>&1; then
    tmpfile="$(mktemp)"
    if read_state_file "docker-config.json" > "$tmpfile" 2>/dev/null && [ -s "$tmpfile" ]; then
      mv -f "$tmpfile" "$CONFIG_CACHE_FILE"
      return 0
    fi
    rm -f "$tmpfile"
  fi

  if [ -f "$CONFIG_FILE_LEGACY_ROOT" ]; then
    cp -f "$CONFIG_FILE_LEGACY_ROOT" "$CONFIG_CACHE_FILE" 2>/dev/null || true
  elif [ -f "$CONFIG_FILE_LEGACY" ]; then
    cp -f "$CONFIG_FILE_LEGACY" "$CONFIG_CACHE_FILE" 2>/dev/null || true
  fi
}

resolve_config_file(){
  if [ -f "$CONFIG_CACHE_FILE" ]; then
    printf '%s' "$CONFIG_CACHE_FILE"
  elif [ -f "$CONFIG_FILE_LEGACY_ROOT" ]; then
    printf '%s' "$CONFIG_FILE_LEGACY_ROOT"
  elif [ -f "$CONFIG_FILE_LEGACY" ]; then
    printf '%s' "$CONFIG_FILE_LEGACY"
  fi
}

# ─── helpers ──────────────────────────────────────────────────

normalize_base_dir(){
  BASE_DIR="${HOME}/$DEFAULT_BASE_DIR_NAME"

  TMP_DIR="$BASE_DIR"
  CONFIG_CACHE_FILE="$BASE_DIR/.docker-config.cache.json"
  LEGACY_HOME_DIR="$BASE_DIR/home-data"
  LEGACY_ROOT_HOME_DIR="$LEGACY_HOME_DIR/root"
  CONFIG_FILE_LEGACY_ROOT="$LEGACY_ROOT_HOME_DIR/.openclaw/docker-config.json"
  CONFIG_FILE_LEGACY="$LEGACY_HOME_DIR/.openclaw/docker-config.json"
  LOG_FILE="$BASE_DIR/install.log"
  ROOT_PASSWORD_FILE="$BASE_DIR/root-initial-password.txt"
}

normalize_release_tag(){
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  if [[ "$raw" =~ ^v[0-9]+(\.[0-9]+){1,3}([.-][A-Za-z0-9._-]+)?$ ]]; then
    printf '%s' "$raw"
  fi
}

get_container_release_tag(){
  docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' 2>/dev/null | head -1 | grep -q "^${CONTAINER_NAME}$" || return 0
  local v
  v="$(docker exec "$CONTAINER_NAME" sh -c 'cat /etc/openclaw-version 2>/dev/null || true' 2>/dev/null | head -1 || true)"
  normalize_release_tag "$v"
}

init_dirs(){
  mkdir -p "$TMP_DIR"
  refresh_config_cache || true
  touch "$LOG_FILE" 2>/dev/null || true
}

log(){
  local level="$1"; shift
  local msg="$*"
  local ts
  local prefix="[$level]"
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  if [ -t 1 ]; then
    case "$level" in
      INFO) prefix="${CYAN}[INFO]${NC}" ;;
      WARN) prefix="${YELLOW}[WARN]${NC}" ;;
      OK) prefix="${GREEN}[OK]${NC}" ;;
      ERROR) prefix="${RED}[ERROR]${NC}" ;;
    esac
  fi
  printf '%b %s\n' "$prefix" "$msg"
  echo "[$ts] [$level] $msg" >> "$LOG_FILE" 2>/dev/null || true
}
info(){ log INFO "$*"; }
warn(){ log WARN "$*"; }
success(){ log OK "$*"; }

print_summary_line(){
  local label="$1"
  local value="$2"
  local target_width=6
  # Display width: ASCII=1col, CJK(3-byte UTF-8)=2col
  local byte_len char_count cjk_count display_width
  byte_len=$(printf '%s' "$label" | wc -c | tr -d ' ')
  char_count=$(printf '%s' "$label" | wc -m | tr -d ' ')
  cjk_count=$(( (byte_len - char_count) / 2 ))
  display_width=$(( char_count + cjk_count ))
  local pad=""
  while [ "$display_width" -lt "$target_width" ]; do
    pad="$pad "
    display_width=$((display_width + 1))
  done
  printf '  %b%s%s%b %b%s%b\n' "$YELLOW" "$label" "$pad" "$NC" "$CYAN" "$value" "$NC"
}

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
  if ! command -v docker &>/dev/null; then
    warn "未检测到 Docker，请先安装 Docker 并重试"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo ""
    warn "Docker 已安装但 Docker daemon 未运行"
    case "$(uname -s 2>/dev/null)" in
      Darwin*) warn "请先启动 Docker Desktop，然后重新运行安装脚本" ;;
      *)       warn "请先启动 Docker daemon（sudo systemctl start docker 或启动 Docker Desktop），然后重新运行安装脚本" ;;
    esac
    exit 1
  fi
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

  local ngt
  ngt="$(find_available_port "$GW_TLS_PORT" 18800 18999)"
  if [ "$ngt" != "$GW_TLS_PORT" ]; then
    warn "Gateway TLS 端口 ${GW_TLS_PORT} 已占用，自动调整为 ${ngt}"
    GW_TLS_PORT="$ngt"
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
  local cfg
  cfg="$(resolve_config_file)"
  [ ! -f "$cfg" ] && return 0
  grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"${key}\"[[:space:]]*:[[:space:]]*[0-9]+|\"${key}\"[[:space:]]*:[[:space:]]*(true|false)" \
    "$cfg" 2>/dev/null | head -1 | sed -E 's/^.*:[[:space:]]*//; s/^"//; s/"$//' || true
}

load_existing_config(){
  refresh_config_cache || true
  [ ! -f "$CONFIG_CACHE_FILE" ] && [ ! -f "$CONFIG_FILE_LEGACY_ROOT" ] && [ ! -f "$CONFIG_FILE_LEGACY" ] && return 1
  local v
  v="$(safe_json_value port)";       [ -n "$v" ] && GW_PORT="$v"
  v="$(safe_json_value gateway_tls_port)"; [ -n "$v" ] && GW_TLS_PORT="$v"
  v="$(safe_json_value web_port)";   [ -n "$v" ] && WEB_PORT="$v"
  v="$(safe_json_value ssh_port)";   [ -n "$v" ] && SSH_PORT="$v"
  v="$(safe_json_value http_port)";  [ -n "$v" ] && HTTP_PORT="$v"
  v="$(safe_json_value https_port)"; [ -n "$v" ] && HTTPS_PORT="$v"
  v="$(safe_json_value domain)";     DOMAIN="$v"
  v="$(safe_json_value cert_mode)";  [ -n "$v" ] && CERT_MODE="$v"
  v="$(safe_json_value timezone)";   [ -n "$v" ] && TZ_VALUE="$v"
  HTTPS_ENABLED="true"
  if [ -z "$DOMAIN" ]; then HTTP_PORT=0; HTTPS_PORT=0; fi
  return 0
}

write_config(){
  cat <<EOF | write_state_file "docker-config.json" 600
{
  "port": ${GW_PORT},
  "gateway_tls_port": ${GW_TLS_PORT},
  "gateway_tls_public_port": ${GW_TLS_PORT},
  "web_port": ${WEB_PORT},
  "ssh_port": ${SSH_PORT},
  "http_port": ${HTTP_PORT},
  "https_port": ${HTTPS_PORT},
  "domain": "${DOMAIN}",
  "cert_mode": "${CERT_MODE}",
  "timezone": "${TZ_VALUE}",
  "https_enabled": ${HTTPS_ENABLED},
  "browser_bridge_enabled": ${BROWSER_BRIDGE_ENABLED:-false},
  "browser_bridge_port": ${BRIDGE_PORT:-0},
  "release_tag": "${TAG:-unknown}"
}
EOF
  cat <<EOF > "$CONFIG_CACHE_FILE"
{
  "port": ${GW_PORT},
  "gateway_tls_port": ${GW_TLS_PORT},
  "gateway_tls_public_port": ${GW_TLS_PORT},
  "web_port": ${WEB_PORT},
  "ssh_port": ${SSH_PORT},
  "http_port": ${HTTP_PORT},
  "https_port": ${HTTPS_PORT},
  "domain": "${DOMAIN}",
  "cert_mode": "${CERT_MODE}",
  "timezone": "${TZ_VALUE}",
  "https_enabled": ${HTTPS_ENABLED},
  "browser_bridge_enabled": ${BROWSER_BRIDGE_ENABLED:-false},
  "browser_bridge_port": ${BRIDGE_PORT:-0},
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
  local out=()
  for p in "${PROXY_PREFIXES[@]}"; do out+=("${p}${primary}"); done
  out+=("$primary")
  printf '%s\n' "${out[@]}"
}

curl_supports_retry_all_errors(){
  curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'
}

probe_range_capable_source(){
  local url header_file probe_file status_line probe_hex
  header_file="${TMP_DIR}/.download-probe.$$"
  probe_file="${TMP_DIR}/.download-probe-body.$$"

  for url in "$@"; do
    rm -f "$header_file" 2>/dev/null || true
    rm -f "$probe_file" 2>/dev/null || true
    if curl -r 0-2 -fsSL --connect-timeout 8 --max-time 20 -D "$header_file" -o "$probe_file" "$url" 2>/dev/null; then
      status_line="$(awk 'toupper($0) ~ /^HTTP\// { line=$0 } END { print line }' "$header_file" 2>/dev/null || true)"
      probe_hex="$(od -An -tx1 -N 3 "$probe_file" 2>/dev/null | tr -d '[:space:]' || true)"
      if { printf '%s\n' "$status_line" | grep -Eq ' 206 '; } || grep -Eiq '^content-range:[[:space:]]*bytes[[:space:]]+0-2/[0-9]+' "$header_file"; then
        if [ "$probe_hex" = "1f8b08" ]; then
          printf '%s\n' "$url"
        fi
      fi
    fi
  done

  rm -f "$header_file" 2>/dev/null || true
  rm -f "$probe_file" 2>/dev/null || true
}

clear_chunk_cache(){
  local output="$1"
  rm -rf "${output}.chunks" "${output}.chunks.meta" 2>/dev/null || true
}

format_mib(){
  awk -v n="${1:-0}" 'BEGIN{printf "%.2f", n/1024/1024}'
}

determine_chunk_parallelism(){
  local total_chunks="$1"
  local jobs=""

  jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  if ! [[ "$jobs" =~ ^[0-9]+$ ]] || [ "$jobs" -le 0 ]; then
    jobs="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  fi
  if ! [[ "$jobs" =~ ^[0-9]+$ ]] || [ "$jobs" -le 0 ]; then
    jobs=4
  fi

  if [ "$jobs" -gt 8 ]; then
    jobs=8
  fi
  if [ "$jobs" -lt 2 ] && [ "$total_chunks" -gt 1 ]; then
    jobs=2
  fi
  if [ "$jobs" -gt "$total_chunks" ]; then
    jobs="$total_chunks"
  fi
  if [ "$jobs" -lt 1 ]; then
    jobs=1
  fi

  printf '%s\n' "$jobs"
}

summarize_chunk_progress(){
  local chunk_dir="$1"
  local completed_bytes=0
  local completed_chunks=0
  local chunk_file actual_size

  for chunk_file in "$chunk_dir"/chunk.*.part; do
    [ -e "$chunk_file" ] || break
    actual_size="$(wc -c < "$chunk_file" 2>/dev/null | tr -d '[:space:]' || echo 0)"
    if [[ "$actual_size" =~ ^[0-9]+$ ]] && [ "$actual_size" -gt 0 ]; then
      completed_bytes=$(( completed_bytes + actual_size ))
      completed_chunks=$(( completed_chunks + 1 ))
    fi
  done

  printf '%s %s\n' "$completed_bytes" "$completed_chunks"
}

render_chunk_progress_line(){
  local completed_bytes="$1"
  local total_bytes="$2"
  local completed_chunks="$3"
  local total_chunks="$4"
  local speed_bytes_per_sec="$5"
  local pct=0 remaining_bytes=0 eta_seconds=0 eta_text="--"
  local completed_mib total_mib speed_mib

  if [ "$total_bytes" -gt 0 ] 2>/dev/null; then
    pct=$(( completed_bytes * 100 / total_bytes ))
    if [ "$pct" -gt 100 ]; then
      pct=100
    fi
    remaining_bytes=$(( total_bytes - completed_bytes ))
    if [ "$remaining_bytes" -lt 0 ]; then
      remaining_bytes=0
    fi
  fi

  if [ "$speed_bytes_per_sec" -gt 0 ] 2>/dev/null && [ "$remaining_bytes" -gt 0 ] 2>/dev/null; then
    eta_seconds=$(( remaining_bytes / speed_bytes_per_sec ))
    eta_text="${eta_seconds}s"
  elif [ "$remaining_bytes" -eq 0 ] 2>/dev/null; then
    eta_text="0s"
  fi

  completed_mib="$(format_mib "$completed_bytes")"
  total_mib="$(format_mib "$total_bytes")"
  speed_mib="$(format_mib "$speed_bytes_per_sec")"

  printf '\r[INFO] 分块下载进度：%3d%% %s/%s MiB %s/%s 块 速度 %s MiB/s ETA %s' \
    "$pct" "$completed_mib" "$total_mib" "$completed_chunks" "$total_chunks" "$speed_mib" "$eta_text"
}

download_chunk_with_retry(){
  local url="$1"
  local chunk_file="$2"
  local start_byte="$3"
  local end_byte="$4"
  local expected_len="$5"
  local chunk_index="$6"
  local total_chunks="$7"
  local max_retry="${8:-20}"
  local attempt actual_size tmp_file
  local -a curl_args

  curl_args=(
    -fsSL
    --connect-timeout 15
    --max-time 900
    -r "${start_byte}-${end_byte}"
  )

  for attempt in $(seq 1 "$max_retry"); do
    tmp_file="${chunk_file}.tmp"
    mkdir -p "$(dirname "$chunk_file")" 2>/dev/null || true
    rm -f "$tmp_file" 2>/dev/null || true

    if curl "${curl_args[@]}" -o "$tmp_file" "$url" 2>/dev/null; then
      [ -f "$tmp_file" ] || continue
      actual_size="$(wc -c < "$tmp_file" 2>/dev/null | tr -d '[:space:]' || echo 0)"
      if [ "$actual_size" -eq "$expected_len" ] 2>/dev/null; then
        mv -f "$tmp_file" "$chunk_file"
        return 0
      fi
    fi

    rm -f "$tmp_file" 2>/dev/null || true
    sleep $(( attempt < 8 ? attempt : 8 ))
  done

  return 1
}

download_chunk_worker(){
  local url="$1"
  local chunk_dir="$2"
  local total_bytes="$3"
  local chunk_size="$4"
  local worker_index="$5"
  local worker_count="$6"
  local total_chunks="$7"
  local failure_file="$8"
  local idx start_byte end_byte expected_len actual_size chunk_file

  for ((idx=worker_index; idx<total_chunks; idx+=worker_count)); do
    [ ! -f "$failure_file" ] || return 1

    start_byte=$(( idx * chunk_size ))
    end_byte=$(( start_byte + chunk_size - 1 ))
    if [ "$end_byte" -ge "$total_bytes" ]; then
      end_byte=$(( total_bytes - 1 ))
    fi
    expected_len=$(( end_byte - start_byte + 1 ))
    chunk_file="$(printf '%s/chunk.%06d.part' "$chunk_dir" "$idx")"

    if [ -f "$chunk_file" ]; then
      actual_size="$(wc -c < "$chunk_file" 2>/dev/null | tr -d '[:space:]' || echo 0)"
      if [ "$actual_size" -eq "$expected_len" ] 2>/dev/null; then
        continue
      fi
      rm -f "$chunk_file" 2>/dev/null || true
    fi

    if ! download_chunk_with_retry "$url" "$chunk_file" "$start_byte" "$end_byte" "$expected_len" "$idx" "$total_chunks" 20; then
      printf '分块 %s/%s 下载失败，范围 %s-%s\n' "$((idx + 1))" "$total_chunks" "$start_byte" "$end_byte" > "$failure_file"
      return 1
    fi
  done

  return 0
}

download_tarball_chunked(){
  local url="$1"
  local output="$2"
  local total_bytes="$3"
  local expected_sig="$4"
  local chunk_size="$((2 * 1024 * 1024))"
  local chunk_dir="${output}.chunks"
  local chunk_meta="${output}.chunks.meta"
  local total_chunks completed_chunks idx start_byte end_byte expected_len actual_size
  local chunk_file assembled_file completed_mib total_mib chunk_jobs failure_file
  local completed_bytes progress_bytes progress_chunks progress_state now elapsed
  local speed_bytes_per_sec delta_bytes delta_seconds prev_bytes prev_ts
  local worker_pids failed=0 pid

  if [ ! "$total_bytes" -gt 0 ] 2>/dev/null; then
    return 1
  fi

  if [ -f "$chunk_meta" ]; then
    local meta_sig="" meta_size=""
    meta_sig="$(awk -F= '/^sig=/{print substr($0,5); exit}' "$chunk_meta" 2>/dev/null || true)"
    meta_size="$(awk -F= '/^size=/{print $2; exit}' "$chunk_meta" 2>/dev/null || true)"
    if [ "$meta_sig" != "$expected_sig" ] || [ "$meta_size" != "$total_bytes" ]; then
      warn "检测到旧分块缓存与当前版本不一致，已清理后重新下载"
      clear_chunk_cache "$output"
    fi
  fi

  mkdir -p "$chunk_dir"
  printf 'sig=%s\nsize=%s\n' "$expected_sig" "$total_bytes" > "$chunk_meta"

  total_chunks=$(( (total_bytes + chunk_size - 1) / chunk_size ))
  chunk_jobs="$(determine_chunk_parallelism "$total_chunks")"
  completed_chunks=0
  for idx in $(seq 0 $((total_chunks - 1))); do
    start_byte=$(( idx * chunk_size ))
    end_byte=$(( start_byte + chunk_size - 1 ))
    if [ "$end_byte" -ge "$total_bytes" ]; then
      end_byte=$(( total_bytes - 1 ))
    fi
    expected_len=$(( end_byte - start_byte + 1 ))
    chunk_file="$(printf '%s/chunk.%06d.part' "$chunk_dir" "$idx")"

    if [ -f "$chunk_file" ]; then
      actual_size="$(wc -c < "$chunk_file" 2>/dev/null | tr -d '[:space:]' || echo 0)"
      if [ "$actual_size" -eq "$expected_len" ] 2>/dev/null; then
        completed_chunks=$(( completed_chunks + 1 ))
      else
        rm -f "$chunk_file" 2>/dev/null || true
      fi
    fi
  done

  total_mib="$(format_mib "$total_bytes")"
  if [ "$completed_chunks" -gt 0 ]; then
    completed_mib="$(awk -v n="$completed_chunks" -v s="$chunk_size" -v t="$total_bytes" 'BEGIN{v=n*s; if (v>t) v=t; printf "%.2f", v/1024/1024}')"
    info "续传分块下载：已完成 ${completed_chunks}/${total_chunks} 块（${completed_mib} MiB / ${total_mib} MiB），并发 ${chunk_jobs} 线程"
  else
    info "启动分块下载：${total_chunks} 块，约 ${total_mib} MiB，并发 ${chunk_jobs} 线程"
  fi

  failure_file="${chunk_dir}/.failed"
  rm -f "$failure_file" 2>/dev/null || true

  read -r completed_bytes completed_chunks <<EOF
$(summarize_chunk_progress "$chunk_dir")
EOF
  prev_bytes="$completed_bytes"
  prev_ts="$(date +%s)"

  worker_pids=()
  for idx in $(seq 0 $((chunk_jobs - 1))); do
    download_chunk_worker "$url" "$chunk_dir" "$total_bytes" "$chunk_size" "$idx" "$chunk_jobs" "$total_chunks" "$failure_file" &
    worker_pids+=("$!")
  done

  while :; do
    read -r progress_bytes progress_chunks <<EOF
$(summarize_chunk_progress "$chunk_dir")
EOF
    now="$(date +%s)"
    delta_seconds=$(( now - prev_ts ))
    delta_bytes=$(( progress_bytes - prev_bytes ))
    if [ "$delta_seconds" -gt 0 ] 2>/dev/null && [ "$delta_bytes" -gt 0 ] 2>/dev/null; then
      speed_bytes_per_sec=$(( delta_bytes / delta_seconds ))
      prev_bytes="$progress_bytes"
      prev_ts="$now"
    elif [ -z "${speed_bytes_per_sec:-}" ]; then
      speed_bytes_per_sec=0
    fi

    render_chunk_progress_line "$progress_bytes" "$total_bytes" "$progress_chunks" "$total_chunks" "$speed_bytes_per_sec"

    elapsed=0
    for pid in "${worker_pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        elapsed=1
        break
      fi
    done
    if [ "$elapsed" -eq 0 ]; then
      break
    fi
    sleep 1
  done
  printf '\n'

  for pid in "${worker_pids[@]}"; do
    if ! wait "$pid"; then
      failed=1
    fi
  done
  if [ "$failed" -ne 0 ] || [ -f "$failure_file" ]; then
    if [ -f "$failure_file" ]; then
      warn "$(cat "$failure_file" 2>/dev/null || echo '分块下载失败')"
    else
      warn "分块下载失败"
    fi
    return 1
  fi

  assembled_file="${output}.assembling"
  rm -f "$assembled_file" 2>/dev/null || true
  for idx in $(seq 0 $((total_chunks - 1))); do
    chunk_file="$(printf '%s/chunk.%06d.part' "$chunk_dir" "$idx")"
    [ -f "$chunk_file" ] || return 1
    cat "$chunk_file" >> "$assembled_file"
  done

  actual_size="$(wc -c < "$assembled_file" 2>/dev/null | tr -d '[:space:]' || echo 0)"
  if [ "$actual_size" -ne "$total_bytes" ] 2>/dev/null; then
    warn "分块合并后的文件大小异常：期望 ${total_bytes}，实际 ${actual_size}"
    rm -f "$assembled_file" 2>/dev/null || true
    return 1
  fi

  mv -f "$assembled_file" "$output"
  return 0
}

log_resume_state(){
  local output="$1"
  local total_bytes="${2:-}"
  local show_hint="${3:-true}"
  local cached_bytes="0"
  local cached_mib="0"
  local total_mib="0"
  local total_pct="0"

  [ -f "$output" ] || return 0

  cached_bytes="$(wc -c < "$output" 2>/dev/null | tr -d '[:space:]' || echo 0)"
  cached_mib="$(awk -v n="$cached_bytes" 'BEGIN{printf "%.2f", n/1024/1024}')"
  if [[ "$total_bytes" =~ ^[0-9]+$ ]] && [ "$total_bytes" -gt 0 ]; then
    total_mib="$(awk -v n="$total_bytes" 'BEGIN{printf "%.2f", n/1024/1024}')"
    total_pct=$(( cached_bytes * 100 / total_bytes ))
    info "检测到断点缓存：已缓存 ${cached_mib} MiB / 估算总大小 ${total_mib} MiB（总体约 ${total_pct}%）"
  else
    info "检测到断点缓存：已缓存 ${cached_mib} MiB（总大小暂不可得）"
  fi
  if [ "$show_hint" = "true" ]; then
    info "说明：下面 curl 百分比显示的是本次新增下载进度，不是总体百分比。"
  fi
}

download_with_resume(){
  local url="$1"
  local output="$2"
  local total_bytes="${3:-}"
  local attempt rc=0 before_bytes after_bytes grown_bytes grown_mib
  local resume_hint_shown="false"
  local -a curl_args

  mkdir -p "$(dirname "$output")" 2>/dev/null || true

  curl_args=(
    -C -
    --progress-bar
    -fL
    --connect-timeout 15
    --max-time 1800
  )

  for attempt in 1 2 3; do
    before_bytes="$( [ -f "$output" ] && wc -c < "$output" 2>/dev/null | tr -d '[:space:]' || echo 0)"
    if [ "$before_bytes" -gt 0 ] 2>/dev/null; then
      info "继续断点续传：第 ${attempt}/3 次尝试"
      if [ "$resume_hint_shown" = "true" ]; then
        log_resume_state "$output" "$total_bytes" "false"
      else
        log_resume_state "$output" "$total_bytes" "true"
        resume_hint_shown="true"
      fi
    elif [ "$attempt" -gt 1 ]; then
      info "重新发起下载：第 ${attempt}/3 次尝试"
    fi

    if curl "${curl_args[@]}" -o "$output" "$url" 2>/dev/null; then
      return 0
    else
      rc=$?
    fi

    after_bytes="$( [ -f "$output" ] && wc -c < "$output" 2>/dev/null | tr -d '[:space:]' || echo 0)"
    grown_bytes=$(( after_bytes - before_bytes ))
    echo ""
    warn "下载中断：${url}（第 ${attempt}/3 次，curl exit ${rc}）"
    if [ "$after_bytes" -gt 0 ] 2>/dev/null; then
      if [ "$grown_bytes" -gt 0 ] 2>/dev/null; then
        grown_mib="$(awk -v n="$grown_bytes" 'BEGIN{printf "%.2f", n/1024/1024}')"
        info "本次已额外写入 ${grown_mib} MiB，分片会保留用于下一次继续下载"
      else
        info "当前分片未增长，但会保留继续尝试"
      fi
    fi
    if [ "$attempt" -lt 3 ]; then
      info "保留已下载分片，稍后继续断点续传"
      sleep $(( attempt * 2 ))
    fi
  done

  return "$rc"
}

check_local_tarball(){
  local target="$TMP_DIR/$IMAGE_TARBALL"
  local target_meta="$target.meta"
  local expected_sig="${TAG}|${IMAGE_TARBALL}"

  [ ! -f "$target" ] && return 1

  # 检查版本签名（避免使用旧版本镜像）
  if [ -f "$target_meta" ]; then
    local meta_sig=""
    meta_sig="$(awk -F= '/^sig=/{print substr($0,5); exit}' "$target_meta" 2>/dev/null || true)"
    if [ -n "$meta_sig" ] && [ "$meta_sig" != "$expected_sig" ]; then
      warn "检测到旧版本本地镜像（${meta_sig}），当前需要 ${TAG}，已清理"
      rm -f "$target" "$target_meta" || true
      return 1
    fi
  else
    # 无版本标记的本地镜像，清理避免跨版本复用
    warn "检测到无版本标记的本地镜像，已清理避免跨版本复用"
    rm -f "$target" || true
    return 1
  fi

  # 检查 gzip 完整性
  if gzip -t "$target" >/dev/null 2>&1; then
    info "检测到本地镜像且校验通过：$target"
    return 0
  fi
  warn "检测到本地镜像损坏（gzip 校验失败），将自动删除并重新下载"
  rm -f "$target" "$target_meta" || true
  return 1
}

download_tarball(){
  local target="$TMP_DIR/$IMAGE_TARBALL"
  local part="$target.part"
  local target_meta="$target.meta"
  local part_meta="$part.meta"
  local primary_http_code=""
  local total_bytes=""
  local expected_sig=""
  local meta_sig=""
  local meta_size=""
  local selected_url=""
  local -a download_urls
  if [ -z "$TAG" ]; then
    warn "缺少有效 release tag，跳过 release 资产下载"
    return 1
  fi

  mkdir -p "$TMP_DIR" 2>/dev/null || true

  local primary_url="https://github.com/${GITHUB_REPO}/releases/download/${TAG}/${IMAGE_TARBALL}"
  expected_sig="${TAG}|${IMAGE_TARBALL}"
  primary_http_code="$(curl -sSLI -o /dev/null -w '%{http_code}' --connect-timeout 8 --max-time 20 "$primary_url" 2>/dev/null || true)"
  if [ "$primary_http_code" = "404" ]; then
    warn "Release 资产不存在：${TAG}/${IMAGE_TARBALL}（HTTP 404），跳过 release 下载并回退 GHCR"
    return 1
  fi
  total_bytes="$(curl -fsSLI --connect-timeout 8 --max-time 20 "$primary_url" 2>/dev/null | awk -F': ' 'tolower($1)=="content-length"{print $2}' | tr -d '\r' | tail -1 || true)"
  if ! [[ "$total_bytes" =~ ^[0-9]+$ ]] || [ "$total_bytes" -le 0 ]; then
    total_bytes=""
  fi

  if [ -f "$target" ]; then
    if [ -f "$target_meta" ]; then
      meta_sig="$(awk -F= '/^sig=/{print substr($0,5); exit}' "$target_meta" 2>/dev/null || true)"
      meta_size="$(awk -F= '/^size=/{print $2; exit}' "$target_meta" 2>/dev/null || true)"
      if [ "$meta_sig" != "$expected_sig" ]; then
        warn "检测到旧版本完整缓存（${meta_sig:-unknown}），已清理并重新下载 ${TAG}"
        rm -f "$target" "$target_meta" || true
      elif [[ "$total_bytes" =~ ^[0-9]+$ ]] && [[ "$meta_size" =~ ^[0-9]+$ ]] && [ "$meta_size" -gt 0 ] && [ "$meta_size" -ne "$total_bytes" ]; then
        warn "检测到完整缓存大小与远端不一致，已清理并重新下载"
        rm -f "$target" "$target_meta" || true
      fi
    else
      warn "检测到无版本标记的旧完整缓存，已清理避免跨版本复用"
      rm -f "$target" || true
    fi
  fi

  if [ -f "$part" ]; then
    if [ -f "$part_meta" ]; then
      meta_sig="$(awk -F= '/^sig=/{print substr($0,5); exit}' "$part_meta" 2>/dev/null || true)"
      meta_size="$(awk -F= '/^size=/{print $2; exit}' "$part_meta" 2>/dev/null || true)"
      if [ "$meta_sig" != "$expected_sig" ]; then
        warn "检测到旧版本断点缓存（${meta_sig:-unknown}），已清理并重新下载 ${TAG}"
        rm -f "$part" "$part_meta" || true
      elif [[ "$total_bytes" =~ ^[0-9]+$ ]] && [[ "$meta_size" =~ ^[0-9]+$ ]] && [ "$meta_size" -gt 0 ] && [ "$meta_size" -ne "$total_bytes" ]; then
        warn "检测到断点缓存大小与远端不一致，已清理并重新下载"
        rm -f "$part" "$part_meta" || true
      fi
    else
      warn "检测到无版本标记的旧断点缓存，已清理避免跨版本续传"
      rm -f "$part" || true
    fi
  fi

  if check_local_tarball; then return 0; fi

  while IFS= read -r u; do
    [ -z "$u" ] && continue
    download_urls+=("$u")
  done < <(build_download_urls "$primary_url")

  while IFS= read -r u; do
    [ -z "$u" ] && continue
    if [ -z "$selected_url" ]; then
      selected_url="$u"
    fi
  done < <(probe_range_capable_source "${download_urls[@]}")

  if [ -n "$selected_url" ] && [[ "$total_bytes" =~ ^[0-9]+$ ]] && [ "$total_bytes" -gt 0 ]; then
    info "已锁定支持 Range 的下载源进行分块下载：$selected_url"
    if download_tarball_chunked "$selected_url" "$part" "$total_bytes" "$expected_sig"; then
      if gzip -t "$part" >/dev/null 2>&1; then
        mv -f "$part" "$target"
        printf 'sig=%s\nsize=%s\n' "$expected_sig" "${total_bytes:-0}" > "$target_meta" 2>/dev/null || true
        rm -f "$part_meta" || true
        clear_chunk_cache "$part"
        success "镜像下载并校验成功"
        return 0
      fi
      warn "分块下载完成但 gzip 校验失败，说明该下载源虽然支持 Range，但返回内容不稳定；已清理分块缓存并回退线性续传"
      rm -f "$part" "$part_meta" || true
      clear_chunk_cache "$part"
    else
      warn "分块下载未完成，将回退到线性续传下载"
    fi
  else
    warn "未探测到稳定的 Range 下载源，将回退到线性续传下载"
  fi

  for u in "${download_urls[@]}"; do
    [ -z "$u" ] && continue
    info "尝试下载：$u"
    printf 'sig=%s\nsize=%s\n' "$expected_sig" "${total_bytes:-0}" > "$part_meta" 2>/dev/null || true
    if download_with_resume "$u" "$part" "$total_bytes"; then
      echo ""
      if gzip -t "$part" >/dev/null 2>&1; then
        mv -f "$part" "$target"
        printf 'sig=%s\nsize=%s\n' "$expected_sig" "${total_bytes:-0}" > "$target_meta" 2>/dev/null || true
        rm -f "$part_meta" || true
        success "镜像下载并校验成功"
        return 0
      fi
      warn "下载完成但校验失败，删除损坏分片并切换下一个源"
      rm -f "$part" "$part_meta" || true
    else
      echo ""
      warn "该下载源失败：${u}（保留当前分片供下次继续）"
    fi
  done

  if command -v aria2c >/dev/null 2>&1; then
    info "curl 源均失败，尝试 aria2c 多线程下载"
    printf 'sig=%s\nsize=%s\n' "$expected_sig" "${total_bytes:-0}" > "$part_meta" 2>/dev/null || true
    aria2c -c -x 8 -s 8 -d "$TMP_DIR" -o "${IMAGE_TARBALL}.part" "$primary_url" || true
    if [ -f "$part" ] && gzip -t "$part" >/dev/null 2>&1; then
      mv -f "$part" "$target"
      printf 'sig=%s\nsize=%s\n' "$expected_sig" "${total_bytes:-0}" > "$target_meta" 2>/dev/null || true
      rm -f "$part_meta" || true
      success "aria2c 下载并校验成功"
      return 0
    fi
    rm -f "$part" "$part_meta" || true
  fi

  return 1
}
load_image(){
  local f="$TMP_DIR/$IMAGE_TARBALL"
  local load_log="$TMP_DIR/.docker-load.log"
  local dangling_before_file=""
  local load_pid start_ts elapsed next_report rc
  if ! check_local_tarball; then return 1; fi
  if ! docker info >/dev/null 2>&1; then
    warn "Docker daemon 未运行，无法导入镜像"
    case "$(uname -s 2>/dev/null)" in
      Darwin*) warn "请先启动 Docker Desktop，然后重新运行安装脚本" ;;
      *)       warn "请先启动 Docker daemon，然后重新运行安装脚本" ;;
    esac
    exit 1
  fi

  dangling_before_file="$(mktemp "${TMP_DIR}/.docker-dangling-before.XXXXXX")"
  capture_dangling_image_ids > "$dangling_before_file" 2>/dev/null || true

  info "正在导入镜像（docker load）: $f"
  rm -f "$load_log" || true
  docker load < "$f" >"$load_log" 2>&1 &
  load_pid=$!
  start_ts="$(date +%s)"
  next_report=5
  while kill -0 "$load_pid" >/dev/null 2>&1; do
    elapsed=$(( $(date +%s) - start_ts ))
    if [ "$elapsed" -ge "$next_report" ]; then
      printf '\r\033[K[INFO] 正在导入镜像（docker load），已耗时 %ds' "$elapsed"
      next_report=$((next_report + 5))
    fi
    sleep 1
  done
  # 进度行结束后换行
  [ "$next_report" -gt 5 ] && printf '\n'
  wait "$load_pid" || rc=$?
  rc="${rc:-0}"

  if [ "$rc" -eq 0 ]; then
    cat "$load_log"
    tag_loaded_image_if_needed
    cleanup_replaced_image_from_load_log "$load_log"
    cleanup_new_dangling_images "$dangling_before_file"
    success "镜像导入完成"
    rm -f "$load_log" || true
    rm -f "$dangling_before_file" 2>/dev/null || true
    return 0
  fi

  warn "docker load 失败，尝试流式解压导入"
  cat "$load_log" || true
  rm -f "$load_log" || true
  if command -v unpigz >/dev/null 2>&1; then
    if unpigz -c "$f" | docker load; then tag_loaded_image_if_needed; cleanup_new_dangling_images "$dangling_before_file"; success "流式解压导入成功"; rm -f "$dangling_before_file" 2>/dev/null || true; return 0; fi
  elif command -v gunzip >/dev/null 2>&1; then
    if gunzip -c "$f" | docker load; then tag_loaded_image_if_needed; cleanup_new_dangling_images "$dangling_before_file"; success "流式解压导入成功"; rm -f "$dangling_before_file" 2>/dev/null || true; return 0; fi
  fi

  cleanup_new_dangling_images "$dangling_before_file"
  rm -f "$dangling_before_file" 2>/dev/null || true
  warn "本地镜像导入失败"
  return 1
}

cleanup_replaced_image_from_load_log(){
  local load_log="$1"
  local old_ids="" old_id
  [ -f "$load_log" ] || return 0

  old_ids="$(sed -n 's/.*renaming the old one with ID \([^ ]*\) to empty string.*/\1/p' "$load_log" | awk '!seen[$0]++')"
  [ -n "$old_ids" ] || return 0

  while IFS= read -r old_id; do
    [ -n "$old_id" ] || continue
    if docker image rm "$old_id" >/dev/null 2>&1; then
      info "已清理被替换的旧镜像：$old_id"
    else
      warn "旧镜像仍被占用，跳过清理：$old_id"
    fi
  done <<EOF
$old_ids
EOF
}

capture_dangling_image_ids(){
  docker image ls --filter dangling=true --format '{{.ID}}' 2>/dev/null | awk 'NF && !seen[$0]++'
}

cleanup_new_dangling_images(){
  local baseline_file="$1"
  local current_file new_ids old_id
  [ -f "$baseline_file" ] || return 0

  current_file="$(mktemp)"
  capture_dangling_image_ids > "$current_file" 2>/dev/null || true
  new_ids="$(comm -13 <(sort "$baseline_file" 2>/dev/null || true) <(sort "$current_file" 2>/dev/null || true) 2>/dev/null || true)"
  rm -f "$current_file" 2>/dev/null || true

  [ -n "$new_ids" ] || return 0

  while IFS= read -r old_id; do
    [ -n "$old_id" ] || continue
    if docker image rm "$old_id" >/dev/null 2>&1; then
      info "已清理加载失败遗留的悬空镜像：$old_id"
    else
      warn "加载失败后发现悬空镜像仍被占用，跳过清理：$old_id"
    fi
  done <<EOF
$new_ids
EOF
}

pull_from_ghcr(){
  info "尝试从 GHCR 拉取镜像（自动回退）"
  if [ -n "$TAG" ] && docker pull "ghcr.io/${GITHUB_REPO}:${TAG}-lite"; then
    docker tag "ghcr.io/${GITHUB_REPO}:${TAG}-lite" "$IMAGE_NAME" || true
    cleanup_local_lite_aliases || true
    success "GHCR 拉取成功"; return 0
  fi
  if docker pull "ghcr.io/${GITHUB_REPO}:lite" 2>/dev/null || docker pull "ghcr.io/${GITHUB_REPO}:latest" 2>/dev/null; then
    if docker image inspect "ghcr.io/${GITHUB_REPO}:lite" >/dev/null 2>&1; then
      docker tag "ghcr.io/${GITHUB_REPO}:lite" "$IMAGE_NAME" || true
    else
      docker tag "ghcr.io/${GITHUB_REPO}:latest" "$IMAGE_NAME" || true
    fi
    cleanup_local_lite_aliases || true
    success "GHCR 拉取成功"; return 0
  fi
  return 1
}

tag_loaded_image_if_needed(){
  local loaded_ref=""
  if docker image inspect "openclaw-pro:lite" >/dev/null 2>&1; then
    loaded_ref="openclaw-pro:lite"
  elif docker image inspect "ghcr.io/${GITHUB_REPO}:lite" >/dev/null 2>&1; then
    loaded_ref="ghcr.io/${GITHUB_REPO}:lite"
  else
    loaded_ref="$(docker images --format '{{.Repository}}:{{.Tag}}' | awk '/openclaw-pro/ && $0 !~ /<none>/ {print; exit}')"
  fi

  if [ -n "$loaded_ref" ] && [ "$loaded_ref" != "$IMAGE_NAME" ]; then
    docker tag "$loaded_ref" "$IMAGE_NAME" >/dev/null 2>&1 || true
  fi

  cleanup_local_lite_aliases || true
}

cleanup_local_lite_aliases(){
  local alias_removed="false"

  if docker image inspect "openclaw-pro:lite" >/dev/null 2>&1; then
    docker rmi "openclaw-pro:lite" >/dev/null 2>&1 || true
    alias_removed="true"
  fi

  if docker image inspect "ghcr.io/${GITHUB_REPO}:lite" >/dev/null 2>&1; then
    docker rmi "ghcr.io/${GITHUB_REPO}:lite" >/dev/null 2>&1 || true
    alias_removed="true"
  fi

  if [ "$alias_removed" = "true" ]; then
    info "已移除本地 lite 标签，统一使用 ${IMAGE_NAME}"
  fi
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

ensure_container_host_user(){
  local host_user="$1" host_uid="$2" host_gid="$3"
  [ -z "$host_user" ] || [ "$host_user" = "root" ] && return 1

  if docker exec "$CONTAINER_NAME" bash -c "id '$host_user' >/dev/null 2>&1"; then
    return 0
  fi

  if ! [[ "$host_user" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
    warn "宿主机用户名格式无效，跳过容器普通用户创建：$host_user"
    return 1
  fi

  info "容器内未检测到用户 ${host_user}，执行兼容创建"
  docker exec "$CONTAINER_NAME" bash -c "
set -e
if [ -n '$host_gid' ] && [[ '$host_gid' =~ ^[0-9]+$ ]] && ! getent group '$host_gid' >/dev/null 2>&1; then
  groupadd -g '$host_gid' '$host_user' 2>/dev/null || groupadd -g '$host_gid' 'oc_$host_user' 2>/dev/null || true
fi
if [ -n '$host_uid' ] && [[ '$host_uid' =~ ^[0-9]+$ ]] && [ -n '$host_gid' ] && [[ '$host_gid' =~ ^[0-9]+$ ]]; then
  useradd -m -u '$host_uid' -g '$host_gid' -s /bin/bash '$host_user' 2>/dev/null || useradd -m -s /bin/bash '$host_user' 2>/dev/null || true
else
  useradd -m -s /bin/bash '$host_user' 2>/dev/null || adduser --disabled-password --gecos '' '$host_user' 2>/dev/null || true
fi
id '$host_user' >/dev/null 2>&1
usermod -aG sudo '$host_user' 2>/dev/null || true
echo '$host_user ALL=(ALL) NOPASSWD:ALL' > '/etc/sudoers.d/90-openclaw-$host_user'
chmod 440 '/etc/sudoers.d/90-openclaw-$host_user'
mkdir -p '/home/$host_user/.ssh'
chmod 700 '/home/$host_user/.ssh'
chown -R '$host_user:$host_user' '/home/$host_user/.ssh'
" >/dev/null 2>&1 || return 1

  docker exec "$CONTAINER_NAME" bash -c "id '$host_user' >/dev/null 2>&1"
}

generate_host_pubkey_if_missing(){
  local key_path="$HOME/.ssh/id_ed25519"
  local pub_path="${key_path}.pub"
  [ -f "$pub_path" ] && { printf '%s' "$pub_path"; return 0; }

  mkdir -p "$HOME/.ssh" >/dev/null 2>&1 || return 1
  chmod 700 "$HOME/.ssh" >/dev/null 2>&1 || true
  command -v ssh-keygen >/dev/null 2>&1 || return 1
  [ -f "$key_path" ] && return 1

  if ssh-keygen -q -t ed25519 -N "" -f "$key_path" >/dev/null 2>&1 && [ -f "$pub_path" ]; then
    printf '%s' "$pub_path"
    return 0
  fi
  return 1
}

harden_container_sshd(){
  local ssh_user="$1"
  docker exec -e OPENCLAW_SSH_USER="$ssh_user" "$CONTAINER_NAME" bash -c '
cfg="/etc/ssh/sshd_config"
[ -f "$cfg" ] || exit 0

set_or_append() {
  local key="$1" value="$2"
  if grep -Eq "^[#[:space:]]*${key}[[:space:]]+" "$cfg"; then
    sed -i -E "s|^[#[:space:]]*${key}[[:space:]]+.*|${key} ${value}|" "$cfg"
  else
    printf "\n%s %s\n" "$key" "$value" >> "$cfg"
  fi
}

if [ -n "$OPENCLAW_SSH_USER" ] && [ "$OPENCLAW_SSH_USER" != "root" ] && id "$OPENCLAW_SSH_USER" >/dev/null 2>&1; then
  set_or_append "PermitRootLogin" "no"
  sed -i "/^[#[:space:]]*AllowUsers[[:space:]]/d" "$cfg" 2>/dev/null || true
  echo "AllowUsers $OPENCLAW_SSH_USER" >> "$cfg"
else
  set_or_append "PermitRootLogin" "prohibit-password"
  sed -i "/^[#[:space:]]*AllowUsers[[:space:]]/d" "$cfg" 2>/dev/null || true
fi

set_or_append "PasswordAuthentication" "no"
set_or_append "KbdInteractiveAuthentication" "no"
set_or_append "ChallengeResponseAuthentication" "no"
set_or_append "PubkeyAuthentication" "yes"
set_or_append "StrictModes" "no"

mkdir -p /run/sshd
/usr/sbin/sshd -t >/dev/null 2>&1 || exit 1
if pgrep -x sshd >/dev/null 2>&1; then
  pid="$(pgrep -x sshd | head -1)"
  kill -HUP "$pid" >/dev/null 2>&1 || true
else
  /usr/sbin/sshd >/dev/null 2>&1 || true
fi
' >/dev/null 2>&1
}

# ─── detect local IP ─────────────────────────────────────────

detect_local_ip(){
  local ip iface
  if [ -n "${OPENCLAW_HOST_IP:-}" ] && echo "$OPENCLAW_HOST_IP" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    printf '%s' "$OPENCLAW_HOST_IP"
    return 0
  fi
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}' || true)"
  fi
  if [ -z "$ip" ] && command -v route >/dev/null 2>&1 && command -v ipconfig >/dev/null 2>&1; then
    iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}' || true)"
    if [ -n "$iface" ]; then
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    fi
  fi
  if [ -z "$ip" ] && command -v ifconfig >/dev/null 2>&1; then
    ip="$(ifconfig 2>/dev/null | awk '
      /^[a-z0-9]/ { iface=$1; sub(":$", "", iface) }
      /inet / && $2 != "127.0.0.1" && iface != "lo" && iface != "lo0" { print $2; exit }
    ' || true)"
  fi
  [ -z "$ip" ] && ip="127.0.0.1"
  printf '%s' "$ip"
}

# ─── HTTPS / domain / cert config ────────────────────────────

prompt_deploy_config(){
  if has_tty; then
    local t

    # Gateway 内部端口固定 18789（仅容器内回环，不对外）

    HTTPS_ENABLED="true"
    printf "HTTPS 域名 (可选，留空自动检测本机局域网IP并使用自签名HTTPS): " > "$TTY_IN"
    IFS= read -r DOMAIN < "$TTY_IN" || true
    DOMAIN="${DOMAIN:-}"

    if [ -z "$DOMAIN" ]; then
      DOMAIN="$(detect_local_ip)"
      CERT_MODE="internal"
      HTTP_PORT=0
      info "检测到 HTTPS IP：$DOMAIN"
      info "域名留空，自动启用 IP 自签 HTTPS：$DOMAIN"
      if [ "$DOMAIN" = "127.0.0.1" ]; then
        warn "未检测到可用局域网 IP，当前回退到 127.0.0.1；如需局域网访问，请手动输入域名或 IP"
      fi
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
    # 自签名模式也需要 80 端口 (HTTP→HTTPS 重定向 + 浏览器插件 ws:// 通道)
    [ "$HTTP_PORT" -eq 0 ] && HTTP_PORT=80
    HTTP_PORT="$(find_available_port "$HTTP_PORT" 8080 8099)"
  fi

  HTTPS_PORT="${HTTPS_PORT:-443}"
  [ "$HTTPS_PORT" -eq 0 ] && HTTPS_PORT=443
  if has_tty; then
    HTTPS_PORT="$(prompt_port_or_default "HTTPS 端口" "$HTTPS_PORT")"
  fi
  HTTPS_PORT="$(find_available_port "$HTTPS_PORT" 8443 8499)"

  GW_TLS_PORT="${GW_TLS_PORT:-18790}"
  [ "$GW_TLS_PORT" -eq 0 ] && GW_TLS_PORT=18790
  if has_tty; then
    GW_TLS_PORT="$(prompt_port_or_default "Gateway TLS 端口" "$GW_TLS_PORT")"
  fi
  GW_TLS_PORT="$(find_available_port "$GW_TLS_PORT" 18800 18999)"

  SSH_PORT="${SSH_PORT:-2222}"
  [ "$SSH_PORT" -eq 0 ] && SSH_PORT=2222
  SSH_PORT="$(find_available_port "$SSH_PORT" 2223 2299)"

  apply_port_conflicts

  [ -z "$BROWSER_BRIDGE_ENABLED" ] && BROWSER_BRIDGE_ENABLED="false"

  if [ "$CERT_MODE" = "internal" ] && echo "$DOMAIN" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    info "当前将使用 IP 自签 HTTPS：$DOMAIN"
  else
    info "当前 HTTPS 域名：$DOMAIN"
    info "证书模式：$CERT_MODE"
  fi

  info "最终端口映射（宿主机 → 容器）："
  info "  Gateway TLS : ${GW_TLS_PORT} → 18790"
  info "  HTTPS       : ${HTTPS_PORT} → 443"
  info "  SSH         : ${SSH_PORT} → 22"
  info "  Gateway     : 127.0.0.1:${GW_PORT} → 18789 (仅本机)"
  info "  Web         : 127.0.0.1:${WEB_PORT} → 3000 (仅本机)"
}

# ─── upgrade detection ────────────────────────────────────────

show_upgrade_detection(){
  local installed_tag container_version
  installed_tag="$(normalize_release_tag "$(safe_json_value release_tag)")"
  container_version="$(get_container_release_tag)"
  # 优先使用容器内版本号（热更新后容器版本是最新的）
  if [ -n "$container_version" ]; then
    installed_tag="$container_version"
  elif [ -z "$installed_tag" ]; then
    installed_tag=""
  fi

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
  installed_tag="$(normalize_release_tag "$(safe_json_value release_tag)")"
  container_version="$(get_container_release_tag)"
  # 优先使用容器内版本号（热更新后容器版本是最新的，而宿主机配置可能未同步）
  if [ -n "$container_version" ]; then
    installed_tag="$container_version"
  fi
  printf '%s' "$installed_tag"
}

can_hotpatch_current_container(){
  docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' 2>/dev/null | head -1 | grep -q "^${CONTAINER_NAME}$" || return 1
  docker exec "$CONTAINER_NAME" sh -c "command -v curl >/dev/null 2>&1" >/dev/null 2>&1 || return 1
  docker exec "$CONTAINER_NAME" sh -c "curl -sS -f --connect-timeout 3 --max-time 8 http://127.0.0.1:3000/api/update/hotpatch/status >/dev/null" >/dev/null 2>&1
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
    printf "  - 状态卷与配置会保留\n\n" > "$TTY_IN"
    continue_install="$(prompt "是否继续执行安装重装流程？[y/N]: ")"
    continue_install="$(echo "$continue_install" | tr '[:upper:]' '[:lower:]')"
    if [ "$continue_install" != "y" ] && [ "$continue_install" != "yes" ]; then
      warn "已取消本次安装流程，请在 Web 面板执行热更新。"
      info "热更新后可再次运行安装脚本（如有需要）。"
      exit 0
    fi
  fi
}


reset_persistent_state(){
  docker volume rm -f "$STATE_VOLUME_NAME" >/dev/null 2>&1 || true
  rm -f "$CONFIG_CACHE_FILE" >/dev/null 2>&1 || true

  if rm -rf "$LEGACY_HOME_DIR" 2>/dev/null; then
    find "$BASE_DIR" -maxdepth 1 -mindepth 1 \( -name 'system-data' -o -name 'user-*' \) -exec rm -rf {} + 2>/dev/null || true
    return 0
  fi

  warn "普通权限删除旧版 home-data 失败，尝试通过 Docker 提权清理..."
  if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    if docker run --rm --platform "$DOCKER_PLATFORM" -v "$BASE_DIR:/work" --entrypoint sh "$IMAGE_NAME" -lc 'rm -rf /work/home-data /work/system-data /work/user-*' >/dev/null 2>&1; then
      return 0
    fi
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    if sudo rm -rf "$LEGACY_HOME_DIR" >/dev/null 2>&1; then
      find "$BASE_DIR" -maxdepth 1 -mindepth 1 \( -name 'system-data' -o -name 'user-*' \) -exec rm -rf {} + 2>/dev/null || true
      return 0
    fi
  fi

  warn "未能完全清理旧版 home-data（权限受限），目录将保留但后续不再使用。"
}


# ─── existing container handling ──────────────────────────────

handle_existing_installation(){
  local exists running choice installed_tag latest_matched
  exists="$(docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' 2>/dev/null | head -1 || true)"
  running="$(docker ps   --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' 2>/dev/null | head -1 || true)"
  # 无容器（含已停止）→ 视为全新安装，残留配置/目录不影响判断
  if [ -z "$exists" ]; then
    refresh_config_cache || true
    if [ -f "$CONFIG_CACHE_FILE" ] || [ -f "$CONFIG_FILE_LEGACY_ROOT" ] || [ -f "$CONFIG_FILE_LEGACY" ]; then
      info "未发现已有容器，但检测到残留配置文件，将按全新安装处理。"
    fi
    return 0
  fi

  warn "检测到已有安装（容器已存在）。"
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
    printf "\n处理方式：\n" > "$TTY_IN"
    if [ "$latest_matched" = "true" ]; then
      printf "  [1] 重建（保留容器内 openclaw 相关数据，重新配置端口/HTTPS）\n" > "$TTY_IN"
      printf "  [2] 全新重建（删除旧容器和全部持久化数据，重新配置端口/HTTPS）\n" > "$TTY_IN"
      printf "  [3] 退出\n" > "$TTY_IN"
      choice="$(prompt "当前已是最新版本，请选择 1/2/3（默认1）: ")"
      [ -z "$choice" ] && choice="1"
    else
      printf "  [1] 升级（保留 /root/.openclaw 中的 openclaw 相关数据与配置，沿用当前端口/HTTPS）\n" > "$TTY_IN"
      printf "  [2] 升级重建（保留容器内 openclaw 相关数据，重新配置端口/HTTPS）\n" > "$TTY_IN"
      printf "  [3] 全新升级重建（删除旧容器和全部持久化数据，重新配置端口/HTTPS）\n" > "$TTY_IN"
      printf "  [4] 退出\n" > "$TTY_IN"
      choice="$(prompt "请选择 1/2/3/4（默认1）: ")"
      [ -z "$choice" ] && choice="1"
    fi
  else
    choice="1"
  fi

  if [ "$latest_matched" = "true" ]; then
    case "${choice:-1}" in
      3) warn "用户取消安装。"; exit 0 ;;
      2) info "全新重建：删除旧容器，并清空 /root/.openclaw 持久化数据，随后重新配置端口/HTTPS"
         docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
         reset_persistent_state
         UPGRADE_MODE="false" ;;
      *) info "重建：保留容器内 openclaw 相关数据，重新配置端口/HTTPS"
         docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
         UPGRADE_MODE="false" ;;
    esac
  else
    case "${choice:-1}" in
      4) warn "用户取消安装。"; exit 0 ;;
      3) info "全新升级重建：删除旧容器，并清空 /root/.openclaw 持久化数据，随后切换到目标版本并重新配置端口/HTTPS"
         docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
         reset_persistent_state
         UPGRADE_MODE="false" ;;
      2) info "升级重建：保留容器内 openclaw 相关数据，切换到目标版本后重新配置端口/HTTPS"
         docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
         UPGRADE_MODE="false" ;;
      *) info "升级：保留 /root/.openclaw 中的 openclaw 相关数据与配置，沿用当前端口/HTTPS"
         load_existing_config || true
         docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
         UPGRADE_MODE="true" ;;
    esac
  fi

  if [ -n "$running" ]; then
    info "已停止并替换运行中的容器：$CONTAINER_NAME"
  fi
  return 0
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
    if [ "$CERT_MODE" = "letsencrypt" ]; then
      [ "$HTTP_PORT"  -gt 0 ] 2>/dev/null && ufw allow "${HTTP_PORT}/tcp"  >/dev/null 2>&1 || true
      [ "$HTTPS_PORT" -gt 0 ] 2>/dev/null && ufw allow "${HTTPS_PORT}/tcp" >/dev/null 2>&1 || true
      [ "$GW_TLS_PORT" -gt 0 ] 2>/dev/null && ufw allow "${GW_TLS_PORT}/tcp" >/dev/null 2>&1 || true
      success "ufw 放行: 22/${SSH_PORT}/${HTTP_PORT}/${HTTPS_PORT}/${GW_TLS_PORT}"
    else
      [ "$HTTPS_PORT" -gt 0 ] 2>/dev/null && ufw allow "${HTTPS_PORT}/tcp" >/dev/null 2>&1 || true
      [ "$GW_TLS_PORT" -gt 0 ] 2>/dev/null && ufw allow "${GW_TLS_PORT}/tcp" >/dev/null 2>&1 || true
      success "ufw 放行: 22/${SSH_PORT}/${HTTPS_PORT}/${GW_TLS_PORT}"
    fi
    if [ "$BROWSER_BRIDGE_ENABLED" = "true" ] && [ "$BRIDGE_PORT" -gt 0 ] 2>/dev/null; then
      ufw allow "${BRIDGE_PORT}/tcp" >/dev/null 2>&1 || true
      success "ufw 放行浏览器控制端口: ${BRIDGE_PORT}"
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
  local host_user host_uid host_gid key_injected ssh_login_user user_ready ssh_hardened ssh_password_disabled container_exec_hint
  host_user="${SUDO_USER:-$(id -un 2>/dev/null || true)}"
  host_uid="$(id -u 2>/dev/null || true)"
  host_gid="$(id -g 2>/dev/null || true)"
  key_injected="false"
  ssh_login_user="root"
  user_ready="false"
  ssh_hardened="false"
  ssh_password_disabled="false"
  container_exec_hint="docker exec -it ${CONTAINER_NAME} bash"

  if [ -n "${OPENCLAW_WSL_DISTRO:-}" ]; then
    container_exec_hint="wsl -d ${OPENCLAW_WSL_DISTRO} docker exec -it ${CONTAINER_NAME} bash"
  fi

  ensure_state_volume

  write_config

  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

  # Build port arguments
  local port_args=()
  if [ "$HTTPS_ENABLED" = "true" ]; then
    # 始终映射 80 端口 (Let's Encrypt 需要 ACME 验证; 自签名模式 Caddy 提供 HTTP→HTTPS 重定向 + ws:// WebSocket 透传)
    port_args+=(-p "${HTTP_PORT}:80" -p "${HTTPS_PORT}:443" -p "${GW_TLS_PORT}:18790" -p "127.0.0.1:${GW_PORT}:18789" -p "127.0.0.1:${WEB_PORT}:3000" -p "${SSH_PORT}:22")
  else
    port_args+=(-p "${GW_TLS_PORT}:18790" -p "127.0.0.1:${GW_PORT}:18789" -p "127.0.0.1:${WEB_PORT}:3000" -p "${SSH_PORT}:22")
  fi
  # 远端浏览器控制端口
  if [ "$BROWSER_BRIDGE_ENABLED" = "true" ] && [ "$BRIDGE_PORT" -gt 0 ] 2>/dev/null; then
    port_args+=(-p "${BRIDGE_PORT}:3001")
  fi

  # Build volume arguments
  local vol_args=()
  vol_args+=(-v "$STATE_VOLUME_NAME:$STATE_MOUNT_POINT")

  # Build environment variables for user creation
  local env_args=()
  env_args+=(-e "TZ=${TZ_VALUE}" -e "DOMAIN=${DOMAIN}" -e "CERT_MODE=${CERT_MODE}")
  if [ -n "$host_user" ] && [ "$host_user" != "root" ]; then
    env_args+=(-e "HOST_USER=${host_user}" -e "HOST_UID=${host_uid}" -e "HOST_GID=${host_gid}")
  fi
  for proxy_var in http_proxy HTTP_PROXY https_proxy HTTPS_PROXY no_proxy NO_PROXY; do
    proxy_val="$(printenv "$proxy_var" 2>/dev/null || true)"
    if [ -n "$proxy_val" ]; then
      env_args+=(-e "${proxy_var}=${proxy_val}")
    fi
  done

  info "创建容器..."
  docker create --name "$CONTAINER_NAME" \
    --platform "$DOCKER_PLATFORM" \
    --hostname openclaw \
    --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
    --cap-add NET_BIND_SERVICE --cap-add KILL --cap-add DAC_OVERRIDE \
    --cap-add FOWNER --cap-add SYS_CHROOT --cap-add AUDIT_WRITE \
    "${vol_args[@]}" \
    "${port_args[@]}" \
    "${env_args[@]}" \
    --restart unless-stopped \
    "$IMAGE_NAME"

  info "启动容器..."
  docker start "$CONTAINER_NAME"
  sleep 3  # 等待容器启动和 start-services.sh 执行

  # 等待 SSH 服务就绪
  local ssh_ready="false"
  for i in 1 2 3 4 5 6 7 8; do
    if docker exec "$CONTAINER_NAME" bash -c "pgrep -x sshd >/dev/null 2>&1"; then
      ssh_ready="true"
      break
    fi
    sleep 1
  done

  if [ "$ssh_ready" != "true" ]; then
    warn "SSH 服务状态未知，请检查容器日志"
  fi

  if [ -n "$host_user" ] && [ "$host_user" != "root" ]; then
    if docker exec "$CONTAINER_NAME" bash -c "id '$host_user' >/dev/null 2>&1"; then
      user_ready="true"
      ssh_login_user="$host_user"
    elif ensure_container_host_user "$host_user" "$host_uid" "$host_gid"; then
      user_ready="true"
      ssh_login_user="$host_user"
    fi
  fi

  # Public key injection（优先普通用户；非 root 宿主机场景不再回退 root 登录）
  for keyfile in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub" "$HOME/.ssh/id_ecdsa.pub"; do
    [ -f "$keyfile" ] || continue
    if [ "$user_ready" = "true" ]; then
      docker exec "$CONTAINER_NAME" bash -c "mkdir -p '/home/$host_user/.ssh' && chmod 700 '/home/$host_user/.ssh'" >/dev/null 2>&1 || true
      if docker cp "$keyfile" "$CONTAINER_NAME:/tmp/host_user_key.pub" >/dev/null 2>&1 \
        && docker exec "$CONTAINER_NAME" bash -c "touch '/home/$host_user/.ssh/authorized_keys' && while IFS= read -r k; do [ -z \"\$k\" ] && continue; grep -qxF \"\$k\" '/home/$host_user/.ssh/authorized_keys' || echo \"\$k\" >> '/home/$host_user/.ssh/authorized_keys'; done < /tmp/host_user_key.pub && chmod 600 '/home/$host_user/.ssh/authorized_keys' && chown -R '$host_user:$host_user' '/home/$host_user/.ssh' && test -s '/home/$host_user/.ssh/authorized_keys' && rm -f /tmp/host_user_key.pub" >/dev/null 2>&1; then
        key_injected="true"
        ssh_login_user="$host_user"
        break
      fi
      continue
    fi
    if [ "$host_user" = "root" ] && docker exec "$CONTAINER_NAME" bash -c "chmod 700 /root 2>/dev/null || true; mkdir -p /root/.ssh && chmod 700 /root/.ssh" >/dev/null 2>&1 \
      && docker cp "$keyfile" "$CONTAINER_NAME:/root/.ssh/authorized_keys.tmp" >/dev/null 2>&1 \
      && docker exec "$CONTAINER_NAME" bash -c "touch /root/.ssh/authorized_keys && while IFS= read -r k; do [ -z \"\$k\" ] && continue; grep -qxF \"\$k\" /root/.ssh/authorized_keys || echo \"\$k\" >> /root/.ssh/authorized_keys; done < /root/.ssh/authorized_keys.tmp && chmod 600 /root/.ssh/authorized_keys && test -s /root/.ssh/authorized_keys && rm -f /root/.ssh/authorized_keys.tmp" >/dev/null 2>&1; then
      key_injected="true"
      ssh_login_user="root"
      break
    fi
  done

  if [ "$key_injected" != "true" ]; then
    local auto_pub=""
    auto_pub="$(generate_host_pubkey_if_missing || true)"
    if [ -n "$auto_pub" ]; then
      if [ "$user_ready" = "true" ]; then
        docker exec "$CONTAINER_NAME" bash -c "mkdir -p '/home/$host_user/.ssh' && chmod 700 '/home/$host_user/.ssh'" >/dev/null 2>&1 || true
        if docker cp "$auto_pub" "$CONTAINER_NAME:/tmp/host_user_key.pub" >/dev/null 2>&1 \
          && docker exec "$CONTAINER_NAME" bash -c "touch '/home/$host_user/.ssh/authorized_keys' && while IFS= read -r k; do [ -z \"\$k\" ] && continue; grep -qxF \"\$k\" '/home/$host_user/.ssh/authorized_keys' || echo \"\$k\" >> '/home/$host_user/.ssh/authorized_keys'; done < /tmp/host_user_key.pub && chmod 600 '/home/$host_user/.ssh/authorized_keys' && chown -R '$host_user:$host_user' '/home/$host_user/.ssh' && test -s '/home/$host_user/.ssh/authorized_keys' && rm -f /tmp/host_user_key.pub" >/dev/null 2>&1; then
          key_injected="true"
          ssh_login_user="$host_user"
        fi
      elif [ "$host_user" = "root" ] && docker exec "$CONTAINER_NAME" bash -c "chmod 700 /root 2>/dev/null || true; mkdir -p /root/.ssh && chmod 700 /root/.ssh" >/dev/null 2>&1 \
        && docker cp "$auto_pub" "$CONTAINER_NAME:/root/.ssh/authorized_keys.tmp" >/dev/null 2>&1 \
        && docker exec "$CONTAINER_NAME" bash -c "touch /root/.ssh/authorized_keys && while IFS= read -r k; do [ -z \"\$k\" ] && continue; grep -qxF \"\$k\" /root/.ssh/authorized_keys || echo \"\$k\" >> /root/.ssh/authorized_keys; done < /root/.ssh/authorized_keys.tmp && chmod 600 /root/.ssh/authorized_keys && test -s /root/.ssh/authorized_keys && rm -f /root/.ssh/authorized_keys.tmp" >/dev/null 2>&1; then
        key_injected="true"
        ssh_login_user="root"
      fi
    fi
  fi

  if harden_container_sshd "$ssh_login_user"; then
    ssh_hardened="true"
  else
    warn "SSH 安全配置加固失败，请检查容器内 /etc/ssh/sshd_config"
  fi

  if [ "$ssh_hardened" = "true" ] && docker exec "$CONTAINER_NAME" bash -c "/usr/sbin/sshd -T 2>/dev/null | grep -q '^passwordauthentication no$'"; then
    ssh_password_disabled="true"
    if [ "$key_injected" = "true" ] && [ "$ssh_login_user" != "root" ]; then
      success "SSH 已加固：已禁用密码登录和 root 登录，仅支持普通用户 ${ssh_login_user} 密钥登录"
    fi
  else
    warn "未确认 SSH 密码认证状态，建议执行: docker exec $CONTAINER_NAME /usr/sbin/sshd -T | grep passwordauthentication"
  fi

  configure_firewall_and_fail2ban

  success "容器已部署并启动"
  local url_suffix=""
  local main_url=""
  local ssh_target=""
  local ssh_user_display=""
  [ "$HTTPS_PORT" != "443" ] && url_suffix=":${HTTPS_PORT}"
  main_url="https://${DOMAIN}${url_suffix}"
  if [ "$ssh_login_user" = "root" ]; then
    ssh_user_display="root"
  elif [ -n "$host_user" ] && [ "$host_user" != "root" ]; then
    ssh_user_display="$host_user"
  else
    ssh_user_display="root"
  fi
  ssh_target="ssh ${ssh_user_display}@<host> -p ${SSH_PORT}"

  echo ""
  printf '%b安装完成%b\n' "$GREEN" "$NC"
  printf '  %b安装摘要%b\n' "$WHITE" "$NC"
  print_summary_line "主站" "$main_url"
  print_summary_line "容器" "$container_exec_hint"
  print_summary_line "SSH" "$ssh_target"
  print_summary_line "目录" "$BASE_DIR"
  print_summary_line "日志" "$LOG_FILE"
  if [ -n "$host_user" ] && [ "$host_user" != "root" ] && [ "$ssh_user_display" = "$host_user" ]; then
    print_summary_line "提权" "ssh 登录后执行 sudo -i"
  fi
  echo ""
  printf '  %b升级命令%b\n' "$WHITE" "$NC"
  printf '     %b%s%b\n' "$CYAN" "curl -fsSL \"https://raw.githubusercontent.com/${GITHUB_REPO}/main/install-imageonly.sh?ts=$(date +%s)\" | sudo bash" "$NC"
  echo ""
  printf '  %b完整日志: %s%b\n' "$DIM" "$LOG_FILE" "$NC"

  if [ "$key_injected" != "true" ] || [ "$ssh_login_user" = "root" ]; then
    echo ""
    warn "远程 SSH 登录需手动注入公钥（宿主机可通过 docker exec 进入容器）"
  fi
  if [ "$ssh_hardened" != "true" ]; then
    warn "SSH 密码认证状态未确认，请手动检查容器内 sshd 配置"
  fi
}

# ─── main ─────────────────────────────────────────────────────

main(){
  normalize_base_dir
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
