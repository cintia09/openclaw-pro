#!/usr/bin/env python3
import re

with open('web/public/app.js','r') as f:
    a = f.read()
with open('web/public/i18n.js','r') as f:
    i = f.read()

targets = ['迁移数据生效', '启动完成', '包含脚本文件', '含可疑模式']

for t in targets:
    print(f'\n=== Searching for: {t} ===')
    for n, line in enumerate(a.split('\n'), 1):
        if t in line:
            print(f'  app L{n}: {line.strip()[:140]}')
            m = re.search(r"_t\('([^']+)'\s*[,)]", line)
            if m:
                key = m.group(1)
                # show special chars
                specials = [(j,c,f'U+{ord(c):04X}') for j,c in enumerate(key)
                            if ord(c) in (0x300c,0x300d,0x201c,0x201d,0x0022,0x2018,0x2019)]
                if specials:
                    print(f'    brackets: {specials}')
    for n, line in enumerate(i.split('\n'), 1):
        if t in line:
            print(f'  i18n L{n}: {line.strip()[:140]}')
