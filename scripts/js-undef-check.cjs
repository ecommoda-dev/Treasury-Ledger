#!/usr/bin/env node
/**
 * js-undef-check.js — EcomModa · ecommoda-html-builder Step 9B
 *
 * بيمسك الحاجة اللي `node --check` بيعدّي عليها: **اسم بيتنادى ومش معرّف**.
 * `node --check` بيفحص النحو (syntax). ده بيفحص الربط (linkage).
 *
 * الواقعة: دفعة تعديل فشلت جزئيًا وضاع منها تعريف esc() اللي كانت متنادية في
 * ٣١ موضع → ReferenceError على أول رسم، والأداة معطّلة بالكامل، وعدّت من
 * node --check ومن Step 9 ومن Step 9A.
 *
 * الاستخدام:
 *   node scripts/js-undef-check.js index.html [more.html ...]
 *   exit 1 عند أي اسم متنادي ومش معرّف.
 *
 * بيشتغل بلا أي dependency — بيستخدم node:vm عشان يجيب أسماء الـ globals
 * المتاحة في المتصفح من قايمة صريحة، وبيحلّل الملف بـ RegExp محافظة.
 * الهدف **صفر false-positive**: أي شك = بيعدّي.
 *
 * الواقعة التانية (12-09-2026): الـ tokenizer مكانش بيعرف **regex literals**،
 * فـ `/"/g` و`/'/g` في `§CONFIG::esc` كانوا بيتقروا كبداية سلسلة نصية →
 * بيبلع تعريفات الدوال اللي بعدها → **إنذارات كاذبة** (cairoDateStr ·
 * apiGet · showToast · formatDateForExport ظهروا «متنادين ومش معرّفين»
 * وهما معرّفين).
 * والأخطر إنه كان **غير مستقر**: نفس الملف عدّى الفحص في تسليم وفشل في اللي
 * بعده، لأن نقطة «إعادة التوازن» بتتحرك مع أي تعديل تحت الدالة — يعني نتيجة
 * مختلفة لنفس العيب حسب حجم الكود، وده أسوأ من فشل ثابت.
 * الإصلاح: stripNoise بقى بيفهم الـ regex literals (readRegexLiteral تحت).
 */

'use strict';
const fs = require('fs');
const path = require('path');

// ── كلمات محجوزة بعدها الـ `/` بيبقى **بداية regex** مش قسمة ───────────────
const REGEX_PREV_KEYWORDS = new Set([
  'return','typeof','instanceof','in','of','new','delete','void','throw',
  'case','do','else','yield','await',
]);

// ── globals المتاحة في المتصفح — القايمة محافظة عن قصد ───────────────────
const BROWSER_GLOBALS = new Set([
  // ES
  'Object','Array','String','Number','Boolean','Symbol','BigInt','Math','JSON','Date',
  'RegExp','Error','TypeError','RangeError','SyntaxError','ReferenceError','EvalError',
  'Map','Set','WeakMap','WeakSet','Promise','Proxy','Reflect','Intl','Function',
  'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent',
  'encodeURI','decodeURI','structuredClone','queueMicrotask','globalThis','console',
  'ArrayBuffer','Uint8Array','Int8Array','Uint16Array','Int16Array','Uint32Array',
  'Int32Array','Float32Array','Float64Array','DataView','TextEncoder','TextDecoder',
  // DOM / BOM
  'window','document','navigator','location','history','screen','localStorage',
  'sessionStorage','indexedDB','fetch','Headers','Request','Response','FormData',
  'URL','URLSearchParams','Blob','File','FileReader','AbortController','AbortSignal',
  'setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame',
  'cancelAnimationFrame','alert','confirm','prompt','open','close','getComputedStyle',
  'matchMedia','CustomEvent','Event','KeyboardEvent','MutationObserver','IntersectionObserver',
  'ResizeObserver','DOMParser','XMLHttpRequest','crypto','performance','atob','btoa',
  'HTMLElement','Element','Node','NodeList','Image','Audio','AudioContext',
  'webkitAudioContext','Notification','WebSocket','EventSource','Worker','print',
  // مكتبات الستاك المسموح تحميلها من CDN
  'Chart','ExcelJS','XLSX','JsBarcode','QRCode','html2canvas','jspdf','dayjs',
]);

// ── استخراج كل <script> بلا src من الـ HTML ───────────────────────────────
function extractScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;                 // خارجي — مش بتاعنا
    if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue; // template وغيره
    // offset السطر عشان الرسالة تدل على مكان صح
    const before = html.slice(0, m.index);
    out.push({ code: m[2], lineOffset: before.split('\n').length - 1 });
  }
  return out;
}

// ── هل الـ `/` هنا بداية regex ولا عامل قسمة؟ ─────────────────────────────
// بنحكم من آخر رمز فعّال **اتكتب في المخرجات** — نفس منطق أي tokenizer.
// عند الشك بنرجّع false (= قسمة)، لأن ده بيسيب الحرف يعدّي من غير ما نبلع كود.
function regexAllowedBefore(out) {
  let j = out.length - 1;
  while (j >= 0 && /\s/.test(out[j])) j--;
  if (j < 0) return true;                                  // بداية السكربت
  const ch = out[j];
  if ('(,=:[!&|?{;+-*%~^<>'.includes(ch)) return true;     // بعد عامل أو فاتح
  if (/[\w$]/.test(ch)) {                                  // بعد كلمة
    let k = j;
    while (k >= 0 && /[\w$]/.test(out[k])) k--;
    return REGEX_PREV_KEYWORDS.has(out.slice(k + 1, j + 1));
  }
  return false;                                            // ) ] } رقم " ... = قسمة
}

// بيرجّع الـ index بعد آخر حرف في الـ regex (بما فيه الـ flags)، أو i نفسه لو
// مش regex صالح على سطر واحد.
function readRegexLiteral(code, i) {
  const n = code.length;
  let j = i + 1, inClass = false;
  while (j < n) {
    const ch = code[j];
    if (ch === '\n') return i;            // regex مابيعديش سطر → مش regex
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      j++;
      while (j < n && /[a-z]/i.test(code[j])) j++;   // flags
      return j;
    }
    j++;
  }
  return i;
}

// ── تنظيف: شيل التعليقات والسلاسل والـ regex عشان ما ندوّرش جوّاهم ─────────
function stripNoise(code) {
  let out = '', i = 0, n = code.length;
  while (i < n) {
    const c = code[i], c2 = code[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && code[i] !== '\n') { i++; } continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { if (code[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '/' && regexAllowedBefore(out)) {
      const end = readRegexLiteral(code, i);
      if (end > i) { i = end; out += '""'; continue; }
      // مش regex صالح — سيبه يعدّي كقسمة عادية تحت
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n && code[i] !== q) {
        if (code[i] === '\\') { i += 2; continue; }
        if (q === '`' && code[i] === '$' && code[i + 1] === '{') {
          // داخل ${ } كود حقيقي — سيبه
          let depth = 1; i += 2; out += '  ';
          while (i < n && depth > 0) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') depth--;
            if (depth > 0) out += code[i];
            i++;
          }
          continue;
        }
        if (code[i] === '\n') out += '\n';
        i++;
      }
      i++; out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}

const RESERVED = new Set([
  'if','else','for','while','do','switch','case','default','break','continue','return',
  'function','var','let','const','class','extends','new','delete','typeof','instanceof',
  'in','of','this','super','null','true','false','undefined','void','throw','try','catch',
  'finally','yield','await','async','static','get','set','import','export','from','as',
]);

function collectDeclared(code) {
  const d = new Set();
  const add = (re, g = 1) => { let m; while ((m = re.exec(code)) !== null) d.add(m[g]); };
  add(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g);
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  // destructuring: const { a, b: c } = ... / const [a, b] = ...
  let m;
  const de = /\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=/g;
  while ((m = de.exec(code)) !== null) {
    for (const part of m[1].split(',')) {
      const nm = part.includes(':') ? part.split(':')[1] : part;
      const t = nm.replace(/[.\s=]+.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) d.add(t);
    }
  }
  // params — تقريبية بس كافية: (a, b = 1, ...rest) =>  و function f(a,b)
  const pe = /(?:function\s*\*?\s*[A-Za-z_$][\w$]*\s*|\bcatch\s*|=>\s*|\(\s*)?\(([^()]*)\)\s*(?:=>|\{)/g;
  while ((m = pe.exec(code)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.replace(/^\.\.\./, '').replace(/[=:].*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) d.add(t);
    }
  }
  add(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g);
  // for (const x of ...) مغطّى فوق. labels:
  add(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:for|while)\b/gm);
  return d;
}

function collectCalled(code) {
  // اسم متبوع بـ( — واستثناء اللي قبله نقطة (method) أو كلمة function/new-class
  const calls = new Map();   // name -> first line
  const re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[2];
    if (RESERVED.has(name)) continue;
    if (calls.has(name)) continue;
    const line = code.slice(0, m.index).split('\n').length;
    calls.set(name, line);
  }
  return calls;
}

function checkFile(file) {
  const html = fs.readFileSync(file, 'utf8');
  const isHtml = /\.html?$/i.test(file);
  const blocks = isHtml ? extractScripts(html) : [{ code: html, lineOffset: 0 }];
  if (!blocks.length) { console.log(`ℹ️  ${file}: مفيش <script> جوّه الصفحة`); return []; }

  // كل البلوكات بتتشارك نفس النطاق العام في الصفحة
  const cleaned = blocks.map(b => ({ ...b, code: stripNoise(b.code) }));
  const declared = new Set();
  for (const b of cleaned) for (const n of collectDeclared(b.code)) declared.add(n);

  const problems = [];
  for (const b of cleaned) {
    for (const [name, line] of collectCalled(b.code)) {
      if (declared.has(name) || BROWSER_GLOBALS.has(name)) continue;
      problems.push({ file, name, line: line + b.lineOffset });
    }
  }
  return problems;
}

// ── main ──────────────────────────────────────────────────────────────────
const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/js-undef-check.js <file.html> [more.html ...]');
  process.exit(2);
}

let bad = 0;
for (const f of files) {
  if (!fs.existsSync(f)) { console.error(`❌ الملف مش موجود: ${f}`); bad++; continue; }
  const problems = checkFile(f);
  if (!problems.length) { console.log(`✅ ${path.basename(f)}: كل دالة متنادية معرّفة`); continue; }
  bad++;
  console.log(`\n❌ ${path.basename(f)} — ${problems.length} اسم متنادي ومش معرّف:`);
  for (const p of problems) console.log(`   • ${p.name}()  ← سطر ~${p.line}`);
  console.log('   ⚠️ لو واحد منهم global محمّل من CDN، ضيفه في BROWSER_GLOBALS في السكربت ده.');
}

if (bad) {
  console.log('\n🔴 Step 9B فشل. `node --check` بيعدّي على دي — دي بالظبط الحالة اللي البند اتكتب عشانها.');
  process.exit(1);
}
console.log('\n✅ Step 9B عدّى.');
