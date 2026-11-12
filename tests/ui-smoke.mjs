// اختبار دخاني للواجهة: Playwright بيشغّل index.html الحقيقي، وكل نداءات الـ Worker بتتوجّه
// للـ index.js الحقيقي فوق D1 shim (node:sqlite). تشغيل: node tests/ui-smoke.mjs [مجلد لقطات الشاشة]
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeDB } from './d1-shim.mjs';
import worker from '../index.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const shots = process.argv[2]; if (shots) mkdirSync(shots, { recursive: true });
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const DB = makeDB(schema);
const env = { DB, WORKER_SECRET: 'sek' };            // مفيش Shopify → المرآة warning (مقصود)
DB.raw.exec(`INSERT INTO employees (username, display_name, pin, is_active) VALUES ('Sara_Cash','سارة','1234',1),('Ahmed_Ibraheem','أحمد','9999',1)`);

const today = new Date(); const ts = new Date(Math.min(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 10, 0, 0), Date.now() - 5000)).toISOString();   // مش في المستقبل (get_pending بيقرا لحد دلوقتي)
const XS = [{ orderId: '9001', orderName: '#61774', courier: 'Abo Yassin', amount: '75.00' }];
const ins = DB.raw.prepare(`INSERT INTO logs (timestamp, tool, type, employee, order_id, order_name, extra) VALUES (?, 'cod_payment', ?, 'Fady_Mostafa', ?, ?, ?)`);
for (const [oid, nm, cc, type] of [['1', '#63798', 2800, 'payment'], ['2', '#63800', 22200, 'payment'], ['3', '#61954', -525, 'refund']])
  ins.run(ts, type, oid, nm, JSON.stringify({ result: 'success', batchId: 'aaaaaaaa-1111', courier: 'Abo Yassin', courierCollect: cc, extraShipping: XS, extraShippingTotal: '75.00',
    batchExpected: { orders: 3, collect: '24475.00', extraShippingTotal: '75.00', net: '24400.00' }, preRegistered: false, hasReturn: type === 'refund' }));

const errors = []; let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failures++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('treasury-ledger-worker.ecommoda-dev.workers.dev')) {
    const req = route.request();
    const res = await worker.fetch(new Request(url, { method: req.method(), headers: req.headers(), body: req.postData() || undefined }), env);
    return route.fulfill({ status: res.status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: await res.text() });
  }
  return route.abort();   // الخطوط/CDN
});
await page.addInitScript(() => localStorage.setItem('treasury_ledger_worker_secret', 'sek'));
await page.goto(new URL('../index.html', import.meta.url).href);

// الدخول: اختيار الموظف ثم PIN
await page.waitForFunction(() => document.querySelectorAll('#loginSelect option').length > 1);
check('شاشة الدخول: الكيباد مخفي قبل اختيار الموظف', !(await page.locator('#pinZone').isVisible()));
await page.selectOption('#loginSelect', 'Sara_Cash');
await page.waitForSelector('#pinZone.visible');
for (const d of '1234') await page.click(`#pinKeypad .pin-key:text-is("${d}")`);
await page.waitForSelector('#loginOverlay.hidden', { state: 'attached' });
check('الدخول ناجح', await page.locator('#loginOverlay.hidden').count() === 1);
await page.waitForSelector('.cg');

check('مندوب واحد وجدول واحد (من غير تأكيد منفصل للجلسة)', await page.locator('.cg').count() === 1 && await page.locator('.sess-dt').count() === 1 && (await page.locator('.cg-head').innerText()).includes('Abo Yassin'));
check('المتوقع = 24,400 (بعد خصم الشحن الإضافي)', (await page.locator('.cg-due .amt').innerText()).includes('24,400'));
check('الجدول مفتوح تلقائي ومفيش صف «بانتظار التسجيل» فوقه', await page.locator('.sess-dt').isVisible() && await page.locator('.cg-sec').count() === 0);
check('الحالة «لم يتم التسجيل» على كل الصفوف', (await page.locator('.sess-dt tbody .badge-warn:text("لم يتم التسجيل")').count()) === 4);
check('خانة المبلغ المستلم فاضية وزرار التأكيد مقفول', (await page.inputValue('#camt-0-0')) === '' && await page.locator('#ccbtn-0-0').isDisabled());
check('صف الشحن الإضافي ظاهر بملاحظة حمراء', (await page.locator('tr.xs').innerText()).includes('Extra Shipping') && await page.locator('tr.xs .note-red').count() === 1);
check('مفيش أي تأكيد لكل جلسة لوحدها', await page.locator('[id^="amt-"], [id^="cbtn-"]').count() === 0);
if (shots) await page.screenshot({ path: `${shots}/01-day.png`, fullPage: true });

// كل الأيام المعلّقة: نفس الكارت ونفس خانة التأكيد
await page.click('#segPending'); await page.waitForSelector('.day-head');
check('كل الأيام المعلّقة: فيها المندوب وخانة المبلغ', await page.locator('#camt-0-0').count() === 1 && !(await page.locator('#dayControls').isVisible()));
check('التسوية التاريخية مش ظاهرة لغير أحمد', !(await page.locator('#settleCard').isVisible()));
await page.click('#segDay'); await page.waitForSelector('.cg');
check('الرجوع ليوم واحد', await page.locator('#dayControls').isVisible());

// فرق: 24000 — الزرار يفضل مقفول والفرق يظهر لحظيًا، ومفيش تسجيل
await page.fill('#camt-0-0', '24000');
if (shots) await page.screenshot({ path: `${shots}/01b-typing.png`, clip: { x: 0, y: 280, width: 1280, height: 120 } });
check('فرق: الزرار مقفول والفرق ظاهر «ناقص 400»', await page.locator('#ccbtn-0-0').isDisabled() && (await page.locator('#chint-0-0').innerText()).includes('ناقص 400'));
await page.press('#camt-0-0', 'Enter');
check('Enter مع فرق مابيسجّلش حاجة', await page.locator('#confirmOverlay.open').count() === 0 && DB.raw.prepare('SELECT COUNT(*) n FROM treasury_ledger').get().n === 0);
// محاولة بفرق عن طريق الـ API مباشرة (بتتسجّل confirm_mismatch والجلسة تحمّر)
await page.evaluate(async () => { const s = views[0].sessions[0]; await apiPost('confirm_session', { batchId: s.batchId, date: s.day, employee: currentEmployee.username, receivedAmount: '24000' }); await reloadConfirmView(); });
await page.waitForSelector('.sess-dt .badge-danger');
check('الحالة بقت حمراء (diff) وبتعرض آخر محاولة', (await page.locator('.sess-dt .note-box.red').innerText()).includes('24,000'));
if (shots) await page.screenshot({ path: `${shots}/02-diff.png`, fullPage: true });

// v1.8.0 — الشريط الجانبي: توريد اليوم بالكامل + «توريد المحدّدين» مايظهرش لو حددت كل المناديب (نفس الرقم)
check('الشريط الجانبي فيه توريد اليوم بالكامل بنفس المتوقع', (await page.locator('#confReg .reg-amt').first().innerText()).includes('24,400') && await page.locator('#damt-0').count() === 1);
await page.fill('#camt-0-0', '123'); await page.click('.cg-arrow'); await page.click('.cg-arrow');
check('طي/فتح المندوب ما بيمسحش المبلغ المكتوب', (await page.inputValue('#camt-0-0')) === '123');
await page.click('.pick'); check('تحديد كل المناديب ← مفيش «توريد المحدّدين» مكرر', await page.locator('#samt').count() === 0);
await page.click('.pick');
// صح: 24400
await page.fill('#camt-0-0', '24,400');
check('مطابق: الزرار اتفتح', await page.locator('#ccbtn-0-0').isEnabled());
await page.press('#camt-0-0', 'Enter'); await page.waitForSelector('#confirmOverlay.open');
check('نافذة التأكيد بتسمّي الأثر بالأرقام', (await page.locator('#cfLines').innerText()).includes('4 حركة'));
await page.click('#cfOk');
await page.waitForSelector('#summaryOverlay.open');
const sm = await page.locator('#smBody').innerText();
check('التأكيد الصح: الملخص ظاهر (تحذير المرآة لأن مفيش Shopify في الاختبار)', (await page.locator('#smHeader').innerText()).includes('تحذير') && sm.includes('اتسجّلت 1 من 1'));
check('الدفتر: 4 حركات مجموعها 24400', DB.raw.prepare('SELECT COUNT(*) n, SUM(amount_piastres) s FROM treasury_ledger').get().s === 2440000);
await page.click('#summaryOverlay .eco-modal-ftr .btn-primary');
await page.waitForSelector('.cg.all-ok');
check('المندوب كله اتسجّل: مفيش خانة مبلغ وقسم «تم تسجيله» بحالة خضرا (والكارت اتطوى لوحده)', await page.locator('#camt-0-0').count() === 0 && (await page.locator('.cg-sec.done').textContent()).includes('تم تسجيله') && await page.locator('.cg.closed').count() === 1 && await page.locator('.sess-dt .badge-success:text("تم التسجيل")').count() === 4);
// v1.8.0 — الصف كله بيطوي/يفتح، والضغط على الخانة ما بيطويش
await page.click('.cg-head .cg-meta'); check('الضغط على أي مكان في الصف بيفتح الكارت', await page.locator('.cg.closed').count() === 0);
await page.click('.cg-head .cg-meta'); check('…وبيطويه تاني', await page.locator('.cg.closed').count() === 1);
await page.click('.bulkbtn:has-text("افتح الكل")'); check('«افتح الكل» (من غير توست)', await page.locator('.cg.closed').count() === 0 && !(await page.locator('.toast').allInnerTexts()).some(t => /افتح|اتفتح|اتطوى/.test(t)));
await page.click('.bulkbtn:has-text("اقفل الكل")'); check('«اقفل الكل»', await page.locator('.cg.closed').count() === 1);
await page.click('.bulkbtn:has-text("افتح الكل")');
// ترتيب بعمود المبلغ: 3 حالات والأيقونة بس عند التفعيل
await page.click('.th-label[data-sort="amt"]'); check('ترتيب تصاعدي ▲', (await page.locator('th.sorted .sort-icon').innerText()) === '▲');
await page.click('.th-label[data-sort="amt"]'); check('ترتيب تنازلي ▼', (await page.locator('th.sorted .sort-icon').innerText()) === '▼');
await page.click('.th-label[data-sort="amt"]'); check('بلا ترتيب (مفيش أيقونة)', await page.locator('th.sorted').count() === 0);
if (shots) await page.screenshot({ path: `${shots}/03-confirmed.png`, fullPage: true });

// سجل الأوردر + التصحيح
await page.click('#tabOrder'); await page.fill('#orderQ', '61774'); await page.click('#orderGo');
await page.waitForSelector('#orderResult table.dt');
check('سجل الأوردر: حركة Extra Shipping بقيمة -75', (await page.locator('#orderResult').innerText()).includes('-75'));
await page.click('#orderResult button:text("تصحيح")'); await page.waitForSelector('#confirmOverlay.open'); await page.fill('#cfReason', 'اختبار'); await page.click('#cfOk');
await page.waitForSelector('#summaryOverlay.open');   // مفيش Shopify في الاختبار → تصحيح مع تحذير المرآة (الملخص إلزامي)
await page.click('#summaryOverlay .eco-modal-ftr .btn-primary');
await page.waitForFunction(() => document.querySelector('#orderResult')?.innerText.includes('اتلغت'));
check('التصحيح: صف REVERSAL والإجمالي صفر', DB.raw.prepare("SELECT COUNT(*) n FROM treasury_ledger WHERE kind='REVERSAL'").get().n === 1 && (await page.locator('#orderResult .chip').first().innerText()).includes('0'));
if (shots) await page.screenshot({ path: `${shots}/04-order.png`, fullPage: true });

// معلّق + تنبيهات + سجل
await page.click('#tabPending'); await page.waitForFunction(() => document.querySelector('#daySessions .empty-box')?.innerText.includes('اتسجّلت'));
check('كل الأيام المعلّقة: فاضي بعد التأكيد', (await page.locator('#daySessions').innerText()).includes('اتسجّلت'));
await page.click('#tabAlerts'); await page.waitForSelector('#alertsList .empty-box, #alertsList table');
await page.click('#tabLog'); await page.waitForSelector('#logBody tr');
await page.waitForFunction(() => document.querySelector('#logCount').textContent !== '—');
check('سجل العمليات: فيه صفوف (تأكيد + محاولة بفرق + تصحيح)', Number((await page.locator('#logCount').innerText()).replace(/,/g, '')) >= 3);
await page.click('#msTypeWrap .ms-btn'); await page.click('#msPanel-type input[value="confirm_mismatch"]');
check('فلتر النوع: القايمة فضلت مفتوحة بعد الاختيار', await page.locator('#msPanel-type.open').count() === 1);
await page.click('#msPanel-type input[value="entry_reversed"]');
check('…وبتقبل اختيار تاني', await page.locator('#msPanel-type input:checked').count() === 2);
await page.waitForFunction(() => document.querySelector('#logCount').textContent === '2');
check('فلتر النوع بيتبعت للسيرفر (النتائج = 2)', (await page.locator('#logCount').innerText()) === '2');
if (shots) await page.screenshot({ path: `${shots}/05-log.png`, fullPage: true });

// خروج بلا تأكيد + مسح الشاشة
await page.click('#activeUserBtn');
check('الخروج اليدوي فوري ومسح الأرقام من الشاشة', await page.locator('#loginOverlay:not(.hidden)').count() === 1 && (await page.locator('#daySessions').innerHTML()) === '');

// ─── v1.4.0 — التسوية التاريخية (أحمد) + علامة «متسجّل في جلسة تانية» ───
const histRow = (t, type, oid, nm, cc, batchId, courier = 'Magdy', extra = {}) => ins.run(t, type, oid, nm, JSON.stringify({ result: 'success', batchId, courier, courierCollect: cc,
  extraShipping: [], extraShippingTotal: '0.00', preRegistered: false, hasReturn: false, ...extra }));
histRow('2026-10-05T09:00:00.000Z', 'payment', '63', '#63567', 2600, 'hist-a');
histRow('2026-10-05T09:00:01.000Z', 'payment', '70', '#700', 1000, 'hist-a');
histRow('2026-10-06T09:00:00.000Z', 'refund', '63', '#63567', -2600, 'hist-ref');
histRow('2026-10-06T10:00:00.000Z', 'payment', '71', '#701', null, 'hist-blk', 'Saif');          // مرفوضة (courierCollect فاضي)
await worker.fetch(new Request('https://w.test/?action=confirm_session', { method: 'POST', headers: { Authorization: 'Bearer sek', 'Content-Type': 'application/json' },
  body: JSON.stringify({ batchId: 'hist-ref', date: '2026-10-06', employee: 'Sara_Cash', receivedAmount: '-2600' }) }), env);
await page.selectOption('#loginSelect', 'Ahmed_Ibraheem');
await page.waitForSelector('#pinZone.visible');
for (const d of '9999') await page.click(`#pinKeypad .pin-key:text-is("${d}")`);
await page.waitForSelector('#loginOverlay.hidden', { state: 'attached' });
await page.click('#tabPending'); await page.waitForSelector('.day-head');
await page.waitForSelector('#settleCard', { state: 'visible' });
check('أحمد: كارت التسوية التاريخية ظاهر في «كل الأيام المعلّقة»', await page.locator('#settleCard').isVisible() && (await page.inputValue('#stFrom')) === '2026-10-01');
check('علامة «متسجّل في جلسة تانية» على #63567', (await page.locator('#daySessions').innerText()).includes('متسجّل في جلسة تانية'));
check('زرار التنفيذ مقفول قبل المعاينة', await page.locator('#stRunBtn').isDisabled());
await page.fill('#stPin', '9999'); await page.click('#stPreviewBtn');
await page.waitForSelector('#stResult table');
const pv = await page.locator('#stResult').innerText();
check('المعاينة: جلسة واحدة للتسوية بـ 3,600 والمرفوضة مستثناة', pv.includes('3,600') && pv.includes('مرفوضة') && await page.locator('#stRunBtn').isEnabled());
check('المعاينة ما كتبتش حاجة', DB.raw.prepare("SELECT COUNT(*) n FROM treasury_confirmations WHERE session_flags LIKE '%historical%'").get().n === 0);
if (shots) await page.screenshot({ path: `${shots}/06-settle-preview.png`, fullPage: true });
await page.click('#stRunBtn'); await page.waitForSelector('#confirmOverlay.open');
check('نافذة تأكيد التسوية بالأرقام', (await page.locator('#cfLines').innerText()).includes('1 جلسة'));
await page.click('#cfOk'); await page.waitForSelector('#summaryOverlay.open');
check('ملخص التسوية', (await page.locator('#smHeader').innerText()).includes('تمت') && (await page.locator('#smBody').innerText()).includes('اتسوّى 1 من 1'));
check('الدفتر: حركتين «تسوية تاريخية» و#63567 رصيده صفر', DB.raw.prepare("SELECT COUNT(*) n FROM treasury_ledger WHERE note LIKE 'تسوية تاريخية%'").get().n === 2
  && DB.raw.prepare("SELECT SUM(amount_piastres) s FROM treasury_ledger WHERE order_name='#63567'").get().s === 0);
if (shots) await page.screenshot({ path: `${shots}/07-settle-done.png`, fullPage: true });
await page.click('#summaryOverlay .eco-modal-ftr .btn-primary');
await page.waitForSelector('.day-head');
check('المرفوضة لسه في «لم يتم التسجيل»', (await page.locator('#daySessions').innerText()).includes('Saif'));
await page.click('#activeUserBtn');

check('صفر أخطاء JS في الكونسول', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? `\n❌ ${failures} فشل` : '\n✅ كل الفحوص عدّت');
process.exit(failures ? 1 : 0);
