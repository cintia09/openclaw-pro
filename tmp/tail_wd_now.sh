#!/bin/sh
set -eu
echo __NOW__
date
echo __PS__
ps -eo pid,ppid,etimes,args | grep -E 'openclaw|gateway-watchdog|start-services|npm view openclaw' | grep -v grep || true
echo __WD_TAIL__
tail -n 60 /root/.openclaw/logs/gateway-watchdog.log 2>/dev/null || true
