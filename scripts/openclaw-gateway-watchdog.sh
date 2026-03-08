#!/bin/bash
#
# OpenClaw Gateway Watchdog v2 (source-build mode)
#

set -u

LOG_DIR="/root/.openclaw/logs"
mkdir -p "$LOG_DIR"
mkdir -p "/root/.openclaw/locks"
LOG_FILE="$LOG_DIR/gateway-watchdog.log"

CHECK_INTERVAL=10
POLL_INTERVAL=5
STARTUP_TIMEOUT=900
MAX_RETRIES=3
BACKOFF_WAIT=300
PORT=18789
MAX_LOG_LINES=5000

HOME="${HOME:-/root}"
export HOME
export DISPLAY=:99

SOURCE_ROOT="/root/.openclaw/openclaw-source"
GATEWAY_CMD="node --experimental-sqlite /root/.openclaw/openclaw-source/openclaw.mjs gateway run --force --allow-unconfigured"
GATEWAY_LOG="/root/.openclaw/logs/openclaw-gateway.log"
OPENCLAW_RUNTIME_VERSION="${OPENCLAW_VERSION:-}"

LOCK_DIR="/root/.openclaw/locks/gateway-watchdog.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"
LOCK_FILE="/root/.openclaw/locks/gateway-watchdog.lockfile"
OPERATION_LOCK_FILE="/root/.openclaw/locks/operation.lock"

CONFIG_FILE="/root/.openclaw/openclaw.json"
BACKUP_DIR="/root/.openclaw/config-backups"
BACKUP_INDEX_FILE="/root/.openclaw/config-backups/.last_hash"
LAST_GOOD_BACKUP_FILE="/root/.openclaw/config-backups/.last_good"
MAX_BACKUPS=30

CONSECUTIVE_FAILURES=0
LAST_PID=""
STARTUP_OLD_PIDS=""
LAST_IDLE_RUNTIME_LOG_TS=0
IDLE_RUNTIME_LOG_INTERVAL=300

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log_event() {
  local event="$1"
  shift
  local msg="$*"
  if [ -n "$msg" ]; then
    log "[wd][$event] $msg"
  else
    log "[wd][$event]"
  fi
}

log_throttled() {
  local now key interval msg
  key="$1"
  interval="$2"
  shift 2
  msg="$*"
  now=$(date +%s)

  case "$key" in
    runtime-missing)
      if [ $((now - LAST_IDLE_RUNTIME_LOG_TS)) -lt "$interval" ]; then
        return 0
      fi
      LAST_IDLE_RUNTIME_LOG_TS="$now"
      ;;
    *)
      ;;
  esac

  log "$msg"
}

detect_runtime_version() {
  [ -n "$OPENCLAW_RUNTIME_VERSION" ] && return 0
  local candidates file ver
  candidates="$SOURCE_ROOT/package.json /root/.npm-global/lib/node_modules/openclaw/package.json /usr/local/lib/node_modules/openclaw/package.json /usr/lib/node_modules/openclaw/package.json"
  for file in $candidates; do
    [ -f "$file" ] || continue
    ver=$(grep -m1 '"version"' "$file" 2>/dev/null | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' | tr -d '\r\n ')
    if [ -n "$ver" ] && [ "$ver" != "dev" ] && [ "$ver" != "unknown" ]; then
      OPENCLAW_RUNTIME_VERSION="$ver"
      export OPENCLAW_VERSION="$ver"
      export OPENCLAW_SERVICE_VERSION="$ver"
      return 0
    fi
  done
  return 1
}

config_hash() {
  local file="$1"
  [ -f "$file" ] || return 1
  sha256sum "$file" 2>/dev/null | awk '{print $1}'
}

trim_backups() {
  [ -d "$BACKUP_DIR" ] || return 0
  local files
  files=$(ls -1t "$BACKUP_DIR"/openclaw-*.json 2>/dev/null || true)
  local count=0
  local file
  for file in $files; do
    count=$((count + 1))
    if [ "$count" -gt "$MAX_BACKUPS" ]; then
      rm -f "$file" 2>/dev/null || true
    fi
  done
}

backup_config_if_changed() {
  mkdir -p "$BACKUP_DIR"
  [ -f "$CONFIG_FILE" ] || return 0

  local cur_hash prev_hash backup_file
  cur_hash=$(config_hash "$CONFIG_FILE")
  [ -n "$cur_hash" ] || return 0

  prev_hash=""
  if [ -f "$BACKUP_INDEX_FILE" ]; then
    prev_hash=$(cat "$BACKUP_INDEX_FILE" 2>/dev/null || true)
  fi

  if [ "$cur_hash" = "$prev_hash" ]; then
    return 0
  fi

  backup_file="$BACKUP_DIR/openclaw-$(date '+%Y%m%d-%H%M%S').json"
  if cp "$CONFIG_FILE" "$backup_file" 2>/dev/null; then
    echo "$cur_hash" > "$BACKUP_INDEX_FILE"
    echo "$backup_file" > "$LAST_GOOD_BACKUP_FILE"
    log "Config changed after successful start, backup created: $backup_file"
    log_event "backup-created" "$backup_file"
    trim_backups
  fi
}

is_invalid_config_failure() {
  [ -f "$GATEWAY_LOG" ] || return 1
  tail -n 120 "$GATEWAY_LOG" 2>/dev/null | grep -Eiq 'Unrecognized key|Invalid config|schema|validation|parse|配置无效|unexpected token|doctor --fix'
}

restore_previous_backup() {
  mkdir -p "$BACKUP_DIR"
  local backup_file=""

  if [ -f "$LAST_GOOD_BACKUP_FILE" ]; then
    backup_file=$(cat "$LAST_GOOD_BACKUP_FILE" 2>/dev/null || true)
  fi

  if [ -z "$backup_file" ] || [ ! -f "$backup_file" ]; then
    backup_file=$(ls -1t "$BACKUP_DIR"/openclaw-*.json 2>/dev/null | head -1 || true)
  fi

  if [ -z "$backup_file" ] || [ ! -f "$backup_file" ]; then
    log "No config backup found for rollback"
    return 1
  fi

  if [ -f "$CONFIG_FILE" ]; then
    cp "$CONFIG_FILE" "$CONFIG_FILE.before-auto-rollback.$(date '+%Y%m%d-%H%M%S').bak" 2>/dev/null || true
  fi

  if cp "$backup_file" "$CONFIG_FILE" 2>/dev/null; then
    local hash
    hash=$(config_hash "$CONFIG_FILE" || true)
    [ -n "$hash" ] && echo "$hash" > "$BACKUP_INDEX_FILE"
    log "Config rollback applied from backup: $backup_file"
    log_event "rollback-success" "$backup_file"
    return 0
  fi

  log "Failed to restore config backup: $backup_file"
  log_event "rollback-failed" "$backup_file"
  return 1
}

get_gateway_pid() {
  pgrep -x "openclaw-gateway" 2>/dev/null | head -1 && return
  pgrep -x "openclaw-gatewa" 2>/dev/null | head -1 && return
  pgrep -f "openclaw.mjs gateway" 2>/dev/null | head -1 && return
  pgrep -f "openclaw.*gateway run" 2>/dev/null | head -1 && return
  local pid
  for pid in $(pgrep -x "openclaw" 2>/dev/null); do
    [[ "$(cat /proc/$pid/comm 2>/dev/null)" == "bash" ]] && continue
    local cmdline
    cmdline="$(tr '\000' ' ' < /proc/$pid/cmdline 2>/dev/null || true)"
    case "$cmdline" in
      *"gateway run"*|*" openclaw gateway"*)
        echo "$pid"
        return
        ;;
    esac
  done
}

collect_gateway_pids() {
  {
    pgrep -x "openclaw-gateway" 2>/dev/null || true
    pgrep -x "openclaw-gatewa" 2>/dev/null || true
    pgrep -x "openclaw" 2>/dev/null || true
    pgrep -f "openclaw.mjs gateway" 2>/dev/null || true
    pgrep -f "openclaw.*gateway run" 2>/dev/null || true
  } | sed '/^$/d' | sort -u
}

pid_in_list() {
  local target="$1"
  shift || true
  local item
  for item in "$@"; do
    [ "$item" = "$target" ] && return 0
  done
  return 1
}

has_new_gateway_pid() {
  local current pid
  current="$(collect_gateway_pids | tr '\n' ' ')"
  [ -z "$current" ] && return 1
  for pid in $current; do
    if ! pid_in_list "$pid" $STARTUP_OLD_PIDS; then
      LAST_PID="$pid"
      return 0
    fi
  done
  return 1
}

old_gateway_pids_gone() {
  local pid
  [ -z "$STARTUP_OLD_PIDS" ] && return 0
  for pid in $STARTUP_OLD_PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
  done
  return 0
}

gateway_health_ready() {
  local code
  code=$(curl --noproxy '*' -sS --connect-timeout 1 --max-time 2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)
  case "$code" in
    200|401|403) return 0 ;;
  esac
  return 1
}

is_gateway_process_alive() {
  if [[ -n "$LAST_PID" ]] && kill -0 "$LAST_PID" 2>/dev/null; then
    return 0
  fi
  [[ -n "$(get_gateway_pid)" ]]
}

is_port_listening() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | grep -q ":${PORT} "
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -q "[.:]${PORT}[[:space:]]"
    return $?
  fi
  return 1
}

current_operation_type() {
  if [ ! -f "$OPERATION_LOCK_FILE" ]; then
    echo "idle"
    return 0
  fi
  local op
  op=$(grep -o '"type":"[^"]*"' "$OPERATION_LOCK_FILE" 2>/dev/null | head -1 | cut -d':' -f2 | tr -d '"')
  echo "${op:-idle}"
}

is_watchdog_standby_active() {
  local op
  op="$(current_operation_type)"
  [[ "$op" = "installing" || "$op" = "updating" || "$op" = "restarting_gateway" ]]
}

kill_gateway() {
  local pid
  pid=$(get_gateway_pid)
  [[ -z "$pid" && -n "$LAST_PID" ]] && kill -0 "$LAST_PID" 2>/dev/null && pid=$LAST_PID
  if [[ -n "$pid" ]]; then
    log "Killing gateway (PID $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    pkill -TERM -P "$pid" 2>/dev/null || true
    local waited=0
    while [[ $waited -lt 5 ]] && kill -0 "$pid" 2>/dev/null; do
      sleep 1
      ((waited++))
    done
  fi
  pkill -9 -x "openclaw-gateway" 2>/dev/null || true
  pkill -9 -x "openclaw-gatewa" 2>/dev/null || true
  pkill -9 -x "openclaw" 2>/dev/null || true
  pkill -9 -f "openclaw.mjs gateway" 2>/dev/null || true
  pkill -9 -f "openclaw.*gateway run" 2>/dev/null || true
  [[ -n "$LAST_PID" ]] && kill -9 "$LAST_PID" 2>/dev/null || true
  LAST_PID=""
  sleep 2
}

wait_for_ready() {
  local timeout=$1
  local elapsed=0
  local last_log=0

  while [[ $elapsed -lt $timeout ]]; do
    if is_port_listening; then
      if has_new_gateway_pid && old_gateway_pids_gone && gateway_health_ready; then
        return 0
      fi
      if [[ $((elapsed - last_log)) -ge 30 ]]; then
        log "Port $PORT is listening but restart handoff not complete (need new pid + old pid gone + health ready), waiting..."
        last_log=$elapsed
      fi
    fi

    if ! is_gateway_process_alive; then
      log "Gateway process exited during startup (after ${elapsed}s)"
      return 1
    fi

    sleep "$POLL_INTERVAL"
    ((elapsed += POLL_INTERVAL))

    if [[ $((elapsed - last_log)) -ge 60 ]]; then
      log "Startup in progress... ${elapsed}s/${timeout}s"
      last_log=$elapsed
    fi
  done

  return 1
}

start_once() {
  detect_runtime_version >/dev/null 2>&1 || true
  local launch_cmd=""
  local openclaw_bin=""
  if [ -f "$SOURCE_ROOT/openclaw.mjs" ]; then
    launch_cmd="node --experimental-sqlite $SOURCE_ROOT/openclaw.mjs gateway run --force --allow-unconfigured"
  else
    openclaw_bin="$(command -v openclaw 2>/dev/null || true)"
    if [ -z "$openclaw_bin" ] && [ -x /root/.npm-global/bin/openclaw ]; then
      openclaw_bin="/root/.npm-global/bin/openclaw"
    fi
    if [ -z "$openclaw_bin" ] && [ -x /usr/local/bin/openclaw ]; then
      openclaw_bin="/usr/local/bin/openclaw"
    fi
    if [ -n "$openclaw_bin" ]; then
      launch_cmd="$openclaw_bin gateway run --force --allow-unconfigured"
    fi
  fi

  if [ -z "$launch_cmd" ]; then
    log "Cannot start gateway: neither source entry nor openclaw binary found"
    return 2
  fi

  local gateway_log_dir fallback_log
  gateway_log_dir="$(dirname "$GATEWAY_LOG")"
  if ! mkdir -p "$gateway_log_dir" 2>/dev/null; then
    fallback_log="$LOG_DIR/gateway.log"
    mkdir -p "$(dirname "$fallback_log")" 2>/dev/null || true
    log "WARN: cannot create runtime log dir ($gateway_log_dir), fallback to $fallback_log"
    GATEWAY_LOG="$fallback_log"
  fi

  if ! : > "$GATEWAY_LOG"; then
    log "ERROR: cannot write gateway log file: $GATEWAY_LOG"
    return 3
  fi
  if [ -n "$OPENCLAW_RUNTIME_VERSION" ]; then
    log "Gateway runtime version: $OPENCLAW_RUNTIME_VERSION"
  fi
  log "Gateway launch command: $launch_cmd"
  STARTUP_OLD_PIDS="$(collect_gateway_pids | tr '\n' ' ')"
  nohup bash --noprofile --norc -lc "$launch_cmd" > "$GATEWAY_LOG" 2>&1 &
  LAST_PID=$!
  log "Gateway process launched (PID $LAST_PID), polling every ${POLL_INTERVAL}s (timeout ${STARTUP_TIMEOUT}s)..."

  if wait_for_ready "$STARTUP_TIMEOUT"; then
    local actual_pid
    actual_pid=$(get_gateway_pid)
    log "Gateway started successfully (port $PORT listening, PID ${actual_pid:-$LAST_PID})"
    log_event "healthy" "pid=${actual_pid:-$LAST_PID}"
    return 0
  fi

  log "ERROR: Gateway failed to start within ${STARTUP_TIMEOUT}s"
  if [[ -f "$GATEWAY_LOG" ]]; then
    local tail_log
    tail_log=$(tail -5 "$GATEWAY_LOG" 2>/dev/null | tr '\n' ' ')
    [[ -n "$tail_log" ]] && log "  Last output: $tail_log"
  fi
  return 1
}

start_gateway() {
  if is_gateway_process_alive; then
    kill_gateway
  fi

  log "Starting gateway..."
  if start_once; then
    CONSECUTIVE_FAILURES=0
    backup_config_if_changed
    return 0
  fi

  if is_invalid_config_failure; then
    log "Detected invalid config signature from startup failure, trying automatic rollback..."
    log_event "rollback-attempt" "detected invalid config signature"
    if restore_previous_backup; then
      kill_gateway
      if start_once; then
        log "Gateway recovered after automatic config rollback"
        log_event "rollback-success" "gateway recovered after rollback"
        CONSECUTIVE_FAILURES=0
        backup_config_if_changed
        return 0
      fi
      log "Gateway still failed after rollback attempt"
      log_event "rollback-failed" "gateway still failed after rollback attempt"
    fi
  fi

  CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
  kill_gateway
  return 1
}

handle_restart() {
  if [[ $CONSECUTIVE_FAILURES -ge $MAX_RETRIES ]]; then
    log "ALERT: ${CONSECUTIVE_FAILURES} consecutive failures — backing off ${BACKOFF_WAIT}s before retry"
    sleep "$BACKOFF_WAIT"
    CONSECUTIVE_FAILURES=0
  fi

  start_gateway
}

handle_user_requested_restart() {
  log "User requested restart detected, executing..."
  log_event "restart-requested" "user initiated"

  # 执行重启
  kill_gateway
  if start_gateway; then
    log "User requested restart completed successfully"
    log_event "restart-completed" "success"
  else
    log "User requested restart failed"
    log_event "restart-failed" "start_gateway failed"
  fi

  # 清除 operation.lock，表示操作完成
  rm -f "$OPERATION_LOCK_FILE" 2>/dev/null || true
}

trim_log() {
  if [[ -f "$LOG_FILE" ]]; then
    local lines
    lines=$(wc -l < "$LOG_FILE")
    if [[ $lines -gt $MAX_LOG_LINES ]]; then
      tail -n "$((MAX_LOG_LINES / 2))" "$LOG_FILE" > "${LOG_FILE}.tmp"
      mv "${LOG_FILE}.tmp" "$LOG_FILE"
    fi
  fi
}

acquire_lock() {
  # 使用 lock_dir 作为主锁，避免 flock FD 被子进程继承后造成“假占锁”

  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_PID_FILE"
    return 0
  fi

  # 若锁目录刚创建但 pid 文件尚未写入，避免误判为 stale 导致并发实例
  if [[ ! -f "$LOCK_PID_FILE" ]]; then
    local lock_mtime now age
    lock_mtime=$(stat -c %Y "$LOCK_DIR" 2>/dev/null || date +%s)
    now=$(date +%s)
    age=$((now - lock_mtime))
    if [[ $age -lt 15 ]]; then
      log "Lock exists without pid (age=${age}s), assume another instance is starting"
      return 1
    fi
  fi

  local old_pid=""
  if [[ -f "$LOCK_PID_FILE" ]]; then
    old_pid=$(cat "$LOCK_PID_FILE" 2>/dev/null || true)
  fi

  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    local cmdline
    cmdline=$(ps -o args= -p "$old_pid" 2>/dev/null || true)
    if echo "$cmdline" | grep -q "openclaw-gateway-watchdog.sh"; then
      log "Another watchdog instance detected (pid=$old_pid), exiting"
      return 1
    fi
  fi

  log "Detected stale watchdog lock, cleaning up"
  rm -rf "$LOCK_DIR" >/dev/null 2>&1 || true
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_PID_FILE"
    return 0
  fi

  log "Failed to acquire watchdog lock, exiting"
  return 1
}

if ! acquire_lock; then
  exit 0
fi
trap 'rm -rf "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

mkdir -p "$BACKUP_DIR"

log "Watchdog v2 started (poll=${POLL_INTERVAL}s, timeout=${STARTUP_TIMEOUT}s, port=$PORT)"
log_event "start" "poll=${POLL_INTERVAL}s timeout=${STARTUP_TIMEOUT}s port=$PORT"

while true; do
  op=$(current_operation_type)

  # 优先处理用户请求的重启
  if [[ "$op" == "restarting_gateway" ]]; then
    handle_user_requested_restart
    sleep "$CHECK_INTERVAL"
    continue
  fi

  if is_watchdog_standby_active; then
    log "OpenClaw operation in progress, watchdog standby"
    sleep "$CHECK_INTERVAL"
    continue
  fi

  if [ ! -f "$SOURCE_ROOT/openclaw.mjs" ] && ! command -v openclaw >/dev/null 2>&1 && [ ! -x /root/.npm-global/bin/openclaw ] && [ ! -x /usr/local/bin/openclaw ]; then
    log_throttled "runtime-missing" "$IDLE_RUNTIME_LOG_INTERVAL" "OpenClaw runtime entry missing (source/binary), watchdog idle"
    sleep "$CHECK_INTERVAL"
    continue
  fi

  if ! is_gateway_process_alive; then
    log "Gateway is DOWN — restarting"
    handle_restart
  elif ! is_port_listening; then
    uptime=0
    uptime=$(ps -o etimes= -p "$(get_gateway_pid)" 2>/dev/null | tr -d ' ')
    uptime=${uptime:-0}
    if [[ $uptime -ge $STARTUP_TIMEOUT ]]; then
      log "Gateway stuck — alive for ${uptime}s but port $PORT not listening. Force restarting..."
      handle_restart
    else
      log "Gateway starting up (${uptime}s/${STARTUP_TIMEOUT}s)..."
    fi
  fi

  trim_log
  sleep "$CHECK_INTERVAL"
done
