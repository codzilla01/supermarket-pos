# 🛒 FreshMart — Supermarket POS (Production-oriented)

نظام نقاط بيع سوبر ماركت بواجهة **عربية كاملة (RTL)** وإنجليزية، وبدون أي حزم خارجية (**zero npm dependencies** — Node.js ≥ 22 built-ins only): قاعدة بيانات SQLite، حسابات وأدوار، ورديات كاشير مع تسوية نقدية، نقاط ولاء، مرتجعات، طابور بيع دون اتصال، تحصيل نقدي فقط، وفترة تجريبية 14 يومًا مع اشتراك سنوي.

A supermarket point-of-sale application and subscription-managed installation: **zero npm dependencies** (Node.js ≥ 22 built-ins only), SQLite database, user accounts with roles, cash shifts with reconciliation, loyalty points, returns, offline sales queue, cash-only checkout, and a 14-day trial / annual license lifecycle.

## 🌐 اللغة والاتجاه (Language & direction)

- **العربية هي اللغة الافتراضية** مع اتجاه RTL وخط عربي مناسب؛ الإنجليزية متاحة بضغطة واحدة من زر اللغة أعلى الشاشة أو من **الإعدادات → اللغة**.
- التبديل يُحفظ **على هذا الجهاز فقط** (`localStorage`)، فلا يتأثر بقية أجهزة الكاشير؛ بيانات المتجر والأسعار والمستخدمين مشتركة كما هي.
- أسماء **الأقسام والوحدات** تظهر مترجمة (خضار وفواكه، ألبان وبيض، قطعة، كجم…) لكنها تُحفظ في قاعدة البيانات بالإنجليزية القياسية، حتى تبقى الفلاتر والتقارير وتصدير CSV متسقة بين اللغتين.
- **الأرقام والتواريخ تبقى بالأرقام اللاتينية** (1234.50) لتوافق الباركود وسرعة الكاشير، مع فواصل وتنسيق حسب اللغة.
- **رسائل أخطاء الخادم** ترجع بالإنجليزية `error` والعربية `messageAr` معًا؛ الواجهة تعرض الرسالة المطابقة للغة النشطة دون كسر أي عميل API قديم.
- الأسماء التي يكتبها المستخدم (منتجات، عملاء، اسم المتجر، تذييل الإيصال) تُعرض كما هي بغض النظر عن اللغة، والإيصال الحراري 80mm يُطبع من اليمين لليسار في الوضع العربي.

## Secure first startup

Set three private environment variables in the service manager before starting. Use unique random secrets of at least 16 characters; do not put them in Git or share them with store staff:

- `POS_INITIAL_ADMIN_PASSWORD` — one-time seed password for the first `admin` login in a fresh DB. The admin must rotate it at first sign-in.
- `POS_DEVELOPER_USERNAME` and `POS_DEVELOPER_PASSWORD` — protected developer-console credentials. The developer account is provisioned/rotated at server startup and is separate from store admin accounts.

Copy `.env.example` as a checklist for your process manager (Node does not load `.env` automatically), set the secrets, then run:

```bash
node server.js          # or: npm start
```

Open http://localhost:3000 and sign in as `admin` with the initial password you configured. Then create cashier accounts and have each cashier rotate their temporary password. The developer signs in with the separate environment-configured account.

## Features

- **Bilingual Arabic/English UI** — Arabic RTL by default with a per-terminal language switch, localized categories/units/statuses, Arabic server error messages, and a thermal receipt that prints in the active direction
- **Point of Sale** — product grid, search, barcode entry (keyboard-wedge scanners work out of the box), discounts, store default plus per-product tax rates, configurable receipt address/phone/VAT number/footer, 80 mm thermal-print layout; sale retries use idempotency keys
- **Starter catalog** — 33 default grocery items; admins can add missing starter products and edit names, prices, tax rates, and stock from Inventory without overwriting existing edits
- **Notifications** — persistent visual alert center with optional tones, browser notifications, low/out-of-stock alerts, cash sale/shift events, and offline/sync warnings
- **Users & roles** — Admin (inventory, settings, users, voids/refunds, backups) vs Cashier (selling only); scrypt password hashing, 12-hour sessions, login rate limiting
- **Shifts** — independent open/close sessions and cash reconciliation per named register; multiple browser terminals can connect to the same POS server
- **Loyalty** — customers with phone numbers, earn points per store-currency unit spent, redeem points at checkout
- **Returns** — cash-sale void/refund actions restore stock and loyalty points. Historical card refunds are blocked unless provider credentials and the original PaymentIntent reference are available; then full refunds use an idempotency key.
- **Reports** — today's revenue/transactions, top products, sales by cashier, low-stock alerts, CSV export
- **Offline mode** — the app shell is cached (service worker); offline sales remain queued if sync is rejected, can be retried from the queue badge, and carry idempotency keys to prevent duplicate recording
- **Backups** — JSON export/import of products, sales, sale items, shifts, customers and settings (user credentials are not exported)
- **Cash-only checkout** — card buttons and card-sale API requests are disabled; each new transaction must include the cash tendered and calculates change. A server-side Stripe secret is only used to refund historical card sales.
- **Annual subscription lifecycle** — fresh installs begin with a 14-day trial; developer console records manual payment references, activates/extends a 365-day annual subscription, suspends/restores service, and records an audit timeline. POS APIs are blocked after expiry/suspension while subscription status and logout remain available.
- **Developer control center** — separate env-provisioned developer account, store metrics, license dates/status, last activity, activation/login history, payment receipt references, manual annual renewal, suspension and restoration. This console manages the *current installation only*.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `POS_DB_PATH` | `./pos.db` | SQLite database file |
| `POS_INITIAL_ADMIN_PASSWORD` | required | First-run admin password for a new DB (16+ characters) |
| `POS_DEVELOPER_USERNAME` | required | Separate developer-console account |
| `POS_DEVELOPER_PASSWORD` | required | Developer-console secret (16+ characters) |
| `POS_COOKIE_SECURE` | `true` | Secure session cookies; set false only for local plain HTTP |
| `STRIPE_SECRET_KEY` | — | Optional; used only for refunds of historical Stripe card sales (new checkout is cash-only) |

Store settings (name, tax rate, currency, low-stock threshold, register name, loyalty rates) are managed in **Settings** and stored in the database. Egyptian pound (EGP / ج.م) is the default display currency; set product prices and validate all local tax rules for each store.

## Data & backups

- All data lives in a single SQLite file (`pos.db`, WAL mode). Back it up by copying the file, or use **Settings → Export backup** for a portable JSON snapshot.
- The old demo `data.json` format is no longer used.
- Subscription dates and audit records are stored in SQLite; the developer console logs successful logins, renewals, suspensions and restorations.

## Tests and health check

```bash
npm test   # API tests (temporary database) + localization/translation tests
```

The localization suite (`test/i18n.test.js`) fails the build if any translation key used by the UI is missing in Arabic or English, if a placeholder such as `{id}` disappears in either language, or if an API error loses its Arabic `messageAr`.

The unauthenticated `GET /healthz` endpoint returns `{ "status": "ok" }` after confirming SQLite responds; CI runs the same suite on pushes and pull requests.

## Before going live

This remains a production-oriented baseline, not a certified retail deployment or remotely hosted subscription platform. Configure the store default and per-product tax rates and verify local invoicing/fiscal rules; the software does not decide which rate applies to a product. Checkout is cash-only. Historical Stripe card refunds can be sent only when the original PaymentIntent reference exists and `STRIPE_SECRET_KEY` is configured; partial refunds, provider webhooks/reconciliation and fiscal integrations are not implemented. Validate cash reconciliation, receipt, backup/restore and offline recovery in staging before handling customers.

## Subscription scope and deployment

The developer console and its license/audit data live in the same SQLite database as the POS. For the selected separate-installation model, the current implementation can activate and monitor one installation at a time; the developer must connect to each store installation. It does **not** remotely aggregate, provision or suspend other independent servers. A central multi-store control plane requires a separately hosted licensing API, secure per-install credentials and an agreed domain; it is not included in this repository. Annual activation is manual after the developer records a payment/receipt reference—there is no online recurring billing or automatic payment verification.

## Deployment notes

- Run behind a reverse proxy (nginx/Caddy) with **HTTPS** — session cookies are `HttpOnly; SameSite=Lax; Secure` by default. Set `POS_COOKIE_SECURE=false` only for local plain-HTTP development.
- Multiple named registers may use the same running POS server and database; set a distinct terminal/register ID in Settings on each browser. Do not run multiple Node instances against a shared SQLite file—use a dedicated database/sync service before horizontal scaling.
- Hardware: receipt printing uses the browser print dialog (thermal-printer friendly CSS included); barcode scanners in keyboard-wedge mode work without drivers.
