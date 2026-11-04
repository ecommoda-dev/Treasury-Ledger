CREATE TABLE IF NOT EXISTS treasury_confirmations (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL UNIQUE, confirmed_at TEXT NOT NULL, cairo_day TEXT NOT NULL, courier TEXT, collector_employee TEXT, treasury_employee TEXT NOT NULL, expected_piastres INTEGER NOT NULL, received_piastres INTEGER NOT NULL, rows_count INTEGER NOT NULL, session_flags TEXT);
CREATE TABLE IF NOT EXISTS treasury_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, order_id TEXT, order_name TEXT, kind TEXT NOT NULL CHECK (kind IN ('CASH_IN','CASH_OUT','REVERSAL')), amount_piastres INTEGER NOT NULL, note TEXT, source TEXT NOT NULL, source_log_id INTEGER, source_batch_id TEXT, courier TEXT, collector_employee TEXT, treasury_employee TEXT NOT NULL, confirmation_id INTEGER, reverses_id INTEGER, idempotency_key TEXT NOT NULL UNIQUE);
CREATE INDEX IF NOT EXISTS idx_tl_order_id ON treasury_ledger (order_id);
CREATE INDEX IF NOT EXISTS idx_tl_order_name ON treasury_ledger (order_name);
CREATE INDEX IF NOT EXISTS idx_tl_reverses ON treasury_ledger (reverses_id);
CREATE INDEX IF NOT EXISTS idx_tl_batch ON treasury_ledger (source_batch_id);
CREATE INDEX IF NOT EXISTS idx_tc_day ON treasury_confirmations (cairo_day);
