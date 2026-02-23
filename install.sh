#!/usr/bin/env bash
# OpenClaw Pro — One-command installer
# Usage: curl -fsSL https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/cintia09/openclaw-pro.git"
INSTALL_DIR="${OPENCLAW_INSTALL_DIR:-$HOME/openclaw-pro}"

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
  else
    echo "❌ Cannot install git automatically. Please install git first."
    exit 1
  fi
fi

# ---- 2. Clone or update repo ----
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "📂 Updating existing installation at $INSTALL_DIR ..."
  cd "$INSTALL_DIR"
  git pull --ff-only
else
  echo "📥 Downloading OpenClaw Pro to $INSTALL_DIR ..."
  git clone "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ---- 3. Launch ----
chmod +x openclaw-docker.sh
echo ""
echo "✅ OpenClaw Pro downloaded to: $INSTALL_DIR"
echo ""
echo "Starting setup..."
echo ""
exec ./openclaw-docker.sh run
