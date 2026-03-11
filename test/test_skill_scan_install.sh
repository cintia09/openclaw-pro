#!/bin/bash
# test/test_skill_scan_install.sh — 测试 Skill 扫描与安装 API
# 用法: bash test/test_skill_scan_install.sh [host] [port]
# 示例: bash test/test_skill_scan_install.sh 192.168.31.107 3000

set -euo pipefail

HOST="${1:-192.168.31.107}"
PORT="${2:-3000}"
BASE="http://${HOST}:${PORT}"
LOGDIR="$(cd "$(dirname "$0")/../log" && pwd)"
LOGFILE="${LOGDIR}/test_skill_scan_$(date +%Y%m%d_%H%M%S).log"
PASS=0
FAIL=0

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOGFILE"; }
ok()   { PASS=$((PASS+1)); log "  ✓ PASS: $*"; }
fail() { FAIL=$((FAIL+1)); log "  ✗ FAIL: $*"; }

api() {
  local method="$1" endpoint="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -X "$method" "${BASE}${endpoint}" \
      -H 'Content-Type: application/json' \
      -d "$body" --connect-timeout 10 --max-time 180 2>&1
  else
    curl -s -X "$method" "${BASE}${endpoint}" --connect-timeout 10 --max-time 30 2>&1
  fi
}

log "=== Skill Scan/Install API Test ==="
log "Target: ${BASE}"
log "Log: ${LOGFILE}"
echo ""

# Test 1: Scan with empty source
log "Test 1: Scan with empty source"
R=$(api POST /api/plugins/skill/scan '{"source":""}')
if echo "$R" | grep -q '"error"'; then ok "empty source rejected"; else fail "empty source not rejected: $R"; fi

# Test 2: Scan with invalid host
log "Test 2: Scan with blocked host URL"
R=$(api POST /api/plugins/skill/scan '{"source":"https://evil.com/repo"}')
if echo "$R" | grep -q '不支持的'; then ok "blocked host rejected"; else fail "blocked host not rejected: $R"; fi

# Test 3: Scan with shell injection attempt
log "Test 3: Scan with injection attempt"
R=$(api POST /api/plugins/skill/scan '{"source":"https://github.com/test; rm -rf /"}')
if echo "$R" | grep -q '"error"'; then ok "injection blocked"; else fail "injection not blocked: $R"; fi

# Test 4: Scan non-existent local dir
log "Test 4: Scan non-existent local directory"
R=$(api POST /api/plugins/skill/scan '{"source":"/nonexistent/path/xyz"}')
if echo "$R" | grep -q '"error"'; then ok "non-existent dir rejected"; else fail "non-existent dir not rejected: $R"; fi

# Test 5: Scan blocked sensitive path
log "Test 5: Scan blocked sensitive path"
R=$(api POST /api/plugins/skill/scan '{"source":"/etc"}')
if echo "$R" | grep -q '不可扫描'; then ok "sensitive path blocked"; else fail "sensitive path not blocked: $R"; fi

# Test 6: List plugins (should include skills)
log "Test 6: List plugins API"
R=$(api GET /api/plugins/list)
if echo "$R" | grep -q '"skills"'; then ok "plugins list returns skills"; else fail "plugins list missing skills: $R"; fi

# Test 7: Install-selected with empty list
log "Test 7: Install-selected with empty skills"
R=$(api POST /api/plugins/skill/install-selected '{"skills":[]}')
if echo "$R" | grep -q '"error"'; then ok "empty install rejected"; else fail "empty install not rejected: $R"; fi

# Test 8: Install-selected with path traversal
log "Test 8: Install-selected with path traversal"
R=$(api POST /api/plugins/skill/install-selected '{"skills":[{"dirName":"../etc","relPath":".."}]}')
if echo "$R" | grep -qi 'error\|非法'; then ok "path traversal blocked"; else fail "path traversal not blocked: $R"; fi

# Test 9: Remove non-existent skill
log "Test 9: Remove non-existent skill"
R=$(api POST /api/plugins/skill/remove '{"name":"__nonexistent_test_skill__"}')
if echo "$R" | grep -q '不存在'; then ok "non-existent remove handled"; else fail "unexpected remove response: $R"; fi

echo ""
log "=== Results: ${PASS} passed, ${FAIL} failed ==="
exit "$FAIL"
