#!/usr/bin/env node
/**
 * Improved i18n checker - handles \n in keys and focuses on real issues.
 */
const fs = require('fs');

const i18nSrc = fs.readFileSync('/opt/openclaw-web/public/i18n.js', 'utf-8');
const dictStart = i18nSrc.indexOf("const _en = {");
let braceDepth = 0, dictEnd = -1;
for (let i = dictStart + 12; i < i18nSrc.length; i++) {
  if (i18nSrc[i] === '{') braceDepth++;
  else if (i18nSrc[i] === '}') { braceDepth--; if (braceDepth === 0) { dictEnd = i + 1; break; } }
}
const _en = eval('(' + i18nSrc.substring(dictStart, dictEnd).replace('const _en = ', '') + ')');
console.log(`Loaded ${Object.keys(_en).length} keys\n`);

function _normQ(s) { return s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/[\u300c\u300d]/g, '"'); }

// Build normalized-key → english map (same as i18n.js _getNormEn)
const normEn = {};
for (const k of Object.keys(_en)) { normEn[_normQ(k)] = _en[k]; }
const sortedKeys = Object.keys(normEn).sort((a, b) => b.length - a.length);

function translateText(raw) {
  if (!raw || !/[\u4e00-\u9fff]/.test(raw)) return { result: raw, ok: true };
  const text = _normQ(raw);
  const trimmed = text.trim();
  if (normEn[trimmed]) return { result: text.replace(trimmed, normEn[trimmed]), ok: true };
  let result = text, changed = false;
  for (const zh of sortedKeys) {
    if (result.includes(zh)) { result = result.split(zh).join(normEn[zh]); changed = true; }
  }
  const ok = !/[\u4e00-\u9fff]/.test(result);
  return { result, ok };
}

// ─── index.html text nodes ───
const html = fs.readFileSync('/opt/openclaw-web/public/index.html', 'utf-8');
const lines = html.split('\n');

// Simulate text node extraction line by line
let textIssues = [];
let attrIssues = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const ln = i + 1;
  
  // Skip script blocks
  if (/<script[\s>]/.test(line) && !/<\/script>/.test(line)) {
    while (i < lines.length - 1 && !/<\/script>/.test(lines[i])) i++;
    continue;
  }
  
  // Extract text between tags
  const textParts = line.replace(/<[^>]+>/g, '\x00').split('\x00').filter(t => t.trim() && /[\u4e00-\u9fff]/.test(t));
  for (const text of textParts) {
    const t = text.trim();
    if (!t) continue;
    const { result, ok } = translateText(t);
    if (!ok) {
      const remaining = result.match(/[\u4e00-\u9fff]+/g) || [];
      textIssues.push({ ln, text: t, result, remaining });
    }
  }
  
  // Extract attributes  
  const attrRe = /(placeholder|title|aria-label|label|data-title)="([^"]+)"/g;
  let m;
  while ((m = attrRe.exec(line)) !== null) {
    const val = m[2];
    if (!/[\u4e00-\u9fff]/.test(val)) continue;
    const { result, ok } = translateText(val);
    if (!ok) {
      const remaining = result.match(/[\u4e00-\u9fff]+/g) || [];
      attrIssues.push({ ln, attr: m[1], text: val, result, remaining });
    }
  }
  
  // Extract option text
  const optRe = /<option[^>]*>([^<]+)<\/option>/g;
  while ((m = optRe.exec(line)) !== null) {
    const val = m[1].trim();
    if (!/[\u4e00-\u9fff]/.test(val)) continue;
    const { result, ok } = translateText(val);
    if (!ok) {
      const remaining = result.match(/[\u4e00-\u9fff]+/g) || [];
      textIssues.push({ ln, text: val, result, remaining, ctx: 'option' });
    }
  }
}

// ─── app.js: check ALL _t() keys properly (handle multi-line, \n in strings) ───
const appJs = fs.readFileSync('/opt/openclaw-web/public/app.js', 'utf-8');
// Match _t('...') allowing escaped chars inside
const appIssues = [];
const tRe = /_t\('((?:[^'\\]|\\.)*)'/g;
const seen = new Set();
let am;
while ((am = tRe.exec(appJs)) !== null) {
  let key = am[1].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  if (!/[\u4e00-\u9fff]/.test(key)) continue;
  if (seen.has(key)) continue;
  seen.add(key);
  const nk = _normQ(key);
  if (!_en[key] && !_en[nk] && !normEn[nk]) {
    const ln = appJs.substring(0, am.index).split('\n').length;
    appIssues.push({ ln, key: key.substring(0, 80) });
  }
}

// ─── Report ───
console.log('=== INDEX.HTML TEXT NODES ===');
for (const t of textIssues) {
  console.log(`L${t.ln}${t.ctx ? '('+t.ctx+')' : ''}: "${t.text.substring(0,80)}"`);
  console.log(`  → "${t.result.substring(0,80)}"`);
  console.log(`  残留: ${t.remaining.join(', ')}\n`);
}

console.log('\n=== INDEX.HTML ATTRIBUTES ===');
for (const t of attrIssues) {
  console.log(`L${t.ln} [${t.attr}]: "${t.text.substring(0,80)}"`);
  console.log(`  → "${t.result.substring(0,80)}"`);
  console.log(`  残留: ${t.remaining.join(', ')}\n`);
}

console.log('\n=== APP.JS MISSING _t() KEYS ===');
for (const t of appIssues) {
  console.log(`L${t.ln}: "${t.key}"`);
}

console.log(`\n=== SUMMARY ===`);
console.log(`Text nodes: ${textIssues.length} issues`);
console.log(`Attributes: ${attrIssues.length} issues`);
console.log(`app.js _t(): ${appIssues.length} missing keys`);
