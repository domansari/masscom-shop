ALTER TABLE tenants ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1));
ALTER TABLE leases ADD COLUMN deposit_receipt_number TEXT;
ALTER TABLE leases ADD COLUMN deposit_paid_on TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS leases_deposit_receipt_number
  ON leases(deposit_receipt_number);

UPDATE leases
SET deposit_receipt_number='SD-HIST-' || replace(id,'-','')
WHERE deposit>0 AND deposit_receipt_number IS NULL;
