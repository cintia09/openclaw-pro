#!/usr/bin/env python3
"""Check for quote character mismatches between index.html and i18n.js"""
import re

with open('web/public/index.html', 'r') as f:
    html = f.read()
with open('web/public/i18n.js', 'r') as f:
    i18n = f.read()

html_lines = html.split('\n')
i18n_lines = i18n.split('\n')

print('=== Smart quotes (\u201c\u201d) in index.html ===')
for i, line in enumerate(html_lines, 1):
    if '\u201c' in line or '\u201d' in line:
        snippet = line.strip()[:120]
        print(f'  L{i}: {snippet}')

print()
print('=== i18n.js keys with STRAIGHT quotes in Chinese context ===')
for i, line in enumerate(i18n_lines, 1):
    m = re.match(r"^\s+'(.+?)':", line)
    if m:
        key = m.group(1)
        if re.search(r'[\u4e00-\u9fff]', key) and '"' in key:
            print(f'  L{i}: {key[:100]}')

print()
print('=== i18n.js keys with SMART quotes ===')
for i, line in enumerate(i18n_lines, 1):
    m = re.match(r"^\s+'(.+?)':", line)
    if m:
        key = m.group(1)
        if '\u201c' in key or '\u201d' in key:
            print(f'  L{i}: {key[:100]}')
