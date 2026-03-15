#!/bin/sh
set -eu
sleep 90
echo __PS__
ps -eo pid,ppid,etimes,args | grep -E 'openclaw|gateway-watchdog|start-services' | grep -v grep || true
echo __PORT__
(ss -tlnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep 18789 || true
echo __HEALTH__
curl --noproxy '*' -sS --max-time 5 -i http://127.0.0.1:18789/health || true
echo __WD_LOG__
tail -n 160 /root/.openclaw/logs/gateway-watchdog.log 2>/dev/null || true
echo __RUNTIME_RECENT__
grep -nE '21:5|22:0|force: no listeners|already running|Registered|health|listen|port 18789' /tmp/openclaw/openclaw-$(date +%F).log | tail -n 120 || true
