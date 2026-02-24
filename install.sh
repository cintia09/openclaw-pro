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
download_image() {
  # Skip if image already loaded
  if docker image inspect "$IMAGE_NAME" &>/dev/null 2>&1; then
    echo "✅ Docker image '$IMAGE_NAME' already exists, skipping download."
    return 0
  fi

  # Skip if tarball already downloaded
  if [ -f "$INSTALL_DIR/$IMAGE_TARBALL" ]; then
    echo "📦 Found local $IMAGE_TARBALL, importing..."
    if docker load < "$INSTALL_DIR/$IMAGE_TARBALL"; then
      echo "✅ Image imported successfully."
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

# Always attempt image download (works in both pipe and interactive modes)
download_image || true

echo ""

# ---- 5. Launch interactive setup or show instructions ----
# When piped via curl|bash, stdin is not a tty — interactive setup won't work
if [ ! -t 0 ]; then
  echo "⚠️  检测到通过管道安装（curl | bash），无法启动交互式配置。"
  echo "   请手动运行："
  echo ""
  echo "   cd $INSTALL_DIR && ./openclaw-docker.sh run"
  echo ""
  exit 0
fi

echo "Starting setup..."
echo ""
exec ./openclaw-docker.sh run
