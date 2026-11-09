# 🛒 FreshMart — Supermarket POS (Production-oriented)

A production-oriented point-of-sale foundation for supermarkets: **zero npm dependencies** (Node.js ≥ 22 built-ins only), SQLite database, user accounts with roles, cash shifts with reconciliation, loyalty points, returns, offline sales queue, and optional Stripe card checkout.

## Quick start

```bash
node server.js          # or: npm start
```

Open http://localhost:3000 and sign in with the seeded admin account:

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | Admin (full access) |

> ⚠️ **Change the admin password immediately** (Settings → My password), then create cashier accounts for your staff.

## Features

- **Point of Sale** — product grid, search, barcode entry (keyboard-wedge scanners work out of the box), discounts, configurable tax, printable receipts
- **Users & roles** — Admin (inventory, settings, users, voids/refunds, backups) vs Cashier (selling only); scrypt password hashing, 12-hour sessions, login rate limiting
- **Shifts** — open/close with opening float, expected-vs-counted cash reconciliation, per-shift history
- **Loyalty** — customers with phone numbers, earn points per dollar spent, redeem points at checkout
- **Returns** — void/refund actions restore stock and loyalty points. These are internal records only; a card refund must still be issued through your payment provider.
- **Reports** — today's revenue/transactions, top products, sales by cashier, low-stock alerts, CSV export
- **Offline mode** — the app shell is cached (service worker); sales made offline are queued and synced automatically on reconnect
- **Backups** — full JSON export/import of products, sales, customers and settings
- **Stripe checkout (USD)** — set `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY`; when configured, the server verifies PaymentIntent status and exact sale amount before recording a card sale. Without keys, card payments are simulated.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `POS_DB_PATH` | `./pos.db` | SQLite database file |
| `STRIPE_SECRET_KEY` | — | Stripe secret key (enables live card payments) |
| `STRIPE_PUBLISHABLE_KEY` | — | Stripe publishable key |

Store settings (name, tax rate, currency, low-stock threshold, register name, loyalty rates) are managed in **Settings** and stored in the database.

## Data & backups

- All data lives in a single SQLite file (`pos.db`, WAL mode). Back it up by copying the file, or use **Settings → Export backup** for a portable JSON snapshot.
- The old demo `data.json` format is no longer used.

## Tests

```bash
npm test   # spins up a throwaway server + temp DB and exercises the API
```

## Before going live

This is a production-oriented baseline, not a certified retail deployment. Configure the correct tax and currency for your jurisdiction before use. The sample tax is a single flat rate (8%) and the sample currency is USD; it does not model multiple product tax classes. Stripe checkout currently charges USD. Card refunds are not sent to Stripe automatically. Validate payment terminal, refund, receipt, backup/restore and offline recovery procedures in a Stripe test account and staging environment before handling real customers.

## Deployment notes

- Run behind a reverse proxy (nginx/Caddy) with **HTTPS** — session cookies are `HttpOnly; SameSite=Lax`.
- For multi-register setups, run one instance per register against a shared database volume, or extend the API with a sync layer.
- Hardware: receipt printing uses the browser print dialog (thermal-printer friendly CSS included); barcode scanners in keyboard-wedge mode work without drivers.
