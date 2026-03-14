#!/bin/sh
set -eu
echo __LOCAL_VERSION__
node -e 'try{console.log(require("/tmp/openclaw-runtime/openclaw-source/package.json").version||"")}catch(e){console.error(e.message);process.exit(1)}' || true
echo __PERSIST_VERSION__
node -e 'try{console.log(require("/root/.openclaw/openclaw-source/package.json").version||"")}catch(e){console.error(e.message);process.exit(1)}' || true
echo __LOCAL_ENTRY__
ls -l /tmp/openclaw-runtime/openclaw-source/openclaw.mjs /tmp/openclaw-runtime/openclaw-source/dist/entry.js 2>/dev/null || true
