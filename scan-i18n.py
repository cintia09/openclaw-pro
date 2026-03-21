#!/usr/bin/env python3
"""
Comprehensive i18n coverage scanner for OpenClaw Web Panel.
Scans app.js and index.html for Chinese text not covered by _t() or i18n.js dictionary.
"""
import re, sys, json

def load_i18n_keys(path):
    """Extract all Chinese keys from i18n.js _en dictionary"""
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    m = re.search(r'const _en = \{([\s\S]*?)\n  \};', content)
    if not m:
        print("ERROR: Could not find _en dictionary"); sys.exit(1)
    keys = set()
    for line in m.group(1).split('\n'):
        km = re.match(r"\s+'([^']+)':\s*'", line)
        if km:
            keys.add(km.group(1))
    return keys

def has_chinese(s):
    return bool(re.search(r'[\u4e00-\u9fff]', s))

def extract_chinese_segments(s):
    """Extract contiguous Chinese text segments from a string"""
    return re.findall(r'[\u4e00-\u9fff\uff00-\uffef]+(?:[\s\w\d./\-:()（）、，。！？·+—]*[\u4e00-\u9fff\uff00-\uffef]+)*', s)

# === SCAN APP.JS ===
print("=" * 70)
print("SCANNING app.js — Chinese strings NOT wrapped in _t()")
print("=" * 70)

i18n_keys = load_i18n_keys('web/public/i18n.js')
print(f"i18n.js has {len(i18n_keys)} keys\n")

with open('web/public/app.js', 'r', encoding='utf-8') as f:
    app_lines = f.readlines()

# Find Chinese text in app.js that is NOT inside _t() calls
app_issues = []
for i, line in enumerate(app_lines, 1):
    stripped = line.strip()
    if not has_chinese(stripped):
        continue
    # Skip comments
    if stripped.startswith('//') or stripped.startswith('*') or stripped.startswith('/*'):
        continue
    # Skip lines that are already fully inside _t()
    # Check if ALL Chinese segments in this line are inside _t() calls
    # Simple heuristic: if _t(' appears before each Chinese segment
    
    # Extract Chinese text not inside _t('...')
    # Remove _t('...') content first, then check if Chinese remains
    cleaned = re.sub(r"_t\('[^']*'(?:,\s*[^)]+)?\)", '', line)
    # Also remove _t("...") form
    cleaned = re.sub(r'_t\("[^"]*"(?:,\s*[^)]+)?\)', '', cleaned)
    
    if has_chinese(cleaned):
        # Check if the remaining Chinese is covered by i18n.js substring matching
        segs = extract_chinese_segments(cleaned)
        uncovered = []
        for seg in segs:
            # Check if this segment or a key containing it exists
            found = False
            for key in i18n_keys:
                if seg in key or key in seg:
                    found = True
                    break
            if not found and len(seg) >= 2:
                uncovered.append(seg)
        if uncovered:
            app_issues.append((i, stripped[:120], uncovered))

print(f"Found {len(app_issues)} lines with uncovered Chinese text:\n")
for lineno, text, segs in app_issues:
    print(f"  L{lineno}: {text[:100]}")
    for s in segs:
        print(f"         ↳ missing: '{s}'")
    print()

# === SCAN INDEX.HTML ===
print("=" * 70)
print("SCANNING index.html — Chinese text not covered by i18n.js keys")
print("=" * 70)

with open('web/public/index.html', 'r', encoding='utf-8') as f:
    html_lines = f.readlines()

html_issues = []
for i, line in enumerate(html_lines, 1):
    stripped = line.strip()
    if not has_chinese(stripped):
        continue
    # Skip script blocks (handled by app.js scan)
    if '<script' in stripped.lower() or '</script' in stripped.lower():
        continue
    
    # Extract visible text (strip HTML tags)
    text_only = re.sub(r'<[^>]+>', ' ', stripped)
    text_only = re.sub(r'&[a-z]+;', ' ', text_only)
    text_only = text_only.strip()
    
    if not has_chinese(text_only):
        continue
    
    segs = extract_chinese_segments(text_only)
    uncovered = []
    for seg in segs:
        found = False
        for key in i18n_keys:
            if seg in key or key in seg:
                found = True
                break
        if not found and len(seg) >= 2:
            uncovered.append(seg)
    if uncovered:
        html_issues.append((i, text_only[:120], uncovered))

print(f"\nFound {len(html_issues)} lines with uncovered Chinese text:\n")
for lineno, text, segs in html_issues:
    print(f"  L{lineno}: {text[:100]}")
    for s in segs:
        print(f"         ↳ missing: '{s}'")
    print()

# === SUMMARY ===
print("=" * 70)
print(f"SUMMARY: {len(app_issues)} app.js issues, {len(html_issues)} index.html issues")
print("=" * 70)

# Collect all unique missing segments
all_missing = set()
for _, _, segs in app_issues + html_issues:
    for s in segs:
        all_missing.add(s)

print(f"\nUnique missing Chinese segments: {len(all_missing)}")
for s in sorted(all_missing, key=lambda x: -len(x)):
    print(f"  '{s}'")
