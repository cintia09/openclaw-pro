#!/usr/bin/env bash
# OpenClaw Pro — One-command installer
# Usage: curl -fsSL https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/cintia09/openclaw-pro.git"
GITHUB_REPO="cintia09/openclaw-pro"
IMAGE_NAME="openclaw-pro"
IMAGE_TARBALL="openclaw-pro-image.tar.gz"

echo "🐾 OpenClaw Pro Installer"
echo "========================="
echo ""

# ---- 0. Detect install directory (align with Windows SCRIPT_DIR detection) ----
# Priority: env var > existing install under pwd > existing install under pwd/openclaw-pro > new install
if [ -n "${OPENCLAW_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="$OPENCLAW_INSTALL_DIR"
elif [ -f "$(pwd)/openclaw-docker.sh" ] && [ -d "$(pwd)/.git" ]; then
  # Already inside an openclaw-pro directory
  INSTALL_DIR="$(pwd)"
  echo "📂 检测到当前目录已是 OpenClaw Pro 安装目录"
elif [ -f "$(pwd)/openclaw-pro/openclaw-docker.sh" ]; then
  # openclaw-pro subdirectory already exists
  INSTALL_DIR="$(pwd)/openclaw-pro"
  echo "📂 检测到已有安装: $INSTALL_DIR"
else
  INSTALL_DIR="$(pwd)/openclaw-pro"
fi

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

# ---- 3.5 aria2c: optional hint (never force install) ----
if ! command -v aria2c &>/dev/null; then
  echo "💡 提示: 安装 aria2c 可获得 8 线程加速下载（可选，非必须）"
  echo "   apt: sudo apt-get install -y aria2"
  echo "   dnf: sudo dnf install -y aria2"
  echo "   当前将使用 curl 断点续传下载，也能正常工作。"
  echo ""
fi

# ---- 4. Launch interactive setup or show instructions ----
# Image download is handled by openclaw-docker.sh run (after interactive config),
# aligned with Windows installer flow: Config → Image → Container

echo ""
if [ ! -t 0 ]; then
  # Pipe mode (curl|bash): stdin is not a tty, cannot do interactive config
  echo "✅ 安装完成！请手动运行以下命令启动配置向导："
  echo ""
  echo "   cd $INSTALL_DIR && ./openclaw-docker.sh run"
  echo ""
  echo "   首次运行会引导你完成配置（密码、端口、HTTPS等），"
  echo "   然后自动获取 Docker 镜像并启动服务。"
  echo ""
  exit 0
fi

echo "Starting setup..."
echo ""
exec ./openclaw-docker.sh run
