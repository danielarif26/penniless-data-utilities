CREATE TABLE IF NOT EXISTS endpoint_counters (
  endpoint TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  paid_attempts INTEGER NOT NULL DEFAULT 0,
  settled_success INTEGER NOT NULL DEFAULT 0,
  free_requests INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
