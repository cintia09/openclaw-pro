#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTAINER_NAME="${1:-clawnook}"
GATEWAY_DIST_PATH="/root/.openclaw/openclaw-source/dist/gateway-cli-CuZs0RlJ.js"
WEB_ROOT="/opt/openclaw-web"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_cmd docker
require_cmd python3
require_cmd node

echo "[patch] validating local files"
node --check "$PROJECT_ROOT/web/server.js"
node --check "$PROJECT_ROOT/web/public/app.js"

echo "[patch] verifying container: $CONTAINER_NAME"
docker inspect "$CONTAINER_NAME" >/dev/null 2>&1

echo "[patch] syncing web files"
docker cp "$PROJECT_ROOT/web/server.js" "$CONTAINER_NAME:$WEB_ROOT/server.js"
docker cp "$PROJECT_ROOT/web/public/app.js" "$CONTAINER_NAME:$WEB_ROOT/public/app.js"

echo "[patch] backing up gateway runtime"
backup_name="gateway-cli-CuZs0RlJ.js.bak-unpair-disconnect-$(date +%Y%m%d%H%M%S)"
docker exec "$CONTAINER_NAME" cp "$GATEWAY_DIST_PATH" "/root/.openclaw/openclaw-source/dist/$backup_name"

echo "[patch] patching gateway runtime"
docker exec -i "$CONTAINER_NAME" python3 - <<'PY'
from pathlib import Path

path = Path("/root/.openclaw/openclaw-source/dist/gateway-cli-CuZs0RlJ.js")
text = path.read_text(encoding="utf-8")

old_registry = """\tget(nodeId) {\n\t\treturn this.nodesById.get(nodeId);\n\t}\n\tasync invoke(params) {"""
new_registry = """\tget(nodeId) {\n\t\treturn this.nodesById.get(nodeId);\n\t}\n\tdisconnect(nodeId, code = 1008, reason = \"device unpaired\") {\n\t\tconst node = this.nodesById.get(nodeId);\n\t\tif (!node?.client?.socket) return false;\n\t\tconst socket = node.client.socket;\n\t\ttry {\n\t\t\tif (typeof socket.close === \"function\") {\n\t\t\t\tsocket.close(code, reason);\n\t\t\t\treturn true;\n\t\t\t}\n\t\t} catch {\n\t\t}\n\t\ttry {\n\t\t\tif (typeof socket.terminate === \"function\") {\n\t\t\t\tsocket.terminate();\n\t\t\t\treturn true;\n\t\t\t}\n\t\t} catch {\n\t\t}\n\t\treturn false;\n\t}\n\tasync invoke(params) {"""

old_remove = """\t\tconst { deviceId } = params;\n\t\tconst removed = await removePairedDevice(deviceId);\n\t\tif (!removed) {\n\t\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, \"unknown deviceId\"));\n\t\t\treturn;\n\t\t}\n\t\tcontext.logGateway.info(`device pairing removed device=${removed.deviceId}`);\n\t\trespond(true, removed, void 0);\n\t},"""
new_remove = """\t\tconst { deviceId } = params;\n\t\tconst removed = await removePairedDevice(deviceId);\n\t\tif (!removed) {\n\t\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, \"unknown deviceId\"));\n\t\t\treturn;\n\t\t}\n\t\tconst disconnected = context.nodeRegistry.disconnect(deviceId, 1008, \"device unpaired\");\n\t\tcontext.logGateway.info(`device pairing removed device=${removed.deviceId}${disconnected ? \" disconnected=true\" : \"\"}`);\n\t\trespond(true, {\n\t\t\t...removed,\n\t\t\tdisconnected\n\t\t}, void 0);\n\t},"""

if "disconnect(nodeId, code = 1008, reason = \"device unpaired\")" not in text:
    if old_registry not in text:
        raise SystemExit("failed to locate NodeRegistry insertion point")
    text = text.replace(old_registry, new_registry, 1)

if "disconnected=true" not in text:
    if old_remove not in text:
        raise SystemExit("failed to locate device.pair.remove block")
    text = text.replace(old_remove, new_remove, 1)

path.write_text(text, encoding="utf-8")
PY

echo "[patch] validating deployed gateway runtime"
docker exec "$CONTAINER_NAME" node --check "$GATEWAY_DIST_PATH"

echo "[patch] restarting gateway"
docker exec "$CONTAINER_NAME" sh -lc "pid=\$(pgrep -f 'openclaw.mjs gateway run --force --allow-unconfigured' | head -n 1 || true); if [ -n \"\$pid\" ]; then kill \"\$pid\"; fi"
docker exec "$CONTAINER_NAME" sh -lc "sleep 6; pgrep -af 'openclaw\\.mjs gateway run|openclaw-gateway-watchdog' || true"

echo "[patch] restarting web panel"
docker exec "$CONTAINER_NAME" sh -lc "pid=\$(ps -eo pid,args | awk '/node .*server\\.js/ && !/awk/ { print \$1; exit }'); if [ -n \"\$pid\" ]; then kill \"\$pid\"; fi"
docker exec "$CONTAINER_NAME" sh -lc "cd $WEB_ROOT && nohup node server.js >/root/.openclaw/logs/web-panel.log 2>&1 </dev/null &"

echo "[patch] verifying listening ports"
docker exec "$CONTAINER_NAME" sh -lc "ss -ltn '( sport = :18789 or sport = :3000 )' 2>/dev/null || netstat -ltn 2>/dev/null | grep -E '18789|3000' || true"

echo "[patch] completed"