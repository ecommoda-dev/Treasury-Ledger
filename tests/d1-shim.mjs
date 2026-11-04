// شيم بسيط لواجهة D1 فوق node:sqlite — للاختبارات المحلية بس (مش بيتنشر)
import { DatabaseSync } from 'node:sqlite';

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...p) { this.params = p.map(v => (v === undefined ? null : v)); return this; }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.params); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; }
}

export function makeDB(schemaSql) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, tool TEXT, type TEXT, employee TEXT, order_id TEXT, order_name TEXT, sku TEXT, product_title TEXT, delta REAL, value_before REAL, value_after REAL, notes TEXT, extra TEXT);
    CREATE INDEX idx_logs_tool_ts ON logs (tool, timestamp DESC);
    CREATE TABLE employees (username TEXT PRIMARY KEY, display_name TEXT, pin TEXT, is_active INTEGER DEFAULT 1, last_login TEXT, is_admin INTEGER DEFAULT 0);
    CREATE TABLE log_value_alerts (source_tool TEXT NOT NULL, tool TEXT NOT NULL, type TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1, worker_version TEXT, sample_order_name TEXT, sample_employee TEXT, sample_notes TEXT, status TEXT NOT NULL DEFAULT 'open', PRIMARY KEY (source_tool, tool, type));
  `);
  raw.exec(schemaSql);
  return {
    raw,
    prepare: (sql) => new Stmt(raw, sql),
    // D1 batch = transaction: لو أي statement فشل، الكل يتلغي
    async batch(stmts) {
      raw.exec('BEGIN');
      try { for (const s of stmts) raw.prepare(s.sql).run(...s.params); raw.exec('COMMIT'); return stmts.map(() => ({ success: true })); }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}
