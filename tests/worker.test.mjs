import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDB } from './d1-shim.mjs';
import worker from '../index.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const SECRET = 'test-secret';

function setup(envExtra = {}) {
  const DB = makeDB(schema);
  DB.raw.exec(`INSERT INTO employees (username, display_name, pin, is_active) VALUES ('Sara_Cash','Sara','1234',1),('Old_Emp','Old','1111',0),('Ahmed_Ibraheem','Ahmed Ibraheem','9999',1)`);
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
    assert.match(log100.value, /^📅 \d\d\/\d\d\/\d{4} 🕕 \d\d:\d\d \| CASH_IN \| 💲 \+100\.00 \| Sara Cash$/);   // التاريخ = وقت التأكيد بتوقيت القاهرة
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

test('بوسطة: courierCollect = Net Value، الجلسة ناقصة لحد ما كل الصفوف تتسجّل، والتأكيد بالصافي، والمقارنة BOSTA_FEES (حكم فعلي بعد v1.3.0)', async () => {
  const realFetch = globalThis.fetch;
  const bostaRow = (id, name, net, type = 'payment') => ({ orderId: id, orderName: name, type, net });
  const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
  const put = (r, orders, collect) => seed(DB, { ts: '2026-11-04T10:00:00.000Z', type: r.type, orderId: r.orderId, orderName: r.orderName, extra: {
    result: 'success', batchId: 'bosta-MONCOD02NOV26', courier: 'Bosta', courierCollect: r.net, source: 'bosta_cash_cycle',
    cashOutId: 'MONCOD02NOV26', trackingNumber: 't' + r.orderId, extraShipping: null, extraShippingTotal: '0.00', preRegistered: false, hasReturn: false,
    batchExpected: { orders, payOrders: orders, refundOrders: 0, collect, extraShippingTotal: '0.00', net: collect, methods: null } } });
  // الملف 3 صفوف: Net 2538.20 + (−85.82 بدون تحصيل) + (−1771.41 استرداد) = 680.97 — اتسجّل صفين بس
  put(bostaRow('1', '#61945', 2538.2), 3, '680.97');
  put(bostaRow('2', '#61540', -85.82), 3, '680.97');
  let day = (await call(env, 'get_day', { params: { date: '2026-11-04' } })).body;
  let s = day.sessions.find(x => x.batchId === 'bosta-MONCOD02NOV26');
  assert.equal(s.courier, 'Bosta'); assert.equal(s.expected, '2452.38'); assert.equal(s.incomplete, true);
  put(bostaRow('3', '#61298', -1771.41, 'refund'), 3, '680.97');
  day = (await call(env, 'get_day', { params: { date: '2026-11-04' } })).body;
  s = day.sessions.find(x => x.batchId === 'bosta-MONCOD02NOV26');
  assert.equal(s.expected, '680.97'); assert.equal(s.incomplete, false);
  assert.equal(s.rows.length, 3);

  // التأكيد: موظف الخزنة بيكتب اللي بوسطة حوّلته (Σ Net)
  const bad = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'bosta-MONCOD02NOV26', date: '2026-11-04', employee: 'Sara_Cash', receivedAmount: '2538.20' } });
  assert.equal(bad.body.ok, false);
  globalThis.fetch = async (u) => String(u).includes('/oauth/')
    ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
    : new Response(JSON.stringify({ data: { metafieldsSet: { metafields: [], userErrors: [] } } }), { status: 200 });
  try {
    const ok = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'bosta-MONCOD02NOV26', date: '2026-11-04', employee: 'Sara_Cash', receivedAmount: '680.97' } });
    assert.equal(ok.body.ok, true);
    const led = DB.raw.prepare('SELECT order_id, kind, amount_piastres, source, note FROM treasury_ledger ORDER BY id').all();
    assert.deepEqual(led.map(e => [e.order_id, e.kind, e.amount_piastres, e.source]), [
      ['1', 'CASH_IN', 253820, 'bosta_cash_cycle'], ['2', 'CASH_OUT', -8582, 'bosta_cash_cycle'], ['3', 'CASH_OUT', -177141, 'bosta_cash_cycle']]);
    assert.equal(led[0].note, 'بوسطة — صافي بعد الرسوم');
  } finally { globalThis.fetch = realFetch; }

  // مقارنة Shopify: أوردر بوسطة = BOSTA_FEES (الفرق = رسوم بوسطة، مش SHORT كاذب)، وأوردر عادي لسه بيتقارن
  const node = (id, name, net) => ({ id: `gid://shopify/Order/${id}`, legacyResourceId: id, name, displayFinancialStatus: 'PAID', cancelledAt: null,
    netPaymentSet: { shopMoney: { amount: net } }, totalShippingPriceSet: { shopMoney: { amount: '0.00' } }, totalOutstandingSet: { shopMoney: { amount: '0.0' } },
    returns: { pageInfo: { hasNextPage: false }, nodes: [] } });
  globalThis.fetch = async (u) => String(u).includes('/oauth/')
    ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
    : new Response(JSON.stringify({ data: { nodes: [node('1', '#61945', '2675.00'), node('9', '#9', '100.00')] } }), { status: 200 });
  try {
    DB.raw.prepare(`INSERT INTO treasury_ledger (created_at, order_id, order_name, kind, amount_piastres, source, treasury_employee, idempotency_key) VALUES ('2026-11-04T10:00:00Z','9','#9','CASH_IN',5000,'cod_payment','X','kx')`).run();
    const r = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['1', '9'] } })).body;
    const st = Object.fromEntries(r.results.map(x => [x.orderId, x.status]));
    assert.deepEqual(st, { 1: 'BOSTA_FEES', 9: 'SHORT' });
    assert.equal(r.results.find(x => x.orderId === '1').ledger, '2538.20');
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

// ─── v1.2.0 — التسوية التاريخية + الشحنة المعلّقة ───
const shopNode = (id, name, net, ship = '0.00', fees = []) => ({ id: `gid://shopify/Order/${id}`, legacyResourceId: id, name, displayFinancialStatus: 'PARTIALLY_REFUNDED', cancelledAt: null,
  netPaymentSet: { shopMoney: { amount: net } }, totalShippingPriceSet: { shopMoney: { amount: ship } }, totalOutstandingSet: { shopMoney: { amount: '0.0' } },
  returns: { pageInfo: { hasNextPage: false }, nodes: [{ returnShippingFees: fees.map(f => ({ amountSet: { shopMoney: { amount: f } } })) }] } });
function mockShopify(nodes) {
  return async (u, opts) => {
    if (String(u).includes('/oauth/')) return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    const q = JSON.parse(opts.body).query;
    if (/metafieldsSet/.test(q)) return new Response(JSON.stringify({ data: { metafieldsSet: { metafields: [], userErrors: [] } } }), { status: 200 });
    if (/orders\(first/.test(q)) return new Response(JSON.stringify({ data: { orders: { nodes: nodes.map(n => ({ legacyResourceId: n.legacyResourceId, name: n.name })) } } }), { status: 200 });
    return new Response(JSON.stringify({ data: { nodes } }), { status: 200 });
  };
}

test('تسوية تاريخية: أحمد بس + PIN، مش النهارده، المعاينة ما بتكتبش، والمستثنى (مرفوضة/ناقصة/بفرق) بيفضل معلّق', async () => {
  const { DB, env } = setup();
  const D = '2026-10-05', ts = '2026-10-05T10:00:00.000Z';
  session(DB, { batchId: 'ok1', ts, rows: [{ orderId: '1', orderName: '#1', cc: 1000 }, { orderId: '2', orderName: '#2', cc: -200, type: 'refund' }], xs: [{ orderId: '1', orderName: '#1', courier: 'Saif', amount: '50.00' }] });
  session(DB, { batchId: 'ok2', ts, courier: 'Magdy', rows: [{ orderId: '3', orderName: '#3', cc: 300 }] });
  session(DB, { batchId: 'inc', ts, rows: [{ orderId: '4', orderName: '#4', cc: 100 }], orders: 2 });                 // ناقصة
  seed(DB, { ts, orderId: '5', orderName: '#5', extra: { result: 'success', batchId: 'blk', courier: 'Saif', courierCollect: null } });   // مرفوضة
  session(DB, { batchId: 'dif', ts, rows: [{ orderId: '6', orderName: '#6', cc: 700 }] });
  await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'dif', date: D, employee: 'Sara_Cash', receivedAmount: '600' } });
  session(DB, { batchId: 'done', ts, rows: [{ orderId: '7', orderName: '#7', cc: 80 }] });
  await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'done', date: D, employee: 'Sara_Cash', receivedAmount: '80' } });
  const before = DB.raw.prepare('SELECT COUNT(*) n FROM treasury_ledger').get().n;

  const post = (body) => call(env, 'settle_historical', { method: 'POST', body: { date: D, ...body } });
  assert.equal((await post({ employee: 'Sara_Cash', pin: '1234' })).status, 403);              // مش أحمد
  assert.equal((await post({ employee: 'Ahmed_Ibraheem', pin: '0000' })).status, 403);         // PIN غلط
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
  assert.equal((await call(env, 'settle_historical', { method: 'POST', body: { date: today, employee: 'Ahmed_Ibraheem', pin: '9999' } })).status, 400);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM logs WHERE tool='treasury_ledger' AND type='historical_settle_rejected'").get().n, 3);

  const pv = (await post({ employee: 'Ahmed_Ibraheem', pin: '9999', dryRun: true })).body;
  assert.equal(pv.status, 'preview');
  assert.deepEqual(pv.eligible.map(x => x.batchId).sort(), ['ok1', 'ok2']);
  assert.equal(pv.expected, '1050.00');                           // (1000 − 200 − 50) + 300
  assert.equal(pv.entries, 4);
  assert.deepEqual(Object.fromEntries(pv.skipped.map(x => [x.batchId, x.reason])), { inc: 'incomplete', blk: 'blocked', dif: 'diff' });
  assert.equal(pv.alreadyConfirmed, 1);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM treasury_ledger').get().n, before);   // المعاينة ما كتبتش

  const ex = (await post({ employee: 'Ahmed_Ibraheem', pin: '9999' })).body;
  assert.equal(ex.status, 'success'); assert.equal(ex.sessions, 2);
  assert.deepEqual(ex.orderIds.sort(), ['1', '2', '3']);
  const c = DB.raw.prepare("SELECT * FROM treasury_confirmations WHERE batch_id='ok1'").get();
  assert.equal(c.session_flags, 'historical'); assert.equal(c.treasury_employee, 'Ahmed_Ibraheem');
  assert.equal(c.received_piastres, c.expected_piastres);
  const notes = DB.raw.prepare("SELECT note, source FROM treasury_ledger WHERE source_batch_id='ok1' ORDER BY id").all();
  assert.deepEqual(notes.map(n => n.note), ['تسوية تاريخية', 'تسوية تاريخية · استرداد', 'تسوية تاريخية · Extra Shipping']);
  assert.equal(notes[2].source, 'cod_extra_shipping');            // المصدر ما اتغيّرش → المقارنة بتستثني الشحن الإضافي زي العادي
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM logs WHERE tool='treasury_ledger' AND type='historical_settled'").get().n, 1);

  // تاني مرة: مفيش حاجة · والتأكيد العادي على جلسة اتسوّت = already · والمستثنى لسه معلّق
  assert.equal((await post({ employee: 'Ahmed_Ibraheem', pin: '9999' })).body.status, 'nothing');
  assert.equal((await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'ok2', date: D, employee: 'Sara_Cash', receivedAmount: '300' } })).body.status, 'already');
  const day = (await call(env, 'get_day', { params: { date: D } })).body;
  assert.equal(day.sessions.find(x => x.batchId === 'ok1').confirmation.flags, 'historical');
  assert.deepEqual(day.sessions.filter(x => x.status !== 'confirmed').map(x => x.batchId).sort(), ['blk', 'dif', 'inc']);
  const bad = DB.raw.prepare("SELECT COUNT(*) n FROM logs WHERE tool='treasury_ledger' AND extra LIKE '%_unregistered%'").get().n;
  assert.equal(bad, 0);
});

test('الشحنة المعلّقة (#63567): تحصيل معلّق + استرداد متسجّل = AWAITING_LEG (مش SHORT)، وبعد التسوية = MATCH', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockShopify([shopNode('63', '#63567', '75.00', '0.00', ['75.00'])]);   // متوقع شوبيفاي 0
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    session(DB, { batchId: 'pay', ts: '2026-11-03T11:35:00.000Z', courier: 'Magdy', rows: [{ orderId: '63', orderName: '#63567', cc: 2600 }] });
    session(DB, { batchId: 'ref', ts: '2026-11-04T11:24:00.000Z', courier: 'Magdy', rows: [{ orderId: '63', orderName: '#63567', cc: -2600, type: 'refund' }] });
    await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'ref', date: '2026-11-04', employee: 'Sara_Cash', receivedAmount: '-2600' } });

    const o = (await call(env, 'get_order', { params: { orderName: '63567' } })).body;
    assert.equal(o.total, '-2600.00');
    assert.equal(o.shopify.status, 'AWAITING_LEG');
    assert.equal(o.shopify.diff, '-2600.00');
    assert.equal(o.shopify.projectedDiff, '0.00'); assert.equal(o.shopify.willMatch, true);
    assert.deepEqual(o.shopify.pending, { amount: '+2600.00', count: 1, days: ['2026-11-03'] });
    const cmp = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['63'] } })).body.results[0];
    assert.equal(cmp.status, 'AWAITING_LEG'); assert.equal(cmp.willMatch, true);

    // جلسة 03-11 المعلّقة: علامة إن الأوردر عليه حركة متسجّلة في جلسة تانية
    const d3 = (await call(env, 'get_day', { params: { date: '2026-11-03' } })).body;
    assert.equal(d3.sessions[0].rows[0].elsewhere, '-2600.00');

    await call(env, 'settle_historical', { method: 'POST', body: { date: '2026-11-03', employee: 'Ahmed_Ibraheem', pin: '9999' } });
    const o2 = (await call(env, 'get_order', { params: { orderName: '63567' } })).body;
    assert.equal(o2.total, '0.00'); assert.equal(o2.shopify.status, 'MATCH'); assert.equal(o2.shopify.pending, null);
  } finally { globalThis.fetch = realFetch; }
});

// ─── v1.3.0 — التسوية المالية: المتحصَّل من العميل ↔ الداخل الخزنة ← الخسارة ───
const txn = (kind, gateway, amount, status = 'SUCCESS', processedAt = null) => ({ kind, status, gateway, processedAt, amountSet: { shopMoney: { amount } } });
const retNode = (fee, createdAt = '2026-08-02T15:11:09Z', status = 'CLOSED') => ({ status, createdAt, returnShippingFees: [{ amountSet: { shopMoney: { amount: fee } } }] });
const settleNode = (id, name, { net, total = net, ship = '0.00', curShip, outstanding = '0.0', tx, fin = 'PAID', returns = [], cancelledAt = null }) => ({ id: `gid://shopify/Order/${id}`, legacyResourceId: id, name,
  displayFinancialStatus: fin, cancelledAt,
  netPaymentSet: { shopMoney: { amount: net } }, currentTotalPriceSet: { shopMoney: { amount: total } }, totalShippingPriceSet: { shopMoney: { amount: ship } },
  ...(curShip !== undefined ? { currentShippingPriceSet: { shopMoney: { amount: curShip } } } : {}),
  totalOutstandingSet: { shopMoney: { amount: outstanding } }, transactions: tx,
  returns: { pageInfo: { hasNextPage: false }, nodes: returns } });
const insL = (DB, o, n, kind, amt, src, note = null) => DB.raw.prepare(`INSERT INTO treasury_ledger (created_at, order_id, order_name, kind, amount_piastres, note, source, treasury_employee, idempotency_key) VALUES ('2026-11-10T10:00:00Z', ?, ?, ?, ?, ?, ?, 'X', ?)`).run(o, n, kind, amt, note, src, `s${o}${src}${amt}${Math.random()}`);

test('التسوية: #49395 (بوسطة · شحنتين) — 6200 − شحن 75 − شحن استبدال 75 − 5844.60 = خسارة 205.40 مقسّمة على الشحنتين', async () => {
  const realFetch = globalThis.fetch;
  // بيانات Shopify الحية (10-11-2026): الـ SALE المعلّقة الأولى مش بتتحسب، والتانية manual بعد الاستبدال
  globalThis.fetch = mockShopify([settleNode('49395', '#49395', { net: '6200.00', ship: '75.00', curShip: '75.00', returns: [retNode('75.0')],
    tx: [txn('SALE', 'Cash on Delivery (COD)', '4975.00', 'PENDING', '2026-08-01T12:21:08Z'), txn('SALE', 'manual', '1225.00', 'SUCCESS', '2026-11-10T13:14:36Z'),
         txn('SALE', 'Cash on Delivery (COD)', '4975.00', 'SUCCESS', '2026-08-02T15:10:21Z')] })]);
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    insL(DB, '49395', '#49395', 'CASH_IN', 105286, 'bosta_cash_cycle', 'بوسطة — صافي بعد الرسوم');
    insL(DB, '49395', '#49395', 'CASH_IN', 479174, 'bosta_cash_cycle', 'بوسطة — صافي بعد الرسوم');
    const r = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['49395'] } })).body.results[0];
    assert.equal(r.status, 'BOSTA_FEES');
    const st = r.settlement;
    assert.equal(st.customer.cashReceived, '6200.00'); assert.equal(st.customer.settled, true); assert.equal(st.customer.nonCash, '0.00');
    assert.equal(st.treasury.net, '5844.60');
    assert.deepEqual(st.loss, { total: '205.40', extraShipping: '0.00', other: '205.40', otherKind: 'BOSTA_FEES', bostaFees: '355.40' });
    assert.deepEqual(st.deducted, { total: '150.00', shipping: '75.00', returnFees: '75.00', returnFeesUnpaid: '0.00' });   // v1.4.0: شحن العميل بيغطّي جزء من رسوم بوسطة
    assert.equal(st.state, 'FINAL'); assert.equal(st.over, false); assert.equal(st.overKind, null);
    // الحركات هنا من غير source_log_id ← مفيش تقسيم (v1.4.3: اتشال التقدير بالمبلغ) والأرقام الإجمالية سليمة
    assert.equal(st.shipments, null); assert.equal(st.shippingApprox, null);
  } finally { globalThis.fetch = realFetch; }
});

// ─── v1.4.2 — تقسيم الشحنات من سجلات التحصيل (source_log_id) مش من المطابقة بالمبلغ ───
const bostaLeg = (DB, { order, name, slot, type = 'EXCHANGE', gross, fees, flex = '0.00', net, tracking, paidAt, cashOut, ts, ledgerTs = '2026-11-10T13:20:00Z' }) => {
  const logId = DB.raw.prepare(`INSERT INTO logs (timestamp, tool, type, employee, order_id, order_name, extra) VALUES (?, 'cod_payment', 'payment', 'Ahmed_Ibraheem', ?, ?, ?)`)
    .run(ts, order, name, JSON.stringify({ result: 'success', batchId: 'bosta-' + cashOut, courier: 'Bosta', courierCollect: parseFloat(net), source: 'bosta_cash_cycle', cashOutId: cashOut, paidAt,
      trackingNumber: tracking, bostaOrderType: type, slot, grossCollected: gross, bostaFees: fees, flexShipAmount: flex, netValue: net, returnShipping: null })).lastInsertRowid;
  DB.raw.prepare(`INSERT INTO treasury_ledger (created_at, order_id, order_name, kind, amount_piastres, note, source, source_log_id, source_batch_id, treasury_employee, idempotency_key) VALUES (?, ?, ?, ?, ?, 'بوسطة — صافي بعد الرسوم', 'bosta_cash_cycle', ?, ?, 'X', ?)`)
    .run(ledgerTs, order, name, parseFloat(net) < 0 ? 'CASH_OUT' : 'CASH_IN', Math.round(parseFloat(net) * 100), logId, 'bosta-' + cashOut, `log:${logId}`);
  return logId;
};

test('تقسيم الشحنات v1.4.2: #49395 من سجلات التحصيل (source_log_id) — حتى لو ترتيب الدفتر معكوس', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockShopify([settleNode('49395', '#49395', { net: '6200.00', ship: '75.00', curShip: '75.00', returns: [retNode('75.0')],
    tx: [txn('SALE', 'Cash on Delivery (COD)', '4975.00', 'SUCCESS', '2026-08-02T15:10:21Z'), txn('SALE', 'manual', '1225.00', 'SUCCESS', '2026-11-10T13:14:36Z')] })]);
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    // نفس ترتيب الإدخال الحقيقي: S2 اتسجّلت الأول (دفتر 1538) وS1 بعدها (دفتر 1539)
    const l2 = bostaLeg(DB, { order: '49395', name: '#49395', slot: 'S2', gross: '1225.00', fees: '172.14', net: '1052.86', tracking: '8145633046', paidAt: '2026-08-12', cashOut: 'WEDCOD12AUG26', ts: '2026-11-10T13:14:37.099Z' });
    const l1 = bostaLeg(DB, { order: '49395', name: '#49395', slot: 'S1', type: 'SEND', gross: '4975.00', fees: '183.26', net: '4791.74', tracking: '6579132603', paidAt: '2026-08-05', cashOut: 'WEDCOD05AUG26', ts: '2026-11-10T13:13:43.909Z' });
    for (const body of [{ action: 'compare_orders', b: { orderIds: ['49395'] } }]) {
      const st = (await call(env, body.action, { method: 'POST', body: body.b })).body.results[0].settlement;
      assert.equal(st.shippingApprox, false);
      assert.deepEqual(st.shipments, [
        { gross: '4975.00', ledger: '4791.74', fee: '183.26', shipping: '75.00', loss: '108.26', slot: 'S1', tracking: '6579132603', paidAt: '2026-08-05', cashOutId: 'WEDCOD05AUG26', logId: l1 },
        { gross: '1225.00', ledger: '1052.86', fee: '172.14', shipping: '75.00', loss: '97.14', slot: 'S2', tracking: '8145633046', paidAt: '2026-08-12', cashOutId: 'WEDCOD12AUG26', logId: l2 }]);
    }
    const o = (await call(env, 'get_order', { params: { orderName: '49395' } })).body.shopify.settlement;     // نفس النتيجة من get_order
    assert.equal(o.shipments[0].tracking, '6579132603');
  } finally { globalThis.fetch = realFetch; }
});

test('تقسيم الشحنات v1.4.2: أكتر من استبدال — الشحنتين بالتتبع والتاريخ، وشحن العميل تقريبي (أكتر من مرتجع)، وبدون ما نعتمد على Shopify transactions', async () => {
  const realFetch = globalThis.fetch;
  // S1 + استبدالين S2: المرتجعين رسومهم مختلفة (60 · 90) — Shopify مابيربطهم برقم تتبع
  globalThis.fetch = mockShopify([settleNode('9', '#9', { net: '3000.00', ship: '80.00', curShip: '80.00', returns: [retNode('60.0', '2026-08-02T10:00:00Z'), retNode('90.0', '2026-08-09T10:00:00Z')],
    tx: [txn('SALE', 'Cash on Delivery (COD)', '3000.00')] })]);
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    bostaLeg(DB, { order: '9', name: '#9', slot: 'S2', gross: '500.00', fees: '150.00', net: '350.00', tracking: 'T3', paidAt: '2026-08-20', cashOut: 'C3', ts: '2026-11-10T10:03:00Z' });
    bostaLeg(DB, { order: '9', name: '#9', slot: 'S1', type: 'SEND', gross: '2000.00', fees: '140.00', net: '1860.00', tracking: 'T1', paidAt: '2026-08-05', cashOut: 'C1', ts: '2026-11-10T10:01:00Z' });
    bostaLeg(DB, { order: '9', name: '#9', slot: 'S2', gross: '500.00', fees: '160.00', net: '340.00', tracking: 'T2', paidAt: '2026-08-12', cashOut: 'C2', ts: '2026-11-10T10:02:00Z' });
    const st = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['9'] } })).body.results[0].settlement;
    assert.equal(st.shippingApprox, true);
    assert.deepEqual(st.shipments.map(x => [x.tracking, x.slot, x.fee, x.shipping, x.loss]),
      [['T1', 'S1', '140.00', '80.00', '60.00'], ['T2', 'S2', '160.00', '60.00', '100.00'], ['T3', 'S2', '150.00', '90.00', '60.00']]);
  } finally { globalThis.fetch = realFetch; }
});

test('تقسيم الشحنات v1.4.2: عدد الشحنتين مختلف عن الشحن/المرتجعات — الأرقام الأساسية من السجل وشحن العميل null، وREVERSAL = مفيش تقسيم', async () => {
  const realFetch = globalThis.fetch;
  try {
    // شحنة واحدة بس في الدفتر لكن على Shopify مرتجع — شحن العميل ما يتوزّعش
    globalThis.fetch = mockShopify([settleNode('10', '#10', { net: '1000.00', ship: '70.00', curShip: '70.00', returns: [retNode('70.0')], tx: [txn('SALE', 'Cash on Delivery (COD)', '1000.00')] })]);
    let { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    bostaLeg(DB, { order: '10', name: '#10', slot: 'S1', type: 'SEND', gross: '1000.00', fees: '120.00', net: '880.00', tracking: 'T1', paidAt: '2026-08-05', cashOut: 'C1', ts: '2026-11-10T10:01:00Z' });
    let st = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['10'] } })).body.results[0].settlement;
    assert.equal(st.shipments.length, 1);
    assert.deepEqual([st.shipments[0].gross, st.shipments[0].fee, st.shipments[0].shipping, st.shipments[0].loss], ['1000.00', '120.00', null, null]);
    // تصحيح REVERSAL على الأوردر = السجل مش مصدر موثوق ← مفيش تقسيم (مش بنخمّن من سجلات اتصحّحت)
    DB.raw.prepare(`INSERT INTO treasury_ledger (created_at, order_id, order_name, kind, amount_piastres, source, treasury_employee, reverses_id, idempotency_key) VALUES ('2026-11-10T11:00:00Z','10','#10','REVERSAL',-88000,'bosta_cash_cycle','X',1,'rev:1')`).run();
    st = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['10'] } })).body.results[0].settlement;
    assert.equal(st.shipments, null);
  } finally { globalThis.fetch = realFetch; }
});

test('التسوية: أوردر مندوب — الشحن العادي «مخصوم» خارج الخسارة، والشحن الإضافي هو الخسارة', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockShopify([settleNode('1', '#1', { net: '2875.00', ship: '75.00', tx: [txn('SALE', 'Cash on Delivery (COD)', '2875.00')] })]);
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    insL(DB, '1', '#1', 'CASH_IN', 280000, 'cod_payment');
    insL(DB, '1', '#1', 'CASH_OUT', -5000, 'cod_extra_shipping', 'Extra Shipping');
    const r = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['1'] } })).body.results[0];
    assert.equal(r.status, 'MATCH');                       // الحكم القديم ما اتغيّرش (من غير الشحن الإضافي)
    assert.deepEqual(r.settlement.loss, { total: '50.00', extraShipping: '50.00', other: '0.00', otherKind: 'UNEXPLAINED', bostaFees: null });
    assert.equal(r.settlement.deducted.total, '75.00'); assert.equal(r.settlement.treasury.net, '2750.00');
    assert.equal(r.settlement.state, 'FINAL'); assert.equal(r.settlement.shipments, null);
  } finally { globalThis.fetch = realFetch; }
});

test('التسوية: دفع غير نقدي (بوابة تانية) مش بيتحسب خسارة، والعميل اللي لسه عليه متبقي = مؤقتة', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockShopify([
    settleNode('1', '#1', { net: '1500.00', tx: [txn('SALE', 'Cash on Delivery (COD)', '1000.00'), txn('SALE', 'paymob', '500.00'), txn('SALE', 'manual', '99.00', 'FAILURE')] }),
    settleNode('2', '#2', { net: '300.00', total: '500.00', outstanding: '200.00', fin: 'PARTIALLY_PAID', tx: [txn('SALE', 'manual', '300.00')] }),
  ]);
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    insL(DB, '1', '#1', 'CASH_IN', 100000, 'cod_payment');
    insL(DB, '2', '#2', 'CASH_IN', 30000, 'cod_payment');
    const r = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['1', '2'] } })).body.results;
    assert.equal(r[0].settlement.customer.cashReceived, '1000.00'); assert.equal(r[0].settlement.customer.nonCash, '500.00');
    assert.equal(r[0].settlement.loss.total, '0.00');
    assert.equal(r[1].settlement.state, 'PROVISIONAL'); assert.equal(r[1].settlement.customer.settled, false);
    assert.ok(r[1].settlement.reasons.some(x => x.includes('لسه عليه تحصيل')));
  } finally { globalThis.fetch = realFetch; }
});

test('التسوية: الداخل أكتر من المتحصَّل = تنبيه OVER_COLLECTED مرة واحدة، وبيتقفل لما الفرق يتصحّح', async () => {
  const realFetch = globalThis.fetch;
  const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
  insL(DB, '7', '#7', 'CASH_IN', 50000, 'cod_payment');
  try {
    globalThis.fetch = mockShopify([settleNode('7', '#7', { net: '400.00', tx: [txn('SALE', 'manual', '400.00')] })]);
    const a = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['7'] } })).body.results[0];
    assert.equal(a.settlement.over, true); assert.equal(a.settlement.loss.total, '-100.00');
    await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['7'] } });          // فحص تاني ما يكرّرش
    assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM logs WHERE type='settlement_over'").get().n, 1);
    let al = (await call(env, 'get_alerts')).body.alerts.filter(x => x.type === 'OVER_COLLECTED');
    assert.equal(al.length, 1); assert.equal(al[0].orderName, '#7');
    globalThis.fetch = mockShopify([settleNode('7', '#7', { net: '500.00', tx: [txn('SALE', 'manual', '500.00')] })]);
    await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['7'] } });
    al = (await call(env, 'get_alerts')).body.alerts.filter(x => x.type === 'OVER_COLLECTED');
    assert.equal(al.length, 0);
    assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM logs WHERE type='settlement_cleared'").get().n, 1);
    assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM log_value_alerts').get().n, 0);
  } finally { globalThis.fetch = realFetch; }
});

// ─── v1.4.0 — خصم شحن العميل من رسوم بوسطة: السيناريوهات المقاسة على بيانات حية (10-11-2026) ───
test('التسوية v1.4.0: بوسطة RTO ملغي — الشحن اترد (current=0) فالخسارة = رسوم بوسطة كاملة، ومفيش تنبيه كاذب', async () => {
  const realFetch = globalThis.fetch;
  // #49682: totalShipping=100 · currentShipping=0 · العميل ما دفعش حاجة · صف بوسطة «بدون تحصيل» −48.77
  globalThis.fetch = mockShopify([settleNode('5', '#5', { net: '0.0', total: '0.0', ship: '100.0', curShip: '0.0', fin: 'VOIDED', cancelledAt: '2026-08-30T05:42:05Z',
    tx: [txn('SALE', 'Cash on Delivery (COD)', '1350.0', 'PENDING'), txn('VOID', 'Cash on Delivery (COD)', '0.0')] })]);
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    insL(DB, '5', '#5', 'CASH_OUT', -4877, 'bosta_cash_cycle', 'بوسطة — صافي بعد الرسوم');
    const r = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['5'] } })).body.results[0];
    assert.equal(r.status, 'BOSTA_FEES');
    assert.equal(r.settlement.deducted.total, '0.00');
    assert.equal(r.settlement.loss.total, '48.77'); assert.equal(r.settlement.over, false);
    assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM logs WHERE type='settlement_over'").get().n, 0);
  } finally { globalThis.fetch = realFetch; }
});

test('التسوية v1.4.0: رسوم مرتجع لسه على العميل ما بتتخصمش، والخسارة مؤقتة من غير تنبيه', async () => {
  const realFetch = globalThis.fetch;
  // #49403: netPayment 1099 (فيه شحن 100) · رسوم مرتجع 100 لسه على العميل (outstanding 100)
  globalThis.fetch = mockShopify([settleNode('6', '#6', { net: '1099.0', total: '1199.0', ship: '100.0', curShip: '100.0', outstanding: '100.0', fin: 'PARTIALLY_PAID',
    returns: [retNode('100.0')], tx: [txn('SALE', 'Cash on Delivery (COD)', '1099.0')] })]);
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    bostaLeg(DB, { order: '6', name: '#6', slot: 'S1', type: 'SEND', gross: '1099.00', fees: '143.64', net: '955.36', tracking: 'T6', paidAt: '2026-08-05', cashOut: 'C6', ts: '2026-11-10T10:00:00Z' });
    const st = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['6'] } })).body.results[0].settlement;
    assert.deepEqual(st.deducted, { total: '100.00', shipping: '100.00', returnFees: '0.00', returnFeesUnpaid: '100.00' });
    assert.equal(st.loss.total, '43.64'); assert.equal(st.state, 'PROVISIONAL'); assert.equal(st.over, false);
    assert.ok(st.reasons.some(x => x.includes('رسوم المرتجع لسه على العميل')));
    assert.equal(st.shipments[0].shipping, null);              // الرسوم المعلّقة بتلغي توزيع الشحن على الشحنة
  } finally { globalThis.fetch = realFetch; }
});

test('التسوية v1.4.0: رسوم بوسطة أقل من شحن العميل (مستحيل — قرار أحمد) = تنبيه BOSTA_FEES_BELOW_SHIPPING', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockShopify([settleNode('8', '#8', { net: '1000.00', ship: '100.00', curShip: '100.00', tx: [txn('SALE', 'Cash on Delivery (COD)', '1000.00')] })]);
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    insL(DB, '8', '#8', 'CASH_IN', 94000, 'bosta_cash_cycle', 'بوسطة — صافي بعد الرسوم');      // رسوم 60 < شحن 100
    const r = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['8'] } })).body.results[0];
    assert.equal(r.status, 'OVER');
    assert.equal(r.settlement.loss.bostaFees, '60.00'); assert.equal(r.settlement.loss.total, '-40.00');
    assert.equal(r.settlement.over, true); assert.equal(r.settlement.overKind, 'BOSTA_FEES_BELOW_SHIPPING');
    const al = (await call(env, 'get_alerts')).body.alerts.filter(x => x.type === 'OVER_COLLECTED');
    assert.equal(al.length, 1); assert.ok(al[0].detail.includes('رسوم بوسطة (60.00) أقل من الشحن اللي دفعه العميل (100.00)'));
  } finally { globalThis.fetch = realFetch; }
});

test('التسوية v1.4.0: مرتجع ملغي (CANCELED) رسومه ما بتتخصمش، والمندوب على نفس المعادلة', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockShopify([settleNode('9', '#9', { net: '2875.00', ship: '75.00', curShip: '75.00',
    returns: [retNode('75.0', '2026-08-03T00:00:00Z', 'CANCELED')], tx: [txn('SALE', 'Cash on Delivery (COD)', '2875.00')] })]);
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    insL(DB, '9', '#9', 'CASH_IN', 280000, 'cod_payment');
    const r = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['9'] } })).body.results[0];
    assert.equal(r.status, 'MATCH'); assert.equal(r.parts.returnFees, '0.00');
    assert.equal(r.settlement.deducted.total, '75.00'); assert.equal(r.settlement.loss.total, '0.00');
  } finally { globalThis.fetch = realFetch; }
});

test('get_order v1.4.3: sources فيها تفاصيل شحنة بوسطة (حتى الصف اللي لسه مش في الدفتر)، والمندوب من غيرها', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockShopify([settleNode('11', '#11', { net: '1500.00', ship: '70.00', curShip: '70.00', tx: [txn('SALE', 'Cash on Delivery (COD)', '1500.00')] })]);
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    const l1 = bostaLeg(DB, { order: '11', name: '#11', slot: 'S1', type: 'SEND', gross: '1000.00', fees: '120.00', net: '880.00', tracking: 'T1', paidAt: '2026-08-05', cashOut: 'C1', ts: '2026-11-10T10:01:00Z' });
    // شحنة تانية صف تحصيل بس (لسه ما اتسجّلتش في الدفتر) — noCollection: gross 0 · رسوم 145.35 · flex 100
    DB.raw.prepare(`INSERT INTO logs (timestamp, tool, type, employee, order_id, order_name, extra) VALUES ('2026-11-10T10:02:00Z','cod_payment','payment','Ahmed_Ibraheem','11','#11',?)`)
      .run(JSON.stringify({ result: 'success', batchId: 'bosta-C2', courier: 'Bosta', courierCollect: -45.35, source: 'bosta_cash_cycle', cashOutId: 'C2', paidAt: '2026-08-12', trackingNumber: 'T2', slot: 'S2',
        grossCollected: '0.00', bostaFees: '145.35', flexShipAmount: '100.00', netValue: '-45.35' }));
    const d = (await call(env, 'get_order', { params: { orderName: '11' } })).body;
    const [a, b] = d.sources;
    assert.deepEqual([a.bosta, a.gross, a.fee, a.tracking, a.slot, a.paidAt, a.cashOutId, a.inLedger], [true, '1000.00', '120.00', 'T1', 'S1', '2026-08-05', 'C1', true]);
    assert.deepEqual([b.bosta, b.gross, b.fee, b.tracking, b.slot, b.inLedger], [true, '0.00', '45.35', 'T2', 'S2', false]);   // fee = gross − net (بعد الـ Flex)
    assert.equal(a.logId, l1); assert.equal(d.shopify.settlement.shipments[0].logId, l1);                                   // الربط بين sources وshipments بالـ logId
    // صف مندوب عادي: من غير حقول بوسطة
    seed(DB, { ts: '2026-11-10T09:00:00.000Z', orderId: '12', orderName: '#12', extra: { result: 'success', batchId: 'b1', courier: 'Saif', courierCollect: 100, extraShipping: [], extraShippingTotal: '0.00', batchExpected: { orders: 1, payOrders: 1, refundOrders: 0, collect: '100.00', net: '100.00' } } });
    const c = (await call(env, 'get_order', { params: { orderName: '12' } })).body.sources[0];
    assert.equal(c.bosta, undefined); assert.equal(c.gross, undefined);
  } finally { globalThis.fetch = realFetch; }
});

test('v1.5.0: صف اتضاف لجلسة متأكدة = «لم يتم التسجيل» (مش «تم»)، وتأكيده يكتب سطوره بس على نفس صف التأكيد', async () => {
  const { DB, env } = setup();
  const D1 = '2026-11-10', D2 = '2026-11-13';
  // جلسة ملف بوسطة: 3 صفوف من 5 اتكتبوا واتأكدت (ناقصة)
  session(DB, { batchId: 'bosta-X', ts: '2026-11-10T09:00:00.000Z', courier: 'Bosta', orders: 5, collect: 500, net: 500, rows: [
    { orderId: '1', orderName: '#1', cc: 100 }, { orderId: '2', orderName: '#2', cc: 100 }, { orderId: '3', orderName: '#3', cc: 100 } ] });
  assert.equal((await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'bosta-X', date: D1, employee: 'Sara_Cash', receivedAmount: '300' } })).body.ok, true);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM treasury_ledger').get().n, 3);
  // بعد التأكيد بيومين: صفين اتسجّلوا في نفس الجلسة (واحد سالب)
  for (const [oid, cc, type] of [['4', -49.34, 'payment'], ['5', -1285.01, 'refund']]) {
    seed(DB, { ts: '2026-11-13T15:33:00.000Z', type, orderId: oid, orderName: '#' + oid, extra: { result: 'success', batchId: 'bosta-X', courier: 'Bosta', courierCollect: cc,
      extraShipping: [], extraShippingTotal: '0.00', batchExpected: { orders: 5, payOrders: 4, refundOrders: 1, collect: '500.00', net: '500.00' } } });
  }
  // اليوم الأصلي: لسه متأكد ومفيش فيه صفوف متأخرة
  const day1 = (await call(env, 'get_day', { params: { date: D1 } })).body;
  assert.equal(day1.sessions[0].status, 'confirmed'); assert.equal(day1.sessions[0].lateRows, null);
  // يوم الصفين: معلّقة (مش confirmed) والمتوقع = الصفين بس، وفيها علامة lateRows
  const day2 = (await call(env, 'get_day', { params: { date: D2 } })).body;
  const v = day2.sessions.find(x => x.batchId === 'bosta-X');
  assert.equal(v.status, 'pending'); assert.equal(v.expected, '-1334.35'); assert.equal(v.rows.length, 2);
  assert.equal(v.lateRows.count, 2); assert.equal(v.lateRows.confirmedBy, 'Sara_Cash');
  assert.equal(day2.tally.confirmed, 0); assert.equal(day2.tally.pending, 1);
  // كل الأيام المعلّقة بتشوفها كمان (تحت يوم الصفين)
  const pend = (await call(env, 'get_pending')).body;
  assert.equal(pend.count, 1); assert.equal(pend.days[0].day, D2); assert.equal(pend.days[0].expectedTotal, '-1334.35');
  // مبلغ غلط = رفض (D17) ومفيش كتابة
  const bad = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'bosta-X', date: D2, employee: 'Sara_Cash', receivedAmount: '-1000' } });
  assert.equal(bad.body.status, 'rejected');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM treasury_ledger').get().n, 3);
  // مبلغ صح: سطرين جداد على نفس صف التأكيد، ومفيش تأكيد جديد
  const ok = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'bosta-X', date: D2, employee: 'Sara_Cash', receivedAmount: '-1334.35' } });
  assert.equal(ok.body.ok, true); assert.equal(ok.body.summary.entries, 2);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM treasury_confirmations').get().n, 1);
  const rows = DB.raw.prepare("SELECT * FROM treasury_ledger WHERE order_name IN ('#4','#5') ORDER BY id").all();
  assert.equal(rows.length, 2); assert.ok(rows.every(r => r.confirmation_id === 1 && r.source_batch_id === 'bosta-X' && r.kind === 'CASH_OUT'));
  assert.equal(rows.reduce((t, r) => t + r.amount_piastres, 0), -133435);
  // بعد كده: متأكدة، ومرة تانية = already من غير كتابة
  assert.equal((await call(env, 'get_day', { params: { date: D2 } })).body.sessions[0].status, 'confirmed');
  assert.equal((await call(env, 'get_pending')).body.count, 0);
  const again = await call(env, 'confirm_session', { method: 'POST', body: { batchId: 'bosta-X', date: D2, employee: 'Sara_Cash', receivedAmount: '-1334.35' } });
  assert.equal(again.body.status, 'already');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM treasury_ledger').get().n, 5);
});
