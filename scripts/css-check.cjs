#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// EcomModa — فحص CSS بـ parser حقيقي (Standards #42)
// ═══════════════════════════════════════════════════════════════════════
// الفحص ده **مش بديل** لـ Step 9 — هو جنبه. Step 9 كله grep، والـ grep
// بيعدّ نصوص مابيقراش CSS، فمشروع CSS **مكسور بالكامل** بيعدّي منه.
//
// بيمسك تلات فئات من الفشل الصامت:
//   ① كتلة التوكنز اتبلعت جوّه selector غلط (تعليق متداخل قفل بدري)
//   ② var(--x) مستخدمة ومش معرّفة في أي :root
//   ③ علامة تعليق شاردة / `<style>` كله فشل يتقرا (زي `var(` مش مقفولة)
//
// التشغيل:
//   npm i postcss          # مرة واحدة في مجلد المشروع أو -g
//   node scripts/css-check.js shared/core.css index.html pack.html print.html
//
// بيرجّع exit code 1 عند أي مشكلة — يعني ينفع في CI أو pre-commit.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');

// ⚠️ متكتبش مسار مطلق لـ postcss. النسخة الأصلية اللي اتكتبت وقت بناء الهب
//    كانت `require('/tmp/.../node_modules/postcss')` — ده بيشتغل في الجلسة
//    اللي اتكتب فيها بس، وبيموت في أي مكان تاني. الحل: resolve عادي مع
//    رسالة واضحة لو الحزمة مش متثبتة.
const path = require('path');
let postcss;
for (const cand of ['postcss', path.join(process.cwd(), 'node_modules', 'postcss')]) {
  try { postcss = require(cand); break; } catch { /* جرّب اللي بعده */ }
}
if (!postcss) {
  console.error('❌ postcss مش متثبت. شغّل: npm i postcss   (أو npm i -g postcss)');
  process.exit(2);
}

function blocks(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.css')) return [{ css: src, where: file }];
  return [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m, i) => ({ css: m[1], where: `${file} <style#${i}>` }));
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('الاستخدام: node scripts/css-check.js <ملف.css|ملف.html> …');
  process.exit(2);
}

let bad = 0;
const defined = new Set();
const used = [];

for (const file of files) {
  for (const { css, where } of blocks(file)) {
    let root;
    try {
      root = postcss.parse(css, { from: where });
    } catch (e) {
      // ❌ الفئة التالتة: الملف مش بيتقرا أصلاً — أخطر حالة، والمتصفح
      //    بيتجاهلها في صمت من غير أي سطر في الكونسول.
      console.log(`❌ ${where}: parse error — ${e.message}`);
      bad++;
      continue;
    }

    let rootRules = 0;
    root.walkRules((rule) => {
      if (rule.selector.includes(':root')) {
        rootRules++;
        // ❌ الفئة الأولى: التوكنز اتبلعت. selector لازم يكون `:root` بالظبط.
        if (rule.selector.trim() !== ':root') {
          console.log(`❌ ${where}: كتلة التوكنز اتبلعت جوّه selector غلط →`);
          console.log(`   ${JSON.stringify(rule.selector.slice(0, 120))}`);
          bad++;
        }
        rule.walkDecls((d) => { if (d.prop.startsWith('--')) defined.add(d.prop); });
      }
      rule.walkDecls((d) => {
        for (const m of d.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
          used.push([m[1], where, rule.selector.slice(0, 60)]);
        }
      });
    });

    // علامة تعليق شاردة — تعليق قفل بدري أو مفتوح ومش مقفول
    const stray = css.replace(/\/\*[\s\S]*?\*\//g, '');
    if (stray.includes('*/') || stray.includes('/*')) {
      console.log(`❌ ${where}: علامة تعليق شاردة (تعليق مقفول بدري أو مش مقفول)`);
      bad++;
    }

    console.log(`   ${where}: ${rootRules} كتلة توكنز · ${root.nodes.length} عقدة`);
  }
}

// ❌ الفئة التانية: متغيّر مستخدم ومش معرّف. الفحص ده **بيغني عن قايمة
//    الأسماء الوهمية المعروفة سلفًا** اللي كانت في Step 9 — القايمة بتمسك
//    اللي اتعرفنا عليه قبل كده بس (`--accent-muted` عدّت منها فعليًا).
const missing = [...new Set(
  used.filter(([v]) => !defined.has(v)).map(([v, w, s]) => `${v}  (${w} · ${s})`)
)];
if (missing.length) {
  console.log(`\n❌ متغيّرات مستخدمة ومش معرّفة (${missing.length}):`);
  missing.slice(0, 25).forEach((m) => console.log('   ' + m));
  bad++;
}

console.log(bad
  ? `\n❌ فشل — ${bad} مشكلة`
  : `\n✅ عدّى — ${defined.size} توكن معرّف · ${used.length} استخدام`);
process.exit(bad ? 1 : 0);
