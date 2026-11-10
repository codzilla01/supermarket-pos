# 🛒 FreshMart — Supermarket POS (Production-oriented)

A production-oriented point-of-sale foundation for supermarkets: **zero npm dependencies** (Node.js ≥ 22 built-ins only), SQLite database, user accounts with roles, cash shifts with reconciliation, loyalty points, returns, offline sales queue, and cash-only checkout.

## Quick start

```bash
node server.js          # or: npm start
```

Open http://localhost:3000 and sign in with the seeded admin account:

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | Admin (full access) |

> ⚠️ The seeded admin must change the starter password at first login (12+ characters) before accessing the POS. Then create cashier accounts and have each cashier rotate their temporary password.

## Features

- **Point of Sale** — product grid, search, barcode entry (keyboard-wedge scanners work out of the box), discounts, store default plus per-product tax rates, configurable receipt address/phone/VAT number/footer, 80 mm thermal-print layout; sale retries use idempotency keys
- **Starter catalog** — 33 default grocery items; admins can add missing starter products and edit names, prices, tax rates, and stock from Inventory without overwriting existing edits
- **Notifications** — persistent visual alert center with optional tones, browser notifications, low/out-of-stock alerts, cash sale/shift events, and offline/sync warnings
- **Users & roles** — Admin (inventory, settings, users, voids/refunds, backups) vs Cashier (selling only); scrypt password hashing, 12-hour sessions, login rate limiting
- **Shifts** — independent open/close sessions and cash reconciliation per named register; multiple browser terminals can connect to the same POS server
- **Loyalty** — customers with phone numbers, earn points per dollar spent, redeem points at checkout
- **Returns** — cash-sale void/refund actions restore stock and loyalty points. Historical card refunds are blocked unless provider credentials and the original PaymentIntent reference are available; then full refunds use an idempotency key.
- **Reports** — today's revenue/transactions, top products, sales by cashier, low-stock alerts, CSV export
- **Offline mode** — the app shell is cached (service worker); offline sales remain queued if sync is rejected, can be retried from the queue badge, and carry idempotency keys to prevent duplicate recording
- **Backups** — JSON export/import of products, sales, sale items, shifts, customers and settings (user credentials are not exported)
- **Cash-only checkout** — card buttons and card-sale API requests are disabled; each new transaction must include the cash tendered and calculates change. A server-side Stripe secret is only used to refund historical card sales.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `POS_DB_PATH` | `./pos.db` | SQLite database file |
| `POS_COOKIE_SECURE` | `true` | Secure session cookies; set false only for local plain HTTP |
| `STRIPE_SECRET_KEY` | — | Optional; used only for refunds of historical Stripe card sales (new checkout is cash-only) |

Store settings (name, tax rate, currency, low-stock threshold, register name, loyalty rates) are managed in **Settings** and stored in the database.

## Data & backups

- All data lives in a single SQLite file (`pos.db`, WAL mode). Back it up by copying the file, or use **Settings → Export backup** for a portable JSON snapshot.
- The old demo `data.json` format is no longer used.

## Tests and health check

```bash
npm test   # isolated API tests using a temporary database
```

The unauthenticated `GET /healthz` endpoint returns `{ "status": "ok" }` after confirming SQLite responds; CI runs the same suite on pushes and pull requests.

## Before going live

This remains a production-oriented baseline, not a certified retail deployment. Configure the store default and per-product tax rates and verify local invoicing/fiscal rules; the software does not decide which rate applies to a product. Checkout is cash-only. Historical Stripe card refunds can be sent only when the original PaymentIntent reference exists and `STRIPE_SECRET_KEY` is configured; partial refunds, provider webhooks/reconciliation and fiscal integrations are not implemented. Validate cash reconciliation, receipt, backup/restore and offline recovery in staging before handling customers.

## Deployment notes

- Run behind a reverse proxy (nginx/Caddy) with **HTTPS** — session cookies are `HttpOnly; SameSite=Lax; Secure` by default. Set `POS_COOKIE_SECURE=false` only for local plain-HTTP development.
- Multiple named registers may use the same running POS server and database; set a distinct terminal/register ID in Settings on each browser. Do not run multiple Node instances against a shared SQLite file—use a dedicated database/sync service before horizontal scaling.
- Hardware: receipt printing uses the browser print dialog (thermal-printer friendly CSS included); barcode scanners in keyboard-wedge mode work without drivers.
