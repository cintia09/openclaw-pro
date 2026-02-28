#!/usr/bin/env bash
# OpenClaw Pro — One-command installer
# Usage: curl -fsSL https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install.sh | bash
set -euo pipefail

# 非交互（pipe）模式优先：若通过 curl|bash 执行，直接触发 ImageOnly 安装（不克隆仓库）
if [ ! -t 0 ]; then
  echo "⚡ 非交互模式检测到 (curl|bash)，直接运行 ImageOnly 安装（无需克隆源码）..."
  TMP_SCRIPT=$(mktemp /tmp/openclaw-imageonly.XXXXXX.sh)
  if curl -fsSL "https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-imageonly.sh" -o "$TMP_SCRIPT"; then
    chmod +x "$TMP_SCRIPT"
    exec bash "$TMP_SCRIPT"
  else
    echo "⚠️ 无法下载 ImageOnly 安装脚本（网络或脚本不存在），请稍后重试或手动运行本地安装。" >&2
    exit 1
  fi
fi


REPO="https://github.com/cintia09/openclaw-pro.git"
GITHUB_REPO="cintia09/openclaw-pro"
IMAGE_NAME="openclaw-pro"
IMAGE_TARBALL="openclaw-pro-image.tar.gz"

echo "🐾 OpenClaw Pro Installer"
echo "========================="
echo ""

# 如果是交互终端，先询问安装方式：源码安装（默认）或 ImageOnly（仅下载镜像）
if [ -t 0 ]; then
  echo "请选择安装方式："
  echo "  [1] 源码安装（默认，克隆仓库并进行完整部署）"
  echo "  [2] ImageOnly（仅下载 Release 镜像并部署容器，无需克隆源码）"
  read -t 30 -p "请选择 [1/2，默认1]: " INSTALL_MODE || true
  echo ""
  if [ "${INSTALL_MODE}" = "2" ]; then
    # 尝试优先使用本地脚本，否则从 GitHub 拉取并执行
    if [ -f "$(pwd)/install-imageonly.sh" ]; then
      chmod +x "$(pwd)/install-imageonly.sh" || true
      exec bash "$(pwd)/install-imageonly.sh"
    else
      TMP_SCRIPT=$(mktemp /tmp/openclaw-imageonly.XXXXXX.sh)
      if curl -fsSL "https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-imageonly.sh" -o "$TMP_SCRIPT"; then
        chmod +x "$TMP_SCRIPT"
        exec bash "$TMP_SCRIPT"
      else
        echo "无法下载 ImageOnly 安装脚本，请检查网络或使用源码安装。" >&2
        exit 1
      fi
    fi
  fi
fi

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
  if command -v apt-get &>/dev/null; then
    echo "   sudo apt-get install -y aria2"
  elif command -v dnf &>/dev/null; then
    echo "   sudo dnf install -y aria2"
  elif command -v yum &>/dev/null; then
    echo "   sudo yum install -y aria2"
  elif command -v pacman &>/dev/null; then
    echo "   sudo pacman -S aria2"
  elif command -v brew &>/dev/null; then
    echo "   brew install aria2"
  fi
  echo "   当前将使用 curl 断点续传下载，也能正常工作。"
  echo ""
fi

# ---- 4. Launch interactive setup or show instructions ----
# Image download is handled by openclaw-docker.sh run (after interactive config),
# aligned with Windows installer flow: Config → Image → Container

echo ""
if [ ! -t 0 ]; then
  # Pipe mode (curl|bash): 自动使用 ImageOnly 流程（与 Windows 一致），无需克隆源码
  echo "⚡ Detected non-interactive install (curl|bash). Running ImageOnly installer..."
  TMP_SCRIPT=$(mktemp /tmp/openclaw-imageonly.XXXXXX.sh)
  if curl -fsSL "https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-imageonly.sh" -o "$TMP_SCRIPT"; then
    chmod +x "$TMP_SCRIPT"
    echo "→ 执行 ImageOnly 安装脚本"
    bash "$TMP_SCRIPT" || { echo "ImageOnly 安装失败" >&2; exit 1; }
    exit 0
  else
    echo "无法下载 ImageOnly 安装脚本，尝试提示用户手动运行本地安装。" >&2
    echo "  cd $INSTALL_DIR && ./openclaw-docker.sh run" >&2
    exit 1
  fi
fi

echo "Starting setup..."
echo ""
exec ./openclaw-docker.sh run
