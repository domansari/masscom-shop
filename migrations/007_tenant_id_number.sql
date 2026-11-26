ALTER TABLE tenants ADD COLUMN tenant_id_number TEXT CHECK (tenant_id_number IS NULL OR (length(tenant_id_number)=12 AND tenant_id_number NOT GLOB '*[^0-9]*'));
