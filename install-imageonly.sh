#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="openclaw-pro"
IMAGE_NAME="openclaw-pro:latest"
GITHUB_REPO="cintia09/openclaw-pro"
IMAGE_TARBALL="openclaw-pro-image-lite.tar.gz"

TARGET_DIR="${TARGET_DIR:-$(pwd)}"
BASE_DIR="${TARGET_DIR}/openclaw-pro"
TMP_DIR="$BASE_DIR"
HOME_DIR="$BASE_DIR/home-data"
LOG_FILE="$BASE_DIR/install.log"

PROXY_PREFIXES=(
  "https://ghfast.top/"
  "https://gh-proxy.com/"
  "https://ghproxy.net/"
  "https://mirror.ghproxy.com/"
)

TTY_IN="/dev/tty"
has_tty(){ [ -r "$TTY_IN" ] && [ -w "$TTY_IN" ]; }

init_dirs(){
  mkdir -p "$TMP_DIR" "$HOME_DIR"
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

ensure_docker(){
  if command -v docker &>/dev/null; then
    return 0
  fi
  warn "未检测到 Docker，请先安装 Docker 并重试"
  exit 1
}

get_latest_tag(){
  curl -sL --max-time 10 "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true
}

build_download_urls(){
  local url="$1"
  local out=("$url")
  for p in "${PROXY_PREFIXES[@]}"; do
    out+=("${p}${url}")
  done
  echo "${out[@]}"
}

check_local_image(){
  local target="$TMP_DIR/$IMAGE_TARBALL"
  if [ ! -f "$target" ]; then
    return 1
  fi
  if gzip -t "$target" >/dev/null 2>&1; then
    info "检测到本地镜像且校验通过：$target"
    return 0
  fi
  warn "检测到本地镜像损坏（gzip 校验失败），将自动删除并重新下载：$target"
  rm -f "$target" || true
  return 1
}

download_tarball(){
  local tag="$1"
  local asset_url="https://github.com/${GITHUB_REPO}/releases/download/${tag}/${IMAGE_TARBALL}"
  local target="$TMP_DIR/$IMAGE_TARBALL"
  local part="$target.part"
  local urls
  IFS=' ' read -r -a urls <<< "$(build_download_urls "$asset_url")"

  if check_local_image; then
    return 0
  fi

  for u in "${urls[@]}"; do
    info "尝试下载：$u"
    rm -f "$part" || true
    if curl -C - -fL --connect-timeout 15 --max-time 1800 --retry 3 --retry-delay 3 -o "$part" "$u"; then
      if gzip -t "$part" >/dev/null 2>&1; then
        mv -f "$part" "$target"
        success "镜像下载并校验成功：$target"
        return 0
      fi
      warn "下载完成但校验失败，切换下一个源"
      rm -f "$part" || true
    else
      warn "该下载源失败：$u"
      rm -f "$part" || true
    fi
  done

  if command -v aria2c &>/dev/null; then
    info "curl 源均失败，尝试 aria2c 多线程下载"
    rm -f "$part" || true
    aria2c -x 8 -s 8 -d "$TMP_DIR" -o "${IMAGE_TARBALL}.part" "${urls[@]}" || true
    if [ -f "$part" ] && gzip -t "$part" >/dev/null 2>&1; then
      mv -f "$part" "$target"
      success "aria2c 下载并校验成功：$target"
      return 0
    fi
    rm -f "$part" || true
  fi

  return 1
}

ensure_latest_tag(){
  TAG="$(get_latest_tag)"
  if [ -z "$TAG" ]; then
    warn "无法获取最新 Release tag，使用 latest 作为回退"
    TAG="latest"
  else
    info "检测到最新 release: $TAG"
  fi
}

tag_loaded_image_if_needed(){
  if docker image inspect "$IMAGE_NAME" &>/dev/null; then
    return 0
  fi
  local loaded_ref
  loaded_ref=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -i openclaw | head -1 || true)
  if [ -n "$loaded_ref" ]; then
    docker tag "$loaded_ref" "$IMAGE_NAME" || true
  fi
}

load_image(){
  local f="$TMP_DIR/$IMAGE_TARBALL"
  if ! check_local_image; then
    return 1
  fi

  info "正在导入镜像（docker load）: $f"
  if docker load < "$f"; then
    tag_loaded_image_if_needed
    success "镜像导入完成"
    return 0
  fi

  warn "docker load 失败，尝试流式解压导入"
  if command -v unpigz &>/dev/null; then
    if unpigz -c "$f" | docker load; then
      tag_loaded_image_if_needed
      success "流式解压导入成功"
      return 0
    fi
  elif command -v gunzip &>/dev/null; then
    if gunzip -c "$f" | docker load; then
      tag_loaded_image_if_needed
      success "流式解压导入成功"
      return 0
    fi
  fi

  warn "本地镜像导入失败"
  return 1
}

pull_from_ghcr(){
  info "尝试从 GHCR 拉取镜像（自动回退）"
  if docker pull "ghcr.io/${GITHUB_REPO}:${TAG}-lite" || docker pull "ghcr.io/${GITHUB_REPO}:lite" || docker pull "ghcr.io/${GITHUB_REPO}:latest"; then
    if docker image inspect "ghcr.io/${GITHUB_REPO}:${TAG}-lite" >/dev/null 2>&1; then
      docker tag "ghcr.io/${GITHUB_REPO}:${TAG}-lite" "$IMAGE_NAME" || true
    elif docker image inspect "ghcr.io/${GITHUB_REPO}:lite" >/dev/null 2>&1; then
      docker tag "ghcr.io/${GITHUB_REPO}:lite" "$IMAGE_NAME" || true
    else
      docker tag "ghcr.io/${GITHUB_REPO}:latest" "$IMAGE_NAME" || true
    fi
    success "GHCR 拉取并打标签成功：$IMAGE_NAME"
    return 0
  fi
  return 1
}

prompt_password(){
  if [ -n "${ROOT_PASS:-}" ]; then
    return 0
  fi
  if ! has_tty; then
    warn "非交互模式下请通过 ROOT_PASS 环境变量提供密码"
    return 1
  fi

  while true; do
    printf "设置容器 root 密码: " > "$TTY_IN"
    IFS= read -r -s ROOT_PASS < "$TTY_IN" || true
    printf "\n" > "$TTY_IN"
    printf "确认密码: " > "$TTY_IN"
    IFS= read -r -s ROOT_PASS2 < "$TTY_IN" || true
    printf "\n" > "$TTY_IN"
    if [ "$ROOT_PASS" = "$ROOT_PASS2" ] && [ -n "$ROOT_PASS" ]; then
      return 0
    fi
    warn "两次输入不一致或为空，请重试"
  done
}

prompt_ports(){
  GW_PORT="${GW_PORT:-18789}"
  WEB_PORT="${WEB_PORT:-3000}"
  SSH_PORT="${SSH_PORT:-2222}"

  if has_tty; then
    printf "Gateway 端口 (默认 ${GW_PORT}): " > "$TTY_IN"; IFS= read -r t < "$TTY_IN" || true; GW_PORT="${t:-$GW_PORT}"
    printf "Web 面板端口 (默认 ${WEB_PORT}): " > "$TTY_IN"; IFS= read -r t < "$TTY_IN" || true; WEB_PORT="${t:-$WEB_PORT}"
    printf "SSH 端口 (默认 ${SSH_PORT}): " > "$TTY_IN"; IFS= read -r t < "$TTY_IN" || true; SSH_PORT="${t:-$SSH_PORT}"
  fi
}

create_and_start(){
  mkdir -p "$HOME_DIR/.openclaw"
  chmod 700 "$HOME_DIR" || true

  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

  info "创建容器..."
  docker create --name "$CONTAINER_NAME" \
    --hostname openclaw \
    --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add NET_BIND_SERVICE --cap-add KILL --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SYS_CHROOT --cap-add AUDIT_WRITE \
    --security-opt no-new-privileges \
    -v "$HOME_DIR:/root" \
    -p ${GW_PORT}:18789 -p ${WEB_PORT}:3000 -p ${SSH_PORT}:22 \
    -e "TZ=Asia/Shanghai" \
    --restart unless-stopped \
    "$IMAGE_NAME"

  info "启动容器并设置 root 密码..."
  docker start "$CONTAINER_NAME"
  sleep 2
  echo "root:${ROOT_PASS}" | docker exec -i "$CONTAINER_NAME" chpasswd || true

  for keyfile in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
    if [ -f "$keyfile" ]; then
      info "注入公钥 $(basename "$keyfile") 到容器"
      docker exec "$CONTAINER_NAME" bash -lc "mkdir -p /root/.ssh && chmod 700 /root/.ssh"
      docker cp "$keyfile" "$CONTAINER_NAME":/root/.ssh/authorized_keys.tmp
      docker exec "$CONTAINER_NAME" bash -lc "cat /root/.ssh/authorized_keys.tmp >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && rm -f /root/.ssh/authorized_keys.tmp"
      break
    fi
  done

  success "容器已部署并启动"
  info "访问：Gateway http://<host>:${GW_PORT}  管理面板 http://<host>:${WEB_PORT}  SSH root@<host> -p ${SSH_PORT}"
  info "日志文件：$LOG_FILE"
}

main(){
  init_dirs
  ensure_docker
  ensure_latest_tag

  info "Image-only 安装（流程与 Windows 对齐，默认 Lite）"
  info "工作目录：$BASE_DIR"

  if has_tty || [ "${FORCE_TTY_INTERACTIVE:-0}" = "1" ]; then
    info "进入交互向导：先配置密码与端口，然后执行镜像检查/下载/导入"
  fi
  prompt_password
  prompt_ports

  if ! load_image; then
    warn "本地镜像不可用，开始自动下载修复"
    if download_tarball "$TAG" && load_image; then
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
