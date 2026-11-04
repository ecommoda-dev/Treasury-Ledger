#!/usr/bin/env node
// check-log-values.mjs — يتأكد إن كل (type) بيتكتب في index.js مسجّل في log-values.json، وإن LOG_REGISTRY مطابق له.
// ⚠️ نسخة محلية مبسّطة كتبتها جلسة البناء (مفيش وصول للنسخة القانونية v3.2 وقتها).
//    لو عندك النسخة القانونية من ecommoda-worker-builder (CHECK_VERSION v3.2) استبدل بيها الملف ده.
// الاستخدام: node check-log-values.mjs   (exit 1 = مش جاهز للتسليم)
import { readFileSync } from 'node:fs';

const CHECK_VERSION = 'local-1';
const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const reg = JSON.parse(readFileSync(new URL('./log-values.json', import.meta.url), 'utf8'));
const anchors = ['writeLog', 'safeLog', 'writeLogsBatch', ...(reg.logAnchors || [])];
const RESULTS = new Set(['success', 'rejected', 'already', 'warning', 'error']);
const STAGES = new Set(['preflight', 'lookup', 'write']);
const dynamic = (reg.dynamicTypes || []);
let errors = 0, warns = 0;
const used = new Set();

// brace-matching على كل نداء (مع تجاهل تعريفات الدوال نفسها)
for (const a of anchors) {
  const re = new RegExp(`(?<!function\\s)(?<![\\w.])${a}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/^\s*(async\s+)?function\b/.test(src.slice(lineStart, m.index + a.length + 1))) continue;
    const open = src.indexOf('{', m.index);
    if (open < 0 || open - m.index > 80) continue;
    let depth = 0, i = open, inStr = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(open, i + 1);
    // نبص على أول مستوى بس (type: على العمق 1)
    let d = 0, top = '';
    for (const ch of body) { if (ch === '{') { d++; if (d > 1) top += ' '; continue; } if (ch === '}') { d--; continue; } top += d === 1 ? ch : ' '; }
    const t = top.match(/\btype\s*:\s*([^,]+?)(?:,|$)/);
    const line = src.slice(0, m.index).split('\n').length;
    if (!t) { if (!/\.\.\.\w+/.test(top)) { console.log(`⚠️  سطر ${line}: نداء ${a} من غير type صريح`); warns++; } continue; }
    const expr = t[1].trim();
    const lit = expr.match(/^['"]([\w.-]+)['"]$/);
    const tern = expr.match(/\?\s*['"]([\w.-]+)['"]\s*:\s*['"]([\w.-]+)['"]/);
    if (lit) used.add(lit[1]);
    else if (tern) { used.add(tern[1]); used.add(tern[2]); }
    else if (dynamic.some(p => expr.replace(/\s+/g, ' ').startsWith(p))) { /* معترف بيه */ }
    else { console.log(`🔴 سطر ${line}: type مش نص ثابت (${expr}) — حلّه أو سجّله في dynamicTypes`); errors++; }
  }
}

for (const t of used) if (!reg.types[t]) { console.log(`🔴 type مستخدم ومش مسجّل في log-values.json: ${t}`); errors++; }
for (const t of Object.keys(reg.types)) if (!used.has(t) && !['login', 'logout'].includes(t)) console.log(`ℹ️  مسجّل ومش مستخدم: ${t}`);
for (const [t, v] of Object.entries(reg.types)) {
  for (const r of [].concat(v.result ?? [])) if (!RESULTS.has(r)) { console.log(`🔴 ${t}: result برّه الخمسة: ${r}`); errors++; }
  for (const s of [].concat(v.stage ?? [])) if (!STAGES.has(s)) { console.log(`🔴 ${t}: stage برّه التلاتة: ${s}`); errors++; }
}
// login/logout بتتكتب من بلوك الـ auth عن طريق resolveAuthTool — لازم موجودين
for (const t of ['login', 'logout']) if (!src.includes(`type:     '${t}'`) && !src.includes(`type: '${t}'`)) { console.log(`🔴 ${t} مش متكتب في index.js`); errors++; }
// كاشف مايعتمدش على الأسماء: فيه INSERT INTO logs ومفيش ولا قيمة اتستخرجت
if (/INSERT INTO logs/.test(src) && used.size === 0) { console.log('🔴 فيه INSERT INTO logs ومفيش قيم type اتستخرجت — الكاشف أعمى'); errors++; }

// LOG_REGISTRY لازم يطابق الملف
const regm = src.match(/const LOG_REGISTRY = \{\s*"treasury_ledger": new Set\((\[.*?\])\)/s);
if (!regm) { console.log('🔴 LOG_REGISTRY مش موجود أو شكله اتغيّر'); errors++; }
else {
  const inCode = new Set(JSON.parse(regm[1])), inFile = new Set(Object.keys(reg.types));
  for (const t of inFile) if (!inCode.has(t)) { console.log(`🔴 ${t} في log-values.json وناقص من LOG_REGISTRY (شغّل التجميع تاني)`); errors++; }
  for (const t of inCode) if (!inFile.has(t)) { console.log(`🔴 ${t} في LOG_REGISTRY وناقص من log-values.json`); errors++; }
}
console.log(`\nCHECK_VERSION ${CHECK_VERSION} · قيم مستخدمة: ${used.size} · أخطاء: ${errors} · تنبيهات: ${warns}`);
process.exit(errors ? 1 : 0);
