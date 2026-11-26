CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  address TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  tenant TEXT NOT NULL,
  phone TEXT NOT NULL,
  rent INTEGER NOT NULL CHECK(rent > 0),
  start_month TEXT NOT NULL,
  end_month TEXT CHECK(end_month >= start_month)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_lease ON leases(shop_id) WHERE end_month IS NULL;
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL REFERENCES leases(id),
  month TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  method TEXT NOT NULL CHECK(method IN ('Cash','UPI','Bank Transfer','Cheque')),
  paid_on TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_month ON payments(lease_id, month);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
