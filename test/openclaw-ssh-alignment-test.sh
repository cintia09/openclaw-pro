#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${1:-clawnook}"
SSH_PORT="${SSH_PORT:-2222}"
SSH_USER="${SSH_USER:-}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "[FAIL] 容器未运行: $CONTAINER_NAME"
  exit 1
fi

if [ -z "$SSH_USER" ]; then
  SSH_USER="$(docker exec "$CONTAINER_NAME" bash -lc "cat /root/.openclaw/users/ssh_user 2>/dev/null | head -1" || true)"
  [ -z "$SSH_USER" ] && SSH_USER="root"
fi

sshd_t="$(docker exec "$CONTAINER_NAME" bash -lc "/usr/sbin/sshd -T 2>/dev/null")"
echo "$sshd_t" | grep -q '^passwordauthentication no$' || { echo "[FAIL] passwordauthentication 不是 no"; exit 1; }
echo "$sshd_t" | grep -q '^kbdinteractiveauthentication no$' || { echo "[FAIL] kbdinteractiveauthentication 不是 no"; exit 1; }
if echo "$sshd_t" | grep -q '^challengeresponseauthentication '; then
  echo "$sshd_t" | grep -q '^challengeresponseauthentication no$' || { echo "[FAIL] challenge-response 未禁用"; exit 1; }
fi
echo "$sshd_t" | grep -q '^pubkeyauthentication yes$' || { echo "[FAIL] pubkeyauthentication 不是 yes"; exit 1; }

if [ "$SSH_USER" != "root" ]; then
  echo "$sshd_t" | grep -q '^permitrootlogin no$' || { echo "[FAIL] 普通用户模式下 root 未禁用"; exit 1; }
  echo "$sshd_t" | grep -q "^allowusers ${SSH_USER}$" || { echo "[FAIL] AllowUsers 未限制为 ${SSH_USER}"; exit 1; }
  docker exec "$CONTAINER_NAME" bash -lc "id '$SSH_USER' >/dev/null 2>&1" || { echo "[FAIL] 容器内用户不存在: $SSH_USER"; exit 1; }
fi

if command -v ssh >/dev/null 2>&1; then
  set +e
  ssh_out="$(ssh -p "$SSH_PORT" -o PreferredAuthentications=password -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=0 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "${SSH_USER}@localhost" true 2>&1)"
  ssh_rc=$?
  set -e
  if [ "$ssh_rc" -eq 0 ]; then
    echo "[FAIL] 密码认证测试异常通过"
    exit 1
  fi
  echo "$ssh_out" | grep -Eiq 'publickey|permission denied' || { echo "[FAIL] 未得到预期拒绝信息"; echo "$ssh_out"; exit 1; }
fi

echo "[PASS] SSH 安全策略与 Windows 对齐（仅密钥登录）"
