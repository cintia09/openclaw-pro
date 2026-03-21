#!/usr/bin/env python3
"""Byte-level comparison of keys between app.js and i18n.js"""
import re

with open('web/public/app.js','r') as f:
    a = f.read()
with open('web/public/i18n.js','r') as f:
    i = f.read()

# Extract the exact key from app.js L1900
for n, line in enumerate(a.split('\n'), 1):
    if n == 1900:
        m = re.search(r"_t\('([^']+)'\)", line)
        if m:
            app_key = m.group(1)
            print(f"app.js L1900 key ({len(app_key)} chars):")
            print(f"  repr: {repr(app_key)}")
            print(f"  hex: {app_key.encode('utf-8').hex()}")
            for j, c in enumerate(app_key):
                if ord(c) > 127:
                    print(f"  [{j}] U+{ord(c):04X} {c}")

# Extract the exact key from i18n.js
for n, line in enumerate(i.split('\n'), 1):
    if '迁移数据生效' in line:
        m = re.match(r"^\s+'(.+?)':", line)
        if m:
            i_key = m.group(1)
            print(f"\ni18n.js L{n} key ({len(i_key)} chars):")
            print(f"  repr: {repr(i_key)}")
            print(f"  hex: {i_key.encode('utf-8').hex()}")
            for j, c in enumerate(i_key):
                if ord(c) > 127:
                    print(f"  [{j}] U+{ord(c):04X} {c}")
            
            if 'app_key' in dir():
                print(f"\nMATCH: {app_key == i_key}")
                if app_key != i_key:
                    for j in range(max(len(app_key), len(i_key))):
                        a_c = app_key[j] if j < len(app_key) else '<END>'
                        i_c = i_key[j] if j < len(i_key) else '<END>'
                        if a_c != i_c:
                            print(f"  DIFF at [{j}]: app=U+{ord(a_c):04X}({a_c}) vs i18n=U+{ord(i_c):04X}({i_c})")

# Also check ⏳ 等待 Gateway 启动完成
print("\n=== L2258 check ===")
for n, line in enumerate(a.split('\n'), 1):
    if n == 2258:
        m = re.search(r"_t\('([^']+)'\)", line)
        if m:
            ak = m.group(1)
            print(f"app L2258 key: {repr(ak)}")
            print(f"  hex: {ak.encode('utf-8').hex()}")
for n, line in enumerate(i.split('\n'), 1):
    if '最多 10 分钟' in line:
        m = re.match(r"^\s+'(.+?)':", line)
        if m:
            ik = m.group(1)
            print(f"i18n L{n} key: {repr(ik)}")
            print(f"  hex: {ik.encode('utf-8').hex()}")
            if 'ak' in dir():
                print(f"  MATCH: {ak == ik}")
                if ak != ik:
                    for j in range(max(len(ak), len(ik))):
                        ac = ak[j] if j < len(ak) else '<END>'
                        ic = ik[j] if j < len(ik) else '<END>'
                        if ac != ic:
                            print(f"  DIFF at [{j}]: app=U+{ord(ac):04X}({ac}) vs i18n=U+{ord(ic):04X}({ic})")
