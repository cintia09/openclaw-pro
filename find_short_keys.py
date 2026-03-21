#!/usr/bin/env python3
"""Find all short standalone i18n keys that could cause damage"""
import re

with open('web/public/i18n.js', 'r') as f:
    lines = f.readlines()

short_keys = []
for i, line in enumerate(lines, 1):
    m = re.match(r"^\s+'([^']+)'\s*:", line)
    if m:
        key = m.group(1)
        # Only Chinese keys (has at least one Chinese char)
        if re.search(r'[\u4e00-\u9fff]', key):
            # Count just the Chinese characters
            zh_count = len(re.findall(r'[\u4e00-\u9fff]', key))
            total = len(key)
            if zh_count <= 3 and total <= 6:
                val_m = re.search(r":\s*'([^']*)'", line)
                val = val_m.group(1) if val_m else '?'
                short_keys.append((i, key, val, zh_count, total))

print(f"Found {len(short_keys)} short keys (<=3 Chinese chars, <=6 total):")
print()
for ln, key, val, zhc, tot in sorted(short_keys, key=lambda x: x[3]):
    print(f"  L{ln:4d}: '{key}' ({zhc}zh/{tot}total) → '{val}'")
