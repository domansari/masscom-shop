CREATE TABLE IF NOT EXISTS markets (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL);
ALTER TABLE shops ADD COLUMN market_id TEXT REFERENCES markets(id);
ALTER TABLE leases ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
INSERT INTO tenants (id,name,phone) SELECT id,tenant,phone FROM leases WHERE tenant_id IS NULL;
UPDATE leases SET tenant_id=id WHERE tenant_id IS NULL;
INSERT INTO markets VALUES ('fatak','फाटक मार्किट','FT'), ('mohsin','मोहसिन मार्किट','MM'), ('bazaar-mohsin','बाज़ार मोहसिन मार्किट','BM'), ('bazaar-ahsan','बाज़ार अहसान ब्लाक','BA'), ('ahsan','अहसान ब्लाक','AB'), ('gafoor','गफूर मार्केट','GM');
WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<30),
limits(id,total) AS (VALUES ('fatak',16), ('mohsin',30), ('bazaar-mohsin',24), ('bazaar-ahsan',24), ('ahsan',13), ('gafoor',20))
INSERT INTO shops (id,code,address,market_id)
SELECT markets.id || '-' || n, markets.prefix || '-' || printf('%02d',n), '', markets.id
FROM markets JOIN limits USING(id) JOIN numbers ON n<=total;
CREATE INDEX shops_market ON shops(market_id);
CREATE INDEX leases_tenant ON leases(tenant_id);
