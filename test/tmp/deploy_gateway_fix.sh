#!/bin/sh
set -eu
stamp=$(date +%Y%m%d-%H%M%S)
cp /usr/local/bin/start-services.sh "/usr/local/bin/start-services.sh.bak.$stamp"
cp /usr/local/bin/openclaw-gateway-watchdog.sh "/usr/local/bin/openclaw-gateway-watchdog.sh.bak.$stamp"
install -m 755 /tmp/start-services.sh /usr/local/bin/start-services.sh
install -m 755 /tmp/openclaw-gateway-watchdog.sh /usr/local/bin/openclaw-gateway-watchdog.sh
bash -n /usr/local/bin/start-services.sh
bash -n /usr/local/bin/openclaw-gateway-watchdog.sh
pkill -TERM -f openclaw-gateway-watchdog.sh || true
pkill -TERM -x openclaw-gateway || true
pkill -TERM -x openclaw || true
sleep 3
nohup /usr/local/bin/openclaw-gateway-watchdog.sh >/root/.openclaw/logs/gateway-watchdog.log 2>&1 </dev/null &
sleep 5
ps -eo pid,ppid,etimes,args | grep -E 'openclaw|gateway-watchdog|start-services' | grep -v grep
