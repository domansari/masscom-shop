ALTER TABLE payments ADD COLUMN receipt_number TEXT;
CREATE UNIQUE INDEX payments_receipt_number_unique ON payments(receipt_number COLLATE NOCASE) WHERE receipt_number IS NOT NULL;
