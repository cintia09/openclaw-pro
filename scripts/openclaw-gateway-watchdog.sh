#!/usr/bin/env bash
set -u

LOG_DIR="/root/.openclaw/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/gateway-watchdog.log"
GATEWAY_LOG="$LOG_DIR/gateway.log"

CHECK_INTERVAL=10
STARTUP_TIMEOUT=120
POLL_INTERVAL=2
MAX_LOG_LINES=5000

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

trim_log() {
  if [[ -f "$LOG_FILE" ]]; then
    local lines
    lines=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
    if [[ "$lines" -gt "$MAX_LOG_LINES" ]]; then
      tail -n "$((MAX_LOG_LINES / 2))" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
    fi
  fi
}

get_gateway_pid() {
  pgrep -f "[o]penclaw.*gateway" 2>/dev/null | head -1
}

is_gateway_alive() {
  [[ -n "$(get_gateway_pid)" ]]
}

is_gateway_port_ready() {
  curl -sS --connect-timeout 1 --max-time 2 http://127.0.0.1:18789/health >/dev/null 2>&1
}

kill_gateway() {
  pkill -f "[o]penclaw.*gateway" >/dev/null 2>&1 || true
  sleep 1
}

start_gateway() {
  log "Starting OpenClaw Gateway..."
  nohup openclaw gateway run --allow-unconfigured >> "$GATEWAY_LOG" 2>&1 &
}

wait_for_ready() {
  local elapsed=0
  while [[ "$elapsed" -lt "$STARTUP_TIMEOUT" ]]; do
    if is_gateway_port_ready; then
      return 0
    fi
    if ! is_gateway_alive; then
      return 1
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

restart_gateway() {
  kill_gateway
  start_gateway
  if wait_for_ready; then
    log "Gateway is ready (PID=$(get_gateway_pid))"
  else
    log "Gateway failed to become ready within ${STARTUP_TIMEOUT}s"
  fi
}

log "openclaw-gateway-watchdog started"

while true; do
  if ! command -v openclaw >/dev/null 2>&1; then
    log "openclaw CLI not found, watchdog idle"
    sleep "$CHECK_INTERVAL"
    continue
  fi

  if ! is_gateway_alive || ! is_gateway_port_ready; then
    log "Gateway down or unhealthy, restarting..."
    restart_gateway
  fi

  trim_log
  sleep "$CHECK_INTERVAL"
done
