<div dir="rtl" style="text-align: right;">

# Treasury-Ledger — سياق الأداة

![version](https://img.shields.io/badge/version-v1.1.0-blue)

## الهدف
موظف الخزنة يتأكد إن كل فلوس استلمها مندوب التحصيل (موجبة أو سالبة، لكل أوردر) **اتوردت فعلاً للخزنة**.
موظف التحصيل وموظف الخزنة شخصين مختلفين. الأداة **مستقلة** (مش جوه أي هب) وبتشتغل من **01-10-2026**.

- الواجهة: `https://ecommoda-dev.github.io/Treasury-Ledger/` (`index.html`)
- الـ Worker: `treasury-ledger-worker` → `https://treasury-ledger-worker.ecommoda-dev.workers.dev`
- `tool` في D1: `treasury_ledger` · D1: `ecommoda-dev-logs` (binding `DB`)

## القرارات الحاكمة (من مواصفات التصميم 03-11-2026 + ردود أحمد 04-11-2026)
| # | القرار |
|---|---|
| D1/D2 | دفتر داخلي مستقل في D1 هو **الحقيقة الوحيدة**؛ الأوردر على Shopify **مرآة عرض** بس |
| D9 | الإدخال = سحب صفوف `tool='cod_payment'` ليوم مختار وتجميعها بالجلسة (`batchId`) تحت كل مندوب — مفيش لزق نص/Excel |
| D16 | موظف الخزنة **يكتب المبلغ اللي عدّه** (خانة فاضية — مفيش ملء تلقائي) |
| D17 | **أي فرق = التسجيل ممنوع**؛ المحاولة بتتسجّل (`confirm_mismatch`) والجلسة تفضل حمرا لحد ما المبلغ يكمل |
| D15 | الشحن الإضافي = `CASH_OUT` بملاحظة `Extra Shipping` على **أوردر البند نفسه** |
| D12 | الحركة السالبة (استرداد/مرتجع) = `CASH_OUT` |
| D19 | الأيام المسموحة من 01-10-2026 بتوقيت القاهرة (`Intl` — مفيش إزاحة ثابتة) |
| D7 | مفيش قيد على الحالة المالية للأوردر |
| D5 | الميتافيلدز **مش** Filterable (سلوتات Orders كلها مستهلكة) |
| ✅ 04-11 | **أي موظف نشط** يقدر يدخل الأداة ويعمل `REVERSAL` |
| ✅ 04-11 | الأداة **مستقلة بس** — مفيش صفحة في أي هب حاليًا |
| ✅ 04-11 | `Treasury-COD` القديمة **ما بتتلمسش** (أحمد هيمسحها بنفسه) — ولا نقل بيانات ولا كتابة على `custom.treasury_amount/count/last_updated` ولا `tool='treasury'` |

## الدفتر (`schema.sql`)
- `treasury_ledger`: صف لكل حركة، **مابيتعدّلش ولا بيتمسح** — التصحيح بصف `REVERSAL` (`reverses_id`). المبالغ **بالقروش (integer)** وبإشارتها.
- `treasury_confirmations`: صف لكل جلسة اتأكدت (`batch_id UNIQUE` → جلسة ما تتأكدش مرتين).
- `idempotency_key` فريد: `log:<logs.id>` · `xs:<batchId>:<orderId>` · `rev:<id>`.
- الكتابة ذرّية: صف التأكيد + كل الحركات في `db.batch()` واحد. المرآة على Shopify **بعد** نجاح D1 (فشلها = `warning` + `rebuild_mirror`، الدفتر محفوظ).
- ⏳ حماية `TRIGGER` ضد `UPDATE/DELETE` **مش مفعّلة** (دعم D1 للـ triggers ما اتجربش — مؤجل بقرار أحمد).

## عقد القراءة من أداة التحصيل 🔴
الـ Worker بيقرا من `extra` صفوف `cod_payment` (`type` ∈ `payment`,`refund`):
`batchId` · `courier` · `courierCollect` (المتوقع لكل أوردر — **مش** `value_after`) · `extraShipping[]` · `extraShippingTotal` · `batchExpected` (+ `result` · `preRegistered` · `hasReturn`).
- `extraShipping[]` منسوخ على **كل** صفوف الجلسة → بيتقرا **مرة واحدة** لكل `batchId` (أي `SUM` على الصفوف بيضرب الرقم).
- المتوقع للجلسة = Σ `courierCollect` للصفوف المكتوبة − Σ الشحن الإضافي.
- ⚠️ **أي تغيير في أسماء المفاتيح دي داخل `COD-Payment-Center`/`Delivery-COD-Operations-Center` بيكسر الخزنة بصمت** (جلسات فاضية/ناقصة بلا خطأ).
  المطلوب من أحمد: ضيف ملاحظة بالمعنى ده في `CLAUDE.md` بتاع الريبوهين (بند 11-٤ في المواصفات).

## 🆕 تحصيلات بوسطة (v1.1.0 · 04-11-2026) — صفوف `extra.source='bosta_cash_cycle'`
مصدرها تاب «تحصيل بوسطة» في `Delivery-COD-Operations-Center` (Worker `cod-payment-center-worker` ≥ 3.11.0) من ملف Cash Cycles.
- **نفس العقد** (`tool='cod_payment'` · `type` payment/refund · `batchId` · `courier='Bosta'` · `courierCollect` · `batchExpected`) — **صفر تغيير في طريقة القراءة**.
- 🔴 `courierCollect` = **Net Value** (المحصَّل − رسوم بوسطة + Flex Ship) = اللي بوسطة حوّلته فعلاً، **مش** مبلغ شوبيفاي. أوردرات «بدون تحصيل» (ملغي/استبدال بلا فرق) ليها صف برسومها السالبة (`extra.noCollection=true`).
- `batchId = bosta-<Cash-out ID>` — جلسة واحدة لكل تحويل، و`batchExpected.orders` = **كل** صفوف الملف، فالجلسة تظهر **«ناقصة»** لحد ما كل الصفوف تتسجّل. ⚠️ قرار أحمد: **الخزنة ما تأكّدش قبل الاكتمال** (التطبيق ما بيمنعش التأكيد — ده إجراء تشغيلي).
- الدفتر: `source='bosta_cash_cycle'` وملاحظة «بوسطة — صافي بعد الرسوم».
- 🔴 `compare_orders`: أي أوردر ليه حركة بوسطة = `BOSTA_NET` (الرقم يتعرض من غير حكم) — المعادلة `netPayment − shipping − returnFees` ما بتنطبقش على الصافي.
- الفحص: اختبار «بوسطة: courierCollect = Net Value…» في `tests/worker.test.mjs`.

## Endpoints (`index.js`)
`check_employee` · `register_pin` · `verify_employee` · `log_logout` · `get_employees` (بوابة الدخول) ·
`get_day` · `get_pending` · `confirm_session` · `reverse_entry` · `rebuild_mirror` · `get_order` · `get_alerts` · `list_ledger_orders` · `compare_orders` ·
`get_logs` · `get_logs_count` · `get_logs_export` · `get_config` · `diag`.
CORS مقفول على `https://ecommoda-dev.github.io`.

## المقارنة مع Shopify (قراءة فقط)
`المتوقع = netPaymentSet − totalShippingPriceSet − Σ returns[].returnShippingFees` ويتقارن بـ Σ حركات الأوردر **من غير** Extra Shipping.
الحالات: `MATCH` · `SHORT` · `OVER` · `NOT_IN_LEDGER` · `LEDGER_ONLY` · `BOSTA_NET` · `IN_PROGRESS` (`PARTIALLY_PAID`/outstanding>0) · `PRE_WINDOW` (ليه صفوف تحصيل قبل 01-10).
`COMPARE_PER_QUERY = 100` (قرار أحمد 04-11-2026) **غير مقيس** — لو النداء اترفض لتجاوز سقف التكلفة (١٠٠٠ نقطة) قلّل الرقم في `index.js` (مع `MAX_ORDER_IDS`) وفي `CMP_CHUNK` بالواجهة؛ القياس من `?action=diag` (`actualQueryCost`).

## قبل أول نشر
مهام أحمد (D1 · Cloudflare · ميتافيلدز Shopify · تحديث `ecommoda-constants` · ملاحظة ريبوهات التحصيل · اختبار حي) اتسلّمت لأحمد في الشات 04-11-2026 وبتتنفّذ برّه الجلسة دي. **أي مهمة منها لسه ما اتأكد تنفيذها = الأداة مش جاهزة للاستخدام.**

## الاختبارات
```bash
npm test                # tests/worker.test.mjs — منطق الـ Worker فوق D1 shim (node:sqlite) — 15 اختبار
node check-log-values.mjs
npm i --no-save postcss && npm run check:ui     # فحص CSS (parser) + ربط JS
node tests/ui-smoke.mjs [مجلد-لقطات]            # Playwright: الواجهة الحقيقية ↔ الـ Worker الحقيقي
```
⚠️ `check-log-values.mjs` هنا **نسخة محلية مبسّطة** (النسخة القانونية v3.2 ما كانتش متاحة وقت البناء) — استبدلها بالقانونية.

## بنود مفتوحة / مؤجلة
| # | البند |
|---|---|
| 1 | **الجلسة الناقصة** (صفوف D1 < `batchExpected.orders`): اتطبّقت التوصية — المتوقع = اللي D1 مثبّته + علامة «ناقصة» وتنبيه دايم حتى بعد التأكيد. **لسه محتاجة تأكيد أحمد** (دالة `buildSession` في `index.js`). |
| 2 | فرق 75 في `#61954` و`#63567` في مقارنة Shopify (احتمال خصم مزدوج لشحن المرتجع في أداة التحصيل) — مراجعة أحمد |
| 3 | webhook `orders/updated` من كتابة الميتافيلد (هل بيعدّي على Webhook Control Center وOrder-Journey) — مؤجل |
| 4 | سجل العمليات: فلاتر أعلى الجدول مش أيقونة قمع في رأس كل عمود (معيار `data-table-standard.md` الكامل) + عرض الأعمدة بالسحب — مؤجل |
| 5 | عدّاد «مين مسموحله» — اتحسم: أي موظف نشط (`is_active`) |

## بصمة المهارات

| المهارة | الإصدار وقت آخر تعديل |
|---|---|
| ecommoda-worker-builder | v3.10.0 |
| ecommoda-constants | v4.5.1 |
| ecommoda-html-builder | v8.7.0 |
| shopify-graphql-helper | v2.5.0 |

آخر مطابقة: 04-11-2026 · `index.js` v1.1.0 · `index.html` v1.1.0
🔴 معلّقة: تسجيل `treasury_ledger` في `ecommoda-constants` §7.1 (مهمة أحمد) · `check-log-values.mjs` نسخة محلية مبسّطة

آخر تحديث: 04-11-2026 — v1.1.0 (استثناء صفوف بوسطة من مقارنة Shopify + توثيق العقد)

</div>
