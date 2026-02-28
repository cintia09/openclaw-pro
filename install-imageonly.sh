#!/usr/bin/env bash
set -euo pipefail

# Image-only installer: 只下载 GitHub Release 的预构建镜像并部署容器（无需克隆源码）
# 用法: sudo ./install-imageonly.sh

CONTAINER_NAME="openclaw-pro"
IMAGE_NAME="openclaw-pro:latest"
GITHUB_REPO="cintia09/openclaw-pro"
IMAGE_TARBALL="openclaw-pro-image.tar.gz"
TMP_DIR="$(pwd)/tmp"
HOME_DIR="$(pwd)/home-data"

PROXY_PREFIXES=(
    "https://ghfast.top/"
    "https://gh-proxy.com/"
    "https://ghproxy.net/"
    "https://mirror.ghproxy.com/"
)

info(){ echo -e "[INFO] $*"; }
warn(){ echo -e "[WARN] $*"; }
success(){ echo -e "[OK] $*"; }

ensure_docker(){
  if command -v docker &>/dev/null; then return 0; fi
  warn "未检测到 Docker，请先安装 Docker 并重试"
  exit 1
}

get_latest_tag(){
  curl -sL --max-time 10 "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true
}

build_download_urls(){
  local url="$1"; local out=("$url")
  for p in "${PROXY_PREFIXES[@]}"; do out+=("${p}${url}"); done
  echo "${out[@]}"
}

download_tarball(){
  local tag="$1"
  mkdir -p "$TMP_DIR"
  local asset_url="https://github.com/${GITHUB_REPO}/releases/download/${tag}/${IMAGE_TARBALL}"
  local urls; IFS=' ' read -r -a urls <<< "$(build_download_urls "$asset_url")"
  local target="$TMP_DIR/$IMAGE_TARBALL"

  if [ -f "$target" ]; then
    info "已存在本地文件 $target，跳过下载"
    return 0
  fi

  if command -v aria2c &>/dev/null; then
    info "使用 aria2c 下载（多线程）..."
    aria2c -x 8 -s 8 -d "$TMP_DIR" -o "$IMAGE_TARBALL" "${urls[0]}" || true
  fi

  for u in "${urls[@]}"; do
    info "尝试： $u"
    if curl -fL --connect-timeout 10 --max-time 1800 -o "$target" "$u"; then
      success "下载完成： $target"
      return 0
    else
      warn "此源下载失败： $u"
    fi
  done

  warn "下载失败，请手动从 https://github.com/${GITHUB_REPO}/releases/latest 下载 ${IMAGE_TARBALL} 到 ${TMP_DIR}"
  return 1
}

load_image(){
  local f="$TMP_DIR/$IMAGE_TARBALL"
  if [ ! -f "$f" ]; then
    warn "镜像包不存在： $f"
    return 1
  fi
  info "正在导入镜像...（docker load）"
  docker load < "$f"
  # 尝试确保有 openclaw-pro:latest tag
  if ! docker image inspect "openclaw-pro:latest" &>/dev/null; then
    local loaded_ref
    loaded_ref=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -i openclaw | head -1 || true)
    if [ -n "$loaded_ref" ]; then
      docker tag "$loaded_ref" openclaw-pro:latest || true
    fi
  fi
  success "镜像导入完成"
}

prompt_password(){
  while true; do
    read -s -p "设置容器 root 密码: " ROOT_PASS; echo
    read -s -p "确认密码: " ROOT_PASS2; echo
    if [ "$ROOT_PASS" = "$ROOT_PASS2" ] && [ -n "$ROOT_PASS" ]; then
      break
    fi
    warn "两次输入不一致或为空，请重试"
  done
}

prompt_ports(){
  read -p "Gateway 端口 (默认 18789): " GW_PORT; GW_PORT=${GW_PORT:-18789}
  read -p "Web 面板端口 (默认 3000): " WEB_PORT; WEB_PORT=${WEB_PORT:-3000}
  read -p "SSH 端口 (默认 2222): " SSH_PORT; SSH_PORT=${SSH_PORT:-2222}
}

create_and_start(){
  ensure_docker
  mkdir -p "$HOME_DIR/.openclaw"
  chmod 700 "$HOME_DIR" || true

  info "创建容器..."
  docker create --name "$CONTAINER_NAME" \
    --hostname openclaw \
    --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add NET_BIND_SERVICE --cap-add KILL --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SYS_CHROOT --cap-add AUDIT_WRITE \
    --security-opt no-new-privileges \
    -v "$HOME_DIR:/root" \
    -p ${GW_PORT}:18789 -p ${WEB_PORT}:3000 -p ${SSH_PORT}:22 \
    -e "TZ=Asia/Shanghai" \
    --restart unless-stopped \
    "openclaw-pro:latest"

  info "启动容器并设置 root 密码..."
  docker start "$CONTAINER_NAME"
  sleep 2
  echo "root:${ROOT_PASS}" | docker exec -i "$CONTAINER_NAME" chpasswd || true

  # 注入宿主公钥（若存在）
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
  echo "访问：Gateway http://<host>:${GW_PORT}  管理面板 http://<host>:${WEB_PORT}  SSH root@localhost -p ${SSH_PORT}"
}

main(){
  ensure_docker
  info "Image-only 安装 —— 仅下载 Release 镜像并部署（不克隆源码）"
  local tag
  tag=$(get_latest_tag)
  if [ -z "$tag" ]; then
    warn "无法获取最新 Release tag，使用 latest 直链"
    tag="latest"
  else
    info "检测到最新 release: $tag"
  fi

  echo "选择镜像版本：1) 精简(lite) 2) 完整(full) （回车默认1）"
  read -t 15 -p "选择 [1/2]: " choice || true; echo
  if [ "$choice" = "2" ]; then IMAGE_TARBALL="openclaw-pro-image.tar.gz"; else IMAGE_TARBALL="openclaw-pro-image-lite.tar.gz"; fi

  if ! download_tarball "$tag"; then
    warn "镜像下载失败，尝试直接从 GHCR 拉取（需要可访问 ghcr.io）"
    if docker pull "ghcr.io/${GITHUB_REPO}:latest"; then
      docker tag "ghcr.io/${GITHUB_REPO}:latest" openclaw-pro:latest || true
      success "从 GHCR 拉取完成"
    else
      echo "无法获取镜像，退出" >&2
      exit 1
    fi
  else
    load_image
  fi

  prompt_password
  prompt_ports
  create_and_start
}

main "$@"
