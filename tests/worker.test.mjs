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

// ─── v1.2.0 — التسوية التاريخية + الرجل المعلّقة ───
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

test('الرجل المعلّقة (#63567): تحصيل معلّق + استرداد متسجّل = AWAITING_LEG (مش SHORT)، وبعد التسوية = MATCH', async () => {
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
const txn = (kind, gateway, amount, status = 'SUCCESS') => ({ kind, status, gateway, amountSet: { shopMoney: { amount } } });
const settleNode = (id, name, { net, total = net, ship = '0.00', outstanding = '0.0', tx, fin = 'PAID' }) => ({ id: `gid://shopify/Order/${id}`, legacyResourceId: id, name,
  displayFinancialStatus: fin, cancelledAt: null,
  netPaymentSet: { shopMoney: { amount: net } }, currentTotalPriceSet: { shopMoney: { amount: total } }, totalShippingPriceSet: { shopMoney: { amount: ship } },
  totalOutstandingSet: { shopMoney: { amount: outstanding } }, transactions: tx,
  returns: { pageInfo: { hasNextPage: false }, nodes: [] } });
const insL = (DB, o, n, kind, amt, src, note = null) => DB.raw.prepare(`INSERT INTO treasury_ledger (created_at, order_id, order_name, kind, amount_piastres, note, source, treasury_employee, idempotency_key) VALUES ('2026-11-10T10:00:00Z', ?, ?, ?, ?, ?, ?, 'X', ?)`).run(o, n, kind, amt, note, src, `s${o}${src}${amt}${Math.random()}`);

test('التسوية: #49395 (بوسطة · رجلين) — العميل مقفول 6200، الداخل 5844.60، الخسارة 355.40 مقسّمة تقريبيًا', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockShopify([settleNode('49395', '#49395', { net: '6200.00', ship: '75.00',
    tx: [txn('SALE', 'Cash on Delivery (COD)', '4975.00'), txn('SALE', 'manual', '1225.00')] })]);
  try {
    const { DB, env } = setup({ SHOP_DOMAIN: 's', CLIENT_ID: 'a', CLIENT_SECRET: 'b' });
    insL(DB, '49395', '#49395', 'CASH_IN', 105286, 'bosta_cash_cycle', 'بوسطة — صافي بعد الرسوم');
    insL(DB, '49395', '#49395', 'CASH_IN', 479174, 'bosta_cash_cycle', 'بوسطة — صافي بعد الرسوم');
    const r = (await call(env, 'compare_orders', { method: 'POST', body: { orderIds: ['49395'] } })).body.results[0];
    assert.equal(r.status, 'BOSTA_FEES');
    const st = r.settlement;
    assert.equal(st.customer.cashReceived, '6200.00'); assert.equal(st.customer.settled, true); assert.equal(st.customer.nonCash, '0.00');
    assert.equal(st.treasury.net, '5844.60');
    assert.deepEqual(st.loss, { total: '355.40', extraShipping: '0.00', other: '355.40', otherKind: 'BOSTA_FEES' });
    assert.equal(st.deducted.total, '0.00');             // بوسطة: الشحن مش مخصوم
    assert.equal(st.state, 'FINAL'); assert.equal(st.over, false);
    assert.deepEqual(st.legs, [{ shopify: '4975.00', ledger: '4791.74', fee: '183.26' }, { shopify: '1225.00', ledger: '1052.86', fee: '172.14' }]);
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
    assert.deepEqual(r.settlement.loss, { total: '50.00', extraShipping: '50.00', other: '0.00', otherKind: 'UNEXPLAINED' });
    assert.equal(r.settlement.deducted.total, '75.00'); assert.equal(r.settlement.treasury.net, '2750.00');
    assert.equal(r.settlement.state, 'FINAL'); assert.equal(r.settlement.legs, null);
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
