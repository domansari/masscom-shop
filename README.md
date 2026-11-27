# Masscom Shop Rent Management

Cloudflare Pages app for shop records, tenancy history, monthly rent, partial payments and print-ready receipts.

## Cloudflare setup

1. Create a separate D1 database named `masscom-shop-rent` and apply `schema.sql` followed by `migrations/001_markets_and_tenants.sql` and `migrations/002_opening_balance_and_deposit.sql`, then `migrations/003_upi_transaction_id.sql`, then `migrations/004_manual_receipt_number.sql` and `migrations/005_tenant_profile.sql`, then `migrations/006_tenant_photo.sql`, then `migrations/007_tenant_id_number.sql`, then `migrations/008_combined_receipts.sql`, then `migrations/009_tenant_father_name.sql`, then `migrations/010_shop_blocked.sql`, then `migrations/011_tenant_status_and_deposit_receipts.sql` and `migrations/012_deposit_returns.sql` and `migrations/013_admin_password_reset.sql`.
2. Create a Pages project named `masscom-shop` with GitHub repository `domansari/masscom-shop`, production branch `main`, no framework or build command, and output directory `public`.
3. In the Pages project, add the D1 binding `SHOP_DB` pointing to `masscom-shop-rent`. Add a production secret named `ADMIN_PASSWORD` with a randomly generated password of 8–20 characters. Redeploy after changing settings.
4. Open the Pages URL, sign in, and check the empty ledger. Add `shop.masscom.co.in` under the Pages project's Custom Domains.

Each tenancy uses a fixed monthly rate and inclusive first and last billable months. A new tenancy can begin the month after the old tenancy ends. Previous months with unpaid balances count as arrears. Payments are recorded against the rent month selected by the admin.


## Admin password recovery

The first request seeds a salted PBKDF2 password hash in D1 from the existing `ADMIN_PASSWORD` secret. Password resets replace that D1 hash, expire after 30 minutes, can only be used once, and revoke all sessions.

To send reset emails, onboard `masscom.co.in` under Cloudflare Email Service > Email Sending, verify `info@masscom.co.in` as a destination address, and create a Cloudflare API token with Email Sending Edit permission for this account. In the Pages project's Production Variables and Secrets, set `CF_ACCOUNT_ID`, `ADMIN_EMAIL_FROM` (an onboarded sender such as `info@masscom.co.in`), and `CF_EMAIL_API_TOKEN` as an encrypted Secret. Optionally set `APP_BASE_URL` to `https://shop.masscom.co.in`. Redeploy after saving the settings. The reset link is sent only to `info@masscom.co.in`.

## WhatsApp rent reminders

The tenant-management page sends the approved `rent_reminder_hi` Utility template to one selected defaulter at a time. In the Pages project's Production Variables and Secrets, add `WHATSAPP_ACCESS_TOKEN` as an encrypted Secret and `WHATSAPP_PHONE_NUMBER_ID` as a variable. Optional variables are `WHATSAPP_TEMPLATE_NAME` (defaults to `rent_reminder_hi`), `WHATSAPP_TEMPLATE_LANGUAGE` (defaults to `hi`) and `WHATSAPP_GRAPH_API_VERSION` (defaults to `v27.0`). Use a permanent or long-lived access token with WhatsApp message-sending permission and the Phone Number ID belonging to the connected WhatsApp Business phone. Redeploy after saving these settings. The app calculates the current outstanding amount and its covered rental months from D1 before sending; an admin confirmation appears before each message.
