#!/bin/sh
set -eu
echo __PGREP__
pgrep -a -x openclaw || true
pgrep -a -x openclaw-gateway || true
pgrep -a -f 'openclaw.mjs gateway' || true
pgrep -a -f 'openclaw.*gateway run' || true
echo __PS14910__
ps -fp 14910 || true
echo __WD_STATUS__
ps -fp 15554 || true
echo __PORT__
(ss -tlnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep 18789 || true
