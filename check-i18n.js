#!/usr/bin/env node
/**
 * Simulate the i18n DOM walker on index.html and report any remaining Chinese text.
 * Run on the server: node /tmp/check-i18n.js
 */
const fs = require('fs');
const path = require('path');

// ─── Load i18n.js _en dictionary ───
const i18nSrc = fs.readFileSync('/opt/openclaw-web/public/i18n.js', 'utf-8');

// Extract the _en dictionary by evaluating the IIFE in a sandboxed way
// We'll parse it out: find `const _en = {` ... matching `};`
const dictStart = i18nSrc.indexOf("const _en = {");
if (dictStart < 0) { console.error("Cannot find _en dict"); process.exit(1); }

let braceDepth = 0, dictEnd = -1;
for (let i = dictStart + 12; i < i18nSrc.length; i++) {
  if (i18nSrc[i] === '{') braceDepth++;
  else if (i18nSrc[i] === '}') {
    braceDepth--;
    if (braceDepth === 0) { dictEnd = i + 1; break; }
  }
}
const dictCode = i18nSrc.substring(dictStart, dictEnd);
const _en = eval('(' + dictCode.replace('const _en = ', '') + ')');

console.log(`✅ Loaded ${Object.keys(_en).length} i18n keys\n`);

// ─── _normQ (same as i18n.js) ───
function _normQ(s) {
  return s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/[\u300c\u300d]/g, '"');
}

// Sorted keys (longest first)
const sortedKeys = Object.keys(_en).sort((a, b) => b.length - a.length);

// ─── Simulate _translateTextNode ───
function translateText(raw) {
  if (!raw || !/[\u4e00-\u9fff]/.test(raw)) return raw;
  const text = _normQ(raw);
  const trimmed = text.trim();
  if (_en[trimmed]) return text.replace(trimmed, _en[trimmed]);
  // substring replacement
  let result = text;
  for (const zh of sortedKeys) {
    if (result.includes(zh)) {
      result = result.split(zh).join(_en[zh]);
    }
  }
  return result;
}

function hasChinese(s) {
  return /[\u4e00-\u9fff]/.test(s);
}

// ─── Parse index.html and extract text nodes ───
const html = fs.readFileSync('/opt/openclaw-web/public/index.html', 'utf-8');

// Simple HTML text node extractor: split at tags, keep text
const textNodes = [];
const tagRegex = /<[^>]+>/g;
let lastIndex = 0;
let lineNum = 1;
let match;

// Map character positions to line numbers
const lineMap = [];
for (let i = 0; i < html.length; i++) {
  lineMap[i] = lineNum;
  if (html[i] === '\n') lineNum++;
}

while ((match = tagRegex.exec(html)) !== null) {
  if (match.index > lastIndex) {
    const text = html.substring(lastIndex, match.index);
    if (text.trim() && hasChinese(text)) {
      textNodes.push({
        text: text.trim(),
        line: lineMap[lastIndex]
      });
    }
  }
  lastIndex = match.index + match[0].length;
}

console.log(`📄 Found ${textNodes.length} Chinese text nodes in index.html\n`);

// ─── Also check attributes ───
const attrRegex = /(placeholder|title|aria-label|label|data-title)="([^"]+)"/g;
const attrNodes = [];
while ((match = attrRegex.exec(html)) !== null) {
  const val = match[2];
  if (hasChinese(val)) {
    attrNodes.push({
      attr: match[1],
      text: val,
      line: lineMap[match.index]
    });
  }
}

// ─── Also check <option> text ───
const optionRegex = /<option[^>]*>([^<]+)<\/option>/g;
while ((match = optionRegex.exec(html)) !== null) {
  const val = match[1].trim();
  if (hasChinese(val)) {
    textNodes.push({
      text: val,
      line: lineMap[match.index],
      context: 'option'
    });
  }
}

// ─── Translate and check for remaining Chinese ───
let issues = 0;

console.log('=== TEXT NODES WITH REMAINING CHINESE ===\n');
for (const node of textNodes) {
  const translated = translateText(node.text);
  if (hasChinese(translated)) {
    issues++;
    console.log(`  ❌ L${node.line}${node.context ? ' ('+node.context+')' : ''}: "${node.text.substring(0, 80)}"`);
    console.log(`     → "${translated.substring(0, 80)}"`);
    // Find the specific Chinese chars remaining
    const remaining = translated.match(/[\u4e00-\u9fff]+/g);
    if (remaining) {
      console.log(`     残留: ${remaining.join(', ')}`);
    }
    console.log();
  }
}

console.log('\n=== ATTRIBUTES WITH REMAINING CHINESE ===\n');
for (const node of attrNodes) {
  const translated = translateText(node.text);
  if (hasChinese(translated)) {
    issues++;
    console.log(`  ❌ L${node.line} [${node.attr}]: "${node.text.substring(0, 80)}"`);
    console.log(`     → "${translated.substring(0, 80)}"`);
    const remaining = translated.match(/[\u4e00-\u9fff]+/g);
    if (remaining) console.log(`     残留: ${remaining.join(', ')}`);
    console.log();
  }
}

// ─── Also check app.js _t() calls for missing keys ───
console.log('\n=== APP.JS _t() CALLS WITH MISSING KEYS ===\n');
const appJs = fs.readFileSync('/opt/openclaw-web/public/app.js', 'utf-8');
const tCallRegex = /_t\('([^']+?)(?:'[,)])/g;
let missingKeys = 0;
const seen = new Set();
while ((match = tCallRegex.exec(appJs)) !== null) {
  const key = match[1];
  if (!hasChinese(key)) continue;
  if (seen.has(key)) continue;
  seen.add(key);
  const nk = _normQ(key);
  if (!_en[key] && !_en[nk]) {
    missingKeys++;
    const ln = appJs.substring(0, match.index).split('\n').length;
    console.log(`  ❌ L${ln}: _t('${key.substring(0, 70)}...')`);
  }
}

console.log(`\n══════════════════════════════════════`);
console.log(`📊 Summary:`);
console.log(`   Text nodes with remaining Chinese: ${issues}`);
console.log(`   app.js _t() missing keys: ${missingKeys}`);
console.log(`══════════════════════════════════════`);
