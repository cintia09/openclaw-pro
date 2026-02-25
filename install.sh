#!/usr/bin/env bash
# OpenClaw Pro — One-command installer
# Usage: curl -fsSL https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/cintia09/openclaw-pro.git"
GITHUB_REPO="cintia09/openclaw-pro"
IMAGE_NAME="openclaw-pro"
IMAGE_TARBALL="openclaw-pro-image.tar.gz"
INSTALL_DIR="${OPENCLAW_INSTALL_DIR:-$(pwd)/openclaw-pro}"

echo "🐾 OpenClaw Pro Installer"
echo "========================="
echo ""

# ---- 1. Check / install git ----
if ! command -v git &>/dev/null; then
  echo "📦 Installing git..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq git
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y -q git
  elif command -v yum &>/dev/null; then
    sudo yum install -y -q git
  elif command -v brew &>/dev/null; then
    brew install git
  else
    echo "❌ Cannot install git automatically. Please install git first."
    exit 1
  fi
fi

# ---- 2. Clone or update repo ----
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "📂 Updating existing installation at $INSTALL_DIR ..."
  cd "$INSTALL_DIR"
  git fetch --tags --depth 1 origin 2>/dev/null || git fetch --tags origin 2>/dev/null || true
  # Checkout latest release tag if available
  LATEST_TAG=$(git tag --sort=-v:refname 2>/dev/null | head -1)
  if [ -n "$LATEST_TAG" ]; then
    git checkout "$LATEST_TAG" 2>/dev/null || git pull --ff-only
    echo "$LATEST_TAG" > "$INSTALL_DIR/.release-version"
    echo "✅ Updated to Release: $LATEST_TAG"
  else
    git pull --ff-only
    echo "✅ Updated to latest main branch"
  fi
else
  echo "📥 Downloading OpenClaw Pro to $INSTALL_DIR ..."
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  # Try to checkout latest release tag
  git fetch --tags --depth 1 2>/dev/null || true
  LATEST_TAG=$(git tag --sort=-v:refname 2>/dev/null | head -1)
  if [ -n "$LATEST_TAG" ]; then
    git checkout "$LATEST_TAG" 2>/dev/null || true
    echo "$LATEST_TAG" > "$INSTALL_DIR/.release-version"
    echo "🏷️  Checked out Release: $LATEST_TAG"
  fi
fi

chmod +x openclaw-docker.sh
echo ""
echo "✅ OpenClaw Pro downloaded to: $INSTALL_DIR"
if [ -n "$LATEST_TAG" ]; then
  echo "   Version: $LATEST_TAG"
fi
echo ""

# ---- 3. Ensure Docker is available ----
if ! command -v docker &>/dev/null; then
  echo "📦 Docker not found, installing..."
  curl -fsSL https://get.docker.com | sh
  sudo systemctl enable --now docker 2>/dev/null || true
fi

# ---- 4. Download pre-built Docker image from GitHub Release ----

# Get the remote latest release tag
get_remote_release_tag() {
  local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
  curl -sL "$api_url" 2>/dev/null | grep '"tag_name"' | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true
}

# Get the local image version tag (saved during previous install)
get_local_image_tag() {
  local tag_file="$INSTALL_DIR/home-data/.openclaw/image-release-tag.txt"
  [ -f "$tag_file" ] && cat "$tag_file" 2>/dev/null || true
}

# Save image version tag after successful download/import
save_image_tag() {
  local tag="$1"
  mkdir -p "$INSTALL_DIR/home-data/.openclaw"
  echo "$tag" > "$INSTALL_DIR/home-data/.openclaw/image-release-tag.txt"
}

# Core download logic (no interaction, just download + import)
do_download_image() {
  # Skip if tarball already downloaded
  if [ -f "$INSTALL_DIR/$IMAGE_TARBALL" ]; then
    echo "📦 Found local $IMAGE_TARBALL, importing..."
    if docker load < "$INSTALL_DIR/$IMAGE_TARBALL"; then
      echo "✅ Image imported successfully."
      local tag
      tag=$(get_remote_release_tag)
      [ -n "$tag" ] && save_image_tag "$tag"
      return 0
    fi
    echo "⚠️  Import failed, re-downloading..."
    rm -f "$INSTALL_DIR/$IMAGE_TARBALL"
  fi

  # Get download URL from GitHub API
  local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
  local download_url
  download_url=$(curl -sL "$api_url" 2>/dev/null | \
    grep -o '"browser_download_url":\s*"[^"]*openclaw-pro-image\.tar\.gz"' | \
    head -1 | sed 's/.*"\(http[^"]*\)"/\1/') || true

  if [ -z "$download_url" ]; then
    echo "⚠️  Cannot get Release download URL. Will build locally on first run."
    return 1
  fi

  echo "📥 Downloading Docker image from GitHub Release (~1.6GB)..."
  echo "   URL: $download_url"
  echo "   💡 支持断点续传，下载中断后重新运行即可继续"
  if curl -fL -C - --retry 5 --retry-delay 3 --progress-bar -o "$INSTALL_DIR/$IMAGE_TARBALL" "$download_url"; then
    echo "📦 Importing Docker image..."
    if docker load < "$INSTALL_DIR/$IMAGE_TARBALL"; then
      local tag
      tag=$(get_remote_release_tag)
      [ -n "$tag" ] && save_image_tag "$tag"
      echo "✅ Docker image imported successfully."
      return 0
    fi
    echo "⚠️  Import failed."
    rm -f "$INSTALL_DIR/$IMAGE_TARBALL"
    return 1
  fi

  echo "⚠️  Download failed. Image will be built locally on first run."
  rm -f "$INSTALL_DIR/$IMAGE_TARBALL"
  return 1
}

# Main image acquisition logic (aligned with Windows installer behavior)
acquire_image() {
  local is_interactive=false
  [ -t 0 ] && is_interactive=true

  # Case 1: Image already exists locally
  if docker image inspect "$IMAGE_NAME" &>/dev/null 2>&1; then
    local local_tag remote_tag
    local_tag=$(get_local_image_tag)
    remote_tag=$(get_remote_release_tag)

    if [ -n "$remote_tag" ] && [ -n "$local_tag" ] && [ "$remote_tag" != "$local_tag" ]; then
      # Version mismatch — new version available
      if $is_interactive; then
        echo "🔄 发现新版本镜像: 远端 $remote_tag，本地 $local_tag"
        echo "   [1] 使用本地镜像（默认）"
        echo "   [2] 下载最新镜像"
        local choice=""
        read -t 15 -p "   请选择 [1/2，默认1，15秒超时自动选1]: " choice 2>/dev/null || true
        echo ""
        if [ "$choice" = "2" ]; then
          echo "   正在下载最新镜像..."
          docker rmi "$IMAGE_NAME" 2>/dev/null || true
          do_download_image
          return $?
        fi
      fi
      # Pipe mode or user chose 1: keep local image
      echo "✅ Docker image '$IMAGE_NAME' already exists (local: ${local_tag:-unknown}), skipping download."
      return 0
    else
      # Same version or cannot determine — skip download
      echo "✅ Docker image '$IMAGE_NAME' already exists${local_tag:+ ($local_tag)}, skipping download."
      return 0
    fi
  fi

  # Case 2: No local image — need to download
  if $is_interactive; then
    echo "📋 未检测到本地镜像 '$IMAGE_NAME'"
    echo "   [1] 从 GitHub Release 下载预构建镜像（推荐，~1.6GB）"
    echo "   [2] 跳过下载，首次运行时自动构建（需较长时间）"
    local choice=""
    read -t 15 -p "   请选择 [1/2，默认1，15秒超时自动选1]: " choice 2>/dev/null || true
    echo ""
    if [ "$choice" = "2" ]; then
      echo "   已跳过镜像下载，首次运行 ./openclaw-docker.sh run 时会自动获取镜像。"
      return 0
    fi
  fi

  # Download (pipe mode: direct download; interactive mode: user chose 1)
  do_download_image
  return $?
}

acquire_image || true

echo ""

# ---- 5. Launch interactive setup or show instructions ----
# When piped via curl|bash, stdin is not a tty — interactive setup won't work
if [ ! -t 0 ]; then
  echo "✅ 安装完成！请手动运行以下命令启动配置向导："
  echo ""
  echo "   cd $INSTALL_DIR && ./openclaw-docker.sh run"
  echo ""
  exit 0
fi

echo "Starting setup..."
echo ""
exec ./openclaw-docker.sh run
