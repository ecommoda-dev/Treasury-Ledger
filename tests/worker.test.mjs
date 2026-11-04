import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDB } from './d1-shim.mjs';
import worker from '../index.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const SECRET = 'test-secret';

function setup(envExtra = {}) {
  const DB = makeDB(schema);
  DB.raw.exec(`INSERT INTO employees (username, display_name, pin, is_active) VALUES ('Sara_Cash','Sara','1234',1),('Old_Emp','Old','1111',0)`);
  return { DB, env: { DB, WORKER_SECRET: SECRET, ...envExtra } };
}
async function call(env, action, { method = 'GET', body, params = {} } = {}) {
  const q = new URLSearchParams({ action, ...params });
  const req = new Request(`https://w.test/?${q}`, {
    method, headers: { Authorization: `Bearer ${SECRET}`, Origin: 'https://ecommoda-dev.github.io', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env);
  return { status: res.status, body: await res.json() };
}
let seq = 0;
function seed(DB, { ts, type = 'payment', emp = 'Fady_Mostafa', orderId, orderName, extra }) {
  DB.raw.prepare(`INSERT INTO logs (timestamp, tool, type, employee, order_id, order_name, extra) VALUES (?, 'cod_payment', ?, ?, ?, ?, ?)`)
    .run(ts, type, emp, orderId, orderName, JSON.stringify(extra));
  seq++;
}
const XS = [{ orderId: '9001', orderName: '#61774', courier: 'Saif', amount: '75.00' }];
function session(DB, { batchId, ts, courier = 'Saif', rows, xs = [], orders = rows.length, collect, net, omitBE = false }) {
  const sum = rows.reduce((s, r) => s + r.cc, 0);
  const xsTot = xs.reduce((s, x) => s + parseFloat(x.amount), 0);
  for (const r of rows) seed(DB, { ts, type: r.type || 'payment', orderId: r.orderId, orderName: r.orderName, extra: {
    result: 'success', batchId, courier, courierCollect: r.cc, extraShipping: xs, extraShippingTotal: xsTot.toFixed(2),
    preRegistered: !!r.pre, hasReturn: false,
    ...(omitBE ? {} : { batchExpected: { orders, payOrders: orders, refundOrders: 0, collect: (collect ?? sum).toFixed(2), extraShippingTotal: xsTot.toFixed(2), net: (net ?? (sum - xsTot)).toFixed(2) } }),
  } });
}

test('get_day: جلسة بمتوقع = Σ courierCollect − الشحن الإضافي، والشحن يتقرا مرة واحدة', async () => {
  const { DB, env } = setup();
  session(DB, { batchId: 'b1', ts: '2026-11-02T12:00:00.000Z', rows: [
    { orderId: '1', orderName: '#1', cc: 2800 }, { orderId: '2', orderName: '#2', cc: 1000.5 }, { orderId: '3', orderName: '#3', cc: -525, type: 'refund' } ], xs: XS });
  const { body } = await call(env, 'get_day', { params: { date: '2026-11-02' } });
  assert.equal(body.sessions.length, 1);
  const s = body.sessions[0];
  assert.equal(s.expected, '3200.50');           // 2800 + 1000.5 − 525 − 75
  assert.equal(s.status, 'pending');
  assert.equal(s.incomplete, false);
  assert.equal(s.rows.length, 3);
  assert.equal(s.extraShipping.length, 1);
});

test('حدود يوم القاهرة: شتاءً UTC+2 (بعد 29-10-2026)', async () => {
  const { DB, env } = setup();
  // 2026-11-01 00:30 بتوقيت القاهرة (UTC+2) = 2026-10-31T22:30Z — لازم تتحسب 11-01 مش 10-31
  session(DB, { batchId: 'late', ts: '2026-10-31T22:30:00.000Z', rows: [{ orderId: '5', orderName: '#5', cc: 100 }] });
  const d1 = (await call(env, 'get_day', { params: { date: '2026-11-01' } })).body;
  const d0 = (await call(env, 'get_day', { params: { date: '2026-10-31' } })).body;
  assert.equal(d1.sessions.length, 1);
  assert.equal(d0.sessions.length, 0);
});

test('تاريخ قبل 01-10-2026 أو مستقبلي مرفوض', async () => {
  const { env } = setup();
  assert.equal((await call(env, 'get_day', { params: { date: '2026-09-30' } })).status, 400);
  assert.equal((await call(env, 'get_day', { params: { date: '2999-01-01' } })).status, 400);
  assert.equal((await call(env, 'get_day', { params: { date: 'abc' } })).status, 400);
});

test('فرق في المبلغ: التسجيل ممنوع + المحاولة بتتسجّل + الجلسة تبقى diff + تنبيه', async () => {
  const { DB, env } = setup();
  session(DB, { batchId: 'b2', ts: '2026-11-02T12:00:00.000Z', rows: [{ orderId: '1', orderName: '#1', cc: 24850 }] });
  const r = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'b2', date: '2026-11-02', employee: 'Sara_Cash', receivedAmount: '24000' } });
  assert.equal(r.body.ok, false); assert.equal(r.body.status, 'rejected');
  assert.equal(r.body.diff, '-850.00'); assert.match(r.body.error, /ناقص 850\.00/);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM treasury_ledger').get().n, 0);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM logs WHERE tool='treasury_ledger' AND type='confirm_mismatch'").get().n, 1);
  const day = (await call(env, 'get_day', { params: { date: '2026-11-02' } })).body;
  assert.equal(day.sessions[0].status, 'diff');
  const al = (await call(env, 'get_alerts')).body;
  assert.ok(al.alerts.some(a => a.type === 'DIFF' && a.batchId === 'b2'));
  // نقص بالقرش كمان يترفض
  const r2 = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'b2', date: '2026-11-02', employee: 'Sara_Cash', receivedAmount: 24849.99 } });
  assert.equal(r2.body.status, 'rejected');
});

test('مبلغ صحيح: حركات الدفتر + التأكيد ذرّيًا، والجلسة ما تتأكدش مرتين، والـ idempotency', async () => {
  const { DB, env } = setup();
  session(DB, { batchId: 'b3', ts: '2026-11-02T12:00:00.000Z', rows: [
    { orderId: '1', orderName: '#1', cc: 2800 }, { orderId: '3', orderName: '#3', cc: -525, type: 'refund' }, { orderId: '4', orderName: '#4', cc: 0 } ], xs: XS });
  const ok = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'b3', date: '2026-11-02', employee: 'Sara_Cash', receivedAmount: '2200' } });
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.status, 'warning');      // مفيش CLIENT_ID → المرآة ما اتكتبتش، الدفتر اتكتب
  assert.equal(ok.body.summary.net, '2200.00');
  const rows = DB.raw.prepare('SELECT * FROM treasury_ledger ORDER BY id').all();
  assert.equal(rows.length, 4);                  // 3 صفوف مصدر + 1 شحن إضافي
  assert.equal(rows.reduce((s, r) => s + r.amount_piastres, 0), 220000);
  const xs = rows.find(r => r.source === 'cod_extra_shipping');
  assert.equal(xs.kind, 'CASH_OUT'); assert.equal(xs.note, 'Extra Shipping'); assert.equal(xs.order_name, '#61774'); assert.equal(xs.amount_piastres, -7500);
  assert.equal(rows.find(r => r.order_name === '#3').kind, 'CASH_OUT');
  assert.equal(rows.find(r => r.order_name === '#4').kind, 'CASH_IN');   // صفر
  assert.equal(rows.find(r => r.order_name === '#4').amount_piastres, 0);
  assert.ok(rows.every(r => r.confirmation_id));
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM treasury_confirmations').get().n, 1);
  // مرة تانية
  const again = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'b3', date: '2026-11-02', employee: 'Sara_Cash', receivedAmount: '2200' } });
  assert.equal(again.body.status, 'already');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM treasury_ledger').get().n, 4);
  const day = (await call(env, 'get_day', { params: { date: '2026-11-02' } })).body;
  assert.equal(day.sessions[0].status, 'confirmed');
  const pend = (await call(env, 'get_pending')).body;
  assert.equal(pend.count, 0);
});

test('الدخول: موظف موقوف/مجهول مرفوض، ومبلغ فاضي مرفوض (مفيش تأكيد أعمى)', async () => {
  const { DB, env } = setup();
  session(DB, { batchId: 'b4', ts: '2026-11-02T12:00:00.000Z', rows: [{ orderId: '1', orderName: '#1', cc: 100 }] });
  const base = { batchId: 'b4', date: '2026-11-02' };
  assert.equal((await call(env, 'confirm_session', { method: 'POST', body: { ...base, employee: 'Old_Emp', receivedAmount: '100' } })).status, 403);
  assert.equal((await call(env, 'confirm_session', { method: 'POST', body: { ...base, employee: 'Nobody', receivedAmount: '100' } })).status, 403);
  assert.equal((await call(env, 'confirm_session', { method: 'POST', body: { ...base, employee: 'Sara_Cash' } })).status, 400);
  assert.equal((await call(env, 'confirm_session', { method: 'POST', body: { ...base, employee: 'Sara_Cash', receivedAmount: '' } })).status, 400);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM treasury_ledger').get().n, 0);
});

test('جلسة ناقصة: المتوقع = اللي D1 مثبّته + تنبيه INCOMPLETE يفضل حتى بعد التأكيد', async () => {
  const { DB, env } = setup();
  session(DB, { batchId: 'inc', ts: '2026-10-22T12:00:00.000Z', rows: [{ orderId: '1', orderName: '#61461', cc: 2700 }, { orderId: '2', orderName: '#61552', cc: 2700 }], orders: 3, collect: 8000 });
  const day = (await call(env, 'get_day', { params: { date: '2026-10-22' } })).body;
  assert.equal(day.sessions[0].incomplete, true);
  assert.equal(day.sessions[0].expected, '5400.00');
  const c = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'inc', date: '2026-10-22', employee: 'Sara_Cash', receivedAmount: '5400' } });
  assert.equal(c.body.ok, true); assert.equal(c.body.summary.incomplete, true);
  const al = (await call(env, 'get_alerts')).body;
  assert.ok(al.alerts.some(a => a.type === 'INCOMPLETE' && a.batchId === 'inc'));
});

test('بيانات مصدر ناقصة (courierCollect فاضي / شحن إضافي مش متسق) = الجلسة blocked ومش بتتأكد', async () => {
  const { DB, env } = setup();
  seed(DB, { ts: '2026-11-02T12:00:00.000Z', orderId: '1', orderName: '#1', extra: { result: 'success', batchId: 'bad', courier: 'X', courierCollect: null, extraShipping: [], extraShippingTotal: '0.00' } });
  seed(DB, { ts: '2026-11-02T12:01:00.000Z', orderId: '2', orderName: '#2', extra: { result: 'success', batchId: 'bad2', courier: 'X', courierCollect: 100, extraShipping: XS, extraShippingTotal: '10.00' } });
  const day = (await call(env, 'get_day', { params: { date: '2026-11-02' } })).body;
  assert.deepEqual(day.sessions.map(s => s.status), ['blocked', 'blocked']);
  const r = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'bad', date: '2026-11-02', employee: 'Sara_Cash', receivedAmount: '0' } });
  assert.equal(r.body.status, 'rejected'); assert.equal(r.body.stage, 'preflight');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM treasury_ledger').get().n, 0);
});

test('التصحيح REVERSAL: عكس الإشارة، مرة واحدة، ومينفعش تصحح تصحيح', async () => {
  const { DB, env } = setup();
  session(DB, { batchId: 'b5', ts: '2026-11-02T12:00:00.000Z', rows: [{ orderId: '7', orderName: '#7', cc: 100 }] });
  await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'b5', date: '2026-11-02', employee: 'Sara_Cash', receivedAmount: '100' } });
  const id = DB.raw.prepare('SELECT id FROM treasury_ledger').get().id;
  const r = await call(env, 'reverse_entry', { method: 'POST', body: { entryId: id, employee: 'Sara_Cash', reason: 'غلط' } });
  assert.equal(r.body.ok, true);
  const rows = DB.raw.prepare('SELECT * FROM treasury_ledger ORDER BY id').all();
  assert.equal(rows.length, 2); assert.equal(rows[1].kind, 'REVERSAL'); assert.equal(rows[1].amount_piastres, -10000); assert.equal(rows[1].reverses_id, id);
  assert.match(rows[1].note, new RegExp(`يلغي #${id}`));
  assert.equal(rows[0].amount_piastres, 10000);   // الأصل ما اتغيّرش
  assert.equal((await call(env, 'reverse_entry', { method: 'POST', body: { entryId: id, employee: 'Sara_Cash' } })).body.status, 'already');
  assert.equal((await call(env, 'reverse_entry', { method: 'POST', body: { entryId: rows[1].id, employee: 'Sara_Cash' } })).body.status, 'rejected');
  const o = (await call(env, 'get_order', { params: { orderName: '7' } })).body;
  assert.equal(o.total, '0.00');
  assert.equal(o.entries.length, 2);
});

test('المرآة على Shopify: سطور مرتبة + إجمالي من كل الحركات، والتأكيد لكل أوردر', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, opts) => {
    const url = String(u);
    if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (/metafieldsSet/.test(body.query)) {
      return new Response(JSON.stringify({ data: { metafieldsSet: { userErrors: [],
        metafields: body.variables.metafields.map(m => ({ namespace: m.namespace, key: m.key, value: m.key === 'treasury_total' ? String(parseFloat(m.value)) : m.value, owner: { id: m.ownerId } })) } },
        extensions: { cost: { requestedQueryCost: 10, actualQueryCost: 10, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 990, restoreRate: 50 } } } }), { status: 200 });
    }
    throw new Error('unexpected query');
  };
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's.myshopify.com', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    session(DB, { batchId: 'm1', ts: '2026-11-02T12:00:00.000Z', rows: [{ orderId: '100', orderName: '#100', cc: 100 }, { orderId: '101', orderName: '#101', cc: 50.25 }] });
    const r = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'm1', date: '2026-11-02', employee: 'Sara_Cash', receivedAmount: '150.25' } });
    assert.equal(r.body.status, 'success'); assert.equal(r.body.mirror.written, 2);
    const mf = calls.find(c => /metafieldsSet/.test(c.query)).variables.metafields;
    assert.equal(mf.length, 4);
    const log100 = mf.find(m => m.ownerId.endsWith('/100') && m.key === 'treasury_log');
    assert.equal(log100.type, 'multi_line_text_field');
    assert.match(log100.value, /^#\d+ \| \d\d\/\d\d\/\d{4} \d\d:\d\d \| CASH_IN  \|   \+100\.00 \| Sara Cash$/);   // التاريخ = وقت التأكيد بتوقيت القاهرة
    assert.equal(mf.find(m => m.ownerId.endsWith('/100') && m.key === 'treasury_total').value, '100.00');
    assert.equal(mf.find(m => m.key === 'treasury_total').type, 'number_decimal');
    // تصحيح → المرآة تتبني من كل الحركات (سطرين + إجمالي صفر)
    calls.length = 0;
    const id = DB.raw.prepare("SELECT id FROM treasury_ledger WHERE order_id='100'").get().id;
    await call(env, 'reverse_entry', { method: 'POST', body: { entryId: id, employee: 'Sara_Cash' } });
    const mf2 = calls.find(c => /metafieldsSet/.test(c.query)).variables.metafields;
    assert.equal(mf2.find(m => m.key === 'treasury_log').value.split('\n').length, 2);
    assert.equal(mf2.find(m => m.key === 'treasury_total').value, '0.00');
  } finally { globalThis.fetch = realFetch; }
});

test('فشل المرآة (userErrors) = warning، والدفتر محفوظ', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => String(u).includes('/oauth/')
    ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
    : new Response(JSON.stringify({ data: { metafieldsSet: { metafields: [], userErrors: [{ message: 'denied' }] } } }), { status: 200 });
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    session(DB, { batchId: 'm2', ts: '2026-11-02T12:00:00.000Z', rows: [{ orderId: '1', orderName: '#1', cc: 10 }] });
    const r = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'm2', date: '2026-11-02', employee: 'Sara_Cash', receivedAmount: '10' } });
    assert.equal(r.body.status, 'warning'); assert.equal(r.body.mirror.failed.length, 1);
    assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM treasury_ledger').get().n, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('مقارنة Shopify: المعادلة netPayment − shipping − returnFees، واستثناء الشحن الإضافي', async () => {
  const realFetch = globalThis.fetch;
  const node = (id, name, net, ship, fees = [], status = 'PAID', outstanding = '0.0') => ({ id: `gid://shopify/Order/${id}`, legacyResourceId: id, name, displayFinancialStatus: status, cancelledAt: null,
    netPaymentSet: { shopMoney: { amount: net } }, totalShippingPriceSet: { shopMoney: { amount: ship } }, totalOutstandingSet: { shopMoney: { amount: outstanding } },
    returns: { pageInfo: { hasNextPage: false }, nodes: [{ returnShippingFees: fees.map(f => ({ amountSet: { shopMoney: { amount: f } } })) }] } });
  globalThis.fetch = async (u) => String(u).includes('/oauth/')
    ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
    : new Response(JSON.stringify({ data: { nodes: [
        node('1', '#1', '2875.00', '75.00'),                 // مطابق 2800
        node('2', '#2', '0.00', '0.00'),                      // ملغي — الدفتر فيه شحن إضافي بس
        node('3', '#3', '1000.00', '0.00'),                   // الدفتر 900 → SHORT
        node('4', '#4', '500.00', '0.00', [], 'PARTIALLY_PAID', '200.00'),   // IN_PROGRESS
      ] } }), { status: 200 });
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    const ins = (o, n, kind, amt, src, note = null) => DB.raw.prepare(`INSERT INTO treasury_ledger (created_at, order_id, order_name, kind, amount_piastres, note, source, treasury_employee, idempotency_key) VALUES ('2026-11-02T10:00:00Z', ?, ?, ?, ?, ?, ?, 'X', ?)`).run(o, n, kind, amt, note, src, `k${o}${src}${amt}`);
    ins('1', '#1', 'CASH_IN', 280000, 'cod_payment');
    ins('2', '#2', 'CASH_OUT', -7500, 'cod_extra_shipping', 'Extra Shipping');
    ins('3', '#3', 'CASH_IN', 90000, 'cod_payment');
    ins('4', '#4', 'CASH_IN', 30000, 'cod_payment');
    const r = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['1', '2', '3', '4'] } })).body;
    const st = Object.fromEntries(r.results.map(x => [x.orderId, x.status]));
    assert.deepEqual(st, { 1: 'MATCH', 2: 'MATCH', 3: 'SHORT', 4: 'IN_PROGRESS' });
    assert.equal(r.results.find(x => x.orderId === '3').diff, '-100.00');
  } finally { globalThis.fetch = realFetch; }
});

test('الأمان: بدون سر = 401، WORKER_SECRET غايب = 500 (مش Bearer undefined)، CORS مقفول', async () => {
  const { env } = setup();
  const noAuth = await worker.fetch(new Request('https://w.test/?action=get_config'), env);
  assert.equal(noAuth.status, 401);
  const missing = await worker.fetch(new Request('https://w.test/?action=get_config', { headers: { Authorization: 'Bearer undefined' } }), { ...env, WORKER_SECRET: undefined });
  assert.equal(missing.status, 500);
  const foreign = await worker.fetch(new Request('https://w.test/?action=get_config', { headers: { Authorization: `Bearer ${SECRET}`, Origin: 'https://evil.example' } }), env);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), 'https://ecommoda-dev.github.io');
});

test('الطبقة ٥: كل type بيكتبه الكود مسجّل (مفيش _unregistered)', async () => {
  const { DB, env } = setup();
  session(DB, { batchId: 'g1', ts: '2026-11-02T12:00:00.000Z', rows: [{ orderId: '1', orderName: '#1', cc: 100 }] });
  await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'g1', date: '2026-11-02', employee: 'Sara_Cash', receivedAmount: '99' } });
  await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'g1', date: '2026-11-02', employee: 'Sara_Cash', receivedAmount: '100' } });
  await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'g1', date: '2026-11-02', employee: 'Sara_Cash', receivedAmount: '100' } });
  const bad = DB.raw.prepare("SELECT COUNT(*) n FROM logs WHERE tool='treasury_ledger' AND extra LIKE '%_unregistered%'").get().n;
  assert.equal(bad, 0);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM log_value_alerts').get().n, 0);
});
