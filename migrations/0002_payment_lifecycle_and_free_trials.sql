CREATE TABLE IF NOT EXISTS payment_lifecycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  route TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'challenge_issued', 'settled_success', 'verify_failed',
    'facilitator_error', 'handler_failed'
  )),
  payer_class TEXT NOT NULL CHECK (payer_class IN (
    'no_payment_header', 'payment_header_present_unsettled',
    'settled_external', 'settled_self'
  )),
  client_class TEXT NOT NULL CHECK (client_class IN (
    'known_crawler', 'agent_client', 'browser', 'unknown'
  ))
);

CREATE INDEX IF NOT EXISTS payment_lifecycle_events_summary
  ON payment_lifecycle_events (outcome, payer_class);

CREATE TABLE IF NOT EXISTS free_trial_allowances (
  client_hash TEXT PRIMARY KEY,
  last_success_at TEXT,
  reservation_id TEXT,
  reservation_at TEXT
);
