#!/bin/sh
set -eu
sleep 25
echo __PS__
ps -eo pid,ppid,etimes,args | grep -E 'openclaw|gateway-watchdog|start-services|rsync' | grep -v grep || true
echo __PORT__
(ss -tlnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep 18789 || true
echo __HEALTH__
curl --noproxy '*' -sS --max-time 5 -i http://127.0.0.1:18789/health || true
echo __WD_LOG__
tail -n 120 /root/.openclaw/logs/gateway-watchdog.log 2>/dev/null || true
echo __TMP_SRC__
ls -ld /tmp/openclaw-runtime /tmp/openclaw-runtime/openclaw-source 2>/dev/null || true
