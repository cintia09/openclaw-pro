#!/usr/bin/env bash
# OpenClaw Pro — One-command installer
# Usage: curl -fsSL https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install.sh | bash
set -euo pipefail

INSTALLER_COMMIT="${INSTALLER_COMMIT:-}"

fetch_remote_installer(){
  local url="$1"
  local out_file="$2"
  curl -fsSL --connect-timeout 8 --max-time 25 --retry 2 --retry-delay 1 "$url" -o "$out_file"
}

fetch_imageonly_script(){
  local out_file="$1"
  local api_url="https://api.github.com/repos/cintia09/openclaw-pro/commits/main"
  local sha=""

  if [ -n "$INSTALLER_COMMIT" ]; then
    echo "[INFO] 正在获取安装脚本（固定提交 ${INSTALLER_COMMIT}）..." >&2
    if fetch_remote_installer "https://raw.githubusercontent.com/cintia09/openclaw-pro/${INSTALLER_COMMIT}/install-imageonly.sh" "$out_file"; then
      return 0
    fi
  fi

  echo "[INFO] 正在查询最新提交..." >&2
  sha="$(curl -fsSL --connect-timeout 8 --max-time 15 "$api_url" 2>/dev/null | awk -F'"' '/"sha"/ {print $4; exit}' || true)"
  if [ -n "$sha" ]; then
    echo "[INFO] 正在获取安装脚本（提交 ${sha}）..." >&2
    if fetch_remote_installer "https://raw.githubusercontent.com/cintia09/openclaw-pro/${sha}/install-imageonly.sh" "$out_file"; then
      return 0
    fi
  fi

  echo "[INFO] 回退获取 main 分支安装脚本..." >&2
  fetch_remote_installer "https://raw.githubusercontent.com/cintia09/openclaw-pro/main/install-imageonly.sh?ts=$(date +%s)" "$out_file"
}

run_imageonly_installer(){
  local target_dir tmp_root tmp_script
  target_dir="${TARGET_DIR:-$(pwd)}"

  tmp_root="${TMPDIR:-/tmp}"
  tmp_root="${tmp_root%/}"
  tmp_script="$(mktemp "${tmp_root}/openclaw-imageonly.XXXXXX")"
  if fetch_imageonly_script "$tmp_script"; then
    chmod +x "$tmp_script"
    if [ -r /dev/tty ] && [ -w /dev/tty ] && [ ! -t 0 ]; then
      echo "⚡ 检测到 curl|bash，切换为交互向导（通过 /dev/tty）..."
      exec env TARGET_DIR="$target_dir" FORCE_TTY_INTERACTIVE=1 bash "$tmp_script"
    fi
    exec env TARGET_DIR="$target_dir" bash "$tmp_script"
  fi

  if [ -f "$target_dir/install-imageonly.sh" ]; then
    echo "⚠️ 远端安装脚本下载失败，回退使用当前目录 install-imageonly.sh" >&2
    chmod +x "$target_dir/install-imageonly.sh" || true
    exec env TARGET_DIR="$target_dir" bash "$target_dir/install-imageonly.sh"
  fi

  if [ -f "$target_dir/openclaw-pro/install-imageonly.sh" ]; then
    echo "⚠️ 远端安装脚本下载失败，回退使用本地仓库 openclaw-pro/install-imageonly.sh" >&2
    chmod +x "$target_dir/openclaw-pro/install-imageonly.sh" || true
    exec env TARGET_DIR="$target_dir" bash "$target_dir/openclaw-pro/install-imageonly.sh"
  fi

  echo "⚠️ 无法下载 ImageOnly 安装脚本，请稍后重试。" >&2
  exit 1
}

echo "🐾 OpenClaw Pro Installer"
echo "========================="
echo "ImageOnly 是当前唯一安装路径。"
echo ""

run_imageonly_installer
