CREATE TABLE IF NOT EXISTS deposit_returns (
  lease_id TEXT PRIMARY KEY REFERENCES leases(id),
  returned_on TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  attachment_data TEXT,
  attachment_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
