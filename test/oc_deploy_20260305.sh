set -e
ROOT="/Volumes/MacData/MyData/Documents/project/clawnook"
REMOTE_TMP_DIR="/root/.openclaw/test-tmp"
ssh -p 2223 wm_20@192.168.31.107 "sudo -n mkdir -p $REMOTE_TMP_DIR"
scp -P 2223 "$ROOT/web/server.js" wm_20@192.168.31.107:$REMOTE_TMP_DIR/server.js.new
scp -P 2223 "$ROOT/web/public/app.js" wm_20@192.168.31.107:$REMOTE_TMP_DIR/app.js.new
scp -P 2223 "$ROOT/scripts/openclaw-gateway-watchdog.sh" wm_20@192.168.31.107:$REMOTE_TMP_DIR/openclaw-gateway-watchdog.sh.new
scp -P 2223 "$ROOT/start-services.sh" wm_20@192.168.31.107:$REMOTE_TMP_DIR/start-services.sh.new
ssh -p 2223 wm_20@192.168.31.107 "sudo bash -lc \"install -m 644 $REMOTE_TMP_DIR/server.js.new /opt/openclaw-web/server.js && install -m 644 $REMOTE_TMP_DIR/app.js.new /opt/openclaw-web/public/app.js && install -m 755 $REMOTE_TMP_DIR/openclaw-gateway-watchdog.sh.new /usr/local/bin/openclaw-gateway-watchdog.sh && install -m 755 $REMOTE_TMP_DIR/start-services.sh.new /usr/local/bin/start-services.sh && node --check /opt/openclaw-web/server.js && bash -n /usr/local/bin/openclaw-gateway-watchdog.sh && bash -n /usr/local/bin/start-services.sh\""
