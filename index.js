// EcomModa — Treasury-Ledger (v1.4.1 — settlement.legs اتسمّت settlement.shipments)
// skills: worker-builder v3.10.0 · constants v4.5.1 · shopify-graphql-helper v2.5.0 — 04-11-2026
//
// دفتر الخزنة: موظف الخزنة يأكد إن فلوس كل جلسة تحصيل (tool='cod_payment') اتوردت فعلاً.
// مصدر الحقيقة = جداول treasury_ledger / treasury_confirmations في D1 (append-only).
// الأوردر على Shopify فيه مرآة للعرض بس (custom.treasury_log / custom.treasury_total).
// المواصفات الكاملة → CLAUDE.md وdocs/spec.md.

// ══════════════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════════════
const TOOL_NAME      = 'treasury_ledger';
const WORKER_VERSION = '1.4.1';

const BOSTA_SRC = 'bosta_cash_cycle';  // extra.source لصفوف تحصيل بوسطة (COD-Payment-Center v3.11.0)
const SOURCE_TOOL = 'cod_payment';        // tool الصفوف المصدر في logs (ecommoda-constants §7.1)
const MIN_DATE    = '2026-10-01';         // أول يوم مسموح بتوقيت القاهرة (قرار أحمد D19)

const KIND = { IN: 'CASH_IN', OUT: 'CASH_OUT', REV: 'REVERSAL' };
const NOTE_EXTRA_SHIPPING = 'Extra Shipping';   // D15 — بالحرف، الأداة بتعتمد عليه في المقارنة

// 🆕 v1.2.0 — التسوية التاريخية (قرار أحمد 05-11-2026): جلسات قبل التشغيل الفعلي اتوردت بالطريقة القديمة
//    ومستحيل تتعدّ تاني. بتتسجّل في الدفتر **من غير عدّ** بعلامة historical — أحمد بس + PIN، ويوم بيوم.
//    الجلسات المرفوضة/الناقصة/اللي عليها محاولة بفرق **مستثناة** وبتتعالج يدوي (قرار أحمد).
const SETTLE_ADMINS   = new Set(['Ahmed_Ibraheem']);
const NOTE_HISTORICAL = 'تسوية تاريخية';
const FLAG_HISTORICAL = 'historical';

const MF_LOG   = { namespace: 'custom', key: 'treasury_log',   type: 'multi_line_text_field' };
const MF_TOTAL = { namespace: 'custom', key: 'treasury_total', type: 'number_decimal' };

// ─── سلسلة السقوف (worker-builder Step 5A ⑪) — التلاتة مع بعض ───
// ① الواجهة  CHUNK_MIRROR_UI = 40 أوردر للنداء الواحد (وقت: كتابة المرآة ≈ نداء Shopify لكل 12 أوردر)
// ② الـ Worker MAX_ORDER_IDS = 100 — حارس لصق/حجم، مش سقف تشغيلي (Paid: 10k subrequests) — لازم ≥ COMPARE_PER_QUERY
// ③ شوبيفاي   MIRROR_ORDERS_PER_CALL = 12 ← metafieldsSet ≤ 25 ميتافيلد ÷ 2 لكل أوردر (shopify.dev «Metafield limits»)
//             COMPARE_PER_QUERY = 100 ← قرار أحمد 04-11-2026 — ⚠️ **غير مقيس**: لو تكلفة الأوردر × 100 عدّت سقف شوبيفاي (١٠٠٠ نقطة)
//             النداء بيترفض كله برسالة خطأ واضحة (مش بيانات غلط). قيس actualQueryCost (?action=diag) وقلّل الرقم هنا وفي CMP_CHUNK بالواجهة.
const MAX_ORDER_IDS            = 100;
const MIRROR_ORDERS_PER_CALL   = 12;
const COMPARE_PER_QUERY        = 100;
const BIND_CHUNK               = 50;          // D1: حد الـ bind parameters = 100 للاستعلام

// مصدر الحالة: صفوف cod_payment بتتراكم (≈40/يوم) → get_pending بيمسح النافذة من MIN_DATE.
// ⚠️ لو الاستعلام بقى بطيء (آلاف الصفوف) → فهرس/جدول جلسات محلي (worker-builder Step 7-ب).
const ORDER_HISTORY_FROM = '2026-08-01T00:00:00.000Z';   // أول ترحيل صفوف تحصيل (للكشف عن PRE_WINDOW)

// ══════════════════════════════════════════════════════════════
// §CORS — Option B: أداة مالية وكتابة → قايمة origins مقفولة
// ══════════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'https://ecommoda-dev.github.io',
];
function getCORS(request) {
  const origin  = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ══════════════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': '*' });
  return new Response(JSON.stringify(data), { status, headers });
}

// ─── §HELPERS::time — توقيت القاهرة يتحسب مايتكتبش ثابت (ecommoda-constants §13 — بالحرف) ───
const CAIRO_TZ = 'Africa/Cairo';
const _cairoFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAIRO_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function cairoParts(d) {
  const o = {};
  for (const p of _cairoFmt.formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';        // حارس: بعض المحركات بترجّع 24
  return o;
}
function cairoOffsetMinutes(d) {             // ١٨٠ صيفًا · ١٢٠ شتاءً
  const p = cairoParts(d);
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day,
                              +p.hour, +p.minute, +p.second) - d.getTime()) / 60000);
}
function cairoDate() { const p = cairoParts(new Date()); return `${p.year}-${p.month}-${p.day}`; }

// حدود يوم تقويمي بالقاهرة → UTC — الإزاحة تتقاس عند **ظهر** اليوم
function cairoDayBoundsUTC(dateStr) {
  const offMin = cairoOffsetMinutes(new Date(`${dateStr}T12:00:00.000Z`));
  return {
    start: new Date(Date.parse(`${dateStr}T00:00:00.000Z`) - offMin * 60000).toISOString(),
    end:   new Date(Date.parse(`${dateStr}T23:59:59.999Z`) - offMin * 60000).toISOString(),
  };
}
function cairoDayOf(iso) { const p = cairoParts(new Date(iso)); return `${p.year}-${p.month}-${p.day}`; }

// ─── §HELPERS::money — كل المبالغ بالقروش (integer)، التحويل مرة واحدة ───
function toPiastres(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function fmtMoney(p) {                         // 280000 → "2800.00" (بإشارة سالبة لو سالب)
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
function fmtSigned(p) { return (p >= 0 ? '+' : '') + fmtMoney(p); }

function isDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }

function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }
function parseJSONSafe(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// ─── §HELPERS::assertEnv ───
const ENV_REQUIRED = {
  shopify: ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET'],
};
function missingEnv(env, ...groups) {
  const missing = [];
  for (const g of groups) {
    for (const key of (ENV_REQUIRED[g] || [])) {
      if (env[key] === undefined || env[key] === null || String(env[key]).trim() === '') missing.push(key);
    }
  }
  if (!env.DB) missing.push('DB (D1 binding)');
  return missing;
}
function assertEnv(env, ...groups) {
  const missing = missingEnv(env, ...groups);
  if (missing.length) {
    throw new Error(
      `متغيرات ناقصة في الـ Worker: ${missing.join('، ')} — ضِفها من ` +
      `Dashboard → Settings → Variables ثم Promote النسخة. (شغّل ?action=diag)`
    );
  }
}

// ─── §CONSTANTS::authApps — قايمة بيضاء مقفولة (الأداة مستقلة: واجهة واحدة) ───
const AUTH_APPS = new Set([TOOL_NAME]);
function resolveAuthTool(appId) { return AUTH_APPS.has(appId) ? appId : TOOL_NAME; }

// ══════════════════════════════════════════════════════════════
// §SHARED — copy verbatim from references/shared-functions.md — الاستثناء الوحيد: حارس الطبقة ٥ جوّه writeLog
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// §LOG-REG — الحارس الديناميكي لقيم اللوج (الطبقة ٥ · worker-builder Step 7-ج)
// مبني من log-values.json (check-log-values.mjs بيتأكد إنهم متطابقين). مفيش رفض كتابة أبدًا.
// ══════════════════════════════════════════════════════════════
const LOG_REGISTRY = {
  "treasury_ledger": new Set(["confirm_failed", "confirm_mismatch", "entry_reversed", "login", "logout", "mirror_rebuilt", "historical_settle_rejected", "historical_settled", "session_already_confirmed", "session_blocked", "session_confirmed", "settlement_over", "settlement_cleared"]),
};
const isRegisteredLogValue = (tool, type) => !!LOG_REGISTRY[tool]?.has(type);

const LOG_ALERT_SQL = `
  INSERT INTO log_value_alerts
    (source_tool, tool, type, first_seen, last_seen, hits,
     worker_version, sample_order_name, sample_employee, sample_notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_tool, tool, type) DO UPDATE SET
    last_seen         = excluded.last_seen,
    hits              = log_value_alerts.hits + excluded.hits,
    worker_version    = excluded.worker_version,
    sample_order_name = excluded.sample_order_name,
    sample_employee   = excluded.sample_employee,
    sample_notes      = excluded.sample_notes,
    status            = CASE WHEN log_value_alerts.status = 'ignored'
                             THEN 'ignored' ELSE 'open' END
`;
async function noteUnregisteredLogValues(db, entries) {
  const byPair = new Map();
  for (const e of entries) {
    const key = `${e.tool}\u0000${e.type}`;
    const acc = byPair.get(key);
    if (acc) { acc.hits++; continue; }
    byPair.set(key, { entry: e, hits: 1 });
  }
  const now = new Date().toISOString();
  for (const { entry, hits } of byPair.values()) {
    try {
      await db.prepare(LOG_ALERT_SQL).bind(
        TOOL_NAME, entry.tool ?? '(بدون tool)', entry.type ?? '(بدون type)',
        now, now, hits, WORKER_VERSION ?? null,
        entry.orderName ?? null, entry.employee ?? null,
        entry.notes ? String(entry.notes).slice(0, 200) : null,
      ).run();
    } catch (e) { /* متعمّد: التنبيه فهرس، وفشله أهون من تعطيل الأداة */ }
  }
}

// ═══════════════════════════════════════════════════════════════
// SHARED: Auth & Logging Functions — EcomModa D1 Pattern v1.3.0
// Copy this block VERBATIM into every Worker — no modifications
// Place BEFORE the export default { } block
// ═══════════════════════════════════════════════════════════════

/**
 * Verify employee and return display_name if correct.
 * Updates last_login automatically.
 * Returns: string (display_name) or null if wrong PIN.
 * Throws: Error if account is suspended.
 */
async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();

  if (!row) return null;

  if (!row.is_active) {
    throw new Error('الحساب موقوف — تواصل مع المسؤول');
  }

  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username)
    .run()
    .catch(() => {});

  return row.display_name;
}

/**
 * Check if employee exists and has a PIN registered.
 * Used in Login screen to decide: normal login vs first-time PIN setup.
 */
async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row) return { exists: false, hasPin: false, isActive: false };
  return {
    exists:   true,
    hasPin:   !!row.pin,
    isActive: !!row.is_active,
  };
}

/**
 * Register PIN for the first time.
 * Throws if: user not found / suspended / already has PIN.
 */
async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');

  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?')
    .bind(pin, username)
    .run();

  return true;
}

/**
 * Write a log entry to D1.
 * Only tool and type are required. All other fields optional (null if not provided).
 */
async function writeLog(db, entry) {
  // الطبقة ٥: قيمة (tool,type) غير مسجّلة بتتكتب برضه + extra._unregistered (مفيش رفض كتابة أبدًا)
  const unregistered = !isRegisteredLogValue(entry.tool, entry.type);
  const extra = unregistered ? { ...(entry.extra || {}), _unregistered: true } : entry.extra;
  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    extra ? JSON.stringify(extra) : null
  ).run();
  if (unregistered) await noteUnregisteredLogValues(db, [entry]);   // بعد الكتابة، مش قبلها
}

const LOG_EXPORT_MAX = 2000;   // سقف التصدير — بيرجع للواجهة كـ `cap`

/**
 * بنّاء شرط الفلترة الموحّد للسجل — التلات دوال تحته بتستخدمه، فمفيش SQL
 * مكرر يتعتّق في واحدة منهم ويسيب التانية.
 *
 * كل الباراميترات **اختيارية**، والسلوك من غيرها **مطابق للنسخة القديمة
 * بالحرف** — الإضافة متوافقة رجوعيًا ١٠٠٪:
 *   employees[] / types[]  → قوايم. multi-select إلزامي في أي شاشة فيها جدول
 *                            (`ecommoda-html-builder` → data-table-standard.md
 *                            بند ٢١)، والسجل بقى جدول (بند ٢٦).
 *   employee / type        → قيمة واحدة — متسابة للتوافق مع واجهات قديمة.
 *   dateFrom / dateTo      → بيتقارنوا بـ substr(timestamp,1,10) — يعني **UTC**،
 *                            والعرض بتوقيت القاهرة (UTC+3). فرق التلات ساعات
 *                            ممكن يحط عملية بعد ٩ مساءً بتوقيت القاهرة في يوم
 *                            UTC اللي بعده. مقبول لفلتر بالأيام — **بس مكتوب**،
 *                            عشان مايتكتشفش كباج بعدين.
 * login/logout مستثنيين في SQL دايمًا — مش client-side.
 */
function buildLogFilterSQL(select, {
  tool      = null,
  employee  = null, employees = null,
  type      = null, types     = null,
  search    = null,
  dateFrom  = null, dateTo    = null,
} = {}) {
  let sql = `${select} FROM logs WHERE type NOT IN ('login','logout')`;
  const b = [];

  const emps = Array.isArray(employees) && employees.length ? employees : (employee ? [employee] : []);
  const typs = Array.isArray(types)     && types.length     ? types     : (type     ? [type]     : []);

  if (tool) { sql += ' AND tool = ?'; b.push(tool); }
  if (emps.length) {
    sql += ` AND employee IN (${emps.map(() => '?').join(',')})`; b.push(...emps);
  }
  if (typs.length) {
    sql += ` AND type IN (${typs.map(() => '?').join(',')})`; b.push(...typs);
  }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) { sql += ' AND substr(timestamp, 1, 10) >= ?'; b.push(dateFrom); }
  if (dateTo)   { sql += ' AND substr(timestamp, 1, 10) <= ?'; b.push(dateTo); }

  return { sql, b };
}

/**
 * Fetch logs from D1 with server-side filtering + pagination.
 * Used for paginated display in the log tab (100 rows per page).
 * Max limit per page: 100 (enforced server-side).
 *
 * ⚠️ Do NOT use this for XLSX export — use getLogsExport() instead.
 */
async function getLogs(db, { limit = 100, offset = 0, sortBy, sortDir, ...filters } = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  const q = sql + orderByClause(sortBy, sortDir) + ' LIMIT ? OFFSET ?';
  return (await db.prepare(q)
    .bind(...b, Math.min(limit, 100), Math.max(offset, 0)).all()).results;
}

// ⚠️ قائمة **مقفولة** — القيمة جاية من العميل وبتتلزق في نص SQL مباشرةً
//    (ORDER BY مابيقبلش bind). أي قيمة بره القايمة بترجع للافتراضي بدون خطأ.
// ⚠️ المفاتيح لازم تطابق `data-sort-key` في الواجهة **حرفيًا** — مفتاح مش في
//    القايمة بيرجع للافتراضي في صمت، فالعمود يبان إنه اترتّب وهو مااترتّبش.
const LOG_SORT_COLUMNS = {
  date: 'timestamp', time: 'timestamp', employee: 'employee', orderName: 'order_name',
  machine: `json_extract(extra, '$.machine')`, result: `json_extract(extra, '$.result')`,
};

function orderByClause(sortBy, sortDir) {
  const col = LOG_SORT_COLUMNS[String(sortBy || '')] || 'timestamp';
  const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 🔴 كاسر تعادل إلزامي: من غيره صفوف نفس القيمة بترتيب عشوائي بين الصفحات،
  //    والصف الواحد ممكن يظهر في صفحتين **أو مايظهرش خالص**.
  return col === 'timestamp' ? ` ORDER BY timestamp ${dir}`
                             : ` ORDER BY ${col} ${dir}, timestamp DESC`;
}

/**
 * Count total matching log rows.
 * Call in parallel with getLogs() (pagination UI) — and with getLogsExport()
 * (عشان الواجهة تعرف إن التصدير اتقص).
 */
async function getLogsCount(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT COUNT(*) as total', filters);
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

/**
 * Fetch all matching logs for XLSX export — up to LOG_EXPORT_MAX rows.
 * Never use getLogs() for export — it's limited to 100 rows per page.
 *
 * ⚠️ الدالة دي **بتقص في السكوت** بطبيعتها. المسؤولية اللي جنبها إلزامية:
 * الـ endpoint لازم يرجّع `cap` و`total` و`truncated` كمان — شوف تحت.
 */
async function getLogsExport(db, filters = {}) {
  const { sql, b } = buildLogFilterSQL('SELECT *', filters);
  // ⚠️ التصدير والعدّ **بيتجاهلوا الترتيب عن قصد** — العدّ مالوش ترتيب،
  //    والتصدير بياخد ترتيب السيرفر الافتراضي. تمرير sortBy/sortDir ليهم بيفتح
  //    باب اختلاف مصدر الباراميترات بين النداءات = تصدير مش مطابق للشاشة.
  const q = sql + ' ORDER BY timestamp DESC LIMIT ?';
  return (await db.prepare(q).bind(...b, LOG_EXPORT_MAX).all()).results;
}

/**
 * بيقرا فلاتر السجل من الـ query string — CSV للقوايم
 * (employees=ahmed,sara · types=cancel,cancel_failed).
 * الاسم المفرد لسه مقبول للتوافق الرجعي.
 */
function logParamsFrom(url, tool) {
  const csv = (k) => (url.searchParams.get(k) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const employees = csv('employees'), types = csv('types');
  return {
    tool,
    employees: employees.length ? employees : null,
    employee:  url.searchParams.get('employee') || null,
    types:     types.length ? types : null,
    type:      url.searchParams.get('type')     || null,
    search:    url.searchParams.get('search')   || null,
    dateFrom:  url.searchParams.get('dateFrom') || null,
    dateTo:    url.searchParams.get('dateTo')   || null,
  };
}

// ═══════════════════════════════════════════════════════════════
// END SHARED BLOCK
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// §SHOPIFY — delete section if not needed
// ══════════════════════════════════════════════════════════════
// ⚠️ التوكن مشترك بين كل Workers الستاك (نفس الـ Custom App) — ومعاه نفس
//    ميزانية تكلفة GraphQL. فشل OAuth عابر في أداة بيتحوّل لفشل كامل في
//    الشاشة اللي بتحمّل أكتر من Worker بالتوازي. → worker-builder Step 5A ⑯
const OAUTH_MAX_ATTEMPTS = 3;

async function getAccessToken(env) {
  let lastErr = null;
  for (let attempt = 1; attempt <= OAUTH_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(
        `https://${env.SHOP_DOMAIN}/admin/oauth/access_token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id:     env.CLIENT_ID,
            client_secret: env.CLIENT_SECRET,
            grant_type:    'client_credentials',
          }),
        }
      );
      if (!resp.ok) {
        const retriable = resp.status === 429 || resp.status >= 500;
        lastErr = new Error(`OAuth failed: ${resp.status}`);
        if (retriable && attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
        throw lastErr;
      }
      const data = await resp.json();
      if (!data.access_token) throw new Error('No access_token in response');
      return data.access_token;
    } catch (e) {
      lastErr = e;
      if (attempt < OAUTH_MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }
  }
  throw lastErr || new Error('OAuth: فشل غير معروف');
}

// ─── §SHOPIFY::shopifyGQL — العقد الإلزامي، انسخها كما هي ───
// أي فشل بيترمي. مفيش رد بيعدّي وهو فاشل:
//   ① فشل شبكة  ② HTTP status  ③ رد مش JSON  ④ data.errors  ⑤ data فاضية
// ⚠️ ④ هو الخطير: لما ميوتيشن تترفض على مستوى الحقل (صلاحية ناقصة مثلاً)
// شوبيفاي بترد {"errors":[…],"data":null} — والـ userErrors بتبقى [] لأن مفيش
// payload أصلاً. كود بيفحص userErrors بس بيقرا ده **نجاح**.
// (كلّف EcomModa ٤ أيام استرجاع مخزون وهمي — 19→23-08-2026)
// ⚠️ تكلفة الاستعلام — الرصيد المتبقي و«النداء ده كلّف كام» رقمان مختلفان،
//    والقرار بيتبني على التاني. → worker-builder Step 5A ⑮
let _lastThrottle = null, _lastQueryCost = null;

async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify', costLog = null) {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body:    JSON.stringify({ query, variables }),
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: فشل الاتصال بشوبيفاي — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }

    if (!resp.ok) {
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: شوبيفاي ردّت HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
      throw lastErr;
    }

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${opName}: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`); }

    if (Array.isArray(data.errors) && data.errors.length) {
      const codes = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      lastErr = new Error(
        `${opName}: ${data.errors.map(e => e.message).join(' | ')}` +
        (codes.length ? ` [${codes.join(',')}]` : '')
      );
      if (codes.includes('THROTTLED') && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1200 * attempt)); continue;
      }
      throw lastErr;
    }

    if (!data.data) throw new Error(`${opName}: رد شوبيفاي بدون data — ${text.slice(0, 180)}`);

    if (data.extensions?.cost) {
      const c = data.extensions.cost;
      if (c.throttleStatus) _lastThrottle = c.throttleStatus;
      _lastQueryCost = { op: opName, requested: c.requestedQueryCost ?? null, actual: c.actualQueryCost ?? null };
      if (costLog) costLog.push({ op: opName, requested: c.requestedQueryCost ?? null, actual: c.actualQueryCost ?? null });
    }
    return data;
  }
  throw lastErr || new Error(`${opName}: فشل غير معروف`);
}


// ══════════════════════════════════════════════════════════════
// §LEDGER — منطق الجلسات والدفتر (كله على السيرفر؛ الواجهة مابتحسبش حاجة)
// ══════════════════════════════════════════════════════════════

// ─── §LEDGER::loadRows — صفوف cod_payment لنطاق زمني (حقول محددة بس، مش extra كامل) ───
// ⚠️ عقد قراءة: Treasury-Ledger بيقرا من extra الصفوف دي: batchId · courier · courierCollect ·
//    extraShipping[] · extraShippingTotal · batchExpected (+ result · preRegistered · hasReturn).
//    تغيير اسم أي مفتاح في COD-Payment-Center = جلسات فاضية/ناقصة هنا بلا أي خطأ. غيّر في الاتنين معًا.
//    الاستعلام دايمًا بـ tool + نطاق timestamp (idx_logs_tool_ts) — ممنوع من غير النطاق (D1 مشترك ~293MB).
const SRC_COLS = `id, timestamp, type, employee, order_id, order_name,
  json_extract(extra,'$.batchId')                 AS batch_id,
  json_extract(extra,'$.courier')                 AS courier,
  json_extract(extra,'$.courierCollect')          AS cc,
  json_extract(extra,'$.result')                  AS result,
  json_extract(extra,'$.extraShipping')           AS xs,
  json_extract(extra,'$.extraShippingTotal')      AS xs_total,
  json_extract(extra,'$.batchExpected')           AS be,
  json_extract(extra,'$.preRegistered')           AS pre,
  json_extract(extra,'$.hasReturn')               AS has_return,
  json_extract(extra,'$.source')                  AS src`;

async function loadRowsRange(db, fromIso, toIso) {
  const { results } = await db.prepare(
    `SELECT ${SRC_COLS} FROM logs WHERE tool = ? AND type IN ('payment','refund') AND timestamp >= ? AND timestamp <= ? ORDER BY id`
  ).bind(SOURCE_TOOL, fromIso, toIso).all();
  return results || [];
}

async function loadRowsByBatch(db, batchIds, fromIso, toIso) {
  const out = [];
  for (const ids of chunk([...new Set(batchIds)], BIND_CHUNK)) {
    const { results } = await db.prepare(
      `SELECT ${SRC_COLS} FROM logs WHERE tool = ? AND type IN ('payment','refund') AND timestamp >= ? AND timestamp <= ?
         AND json_extract(extra,'$.batchId') IN (${ids.map(() => '?').join(',')}) ORDER BY id`
    ).bind(SOURCE_TOOL, fromIso, toIso, ...ids).all();
    out.push(...(results || []));
  }
  return out;
}

// ─── §LEDGER::buildSession — صفوف جلسة واحدة → جلسة بمتوقع محسوب ───
// المتوقع = ما يثبته D1: Σ courierCollect للصفوف المكتوبة − Σ الشحن الإضافي (قرار §13-1، توصية — مستني تأكيد أحمد).
// الجلسة الناقصة (صفوف D1 أقل من batchExpected) بتاخد علامة incomplete + تنبيه دايم.
function buildSession(batchId, rows) {
  rows = [...rows].sort((a, b) => a.id - b.id);
  const first = rows[0];
  const problems = [], warnings = [];

  // الصفوف
  const items = [];
  for (const r of rows) {
    if (r.result !== null && r.result !== undefined && r.result !== 'success') {
      problems.push(`الصف ${r.id}: result=${r.result} (مش success)`);
    }
    const p = toPiastres(r.cc);
    if (p === null) { problems.push(`الصف ${r.id} (${r.order_name || '؟'}): courierCollect فاضي أو مش رقم`); continue; }
    if (!r.order_id || !r.order_name) { problems.push(`الصف ${r.id}: رقم الأوردر ناقص`); continue; }
    const isRefund = r.type === 'refund';
    const pre = r.pre === 1 || r.pre === true || r.pre === 'true';
    const hasReturn = r.has_return === 1 || r.has_return === true || r.has_return === 'true';
    if (isRefund && p > 0) warnings.push(`الصف ${r.id} (${r.order_name}): استرداد بمبلغ موجب (${fmtMoney(p)})`);
    items.push({
      logId: r.id, orderId: String(r.order_id), orderName: r.order_name, srcType: r.type,
      piastres: p, kind: p < 0 ? KIND.OUT : KIND.IN,
      // 🆕 صفوف بوسطة (extra.source='bosta_cash_cycle'): courierCollect = Net Value (بعد رسوم بوسطة) —
      //    مش مبلغ شوبيفاي، فبتتعلّم بمصدر مستقل عشان مقارنة Shopify تستثنيها (BOSTA_NET).
      source: r.src === BOSTA_SRC ? BOSTA_SRC : (isRefund ? 'cod_refund' : 'cod_payment'),
      note: r.src === BOSTA_SRC ? 'بوسطة — صافي بعد الرسوم' : (isRefund ? 'استرداد' : (pre ? 'مسجل مسبقاً' : null)),
      preRegistered: pre, hasReturn,
    });
  }
  const seen = new Set();
  for (const it of items) { if (seen.has(it.logId)) problems.push(`صف مكرر ${it.logId}`); seen.add(it.logId); }

  // الشحن الإضافي — نسخة الجلسة كلها متختمة على كل صف: اقرأها **مرة واحدة** (فخ ١ في المواصفات)
  let xsRaw = null, xsDisagree = false;
  for (const r of rows) {
    const v = parseJSONSafe(r.xs, null);
    if (!Array.isArray(v)) continue;
    if (xsRaw === null) xsRaw = v;
    else if (JSON.stringify(v) !== JSON.stringify(xsRaw)) xsDisagree = true;
  }
  if (xsDisagree) problems.push('قايمة الشحن الإضافي مختلفة بين صفوف الجلسة');
  const extraShipping = [];
  const xsSeen = new Set();
  for (const x of (xsRaw || [])) {
    const p = toPiastres(x?.amount);
    const oid = x?.orderId !== undefined && x?.orderId !== null ? String(x.orderId) : '';
    if (p === null || p <= 0 || !oid || !x?.orderName) { problems.push('بند شحن إضافي ناقص أو مبلغه مش صالح'); continue; }
    if (xsSeen.has(oid)) { problems.push(`شحن إضافي مكرر لنفس الأوردر ${x.orderName}`); continue; }
    xsSeen.add(oid);
    extraShipping.push({ orderId: oid, orderName: x.orderName, courier: x.courier || null, piastres: p });
  }
  const xsSum = extraShipping.reduce((s, x) => s + x.piastres, 0);
  const xsTotalField = toPiastres(first.xs_total);
  if (xsTotalField !== null && xsTotalField !== xsSum) {
    problems.push(`extraShippingTotal (${fmtMoney(xsTotalField)}) مختلف عن مجموع البنود (${fmtMoney(xsSum)})`);
  }

  // المتوقع من اللي D1 مثبّته
  const rowsSum  = items.reduce((s, it) => s + it.piastres, 0);
  const expected = rowsSum - xsSum;

  // مطابقة batchExpected (اللي الجلسة اتحققت عليه قبل التنفيذ)
  let beInfo = null, incomplete = false;
  const beRaw = rows.map(r => parseJSONSafe(r.be, null)).find(Boolean);
  if (beRaw) {
    const exOrders = Number(beRaw.orders);
    const exCollect = toPiastres(beRaw.collect);
    const exNet = toPiastres(beRaw.net);
    beInfo = { orders: exOrders, collect: exCollect, net: exNet };
    incomplete = (Number.isFinite(exOrders) && rows.length !== exOrders) || (exCollect !== null && rowsSum !== exCollect);
    if (!incomplete && exNet !== null && exNet !== expected) {
      problems.push(`الصافي المحسوب (${fmtMoney(expected)}) مخالف لـ batchExpected.net (${fmtMoney(exNet)})`);
    }
  } else {
    warnings.push('الجلسة من غير batchExpected — مفيش طريقة نتأكد إنها كاملة');
  }

  const sessionId = batchId.startsWith('solo:') ? null : batchId;
  if (!sessionId) problems.push(`الصف ${first.id} من غير batchId — مش جلسة معروفة`);

  return {
    batchId, valid: problems.length === 0 && sessionId !== null,
    courier: rows.map(r => r.courier).find(Boolean) || null,
    collector: first.employee || null,
    firstTimestamp: first.timestamp, day: cairoDayOf(first.timestamp),
    items, extraShipping, rowsCount: rows.length,
    expectedPiastres: expected, incomplete, batchExpected: beInfo, problems, warnings,
  };
}

function groupSessions(rows) {
  const by = new Map();
  for (const r of rows) {
    const bid = r.batch_id ? String(r.batch_id) : `solo:${r.id}`;
    if (!by.has(bid)) by.set(bid, []);
    by.get(bid).push(r);
  }
  return [...by.entries()].map(([bid, rs]) => buildSession(bid, rs));
}

// ─── §LEDGER::status ───
async function loadConfirmations(db, batchIds = null) {
  const m = new Map();
  if (batchIds === null) {
    const { results } = await db.prepare('SELECT * FROM treasury_confirmations').all();
    for (const r of results || []) m.set(r.batch_id, r);
  } else {
    for (const ids of chunk(batchIds, BIND_CHUNK)) {
      const { results } = await db.prepare(
        `SELECT * FROM treasury_confirmations WHERE batch_id IN (${ids.map(() => '?').join(',')})`
      ).bind(...ids).all();
      for (const r of results || []) m.set(r.batch_id, r);
    }
  }
  return m;
}

// آخر محاولة تأكيد بفرق لكل جلسة (من logs) — التنبيه بيفضل لحد ما الجلسة تتأكد
async function loadMismatches(db, fromIso) {
  const { results } = await db.prepare(
    `SELECT timestamp, employee,
            json_extract(extra,'$.batchId')  AS batch_id,
            json_extract(extra,'$.expected') AS expected,
            json_extract(extra,'$.received') AS received,
            json_extract(extra,'$.diff')     AS diff
       FROM logs WHERE tool = ? AND type = 'confirm_mismatch' AND timestamp >= ? ORDER BY id`
  ).bind(TOOL_NAME, fromIso).all();
  const m = new Map();
  for (const r of results || []) if (r.batch_id) m.set(String(r.batch_id), r);   // الأحدث بيغلب
  return m;
}

function sessionStatus(s, confirmation, mismatch) {
  if (confirmation) return 'confirmed';
  if (!s.valid) return 'blocked';
  if (mismatch) return 'diff';
  return 'pending';
}

function sessionView(s, confirmation, mismatch, { withRows = true } = {}) {
  const status = sessionStatus(s, confirmation, mismatch);
  const v = {
    batchId: s.batchId, status, courier: s.courier, collector: s.collector,
    day: s.day, firstTimestamp: s.firstTimestamp, rowsCount: s.rowsCount,
    expected: fmtMoney(s.expectedPiastres), expectedPiastres: s.expectedPiastres,
    incomplete: s.incomplete, problems: s.problems, warnings: s.warnings,
    batchExpected: s.batchExpected ? {
      orders: s.batchExpected.orders,
      collect: s.batchExpected.collect === null ? null : fmtMoney(s.batchExpected.collect),
      net: s.batchExpected.net === null ? null : fmtMoney(s.batchExpected.net),
    } : null,
    extraShippingTotal: fmtMoney(s.extraShipping.reduce((a, x) => a + x.piastres, 0)),
    mismatch: mismatch ? {
      at: mismatch.timestamp, by: mismatch.employee,
      expected: mismatch.expected, received: mismatch.received, diff: mismatch.diff,
    } : null,
    confirmation: confirmation ? {
      at: confirmation.confirmed_at, by: confirmation.treasury_employee,
      received: fmtMoney(confirmation.received_piastres), flags: confirmation.session_flags || null,
    } : null,
  };
  if (withRows) {
    v.rows = s.items.map(it => ({
      logId: it.logId, orderId: it.orderId, orderName: it.orderName, srcType: it.srcType,
      kind: it.kind, amount: fmtSigned(it.piastres), note: it.note,
      preRegistered: it.preRegistered, hasReturn: it.hasReturn,
    }));
    v.extraShipping = s.extraShipping.map(x => ({
      orderId: x.orderId, orderName: x.orderName, courier: x.courier, amount: fmtMoney(x.piastres),
    }));
  }
  return v;
}

// ─── §LEDGER::loadDay — جلسات يوم (بتنتسب ليوم أول صف فيها) ───
async function loadDaySessions(db, dateStr) {
  const { start, end } = cairoDayBoundsUTC(dateStr);
  const dayRows = await loadRowsRange(db, start, end);
  const batchIds = [...new Set(dayRows.map(r => r.batch_id).filter(Boolean).map(String))];
  // صفوف الجلسة بتتكتب في ثواني؛ لو جلسة اتقسمت على حد اليوم نكمّلها من هامش ±6 ساعات
  const margin = 6 * 3600 * 1000;
  const full = batchIds.length
    ? await loadRowsByBatch(db, batchIds, new Date(Date.parse(start) - margin).toISOString(),
                                           new Date(Date.parse(end) + margin).toISOString())
    : [];
  const ids = new Set(full.map(r => r.id));
  const rows = [...full, ...dayRows.filter(r => !r.batch_id || !ids.has(r.id))];
  const sessions = groupSessions(rows).filter(s => s.day === dateStr);
  sessions.sort((a, b) => a.firstTimestamp.localeCompare(b.firstTimestamp));
  return sessions;
}

async function loadWindowSessions(db) {
  const from = cairoDayBoundsUTC(MIN_DATE).start;
  const to = new Date().toISOString();
  const rows = await loadRowsRange(db, from, to);
  const sessions = groupSessions(rows).filter(s => s.day >= MIN_DATE);
  sessions.sort((a, b) => a.firstTimestamp.localeCompare(b.firstTimestamp));
  return { sessions, from };
}

// ─── §LEDGER::entries — تحويل المصدر لحركات دفتر (§5.3) ───
function buildEntries(s) {
  const entries = [];
  for (const it of s.items) {
    entries.push({
      order_id: it.orderId, order_name: it.orderName, kind: it.kind, amount_piastres: it.piastres,
      note: it.note, source: it.source, source_log_id: it.logId,
      idempotency_key: `log:${it.logId}`,
    });
  }
  for (const x of s.extraShipping) {
    entries.push({
      order_id: x.orderId, order_name: x.orderName, kind: KIND.OUT, amount_piastres: -x.piastres,
      note: NOTE_EXTRA_SHIPPING, source: 'cod_extra_shipping', source_log_id: null,
      idempotency_key: `xs:${s.batchId}:${x.orderId}`,
    });
  }
  return entries;
}

// ─── §LEDGER::mirror — بناء سطور الأوردر وإجماليه من **كل** حركاته في D1 (مش append) ───
function mirrorLine(e) {
  const who = String(e.treasury_employee || '').replace(/_/g, ' ');
  const p = cairoParts(new Date(e.created_at));
  let line = `📅 ${p.day}/${p.month}/${p.year} 🕕 ${p.hour}:${p.minute} | ${e.kind} | 💲 ${fmtSigned(e.amount_piastres)} | ${who}`;
  if (e.note) line += ` | ${e.note}`;                                // الملاحظة آخر عمود (قد تكون عربي)
  return line;
}

async function loadLedgerByOrderIds(db, orderIds) {
  const by = new Map();
  for (const ids of chunk([...new Set(orderIds.map(String))], BIND_CHUNK)) {
    const { results } = await db.prepare(
      `SELECT * FROM treasury_ledger WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`
    ).bind(...ids).all();
    for (const r of results || []) {
      if (!by.has(r.order_id)) by.set(r.order_id, []);
      by.get(r.order_id).push(r);
    }
  }
  return by;
}

function mirrorValues(entries) {
  return {
    log: entries.map(mirrorLine).join('\n'),
    total: fmtMoney(entries.reduce((s, e) => s + e.amount_piastres, 0)),
  };
}

const MUT_METAFIELDS_SET = `mutation TreasuryMirror($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { namespace key value owner { ... on Order { id } } }
    userErrors { field message }
  }
}`;

// بيرجّع { done:[orderId], failed:[{orderId, error}] } — فشل المرآة ما بيغيّرش D1 (الحقيقة)
async function writeMirror(env, orderIds, costLog = null) {
  const done = [], failed = [];
  const ids = [...new Set(orderIds.map(String))];
  if (!ids.length) return { done, failed };
  const miss = missingEnv(env, 'shopify');
  if (miss.length) {
    return { done, failed: ids.map(orderId => ({ orderId, error: `متغيرات ناقصة: ${miss.join('، ')}` })) };
  }
  const ledger = await loadLedgerByOrderIds(env.DB, ids);
  let token;
  try { token = await getAccessToken(env); }
  catch (e) { return { done, failed: ids.map(orderId => ({ orderId, error: e.message })) }; }

  for (const group of chunk(ids, MIRROR_ORDERS_PER_CALL)) {
    const metafields = [], expect = new Map();
    for (const oid of group) {
      const entries = ledger.get(oid) || [];
      if (!entries.length) { failed.push({ orderId: oid, error: 'مفيش حركات للأوردر ده في الدفتر' }); continue; }
      const mv = mirrorValues(entries);
      const gid = `gid://shopify/Order/${oid}`;
      metafields.push({ ownerId: gid, ...MF_LOG,   value: mv.log });
      metafields.push({ ownerId: gid, ...MF_TOTAL, value: mv.total });
      expect.set(gid, mv);
    }
    if (!metafields.length) continue;
    try {
      const data = await shopifyGQL(env, token, MUT_METAFIELDS_SET, { metafields }, 'metafieldsSet', costLog);
      const res = data.data?.metafieldsSet;
      const errs = res?.userErrors || [];
      if (errs.length) throw new Error('metafieldsSet: ' + errs.map(e => e.message).join(' | '));
      const back = res?.metafields || [];
      // ③ تأكيد الـ payload — لكل أوردر لوحده (مش علم واحد للدفعة)
      for (const oid of group) {
        const gid = `gid://shopify/Order/${oid}`;
        const mv = expect.get(gid);
        if (!mv) continue;
        const logBack   = back.find(m => m.owner?.id === gid && m.key === MF_LOG.key);
        const totalBack = back.find(m => m.owner?.id === gid && m.key === MF_TOTAL.key);
        const okLog = logBack && String(logBack.value) === mv.log;
        const okTot = totalBack && Math.abs(parseFloat(totalBack.value) - parseFloat(mv.total)) < 0.005;
        if (okLog && okTot) done.push(oid);
        else failed.push({ orderId: oid, error: 'شوبيفاي ما أكدتش كتابة الميتافيلدز' });
      }
    } catch (e) {
      for (const oid of group) if (expect.has(`gid://shopify/Order/${oid}`)) failed.push({ orderId: oid, error: e.message });
    }
  }
  return { done, failed };
}

// ─── §LEDGER::compare — مقارنة الدفتر ↔ Shopify (قراءة فقط · §7.2) ───
// المتوقع من Shopify = netPaymentSet − الشحن الحالي − Σ returns[].returnShippingFees (الدورات الفعّالة)
// 🆕 v1.4.0: الشحن = currentShippingPriceSet (مش totalShippingPriceSet) — على أوردر ملغي الشحن بيترد
//    (#49682: total=100 · current=0 · refundedShipping=100)، فالـ total كان بيخصم شحن العميل ما دفعوش.
// ويتقارن بـ Σ حركات الأوردر **من غير** Extra Shipping (مالهاش وجود على Shopify).
const Q_COMPARE = `query TreasuryCompare($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Order {
    id legacyResourceId name displayFinancialStatus cancelledAt
    netPaymentSet { shopMoney { amount } }
    totalShippingPriceSet { shopMoney { amount } }
    currentShippingPriceSet { shopMoney { amount } }
    totalOutstandingSet { shopMoney { amount } }
    currentTotalPriceSet { shopMoney { amount } }
    transactions { kind status gateway processedAt amountSet { shopMoney { amount } } }
    returns(first: 10) { pageInfo { hasNextPage } nodes { status createdAt returnShippingFees { amountSet { shopMoney { amount } } } } }
  } }
}`;

async function fetchShopifyOrders(env, token, orderIds, costLog = null) {
  const out = new Map();
  for (const ids of chunk([...new Set(orderIds.map(String))], COMPARE_PER_QUERY)) {
    const data = await shopifyGQL(env, token, Q_COMPARE,
      { ids: ids.map(i => `gid://shopify/Order/${i}`) }, 'compareOrders', costLog);
    for (const n of data.data?.nodes || []) if (n?.legacyResourceId) out.set(String(n.legacyResourceId), n);
  }
  return out;
}

function money(m) { return toPiastres(m?.shopMoney?.amount) ?? 0; }

// 🆕 v1.2.0 — «الرجل المعلّقة»: صفوف تحصيل للأوردر جوه النافذة، مش في الدفتر، وجلستها لسه ما اتأكدتش.
//    مثال #63567: تحصيل +2,600 يوم 03-11 (معلّق) + استرداد −2,600 يوم 04-11 (اتسجّل) → الدفتر −2,600 مؤقتًا.
//    من غير ده المقارنة بتقول SHORT كاذب؛ بيها بتقول «مستني تسجيل جلسة 03-11» والمتوقع بعد التسجيل.
//    صفوف جلسة **اتأكدت** ومش في الدفتر (صف اتضاف لجلسة ناقصة بعد تأكيدها) مش معلّقة — مش هتتسجّل أبدًا، فبتفضل فرق حقيقي.
function pendingLegsFrom(rows, ledgerLogIds, confirmedBatches) {
  const out = { piastres: 0, count: 0, days: [], bosta: false };
  const days = new Set();
  for (const r of rows) {
    if (ledgerLogIds.has(r.id)) continue;
    if (r.batch_id && confirmedBatches.has(String(r.batch_id))) continue;
    const p = toPiastres(r.cc);
    if (p === null) continue;
    out.piastres += p; out.count++;
    days.add(cairoDayOf(r.timestamp));
    if (r.src === BOSTA_SRC) out.bosta = true;
  }
  out.days = [...days].sort();
  return out.count ? out : null;
}

// صفوف التحصيل جوه النافذة لمجموعة أوردرات → Map(orderId → pending|null)
async function loadPendingLegs(db, orderIds, ledgerByOrder) {
  const ids = [...new Set(orderIds.map(String))];
  const rowsBy = new Map();
  const from = cairoDayBoundsUTC(MIN_DATE).start;
  for (const part of chunk(ids, BIND_CHUNK)) {
    const { results } = await db.prepare(
      `SELECT id, timestamp, order_id, json_extract(extra,'$.courierCollect') AS cc,
              json_extract(extra,'$.batchId') AS batch_id, json_extract(extra,'$.source') AS src
         FROM logs WHERE tool = ? AND type IN ('payment','refund') AND timestamp >= ?
          AND order_id IN (${part.map(() => '?').join(',')}) ORDER BY id`
    ).bind(SOURCE_TOOL, from, ...part).all();
    for (const r of results || []) {
      const k = String(r.order_id);
      if (!rowsBy.has(k)) rowsBy.set(k, []);
      rowsBy.get(k).push(r);
    }
  }
  const batchIds = [...new Set([...rowsBy.values()].flat().map(r => r.batch_id).filter(Boolean).map(String))];
  const confs = batchIds.length ? await loadConfirmations(db, batchIds) : new Map();
  const out = new Map();
  for (const id of ids) {
    const logIds = new Set((ledgerByOrder.get(id) || []).map(e => e.source_log_id).filter(x => x !== null && x !== undefined));
    out.set(id, pendingLegsFrom(rowsBy.get(id) || [], logIds, confs));
  }
  return out;
}

// 🆕 v1.3.0 — بوابات الدفع النقدية: كل تحصيلات المحل بتتسجّل بيها بس (تأكيد أحمد 10-11-2026).
//    أي بوابة تانية = دفع غير نقدي مش مفروض يدخل الخزنة (بيظهر كـ nonCash وما بيتحسبش خسارة).
const CASH_GATEWAY_RE = /cash on delivery|\bcod\b|manual/i;

// المتحصَّل النقدي من معاملات Shopify: Σ (SALE|CAPTURE ناجحة) − Σ REFUND ناجحة — على البوابات النقدية بس.
// بيرجّع null لو المعاملات ما اتجابتش (الحقل غايب) — وقتها بنرجع لـ netPaymentSet.
function cashFromTransactions(node) {
  if (!Array.isArray(node?.transactions)) return null;
  const sales = [], refunds = [], saleAt = [];
  for (const t of node.transactions) {
    if (!t || t.status !== 'SUCCESS' || !CASH_GATEWAY_RE.test(String(t.gateway || ''))) continue;
    const p = money(t.amountSet);
    if (t.kind === 'SALE' || t.kind === 'CAPTURE') { sales.push(p); saleAt.push(String(t.processedAt || '')); }
    else if (t.kind === 'REFUND') refunds.push(p);
  }
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  return { sales, refunds, saleAt, received: sum(sales) - sum(refunds) };
}

// تقسيم الخسارة على الرجلين (تقريبي): بنزاوج كل معاملة Shopify بحركة الدفتر بترتيب المبلغ (الصافي ≤ الإجمالي دايمًا).
// مابنزاوجش إلا لو العدد متساوي ومفيش استردادات/تصحيحات والرسوم منطقية — غير كده null (يفضل الإجمالي بس).
// 🆕 v1.4.0: الرجلين بيترتّبوا بتاريخ المعاملة، وشحن العميل بيتوزّع: الشحن الأصلي على أول رجل ورسوم كل مرتجع
//    (بترتيب createdAt) على الرجل اللي بعده ← خسارة الرجل = رسوم بوسطة − شحنه. لو العدد مش متطابق: shipping/loss = null.
function pairLegs(sales, saleAt, ledgerIns, legShipping) {
  if (!sales.length || sales.length !== ledgerIns.length) return null;
  const a = sales.map((gross, i) => ({ gross, at: saleAt?.[i] || '' })).sort((x, y) => y.gross - x.gross);
  const b = [...ledgerIns].sort((x, y) => y - x);
  const legs = a.map((x, i) => ({ gross: x.gross, at: x.at, net: b[i], fee: x.gross - b[i] }));
  if (legs.some(l => l.fee < 0 || l.fee > l.gross * 0.5)) return null;
  legs.sort((x, y) => x.at.localeCompare(y.at));
  const alloc = legShipping && legShipping.length === legs.length;
  for (const [i, l] of legs.entries()) {
    l.ship = alloc ? legShipping[i] : null;
    l.loss = alloc ? l.fee - legShipping[i] : null;
  }
  return legs;
}

function compareOrder(entries, node, preWindow, pending = null) {
  const byId = new Map(entries.map(e => [e.id, e]));
  const isXs = (e) => e.source === 'cod_extra_shipping' ||
    (e.reverses_id && byId.get(e.reverses_id)?.source === 'cod_extra_shipping');
  const cashEntries = entries.filter(e => !isXs(e));
  const ledgerNet = cashEntries.reduce((s, e) => s + e.amount_piastres, 0);
  const xsNet = entries.filter(isXs).reduce((s, e) => s + e.amount_piastres, 0);   // سالب (CASH_OUT) — بعد التصحيحات

  const pendingOut = pending ? { amount: fmtSigned(pending.piastres), count: pending.count, days: pending.days } : null;
  if (!node) return { status: 'UNKNOWN', ledger: fmtMoney(ledgerNet), shopify: null, diff: null, pending: pendingOut, settlement: null, reason: 'الأوردر مش لاقيه على شوبيفاي' };

  const bosta = cashEntries.some(e => e.source === BOSTA_SRC) || !!pending?.bosta;
  const net = money(node.netPaymentSet);
  const ship = node.currentShippingPriceSet ? money(node.currentShippingPriceSet) : money(node.totalShippingPriceSet);
  // رسوم المرتجع للدورات الفعّالة بس (CANCELED/DECLINED مالهاش رسوم)، بترتيب createdAt (للتوزيع على الرجلين)
  const retList = (node.returns?.nodes || []).filter(r => !['CANCELED', 'DECLINED'].includes(r?.status))
    .sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')))
    .map(r => (r.returnShippingFees || []).reduce((s, f) => s + money(f.amountSet), 0));
  const retFees = retList.reduce((s, x) => s + x, 0);
  const unreliable = !!node.returns?.pageInfo?.hasNextPage;
  const shopExpected = net - ship - retFees;
  const diff = ledgerNet - shopExpected;             // موجب = الخزنة أكتر
  const outstanding = money(node.totalOutstandingSet);
  const inProgress = node.displayFinancialStatus === 'PARTIALLY_PAID' || outstanding > 0;

  // ─── التسوية المالية (v1.3.0 · معادلة موحّدة من v1.4.0): المتحصَّل من العميل ↔ الداخل الخزنة ← الخسارة ───
  //   الخسارة = (المتحصَّل النقدي − شحن دفعه العميل) − (حركات الدفتر + الشحن الإضافي) — **نفس المعادلة للمندوب وبوسطة**.
  //   مندوب: الشحن = أجر المندوب (خارج الخسارة — قرار أحمد 10-11) والباقي فرق غير مفسَّر.
  //   🆕 v1.4.0 بوسطة: الشحن اللي العميل دفعه بيغطّي جزء من رسوم بوسطة (قرار أحمد 10-11 — #49395: 6200 − 75 − 75 − 5844.6 = 205.4)
  //   ← الخسارة = رسوم بوسطة − شحن العميل. ورسوم بوسطة أقل من شحن العميل «مستحيلة» (قرار أحمد) ← تنبيه over.
  //   رسوم المرتجع اللي لسه على العميل (outstanding) ما بتتخصمش، والشحن المخصوم ما يعدّيش المتحصَّل نفسه.
  const cashTx = cashFromTransactions(node);
  const cashReceived = cashTx ? cashTx.received : net;
  const nonCash = net - cashReceived;
  const retPaid = Math.max(0, retFees - Math.max(0, outstanding));
  const shipDue = ship + retPaid;
  const deducted = Math.min(shipDue, Math.max(0, cashReceived));
  const capped = deducted !== shipDue;
  const xsCost = -xsNet;
  const other = cashReceived - deducted - ledgerNet;     // بوسطة = رسوم بوسطة بعد شحن العميل · غيره = فرق غير مفسَّر
  const bostaFees = bosta ? cashReceived - ledgerNet : null;   // رسوم بوسطة الكاملة (قبل خصم شحن العميل)
  const lossTotal = xsCost + other;
  const total = node.currentTotalPriceSet ? money(node.currentTotalPriceSet) : null;
  const refundDue = total === null ? 0 : Math.max(0, net - total);
  const settled = outstanding === 0 && refundDue === 0;
  const reasons = [];
  if (pending) reasons.push('رجل معلّقة: فيه تحصيل لسه ما اتسجّلش في الخزنة');
  if (outstanding > 0) reasons.push('العميل لسه عليه تحصيل');
  if (refundDue > 0) reasons.push('لسه فيه استرداد للعميل');
  if (preWindow) reasons.push('الأوردر ليه صفوف قبل 01-10 (الدفتر ناقص بطبيعته)');
  if (!cashEntries.length && cashReceived - deducted !== 0) reasons.push('الأوردر مش في الدفتر');
  if (cashEntries.length && cashEntries.some(e => e.source === BOSTA_SRC) && cashEntries.some(e => e.source !== BOSTA_SRC)) reasons.push('الأوردر عليه مصدرين (بوسطة + مندوب) — الفرق مش كله رسوم بوسطة');
  if (retPaid !== retFees) reasons.push('رسوم المرتجع لسه على العميل — ما اتخصمتش');
  // شحن كل رجل بالترتيب: الشحن الأصلي ثم رسوم كل مرتجع — بس لو المدفوع كامل (من غير قصّ ولا رسوم معلّقة)
  const legShipping = !capped && retPaid === retFees ? [ship, ...retList] : null;
  const legs = bosta && cashTx && !cashTx.refunds.length && cashEntries.length && cashEntries.every(e => e.kind === KIND.IN && e.amount_piastres > 0)
    ? pairLegs(cashTx.sales, cashTx.saleAt, cashEntries.map(e => e.amount_piastres), legShipping) : null;
  const settlement = {
    customer: { total: total === null ? null : fmtMoney(total), netPayment: fmtMoney(net), cashReceived: fmtMoney(cashReceived),
      cashSource: cashTx ? 'transactions' : 'netPayment', nonCash: fmtMoney(nonCash), outstanding: fmtMoney(outstanding),
      refundDue: fmtMoney(refundDue), settled },
    treasury: { cash: fmtMoney(ledgerNet), extraShipping: fmtMoney(xsCost), net: fmtMoney(ledgerNet + xsNet) },
    deducted: { total: fmtMoney(deducted), shipping: fmtMoney(capped ? Math.min(ship, deducted) : ship),
      returnFees: fmtMoney(capped ? Math.max(0, deducted - ship) : retPaid), returnFeesUnpaid: fmtMoney(retFees - retPaid) },
    loss: { total: fmtMoney(lossTotal), extraShipping: fmtMoney(xsCost), other: fmtMoney(other), otherKind: bosta ? 'BOSTA_FEES' : 'UNEXPLAINED',
      bostaFees: bostaFees === null ? null : fmtMoney(bostaFees) },
    bosta,
    state: reasons.length ? 'PROVISIONAL' : 'FINAL', reasons,
    projectedLoss: pending ? fmtMoney(xsCost + other - pending.piastres) : null,
    // الداخل أكتر من (المتحصَّل − شحن العميل) — المفروض ما يحصلش. في بوسطة = رسوم بوسطة أقل من شحن العميل (قرار أحمد: تنبيه).
    // 🆕 v1.4.0: بيشتغل على العميل المقفول بس — غير كده الخسارة أصلاً مؤقتة والفرق ممكن يكون تحصيل/استرداد لسه ما حصلش.
    over: other < 0 && settled && !pending && !preWindow,
    overKind: other < 0 ? (bosta && ledgerNet <= cashReceived ? 'BOSTA_FEES_BELOW_SHIPPING' : 'OVER_COLLECTED') : null,
    shipments: legs ? legs.map(l => ({ shopify: fmtMoney(l.gross), ledger: fmtMoney(l.net), fee: fmtMoney(l.fee),
      shipping: l.ship === null ? null : fmtMoney(l.ship), loss: l.loss === null ? null : fmtMoney(l.loss) })) : null,
  };

  // الرجل المعلّقة ليها الأولوية: الحكم النهائي بعد ما الجلسة المعلّقة تتسجّل
  const projectedDiff = pending ? diff + pending.piastres : null;
  let status;
  if (pending) status = 'AWAITING_LEG';
  else if (bosta) {
    // 🆕 v1.3.0: بوسطة بقى ليها حكم فعلي (قرار أحمد 10-11) — الفرق = رسوم بوسطة مش مقارنة بمعادلة الشحن
    if (inProgress) status = 'IN_PROGRESS';
    else if (preWindow) status = 'PRE_WINDOW';
    else if (!cashEntries.length) status = 'NOT_IN_LEDGER';
    else status = other === 0 ? 'MATCH' : other > 0 ? 'BOSTA_FEES' : 'OVER';
  }
  else if (diff === 0) status = 'MATCH';
  else if (inProgress) status = 'IN_PROGRESS';
  else if (preWindow) status = 'PRE_WINDOW';
  else if (!cashEntries.length) status = 'NOT_IN_LEDGER';
  else if (net === 0) status = 'LEDGER_ONLY';
  else status = diff < 0 ? 'SHORT' : 'OVER';

  return {
    status, ledger: fmtMoney(ledgerNet), shopify: bosta ? null : fmtMoney(shopExpected), diff: bosta ? null : fmtMoney(diff),
    pending: pendingOut,
    projectedLedger: pending ? fmtMoney(ledgerNet + pending.piastres) : null,
    projectedDiff: pending && !bosta ? fmtMoney(projectedDiff) : null,
    willMatch: pending ? (bosta ? other - pending.piastres === 0 : projectedDiff === 0) : null,
    parts: bosta ? null : { netPayment: fmtMoney(net), shipping: fmtMoney(ship), returnFees: fmtMoney(retFees) },
    financialStatus: node.displayFinancialStatus, cancelled: !!node.cancelledAt,
    settlement,
    note: unreliable ? 'فيه أكتر من 10 مرتجعات على الأوردر — المقارنة غير مكتملة' : null,
  };
}

// 🆕 v1.3.0 — تنبيه «الداخل أكتر من المتحصَّل»: بيتسجّل لحظة ما الأوردر يتفحص (get_order / compare_orders) مش بمسح تلقائي.
//    آخر لوج لكل أوردر هو الحالة: settlement_over = تنبيه مفتوح · settlement_cleared = اتحل (الفرق اتصحّح).
async function syncSettlementAlerts(db, items) {
  const rows = items.filter(x => x.orderName && x.cmp?.settlement);
  if (!rows.length) return;
  const latest = new Map();
  for (const part of chunk([...new Set(rows.map(x => x.orderName))], BIND_CHUNK)) {
    const { results } = await db.prepare(
      `SELECT order_name, type FROM logs WHERE tool = ? AND type IN ('settlement_over','settlement_cleared')
         AND order_name IN (${part.map(() => '?').join(',')}) ORDER BY id`).bind(TOOL_NAME, ...part).all();
    for (const r of results || []) latest.set(r.order_name, r.type);          // الأخير يكسب
  }
  for (const { orderId, orderName, cmp } of rows) {
    const st = cmp.settlement, was = latest.get(orderName);
    if (st.over && was !== 'settlement_over') {
      await safeLog(db, { type: 'settlement_over', orderId: orderId ?? null, orderName, valueAfter: parseFloat(st.loss.other),
        notes: st.overKind === 'BOSTA_FEES_BELOW_SHIPPING'
          ? `رسوم بوسطة (${st.loss.bostaFees}) أقل من الشحن اللي دفعه العميل (${st.deducted.total}) بـ ${fmtMoney(-toPiastres(st.loss.other))}`
          : `الداخل الخزنة أكتر من المتحصَّل بعد الشحن بـ ${fmtMoney(-toPiastres(st.loss.other))}`,
        extra: { result: 'warning', stage: 'lookup', kind: st.overKind, cashReceived: st.customer.cashReceived, deducted: st.deducted.total,
                 ledger: st.treasury.cash, other: st.loss.other } });
    } else if (!st.over && was === 'settlement_over') {
      await safeLog(db, { type: 'settlement_cleared', orderId: orderId ?? null, orderName, extra: { result: 'success', stage: 'lookup' } });
    }
  }
}

// أوردرات ليها صفوف تحصيل قبل نافذة الأداة (الدفتر ناقص بطبيعته)
async function preWindowOrderSet(db, orderNames) {
  const set = new Set();
  const to = cairoDayBoundsUTC(MIN_DATE).start;
  for (const names of chunk([...new Set(orderNames)], BIND_CHUNK)) {
    const { results } = await db.prepare(
      `SELECT DISTINCT order_name FROM logs WHERE tool = ? AND type IN ('payment','refund')
         AND timestamp >= ? AND timestamp < ? AND order_name IN (${names.map(() => '?').join(',')})`
    ).bind(SOURCE_TOOL, ORDER_HISTORY_FROM, to, ...names).all();
    for (const r of results || []) set.add(r.order_name);
  }
  return set;
}

// ─── §LEDGER::log — كتابة لوج بدون ما فشلها يوقّف العملية (Step 5A ⑦) ───
async function safeLog(db, entry) {
  try { await writeLog(db, { tool: TOOL_NAME, ...entry }); return true; }
  catch (e) { return false; }
}

async function requireActiveEmployee(db, username) {
  if (!username) return false;
  const row = await db.prepare('SELECT is_active FROM employees WHERE username = ?').bind(username).first();
  return !!(row && row.is_active);
}

// ══════════════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════════════
function checkDate(d) {
  if (!isDateStr(d)) return 'التاريخ مطلوب بصيغة YYYY-MM-DD';
  if (d < MIN_DATE) return `الأداة بتشتغل من ${MIN_DATE} بس`;
  if (d > cairoDate()) return 'مينفعش تاريخ في المستقبل';
  return null;
}

export default {
  async fetch(request, env) {
    // ALWAYS first: CORS preflight
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: getCORS(request) });

    // 🔴 حارس السر الغايب (Step 8) — من غيره "Bearer undefined" بيعدّي لو WORKER_SECRET مش متظبط
    if (typeof env.WORKER_SECRET !== 'string' || !env.WORKER_SECRET.trim())
      return json({ ok: false, error: 'WORKER_SECRET غير مضبوط على الـ Worker', step: 'env' }, 500, request);

    // ALWAYS second: WORKER_SECRET check
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`)
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...getCORS(request) },
      });

    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    try {

      // ─── §AUTH ────────────────────────────────────────────────────
      // ═══════════════════════════════════════════════════════════════
// AUTH ENDPOINTS — paste inside the try{} block of fetch handler
// ═══════════════════════════════════════════════════════════════

// ── check_employee — GET (no sensitive data — GET is ok) ──────
if (action === 'check_employee') {
  const username = url.searchParams.get('username');
  if (!username) return json({ ok: false, error: 'username مطلوب' }, 400, request);
  const result = await checkEmployee(env.DB, username);
  return json({ ok: true, ...result }, 200, request);
}

// ── register_pin — POST (PIN in body — GET is FORBIDDEN) ──────
if (action === 'register_pin') {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
  const { username, pin } = await request.json().catch(() => ({}));
  if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
  await registerPin(env.DB, username, pin);
  return json({ ok: true }, 200, request);
}

// ── verify_employee — POST (PIN in body — GET is FORBIDDEN) ───
if (action === 'verify_employee') {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
  // appId اختياري — بس لو الـ Worker بيخدم أكتر من واجهة (هب). راجع
  // ecommoda-worker-builder § باراميتر appId قبل ما تضيفه: القايمة البيضاء
  // AUTH_APPS **مقفولة**، والقيمة اللي مش فيها بترجع للاسم الافتراضي بلا خطأ.
  const { username, pin, appId } = await request.json().catch(() => ({}));
  if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);

  const displayName = await verifyEmployee(env.DB, username, pin);
  if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);

  // ⚠️ الدخول نفسه نجح فعلاً هنا (verifyEmployee فوق رجّعت displayName صحيح).
  // فشل D1 بعد كده لازم يترجع كـ logged:false — مش يسقّط الرد كله على 500
  // لدخول حصل فعلاً (Step 5A ⑦ في ecommoda-worker-builder).
  let logged = true;
  try {
    await writeLog(env.DB, {
      tool:     resolveAuthTool(appId),   // = TOOL_NAME لو مفيش appId أو مش في AUTH_APPS
      type:     'login',
      employee: username,
      notes:    `دخول: ${displayName}`,
    });
  } catch (e) {
    logged = false;
  }
  return json({ ok: true, displayName, logged }, 200, request);
}

// ── log_logout — GET ok (no sensitive data) ───────────────────
if (action === 'log_logout') {
  const username = url.searchParams.get('username');
  const appId    = url.searchParams.get('appId');   // اختياري — نفس قاعدة verify_employee
  let logged = true;
  if (username) {
    try {
      await writeLog(env.DB, {
        tool:     resolveAuthTool(appId),
        type:     'logout',
        employee: username,
        notes:    `خروج: ${username.replace(/_/g, ' ')}`,
      });
    } catch (e) {
      logged = false;
    }
  }
  return json({ ok: true, logged }, 200, request);
}

// ── get_employees — GET (for HTML dropdown) ───────────────────
if (action === 'get_employees') {
  const { results } = await env.DB.prepare(
    'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
  ).all();
  return json({ ok: true, employees: results }, 200, request);
}

// ═══════════════════════════════════════════════════════════════
// END AUTH ENDPOINTS BLOCK
// ═══════════════════════════════════════════════════════════════
      // ──────────────────────────────────────────────────────────────

      // ─── §LEDGER::get_day ─────────────────────────────────────────
      if (action === 'get_day') {
        const date = url.searchParams.get('date');
        const bad = checkDate(date);
        if (bad) return json({ ok: false, error: bad }, 400, request);
        const sessions = await loadDaySessions(env.DB, date);
        const confs = await loadConfirmations(env.DB, sessions.map(s => s.batchId));
        const mism  = await loadMismatches(env.DB, cairoDayBoundsUTC(date).start);
        const views = sessions.map(s => sessionView(s, confs.get(s.batchId), mism.get(s.batchId)));
        // 🆕 v1.2.0 — حركات الأوردر المتسجّلة في جلسات تانية (مثلاً استرداد اتسجّل والتحصيل الأصلي لسه هنا):
        //    الدفتر على الأوردر ده ناقص لحد ما الجلسة دي تتسجّل → علامة أولوية في الواجهة
        const openViews = views.filter(v => v.status !== 'confirmed');
        if (openViews.length) {
          const led = await loadLedgerByOrderIds(env.DB, openViews.flatMap(v => v.rows.map(r => r.orderId)));
          for (const v of openViews) for (const r of v.rows) {
            const other = (led.get(String(r.orderId)) || []).filter(e => e.source_batch_id !== v.batchId);
            const sum = other.reduce((t, e) => t + e.amount_piastres, 0);
            if (sum !== 0) r.elsewhere = fmtSigned(sum);
          }
        }
        const tally = { total: views.length, confirmed: 0, pending: 0, diff: 0, blocked: 0 };
        for (const v of views) tally[v.status]++;
        return json({ ok: true, date, sessions: views, tally }, 200, request);
      }

      // ─── §LEDGER::get_pending — كل الجلسات غير المؤكدة من MIN_DATE ───
      if (action === 'get_pending') {
        const { sessions, from } = await loadWindowSessions(env.DB);
        const confs = await loadConfirmations(env.DB);
        const mism  = await loadMismatches(env.DB, from);
        const days = new Map();
        for (const s of sessions) {
          if (confs.has(s.batchId)) continue;
          const v = sessionView(s, null, mism.get(s.batchId), { withRows: false });
          if (!days.has(s.day)) days.set(s.day, []);
          days.get(s.day).push(v);
        }
        const out = [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]))
          .map(([day, list]) => ({ day, sessions: list,
            expectedTotal: fmtMoney(list.reduce((t, v) => t + v.expectedPiastres, 0)) }));
        return json({ ok: true, from: MIN_DATE, days: out,
          count: out.reduce((n, d) => n + d.sessions.length, 0) }, 200, request);
      }

      // ─── §LEDGER::confirm_session ─────────────────────────────────
      // العقد: النتيجة { ok, status: success|warning|rejected|already|error, ... } — أربع حالات (Step 5A ④).
      if (action === 'confirm_session') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const body = await request.json().catch(() => ({}));
        const { batchId, date, employee } = body;
        const bad = checkDate(date);
        if (bad) return json({ ok: false, status: 'rejected', stage: 'preflight', error: bad }, 400, request);
        if (!batchId || typeof batchId !== 'string') return json({ ok: false, status: 'rejected', stage: 'preflight', error: 'batchId مطلوب' }, 400, request);
        if (!(await requireActiveEmployee(env.DB, employee))) return json({ ok: false, status: 'rejected', stage: 'preflight', error: 'الموظف غير معروف أو موقوف' }, 403, request);
        // المبلغ المكتوب: رقم صريح، بدون قيمة افتراضية
        const receivedP = toPiastres(body.receivedAmount);
        if (receivedP === null) return json({ ok: false, status: 'rejected', stage: 'preflight', error: 'اكتب المبلغ المستلم (رقم)' }, 400, request);

        // نعيد الحساب كله من D1 — مانثقش في أي رقم جاي من الواجهة
        const sessions = await loadDaySessions(env.DB, date);
        const s = sessions.find(x => x.batchId === batchId);
        if (!s) return json({ ok: false, status: 'rejected', stage: 'lookup', error: 'الجلسة دي مش موجودة في اليوم ده' }, 404, request);

        const prior = (await loadConfirmations(env.DB, [batchId])).get(batchId);
        if (prior) {
          const logged = await safeLog(env.DB, { type: 'session_already_confirmed', employee, notes: `الجلسة اتأكدت قبل كده`,
            extra: { result: 'already', stage: 'lookup', batchId, confirmedBy: prior.treasury_employee } });
          return json({ ok: true, status: 'already', logged,
            message: `الجلسة دي اتأكدت قبل كده (${prior.treasury_employee} — ${prior.confirmed_at})` }, 200, request);
        }

        if (!s.valid) {
          const logged = await safeLog(env.DB, { type: 'session_blocked', employee, notes: s.problems.join(' | ').slice(0, 300),
            extra: { result: 'rejected', stage: 'preflight', batchId, problems: s.problems } });
          return json({ ok: false, status: 'rejected', stage: 'preflight', logged, problems: s.problems,
            error: 'الجلسة فيها مشكلة في بيانات المصدر — مينفعش تتأكد: ' + s.problems.join(' | ') }, 200, request);
        }

        // D17: أي فرق → التسجيل ممنوع، والمحاولة بتتسجّل عشان التنبيه يفضل ظاهر
        if (receivedP !== s.expectedPiastres) {
          const diff = receivedP - s.expectedPiastres;
          const logged = await safeLog(env.DB, {
            type: 'confirm_mismatch', employee,
            notes: `المتوقع ${fmtMoney(s.expectedPiastres)} — المكتوب ${fmtMoney(receivedP)}`,
            extra: { result: 'rejected', stage: 'lookup', batchId, courier: s.courier, day: s.day,
                     expected: fmtMoney(s.expectedPiastres), received: fmtMoney(receivedP), diff: fmtMoney(diff) },
          });
          return json({ ok: false, status: 'rejected', stage: 'lookup', logged,
            expected: fmtMoney(s.expectedPiastres), received: fmtMoney(receivedP), diff: fmtMoney(diff),
            error: `المتوقع ${fmtMoney(s.expectedPiastres)} — المكتوب ${fmtMoney(receivedP)} — ` +
                   (diff < 0 ? `ناقص ${fmtMoney(-diff)}` : `زيادة ${fmtMoney(diff)}`) }, 200, request);
        }

        // فحص التوازن: Σ الحركات = المتوقع
        const entries = buildEntries(s);
        const sum = entries.reduce((t, e) => t + e.amount_piastres, 0);
        if (sum !== s.expectedPiastres) {
          return json({ ok: false, status: 'error', stage: 'preflight',
            error: `فحص التوازن فشل: مجموع الحركات ${fmtMoney(sum)} ≠ المتوقع ${fmtMoney(s.expectedPiastres)}` }, 500, request);
        }

        // الكتابة ذرّية: صف التأكيد + كل الحركات في db.batch() واحد (D1 بينفّذه كـ transaction)
        const now = new Date().toISOString();
        const flags = [s.incomplete ? 'incomplete' : null, s.warnings.length ? 'warnings' : null].filter(Boolean).join(',') || null;
        const stmts = [env.DB.prepare(
          `INSERT INTO treasury_confirmations
             (batch_id, confirmed_at, cairo_day, courier, collector_employee, treasury_employee,
              expected_piastres, received_piastres, rows_count, session_flags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(batchId, now, s.day, s.courier, s.collector, employee, s.expectedPiastres, receivedP, entries.length, flags)];
        for (const e of entries) {
          stmts.push(env.DB.prepare(
            `INSERT INTO treasury_ledger
               (created_at, order_id, order_name, kind, amount_piastres, note, source, source_log_id,
                source_batch_id, courier, collector_employee, treasury_employee, confirmation_id, reverses_id, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM treasury_confirmations WHERE batch_id = ?), NULL, ?)`
          ).bind(now, e.order_id, e.order_name, e.kind, e.amount_piastres, e.note, e.source, e.source_log_id,
                 batchId, s.courier, s.collector, employee, batchId, e.idempotency_key));
        }
        try {
          await env.DB.batch(stmts);
        } catch (e) {
          const dup = /UNIQUE/i.test(e.message || '');
          const logged = await safeLog(env.DB, { type: dup ? 'session_already_confirmed' : 'confirm_failed', employee,
            notes: String(e.message).slice(0, 250), extra: { result: dup ? 'already' : 'error', stage: 'write', batchId } });
          if (dup) return json({ ok: true, status: 'already', logged, message: 'الجلسة دي اتأكدت لتو من جهاز تاني' }, 200, request);
          return json({ ok: false, status: 'error', stage: 'write', logged, error: 'فشلت كتابة الدفتر (مفيش حاجة اتسجّلت): ' + e.message }, 500, request);
        }

        // المرآة على الأوردرات — بعد نجاح D1. فشلها = warning + قايمة الأوردرات اللي محتاجة rebuild.
        const costLog = [];
        const orderIds = [...new Set(entries.map(e => e.order_id))];
        let mirror;
        try { mirror = await writeMirror(env, orderIds, costLog); }
        catch (e) { mirror = { done: [], failed: orderIds.map(orderId => ({ orderId, error: e.message })) }; }

        const status = mirror.failed.length ? 'warning' : 'success';
        const logged = await safeLog(env.DB, {
          type: 'session_confirmed', employee, orderName: null,
          valueAfter: s.expectedPiastres / 100,
          notes: `${s.courier || '—'} · ${entries.length} حركة · ${fmtMoney(s.expectedPiastres)}` + (s.incomplete ? ' · جلسة ناقصة' : ''),
          extra: { result: status, stage: 'write', batchId, day: s.day, courier: s.courier, collector: s.collector,
                   entries: entries.length, expected: fmtMoney(s.expectedPiastres), incomplete: s.incomplete,
                   mirrorFailed: mirror.failed.slice(0, 20) },
        });
        return json({
          ok: true, status, logged,
          summary: { batchId, courier: s.courier, collector: s.collector, day: s.day,
                     entries: entries.length, orders: orderIds.length, net: fmtMoney(s.expectedPiastres),
                     extraShipping: fmtMoney(s.extraShipping.reduce((a, x) => a + x.piastres, 0)),
                     incomplete: s.incomplete },
          mirror: { written: mirror.done.length, failed: mirror.failed },
          message: status === 'warning'
            ? `الدفتر اتسجّل ✓ لكن المرآة على ${mirror.failed.length} أوردر ما اتكتبتش — استخدم «إعادة بناء المرآة».`
            : 'تم تسجيل التوريد',
        }, 200, request);
      }

      // ─── §LEDGER::settle_historical — تسوية تاريخية ليوم واحد (أحمد بس + PIN) · 🆕 v1.2.0 ───
      // الجلسات دي اتوردت بالطريقة القديمة قبل تشغيل الأداة — بتتسجّل من غير عدّ (استثناء صريح من D16/D17 بقرار أحمد 05-11-2026).
      // dryRun:true = معاينة من غير أي كتابة. التنفيذ = كل جلسات اليوم المؤهلة في db.batch() واحد (يا كلها يا ولا حاجة).
      // المستثنى (بيتعالج يدوي): blocked · incomplete (ومنها بوسطة الناقصة) · اللي عليها محاولة بفرق · النهارده.
      // المرآة مش هنا — الواجهة بتبنيها بعدها على دفعات بـ rebuild_mirror (orderIds راجعة في الرد).
      if (action === 'settle_historical') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const body = await request.json().catch(() => ({}));
        const { date, employee } = body;
        const dryRun = body.dryRun === true;
        const reject = async (error, code = 200, stage = 'preflight') => {
          const logged = dryRun ? false : await safeLog(env.DB, { type: 'historical_settle_rejected', employee: employee || null,
            notes: String(error).slice(0, 250), extra: { result: 'rejected', stage, day: date || null } });
          return json({ ok: false, status: 'rejected', stage, logged, error }, code, request);
        };
        const bad = checkDate(date);
        if (bad) return reject(bad, 400);
        if (date >= cairoDate()) return reject('النهارده مينفعش يتسوّى — بيتسجّل بالعدّ زي العادي', 400);
        if (!employee || !SETTLE_ADMINS.has(employee)) return reject('التسوية التاريخية مسموحة لأحمد بس', 403);
        let who = null;
        try { who = await verifyEmployee(env.DB, employee, String(body.pin ?? '')); }
        catch (e) { return reject(e.message, 403); }
        if (!who) return reject('الـ PIN غلط', 403);

        const sessions = await loadDaySessions(env.DB, date);
        const confs = await loadConfirmations(env.DB, sessions.map(s => s.batchId));
        const mism  = await loadMismatches(env.DB, cairoDayBoundsUTC(date).start);
        const eligible = [], skipped = [];
        let alreadyConfirmed = 0;
        for (const s of sessions) {
          if (confs.has(s.batchId)) { alreadyConfirmed++; continue; }
          const base = { batchId: s.batchId, courier: s.courier, collector: s.collector, rowsCount: s.rowsCount, expected: fmtMoney(s.expectedPiastres) };
          if (!s.valid)                { skipped.push({ ...base, reason: 'blocked',    detail: s.problems.join(' | ') }); continue; }
          if (s.incomplete)            { skipped.push({ ...base, reason: 'incomplete', detail: `صفوف D1 ${s.rowsCount} من ${s.batchExpected?.orders ?? '؟'}` }); continue; }
          if (mism.has(s.batchId))     { const m = mism.get(s.batchId);
                                         skipped.push({ ...base, reason: 'diff', detail: `محاولة بفرق: المتوقع ${m.expected} — المكتوب ${m.received}` }); continue; }
          const entries = buildEntries(s);
          if (entries.reduce((t, e) => t + e.amount_piastres, 0) !== s.expectedPiastres) {
            skipped.push({ ...base, reason: 'blocked', detail: 'فحص التوازن فشل' }); continue;
          }
          eligible.push({ s, entries });
        }
        const totalP = eligible.reduce((t, x) => t + x.s.expectedPiastres, 0);
        const orderIds = [...new Set(eligible.flatMap(x => x.entries.map(e => e.order_id)))];
        const summary = {
          day: date, sessions: eligible.length, entries: eligible.reduce((t, x) => t + x.entries.length, 0),
          orders: orderIds.length, expected: fmtMoney(totalP), expectedPiastres: totalP, alreadyConfirmed,
          eligible: eligible.map(({ s, entries }) => ({ batchId: s.batchId, courier: s.courier, collector: s.collector,
            rowsCount: s.rowsCount, entries: entries.length, expected: fmtMoney(s.expectedPiastres), warnings: s.warnings })),
          skipped,
        };
        if (dryRun) return json({ ok: true, status: 'preview', ...summary }, 200, request);
        if (!eligible.length) return json({ ok: true, status: 'nothing', ...summary, orderIds: [],
          message: 'مفيش جلسات مؤهلة للتسوية في اليوم ده' }, 200, request);

        const now = new Date().toISOString();
        const stmts = [];
        for (const { s, entries } of eligible) {
          const flags = [FLAG_HISTORICAL, s.warnings.length ? 'warnings' : null].filter(Boolean).join(',');
          stmts.push(env.DB.prepare(
            `INSERT INTO treasury_confirmations
               (batch_id, confirmed_at, cairo_day, courier, collector_employee, treasury_employee,
                expected_piastres, received_piastres, rows_count, session_flags)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(s.batchId, now, s.day, s.courier, s.collector, employee, s.expectedPiastres, s.expectedPiastres, entries.length, flags));
          for (const e of entries) {
            const note = e.note ? `${NOTE_HISTORICAL} · ${e.note}` : NOTE_HISTORICAL;
            stmts.push(env.DB.prepare(
              `INSERT INTO treasury_ledger
                 (created_at, order_id, order_name, kind, amount_piastres, note, source, source_log_id,
                  source_batch_id, courier, collector_employee, treasury_employee, confirmation_id, reverses_id, idempotency_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM treasury_confirmations WHERE batch_id = ?), NULL, ?)`
            ).bind(now, e.order_id, e.order_name, e.kind, e.amount_piastres, note, e.source, e.source_log_id,
                   s.batchId, s.courier, s.collector, employee, s.batchId, e.idempotency_key));
          }
        }
        try {
          await env.DB.batch(stmts);
        } catch (e) {
          const dup = /UNIQUE/i.test(e.message || '');
          const logged = await safeLog(env.DB, { type: 'confirm_failed', employee, notes: String(e.message).slice(0, 250),
            extra: { result: 'error', stage: 'write', day: date, historical: true } });
          return json({ ok: false, status: 'error', stage: 'write', logged,
            error: (dup ? 'جلسة من اليوم ده اتأكدت من جهاز تاني أثناء التسوية — ' : 'فشلت كتابة الدفتر — ') +
                   'مفيش حاجة اتسجّلت. اعمل معاينة تاني.' + (dup ? '' : ' ' + e.message) }, 500, request);
        }
        const logged = await safeLog(env.DB, {
          type: 'historical_settled', employee, valueAfter: totalP / 100,
          notes: `تسوية ${date}: ${eligible.length} جلسة · ${summary.entries} حركة · ${fmtMoney(totalP)}` + (skipped.length ? ` · مستثنى ${skipped.length}` : ''),
          extra: { result: 'success', stage: 'write', day: date, sessions: eligible.length, entries: summary.entries,
                   expected: fmtMoney(totalP), batchIds: eligible.map(x => x.s.batchId).slice(0, 60),
                   skipped: skipped.map(x => ({ batchId: x.batchId, reason: x.reason })).slice(0, 30) },
        });
        return json({ ok: true, status: 'success', logged, ...summary, orderIds,
          message: `اتسوّت ${eligible.length} جلسة (${fmtMoney(totalP)}) — اكتب المرآة على ${orderIds.length} أوردر` }, 200, request);
      }

      // ─── §LEDGER::reverse_entry — تصحيح بصف REVERSAL جديد (الأصل ما بيتغيّرش) ───
      if (action === 'reverse_entry') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { entryId, employee, reason } = await request.json().catch(() => ({}));
        if (!(await requireActiveEmployee(env.DB, employee))) return json({ ok: false, status: 'rejected', stage: 'preflight', error: 'الموظف غير معروف أو موقوف' }, 403, request);
        const id = parseInt(entryId, 10);
        if (!Number.isFinite(id)) return json({ ok: false, status: 'rejected', stage: 'preflight', error: 'رقم الحركة مطلوب' }, 400, request);
        const orig = await env.DB.prepare('SELECT * FROM treasury_ledger WHERE id = ?').bind(id).first();
        if (!orig) return json({ ok: false, status: 'rejected', stage: 'lookup', error: 'الحركة مش موجودة' }, 404, request);
        if (orig.kind === KIND.REV) return json({ ok: false, status: 'rejected', stage: 'lookup', error: 'مينفعش تلغي حركة تصحيح — سجّل حركة جديدة بدالها' }, 200, request);
        const already = await env.DB.prepare('SELECT id FROM treasury_ledger WHERE reverses_id = ?').bind(id).first();
        if (already) return json({ ok: true, status: 'already', message: `الحركة #${id} اتلغت قبل كده (#${already.id})` }, 200, request);

        const note = (`يلغي #${id}` + (reason ? ` — ${String(reason).trim().slice(0, 120)}` : ''));
        try {
          await env.DB.prepare(
            `INSERT INTO treasury_ledger
               (created_at, order_id, order_name, kind, amount_piastres, note, source, source_log_id,
                source_batch_id, courier, collector_employee, treasury_employee, confirmation_id, reverses_id, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?, 'reversal', NULL, ?, ?, ?, ?, NULL, ?, ?)`
          ).bind(new Date().toISOString(), orig.order_id, orig.order_name, KIND.REV, -orig.amount_piastres, note,
                 orig.source_batch_id, orig.courier, orig.collector_employee, employee, id, `rev:${id}`).run();
        } catch (e) {
          if (/UNIQUE/i.test(e.message || '')) return json({ ok: true, status: 'already', message: `الحركة #${id} اتلغت قبل كده` }, 200, request);
          return json({ ok: false, status: 'error', stage: 'write', error: 'فشلت كتابة التصحيح: ' + e.message }, 500, request);
        }
        let mirror;
        try { mirror = await writeMirror(env, [orig.order_id]); }
        catch (e) { mirror = { done: [], failed: [{ orderId: orig.order_id, error: e.message }] }; }
        const status = mirror.failed.length ? 'warning' : 'success';
        const newRow = await env.DB.prepare('SELECT id FROM treasury_ledger WHERE reverses_id = ?').bind(id).first();
        const logged = await safeLog(env.DB, { type: 'entry_reversed', employee, orderId: orig.order_id, orderName: orig.order_name,
          delta: -orig.amount_piastres / 100, notes: note,
          extra: { result: status, stage: 'write', reversedId: id, newId: newRow?.id ?? null, mirrorFailed: mirror.failed } });
        return json({ ok: true, status, logged, reversalId: newRow?.id ?? null, mirror: { failed: mirror.failed },
          message: status === 'warning' ? 'التصحيح اتسجّل لكن المرآة ما اتكتبتش — استخدم «إعادة بناء المرآة»' : 'تم التصحيح' }, 200, request);
      }

      // ─── §LEDGER::rebuild_mirror — إعادة بناء الميتافيلدين من D1 (لأوردرات أو ليوم) ───
      if (action === 'rebuild_mirror') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { orderIds, date, employee } = await request.json().catch(() => ({}));
        if (!(await requireActiveEmployee(env.DB, employee))) return json({ ok: false, status: 'rejected', stage: 'preflight', error: 'الموظف غير معروف أو موقوف' }, 403, request);
        let ids = Array.isArray(orderIds) ? orderIds.map(String).filter(x => /^\d+$/.test(x)) : [];
        if (!ids.length && date) {
          const bad = checkDate(date);
          if (bad) return json({ ok: false, status: 'rejected', stage: 'preflight', error: bad }, 400, request);
          const { results } = await env.DB.prepare('SELECT DISTINCT order_id FROM treasury_ledger l JOIN treasury_confirmations c ON c.id = l.confirmation_id WHERE c.cairo_day = ?').bind(date).all();
          ids = (results || []).map(r => r.order_id);
        }
        ids = [...new Set(ids)];
        if (!ids.length) return json({ ok: false, status: 'rejected', stage: 'preflight', error: 'مفيش أوردرات للإعادة' }, 400, request);
        if (ids.length > MAX_ORDER_IDS) return json({ ok: false, status: 'rejected', stage: 'preflight', error: `عدد كبير: ${ids.length} — الحد ${MAX_ORDER_IDS}. قسّمهم على دفعات.` }, 400, request);
        const mirror = await writeMirror(env, ids);
        const status = mirror.failed.length ? (mirror.done.length ? 'warning' : 'error') : 'success';
        const logged = await safeLog(env.DB, { type: 'mirror_rebuilt', employee, notes: `${mirror.done.length} نجح · ${mirror.failed.length} فشل`,
          extra: { result: status, stage: 'write', count: ids.length, failed: mirror.failed.slice(0, 20) } });
        return json({ ok: status !== 'error', status, logged, written: mirror.done.length, failed: mirror.failed }, 200, request);
      }

      // ─── §LEDGER::get_order — سجل الأوردر + مقارنة Shopify + مقارنة أداة التحصيل ───
      if (action === 'get_order') {
        const raw = String(url.searchParams.get('orderName') || '').trim();
        const num = raw.replace(/^#/, '');
        if (!/^[A-Za-z0-9\-]{1,20}$/.test(num)) return json({ ok: false, error: 'رقم أوردر غير صالح' }, 400, request);   // يترفض مش يتنضّف (shopify-graphql-helper §3.1)
        const name = '#' + num;
        const { results: ledger } = await env.DB.prepare('SELECT * FROM treasury_ledger WHERE order_name = ? ORDER BY id').bind(name).all();
        const { results: src } = await env.DB.prepare(
          `SELECT id, timestamp, type, employee, json_extract(extra,'$.batchId') AS batch_id, json_extract(extra,'$.courier') AS courier,
                  json_extract(extra,'$.courierCollect') AS cc, json_extract(extra,'$.source') AS src
             FROM logs WHERE tool = ? AND type IN ('payment','refund') AND timestamp >= ? AND order_name = ? ORDER BY id`
        ).bind(SOURCE_TOOL, ORDER_HISTORY_FROM, name).all();
        const confs = await loadConfirmations(env.DB, [...new Set(src.map(r => r.batch_id).filter(Boolean))]);
        const sources = src.map(r => ({ logId: r.id, timestamp: r.timestamp, type: r.type, collector: r.employee, courier: r.courier,
          courierCollect: toPiastres(r.cc) === null ? null : fmtMoney(toPiastres(r.cc)), batchId: r.batch_id,
          confirmed: confs.has(r.batch_id), inLedger: ledger.some(l => l.source_log_id === r.id) }));
        const orderId = ledger[0]?.order_id ?? null;
        const winStart = cairoDayBoundsUTC(MIN_DATE).start;
        const pending = pendingLegsFrom(src.filter(r => r.timestamp >= winStart),
          new Set(ledger.map(l => l.source_log_id).filter(x => x !== null)), confs);

        let shopify = null, shopifyError = null, orderIdOut = orderId;
        try {
          assertEnv(env, 'shopify');
          const token = await getAccessToken(env);
          let id = orderId;
          if (!id) {                                  // مفيش حركات: دوّر بالاسم وطابق الاسم الراجع قبل أي اعتماد
            const d = await shopifyGQL(env, token, `query($q:String!){orders(first:1,query:$q){nodes{legacyResourceId name}}}`, { q: `name:${name}` }, 'findOrder');
            const n = d.data?.orders?.nodes?.[0];
            if (n && n.name === name) id = String(n.legacyResourceId);
          }
          if (id) {
            orderIdOut = id;
            const costLog = [];
            const map = await fetchShopifyOrders(env, token, [id], costLog);
            const pre = await preWindowOrderSet(env.DB, [name]);
            shopify = compareOrder(ledger, map.get(String(id)) || null, pre.has(name), pending);
            await syncSettlementAlerts(env.DB, [{ orderId: id, orderName: name, cmp: shopify }]).catch(() => {});
          }
        } catch (e) { shopifyError = e.message; }

        const total = ledger.reduce((s, e) => s + e.amount_piastres, 0);
        return json({ ok: true, orderName: name, orderId: orderIdOut,
          entries: ledger.map(e => ({ id: e.id, createdAt: e.created_at, kind: e.kind, amount: fmtSigned(e.amount_piastres),
            note: e.note, courier: e.courier, treasuryEmployee: e.treasury_employee, collector: e.collector_employee,
            source: e.source, reversesId: e.reverses_id, batchId: e.source_batch_id })),
          total: fmtMoney(total), sources, shopify, shopifyError }, 200, request);
      }

      // ─── §LEDGER::compare_orders — مقارنة Shopify لمجموعة أوردرات (الواجهة بتقسّم على دفعات) ───
      if (action === 'list_ledger_orders') {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 500);
        const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
        const { results } = await env.DB.prepare(
          'SELECT order_id, order_name FROM treasury_ledger GROUP BY order_id, order_name ORDER BY MIN(id) LIMIT ? OFFSET ?').bind(limit, offset).all();
        const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM treasury_ledger GROUP BY order_id)').first();
        return json({ ok: true, orders: results, total: cnt?.n ?? 0 }, 200, request);
      }
      if (action === 'compare_orders') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { orderIds } = await request.json().catch(() => ({}));
        const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).map(String).filter(x => /^\d+$/.test(x)))];
        if (!ids.length) return json({ ok: false, error: 'orderIds مطلوبة' }, 400, request);
        if (ids.length > MAX_ORDER_IDS) return json({ ok: false, error: `عدد كبير: ${ids.length} — الحد ${MAX_ORDER_IDS}` }, 400, request);
        assertEnv(env, 'shopify');
        const token = await getAccessToken(env);
        const costLog = [];
        const ledger = await loadLedgerByOrderIds(env.DB, ids);
        const nodes = await fetchShopifyOrders(env, token, ids, costLog);
        const names = [...ledger.values()].map(rows => rows[0].order_name);
        const pre = await preWindowOrderSet(env.DB, names);
        const legs = await loadPendingLegs(env.DB, ids, ledger);
        const results = ids.map(id => {
          const entries = ledger.get(id) || [];
          const nm = entries[0]?.order_name || null;
          return { orderId: id, orderName: nm, ...compareOrder(entries, nodes.get(id) || null, nm ? pre.has(nm) : false, legs.get(id)) };
        });
        await syncSettlementAlerts(env.DB, results.map(r => ({ orderId: r.orderId, orderName: r.orderName, cmp: r }))).catch(() => {});
        return json({ ok: true, results, queryCost: costLog }, 200, request);
      }

      // ─── §LEDGER::get_alerts — الفروق المفتوحة المحلية (محسوبة مش متخزّنة) ───
      if (action === 'get_alerts') {
        const { sessions, from } = await loadWindowSessions(env.DB);
        const confs = await loadConfirmations(env.DB);
        const mism  = await loadMismatches(env.DB, from);
        const alerts = [];
        for (const s of sessions) {
          const c = confs.get(s.batchId), m = mism.get(s.batchId);
          const base = { batchId: s.batchId, day: s.day, courier: s.courier, collector: s.collector, expected: fmtMoney(s.expectedPiastres) };
          if (!c && m) alerts.push({ type: 'DIFF', ...base, detail: `آخر محاولة: المتوقع ${m.expected} — المكتوب ${m.received} (${m.employee})`, at: m.timestamp });
          if (!s.valid && !c) alerts.push({ type: 'BLOCKED', ...base, detail: s.problems.join(' | ') });
          if (s.incomplete) alerts.push({ type: 'INCOMPLETE', ...base,
            detail: `الجلسة ناقصة: صفوف D1 ${s.rowsCount} من ${s.batchExpected?.orders ?? '؟'}` +
                    (s.batchExpected?.collect != null ? ` · ${fmtMoney(s.items.reduce((t, i) => t + i.piastres, 0))} من ${fmtMoney(s.batchExpected.collect)}` : '') +
                    (c ? ' (اتأكدت على الصفوف المكتوبة)' : '') });
        }
        // 🆕 v1.3.0: الداخل أكتر من المتحصَّل — آخر لوج للأوردر = settlement_over
        const { results: sl } = await env.DB.prepare(
          `SELECT id, timestamp, order_id, order_name, type, notes FROM logs WHERE tool = ? AND type IN ('settlement_over','settlement_cleared') ORDER BY id`).bind(TOOL_NAME).all();
        const lastSl = new Map();
        for (const r of sl || []) lastSl.set(r.order_name, r);
        for (const r of lastSl.values()) if (r.type === 'settlement_over')
          alerts.push({ type: 'OVER_COLLECTED', orderId: r.order_id, orderName: r.order_name, detail: r.notes || 'الداخل الخزنة أكتر من المتحصَّل', at: r.timestamp });
        return json({ ok: true, alerts, count: alerts.length }, 200, request);
      }

      // ─── §LEDGER::get_config ───
      if (action === 'get_config') {
        return json({ ok: true, version: WORKER_VERSION, tool: TOOL_NAME, minDate: MIN_DATE, settleAdmins: [...SETTLE_ADMINS] }, 200, request);
      }

      // ─── §DIAG — فحص ذاتي من غير أي كتابة · ممنوع يعرض قيمة أي سر ───
      if (action === 'diag') {
        const checks = [];
        const add = (label, ok, detail) => checks.push({ ok: !!ok, label, detail: detail ?? '' });
        add('WORKER_SECRET', true, `طوله ${env.WORKER_SECRET.length}`);
        for (const k of ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET'])
          add(k, env[k] !== undefined && String(env[k]).trim() !== '', env[k] === undefined ? 'غايب' : `طوله ${String(env[k]).length}`);
        add('envKeys', true, Object.keys(env).map(k => `${k}(${typeof env[k] === 'string' ? env[k].length : typeof env[k]})`).join(' · '));
        try {
          const a = await env.DB.prepare('SELECT COUNT(*) AS n FROM treasury_ledger').first();
          const b = await env.DB.prepare('SELECT COUNT(*) AS n FROM treasury_confirmations').first();
          add('D1 — treasury_ledger', true, `${a.n} حركة`);
          add('D1 — treasury_confirmations', true, `${b.n} تأكيد`);
        } catch (e) { add('D1 — جداول الدفتر', false, 'الجداول مش موجودة؟ نفّذ schema.sql — ' + e.message); }
        try {
          const lo = cairoDayBoundsUTC(MIN_DATE).start;
          const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM logs WHERE tool = ? AND type IN (\'payment\',\'refund\') AND timestamp >= ?').bind(SOURCE_TOOL, lo).first();
          add('مصدر التحصيل (cod_payment)', r.n > 0, `${r.n} صف من ${MIN_DATE}`);
        } catch (e) { add('مصدر التحصيل', false, e.message); }
        try {
          const miss = missingEnv(env, 'shopify');
          if (miss.length) throw new Error('متغيرات ناقصة: ' + miss.join('، '));
          const token = await getAccessToken(env);
          add('Shopify OAuth', true, 'التوكن اتجاب');
          const costLog = [];
          const d = await shopifyGQL(env, token, '{ currentAppInstallation { accessScopes { handle } } }', {}, 'diagScopes', costLog);
          const scopes = (d.data?.currentAppInstallation?.accessScopes || []).map(s => s.handle);
          add('صلاحية write_orders (كتابة المرآة)', scopes.includes('write_orders'), scopes.includes('write_orders') ? 'موجودة' : 'ناقصة — كتابة الميتافيلدز هتفشل');
          add('صلاحية read_orders / read_returns', scopes.includes('read_orders') || scopes.includes('write_orders'), 'read_returns: ' + (scopes.includes('read_returns') || scopes.includes('write_returns') ? 'موجودة' : 'ناقصة — المقارنة بالمرتجعات مش هتكمل'));
          add('read_all_orders (أوردرات أقدم من ٦٠ يوم)', scopes.includes('read_all_orders'), 'من غيرها: أوردر أقدم من ٦٠ يوم بيرجع "غير موجود" بدل خطأ صلاحية');
          add('throttleStatus', true, JSON.stringify(_lastThrottle));
          add('actualQueryCost (آخر نداء)', true, JSON.stringify(_lastQueryCost));
          // تعريفات الميتافيلد — لازم أحمد يكون عملها
          const defs = await shopifyGQL(env, token, `{ metafieldDefinitions(first: 5, ownerType: ORDER, namespace: "custom", key: "treasury_log") { nodes { key type { name } } } d2: metafieldDefinitions(first: 5, ownerType: ORDER, namespace: "custom", key: "treasury_total") { nodes { key type { name } } } }`, {}, 'diagDefs', costLog);
          const l = defs.data?.metafieldDefinitions?.nodes?.[0], t = defs.data?.d2?.nodes?.[0];
          add('تعريف custom.treasury_log', l && l.type.name === MF_LOG.type, l ? `النوع ${l.type.name}` : 'مش معمول — اعمله من Settings → Custom data → Orders');
          add('تعريف custom.treasury_total', t && t.type.name === MF_TOTAL.type, t ? `النوع ${t.type.name}` : 'مش معمول — اعمله من Settings → Custom data → Orders');
        } catch (e) { add('Shopify', false, e.message); }
        add('CORS origins', true, ALLOWED_ORIGINS.join(' · '));
        return json({ ok: checks.every(c => c.ok), version: WORKER_VERSION, checks }, 200, request);
      }

      // ─── §LOG-ENDPOINTS ───────────────────────────────────────────
      if (action === 'get_logs') {
        const p = logParamsFrom(url, TOOL_NAME);
        const limitRaw  = parseInt(url.searchParams.get('limit')  || '100', 10);
        const offsetRaw = parseInt(url.searchParams.get('offset') || '0',   10);
        const limit  = Number.isFinite(limitRaw)  ? Math.min(Math.max(limitRaw, 1), 100) : 100;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
        const entries = await getLogs(env.DB, { ...p, limit, offset,
          sortBy: url.searchParams.get('sortBy'), sortDir: url.searchParams.get('sortDir') });
        return json({ ok: true, entries }, 200, request);
      }
      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, logParamsFrom(url, TOOL_NAME));
        return json({ ok: true, total }, 200, request);
      }
      if (action === 'get_logs_export') {
        const p = logParamsFrom(url, TOOL_NAME);
        const [entries, total] = await Promise.all([getLogsExport(env.DB, p), getLogsCount(env.DB, p)]);
        return json({ ok: true, entries, cap: LOG_EXPORT_MAX, total, truncated: total > LOG_EXPORT_MAX }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      return json({ error: 'Unknown action' }, 404, request);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500, request);
    }
  },
};
