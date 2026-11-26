# Masscom Shop Rent Management

Cloudflare Pages app for shop records, tenancy history, monthly rent, partial payments and print-ready receipts.

## Cloudflare setup

1. Create a separate D1 database named `masscom-shop-rent` and apply `schema.sql` followed by `migrations/001_markets_and_tenants.sql` and `migrations/002_opening_balance_and_deposit.sql`, then `migrations/003_upi_transaction_id.sql`, then `migrations/004_manual_receipt_number.sql` and `migrations/005_tenant_profile.sql`, then `migrations/006_tenant_photo.sql`, then `migrations/007_tenant_id_number.sql`.
2. Create a Pages project named `masscom-shop` with GitHub repository `domansari/masscom-shop`, production branch `main`, no framework or build command, and output directory `public`.
3. In the Pages project, add the D1 binding `SHOP_DB` pointing to `masscom-shop-rent`. Add a production secret named `ADMIN_PASSWORD` with a randomly generated password of 8–20 characters. Redeploy after changing settings.
4. Open the Pages URL, sign in, and check the empty ledger. Add `shop.masscom.co.in` under the Pages project's Custom Domains.

Each tenancy uses a fixed monthly rate and inclusive first and last billable months. A new tenancy can begin the month after the old tenancy ends. Previous months with unpaid balances count as arrears. Payments are recorded against the rent month selected by the admin.
