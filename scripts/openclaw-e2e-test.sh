#!/usr/bin/env bash
set -u

API_BASE="${API_BASE:-http://127.0.0.1:3000}"
TASK_TIMEOUT_SEC="${TASK_TIMEOUT_SEC:-900}"
TASK_POLL_SEC="${TASK_POLL_SEC:-5}"
CHECK_ONLY_COMMAND_CHAIN="${CHECK_ONLY_COMMAND_CHAIN:-0}"

PASS=0
FAIL=0

log() { echo "[$(date '+%F %T')] $*"; }
pass() { PASS=$((PASS+1)); echo "[PASS] $*"; }
fail() { FAIL=$((FAIL+1)); echo "[FAIL] $*"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 2
  }
}

need_cmd curl
need_cmd jq
need_cmd node

sign_cookie() {
  local secret
  secret="$(jq -r '.webAuth.secret // ""' /root/.openclaw/docker-config.json 2>/dev/null || true)"
  [ -n "$secret" ] || return 1
  node - "$secret" <<'NODE'
const crypto = require('crypto');
const secret = process.argv[2] || '';
const b64u = (s) => Buffer.from(s).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const payload = b64u(JSON.stringify({u:'admin', exp: Date.now() + 2*60*60*1000}));
const sig = b64u(crypto.createHmac('sha256', secret).update(payload).digest());
process.stdout.write(`${payload}.${sig}`);
NODE
}

COOKIE="$(sign_cookie)"
if [ -z "$COOKIE" ]; then
  echo "cannot build auth cookie" >&2
  exit 2
fi

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -H "Cookie: oc_session=$COOKIE" -H "Content-Type: application/json" -X "$method" "$API_BASE$path" -d "$body"
  else
    curl -fsS -H "Cookie: oc_session=$COOKIE" -X "$method" "$API_BASE$path"
  fi
}

get_gateway_code() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:18789/health || true
}

log "T1: web/api auth basic"
if api GET /api/openclaw >/tmp/oc-status.json 2>/tmp/oc-status.err; then
  pass "api /api/openclaw reachable"
else
  fail "api /api/openclaw unreachable: $(cat /tmp/oc-status.err 2>/dev/null || true)"
fi

log "T2: status schema fields"
if jq -e '.installed != null and .gatewayRunning != null and .installTaskRunning != null and .repairTaskRunning != null and .gatewayRestartRunning != null' /tmp/oc-status.json >/dev/null 2>&1; then
  pass "status schema includes required runtime flags"
else
  fail "status schema missing required fields"
fi

log "T3: backups list endpoint"
if api GET /api/openclaw/config/backups >/tmp/oc-backups.json 2>/tmp/oc-backups.err && jq -e '.success == true and (.backups | type == "array")' /tmp/oc-backups.json >/dev/null 2>&1; then
  pass "backups list endpoint ok"
else
  fail "backups list endpoint failed: $(cat /tmp/oc-backups.err 2>/dev/null || true)"
fi

log "T4: restore invalid backup should fail cleanly"
if api POST /api/openclaw/config/restore '{"name":"not-exists.json"}' >/tmp/oc-restore-invalid.json 2>/tmp/oc-restore-invalid.err; then
  fail "restore invalid backup unexpectedly succeeded"
else
  if grep -Eq '404|不存在|invalid|无效' /tmp/oc-restore-invalid.err /tmp/oc-restore-invalid.json 2>/dev/null; then
    pass "restore invalid backup returns error as expected"
  else
    pass "restore invalid backup failed (non-2xx), treated as expected"
  fi
fi

log "T5: trigger update/install task"
UPDATE_RESP="$(api POST /api/openclaw/update 2>/tmp/oc-update.err || true)"
TASK_ID="$(echo "$UPDATE_RESP" | jq -r '.taskId // ""' 2>/dev/null || true)"
if [ -z "$TASK_ID" ]; then
  fail "update did not return taskId: $(cat /tmp/oc-update.err 2>/dev/null || true) | resp=$UPDATE_RESP"
else
  pass "update returned taskId=$TASK_ID"
fi

if [ -n "$TASK_ID" ]; then
  log "T6: verify command chain in task log (source download + build)"
  sleep 2
  TASK_JSON="$(api GET "/api/openclaw/install/$TASK_ID" 2>/tmp/oc-task.err || true)"
  TASK_LOG="$(echo "$TASK_JSON" | jq -r '.log // ""' 2>/dev/null || true)"

  if echo "$TASK_LOG" | grep -q 'OPENCLAW_TARBALL_URL="https://codeload.github.com/'; then
    pass "task uses codeload source tarball"
  else
    fail "task log missing codeload source tarball"
  fi

  if echo "$TASK_LOG" | grep -q 'install_with_registry()'; then
    pass "task includes compile dependency retry installer"
  else
    fail "task log missing install_with_registry fallback"
  fi

  if [ "$CHECK_ONLY_COMMAND_CHAIN" != "1" ]; then
    log "T7: wait task final status (timeout=${TASK_TIMEOUT_SEC}s)"
    waited=0
    final_status="running"
    final_exit=""
    while [ "$waited" -lt "$TASK_TIMEOUT_SEC" ]; do
      TJSON="$(api GET "/api/openclaw/install/$TASK_ID" 2>/tmp/oc-task-poll.err || true)"
      final_status="$(echo "$TJSON" | jq -r '.status // ""' 2>/dev/null || true)"
      final_exit="$(echo "$TJSON" | jq -r '.exitCode // ""' 2>/dev/null || true)"
      if [ "$final_status" = "success" ] || [ "$final_status" = "failed" ]; then
        break
      fi
      sleep "$TASK_POLL_SEC"
      waited=$((waited + TASK_POLL_SEC))
    done

    if [ "$final_status" = "success" ]; then
      pass "task completed successfully"
    elif [ "$final_status" = "failed" ]; then
      fail "task failed (exitCode=$final_exit)"
      echo "$TJSON" | jq -r '.log // ""' | tail -n 80 >/tmp/oc-task-tail.log
    else
      fail "task timeout after ${TASK_TIMEOUT_SEC}s"
    fi
  else
    pass "skip waiting task final status (CHECK_ONLY_COMMAND_CHAIN=1)"
  fi
fi

log "T8: restart gateway api + health"
if api POST /api/openclaw/start >/tmp/oc-start.json 2>/tmp/oc-start.err; then
  pass "restart api accepted"
else
  fail "restart api failed: $(cat /tmp/oc-start.err 2>/dev/null || true)"
fi

sleep 4
GCODE="$(get_gateway_code)"
if [ "$GCODE" = "200" ] || [ "$GCODE" = "401" ] || [ "$GCODE" = "403" ]; then
  pass "gateway health code ok ($GCODE)"
else
  fail "gateway health code unexpected ($GCODE)"
fi

log "T9: watchdog process present"
wd_wait=0
while [ "$wd_wait" -lt 30 ]; do
  if pgrep -f "[o]penclaw-gateway-watchdog.sh" >/dev/null 2>&1; then
    pass "watchdog running"
    break
  fi
  sleep 2
  wd_wait=$((wd_wait + 2))
done
if [ "$wd_wait" -ge 30 ]; then
  fail "watchdog not running"
fi

echo
log "E2E RESULT: PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
