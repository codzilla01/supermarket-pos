# 🛒 FreshMart — Supermarket POS (Production-oriented)

نظام نقاط بيع سوبر ماركت بواجهة **عربية كاملة (RTL)** وإنجليزية، وبدون أي حزم خارجية (**zero npm dependencies** — Node.js ≥ 22 built-ins only): قاعدة بيانات SQLite، حسابات وأدوار، ورديات كاشير مع تسوية نقدية، نقاط ولاء، مرتجعات، **استيراد المخزون من Excel/CSV**، **سجل تدقيق**، **نسخ احتياطي تلقائي**، سجلات منظّمة، طابور بيع دون اتصال، تحصيل نقدي فقط، وفترة تجريبية 14 يومًا مع اشتراك سنوي.

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
- **Users & roles** — Admin (inventory, settings, users, voids/refunds, backups) vs Cashier (selling only); sessions use a 12-hour HttpOnly cookie and, with `POS_TOKEN_AUTH=true`, also a bearer token for environments where cookies are blocked; scrypt password hashing, 12-hour sessions, login rate limiting
- **Shifts** — independent open/close sessions and cash reconciliation per named register; multiple browser terminals can connect to the same POS server
- **Loyalty** — customers with phone numbers, earn points per store-currency unit spent, redeem points at checkout
- **Returns** — cash-sale void/refund actions restore stock and loyalty points. Historical card refunds are blocked unless provider credentials and the original PaymentIntent reference are available; then full refunds use an idempotency key.
- **Reports** — today's revenue/transactions, top products, sales by cashier, low-stock alerts, CSV export
- **Profit & margin (admin)** — each sold line stores the unit cost at the moment of sale, so margins stay correct after costs change (older lines fall back to the product's current cost); pick 7, 30 or 90 days and see tax-exclusive revenue, cost of goods (from each product's recorded unit cost), gross profit and margin, broken down per day and per product; the panel names how many sold units still lack a cost, and the whole report exports to CSV. Voided and refunded sales are excluded, and discounts/loyalty redemptions are shared across lines the same way the sale allocated them
- **Offline mode** — the app shell is cached (service worker); offline sales remain queued if sync is rejected, can be retried from the queue badge, and carry idempotency keys to prevent duplicate recording
- **Excel/CSV stock import** — admins upload an `.xlsx`/`.xlsm`/`.csv` of products (Arabic or English headers), get a full preview (new / update / skipped / error per line) and confirm before anything is written; Arabic-Indic digits, `14%`/`0.14` tax formats, Arabic categories and units are normalized, existing rows are matched by barcode then name, and a downloadable CSV template is included
- **Purchases & suppliers** — supplier records (name, phone, email, note, soft-deleted instead of erased) and purchase invoices with multiple lines; receiving an invoice increases stock, recomputes a moving-average unit cost, applies the store tax rate, records what was paid (`paid` / `partial` / `unpaid`) and can be reversed in one click (single-shot, refused if stock is insufficient). Every invoice keeps its number, note and author for auditing
- **Supplier payments** — record a payment against a specific invoice or on account (cash / bank / cheque / wallet), with reference and note; the invoice's paid amount, the supplier balance and the statement update together, overpaying a single invoice is refused, payments can be deleted (audited) and reversing an invoice drops its payments
- **VAT report (admin)** — output tax from completed sales against input tax from received purchase invoices for 30 days, 90 days or a year, net payable, taxable totals and a daily breakdown, with CSV export
- **Supplier statement** — a per-supplier statement (30 days / 90 days / a year) with invoices, what was paid on each, what is still due, period and all-time totals, reversed invoices shown but excluded from the totals, and CSV export
- **Stocktake** — start a count that snapshots every active product with its expected quantity, enter counted values (with live differences, search and a differences-only filter), save drafts as you go and apply once; applying writes the counted quantities and returns gains/losses, and only one count can be open at a time
- **Audit trail** — every sensitive action (sign-in and failed sign-ins, password changes, shifts, voids/refunds, product create/update/delete/import, settings, users, backups) is recorded with actor, role, IP, request id and details, and is searchable from the admin-only **Audit log** tab
- **Automatic backups** — a gzipped JSON snapshot is written every 24 h to `backups/` (7 kept by default, configurable), plus manual "create now" from Settings; each snapshot includes products, sales, shifts, customers, suppliers, purchases, stocktakes, settings, subscription history and the audit log
- **Encrypted off-site backups** — with `POS_BACKUP_ENCRYPTION_KEY` and `POS_BACKUP_UPLOAD_URL` set, the same snapshot is encrypted with AES-256-GCM (scrypt-derived key) into a `.posbak` container and pushed off the server with retries and an optional bearer token; Settings shows the target and the result of the last upload, and `scripts/restore-backup.js` turns a `.posbak` back into the JSON that Settings → Import accepts
- **Backups** — JSON export/import of products, sales, sale items, shifts, customers and settings (user credentials are not exported)
- **Diagnostics & logs** — every response carries `X-Request-Id`, requests are logged with method/path/status/ms/user/IP (text or JSON lines), graceful shutdown on SIGTERM/SIGINT, and the Arabic diagnostics card explains an unreachable API
- **PWA icons** — real 192/512 PNGs plus maskable and Apple touch icons generated with `npm run icons` (no image tooling required)
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
| `POS_COOKIE_SAMESITE` | `Lax` | `None` when the POS is embedded in a third-party iframe (e.g. a preview pane); browsers then require HTTPS |
| `POS_TOKEN_AUTH` | `false` | `true` also returns the session token at sign-in; the UI then sends it as `Authorization: Bearer …`, so hosts that block cookies (embedded previews, strict privacy modes) still work |
| `STRIPE_SECRET_KEY` | — | Optional; used only for refunds of historical Stripe card sales (new checkout is cash-only) |
| `POS_BACKUP_ENABLED` | `true` | Set to `false` to disable the in-process backup timer |
| `POS_BACKUP_DIR` | `./backups` next to the DB | Where gzipped snapshots are written |
| `POS_BACKUP_INTERVAL_HOURS` | `24` | Hours between automatic snapshots |
| `POS_BACKUP_KEEP` | `7` | How many snapshots to retain |
| `POS_BACKUP_ENCRYPTION_KEY` | — | Passphrase (16+ chars) for the encrypted `.posbak` container; without it off-site upload stays disabled |
| `POS_BACKUP_UPLOAD_URL` | — | Where the encrypted container is pushed (any HTTP endpoint that accepts a PUT/POST body) |
| `POS_BACKUP_UPLOAD_TOKEN` | — | Optional bearer token sent as `Authorization: Bearer …` |
| `POS_BACKUP_UPLOAD_METHOD` | `PUT` | HTTP method used for the upload |
| `POS_LOG_FORMAT` | `text` | `json` emits one JSON object per line for log shippers |
| `POS_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

Store settings (name, tax rate, currency, low-stock threshold, register name, loyalty rates) are managed in **Settings** and stored in the database. Egyptian pound (EGP / ج.م) is the default display currency; set product prices and validate all local tax rules for each store.

## Data & backups

- All data lives in a single SQLite file (`pos.db`, WAL mode). Back it up by copying the file, use **Settings → Export backup** for a portable JSON snapshot, or rely on the automatic gzipped snapshots in `backups/` (listed under **Settings → Automatic backups**).
- Supplier payments are included in the file snapshots, the manual export and the restore path, so a round-trip never loses what was paid.
- **Encrypted off-site copy**: `POST /api/backups/upload` (or the button in Settings) writes `backup-YYYYMMDD-HHMMSS.posbak` and uploads it to `POS_BACKUP_UPLOAD_URL`. The container is `POSBAK01 | version | salt(16) | iv(12) | tag(16) | AES-256-GCM(gzip(json))` with a scrypt-derived key (N=16384), so a leaked bucket or a stolen file is useless without the passphrase. A failed upload is retried three times (4xx stops immediately) and the outcome is stored in settings and shown in the UI.
- **Restoring an encrypted copy**: `node scripts/restore-backup.js --file backup-….posbak --key "$POS_BACKUP_ENCRYPTION_KEY" --out restore.json` (add `--check` to print only a summary). Then use **Settings → Import backup** with `restore.json`; suppliers, purchases, purchase items, stocktakes and stocktake items are restored alongside the rest of the data when present.
- The old demo `data.json` format is no longer used.
- Subscription dates and audit records are stored in SQLite; the developer console logs successful logins, renewals, suspensions and restorations.

## Tests and health check

```bash
npm test        # 51 tests: API, localization, import/audit/backup/logging, purchasing, profit report, till flow
npm run icons   # regenerate public/icons/*.png
npm run test:ui # optional headless-browser smoke test (needs: npm i --no-save jsdom)
```

`test/features.test.js` covers the spreadsheet reader (stored and deflated `.xlsx`), Arabic header/digit mapping, the import preview/apply contract, the audit trail, backup creation + retention, request ids + JSON logging, PWA icons, and one end-to-end shift → sale → void flow. `npm run test:ui` drives the real UI in a headless DOM (import a CSV, read the audit tab, create a backup, switch language) without adding a runtime dependency.

The localization suite (`test/i18n.test.js`) fails the build if any translation key used by the UI is missing in Arabic or English, if a placeholder such as `{id}` disappears in either language, or if an API error loses its Arabic `messageAr`.

The unauthenticated `GET /healthz` endpoint returns `{ "status": "ok" }` after confirming SQLite responds; CI runs the same suite on pushes and pull requests.

## Before going live

This remains a production-oriented baseline, not a certified retail deployment or remotely hosted subscription platform. Configure the store default and per-product tax rates and verify local invoicing/fiscal rules; the software does not decide which rate applies to a product. Checkout is cash-only. Historical Stripe card refunds can be sent only when the original PaymentIntent reference exists and `STRIPE_SECRET_KEY` is configured; partial refunds, provider webhooks/reconciliation and fiscal integrations are not implemented. Validate cash reconciliation, receipt, backup/restore and offline recovery in staging before handling customers.

## Subscription scope and deployment

The developer console and its license/audit data live in the same SQLite database as the POS. For the selected separate-installation model, the current implementation can activate and monitor one installation at a time; the developer must connect to each store installation. It does **not** remotely aggregate, provision or suspend other independent servers. A central multi-store control plane requires a separately hosted licensing API, secure per-install credentials and an agreed domain; it is not included in this repository. Annual activation is manual after the developer records a payment/receipt reference—there is no online recurring billing or automatic payment verification.

## استكشاف الأعطال: «فشل الطلب (404)»

إذا ظهرت هذه الرسالة عند فتح النظام فمعناها أن المتصفح حمّل **الواجهة** فقط، لكن طلبات `‎/api/…` لم تصل إلى خادم Node.js. الأسباب الشائعة:

1. **رابط استضافة ثابتة** (Vercel/Netlify/GitHub Pages): تخدم `public/` فقط ولا تشغّل `server.js` ولا SQLite، فترد على كل `‎/api/…` بصفحة 404. شغّل النظام على خادم Node.js.
2. **خادم متوقف**: شغّل `node server.js` على جهاز الكاشير/السيرفر، ثم افتح عنوان الخادم نفسه مثل `http://localhost:3000`.
3. **بروكسي عكسي لا يمرّر `‎/api/…`** إلى المنفذ الصحيح (nginx/Caddy)، أو جدار ناري يمنع المسار.

لذلك يعرض التطبيق تلقائيًا بطاقة تشخيص عربية بجانب شاشة الدخول: رابط الصفحة، نتيجة فحص حقيقي لـ `‎/api/config` (JSON ✅ أو HTML ❌)، حالة الشبكة، وخطوات الإصلاح، مع أزرار **إعادة المحاولة** و**نسخ التقرير** لمشاركته مع المسؤول. وحين يرد الخادم بصفحة HTML أو خطأ 404/5xx تظهر رسالة تشرح السبب بدل رمز الحالة وحده.

## استيراد المخزون من ملف Excel

في **المخزون → رفع أصناف المخزون من ملف Excel** (للمدير فقط):

1. حمّل القالب (`⬇ تنزيل القالب (CSV)`) أو استخدم ملفك.
2. اختر ملف `.xlsx` أو `.xlsm` أو `.csv` (حتى ٣ ميجابايت).
3. راجع المعاينة: كل سطر يظهر كـ **جديد / تحديث / تخطٍ / خطأ** مع سبب الخطأ والتغييرات المقترحة (السعر، المخزون…).
4. اضغط **تأكيد الاستيراد** — لا يُكتب أي شيء قبل هذا التأكيد، والكتابة تتم في معاملة واحدة.

الأعمدة المتعرَّف عليها (عربي أو إنجليزي، وتُقبل المرادفات): **اسم المنتج، القسم، السعر، الوحدة، المخزون، الباركود، الضريبة، الرمز**. يُقبل الترتيب السابق أو أي ترتيب آخر، ووجود صف عنوان في أول ٨ صفوف. تفاصيل المعالجة:

- الأرقام العربية الهندية (`١٢٣٫٤٥`) والفواصل الألفية ورموز العملة تُحوَّل تلقائيًا.
- الضريبة تُقبل كسرًا (`0.14`) أو نسبة (`14%`)؛ الوحدات والأقسام العربية تُحوَّل إلى القيم القياسية المخزّنة.
- المطابقة مع الأصناف الموجودة: **الباركود أولًا ثم الاسم**؛ ويمكن إلغاء التحديث من مربع «تحديث الأصناف الموجودة».
- الأسطر الناقصة أو المكررة أو غير الصالحة تُرفض وتظهر في المعاينة فقط، ولا تُفشل بقية الملف.

## سجل التدقيق والنسخ الاحتياطي

- **السجل (Audit log)**: تبويب للمدير يعرض الوقت، المنفّذ ودوره، العملية (بمسمّى عربي)، التفاصيل، والعنوان، مع تصفية حسب نوع العملية وبحث نصي. قاعدة البيانات تحتفظ بمعرّف الطلب `X-Request-Id` لكل عملية، فيمكن ربط أي سطر بسجل الخادم.
- **النسخ التلقائي**: نسخة مضغوطة `backups/backup-YYYYMMDD-HHMMSS.json.gz` كل 24 ساعة (واحدة فور التشغيل إن لم توجد نسخة حديثة)، ويُحتفظ بأحدث 7 نسخ. تظهر القائمة في **الإعدادات** مع زر «إنشاء نسخة الآن».
- **السجلات**: كل طلب يُسجَّل بسطر واحد يحتوي المعرّف والمسار والحالة والمدة والمستخدم؛ `POS_LOG_FORMAT=json` للإرسال إلى أدوات التحليل، و`SIGTERM`/`SIGINT` تُغلق الخادم وقاعدة البيانات بأمان.

## المشتريات والجرد والنسخ المشفّر

- **الموردون**: تبويب «المشتريات» يجمع الموردين والفواتير. حذف المورد لا يمسحه بل يعطّله (`active = 0`) حتى تبقى فواتيره وتقاريره سليمة. الأسماء مكرّرة مرفوضة (409).
- **فاتورة مشتريات**: بنود متعددة (صنف، كمية، تكلفة الوحدة)؛ عند الحفظ تدخل الكميات إلى المخزون ويُحدَّث متوسط تكلفة الوحدة، وتُطبَّق نسبة الضريبة الافتراضية أو نسبة مخصّصة، ويُسجَّل المدفوع للمورد. عكس الفاتورة يخصم الكميات فورًا، مرة واحدة فقط، ويُرفض إن كان المخزون لا يكفي (409).
- **الجرد**: «بدء جرد جديد» يأخذ لقطة لكل صنف نشط مع الكمية المتوقعة. أدخل الكميات الفعلية (يظهر الفرق مباشرة، مع بحث ومرشّح «الفروق فقط»)، احفظ مسوّدة، ثم «تطبيق الجرد» لكتابة الكميات الفعلية. جرد واحد مفتوح في كل مرة، وكل ذلك مسجّل في سجل التدقيق.
- **النسخ المشفّر خارج الخادم**: اضبط `POS_BACKUP_ENCRYPTION_KEY` (16 حرفًا أو أكثر) و`POS_BACKUP_UPLOAD_URL` (واختياريًا `POS_BACKUP_UPLOAD_TOKEN` و`POS_BACKUP_UPLOAD_METHOD`)، ثم استخدم زر «رفع نسخة مشفّرة الآن» في الإعدادات. الملف الناتج `.posbak` مشفّر بـ AES-256-GCM، ولا يمكن فتحه بدون المفتاح: `node scripts/restore-backup.js --file x.posbak --key "…" --check`. المفاتيح لا تُكتب في الكود ولا تُرفع إلى Git.

## كشف حساب المورد

من تبويب «المشتريات» اضغط 📄 بجانب أي مورد لعرض:

- إجمالي الفواتير، المسدَّد، والمستحق **داخل الفترة** (٣٠ يومًا / ٩٠ يومًا / سنة) بالإضافة إلى الإجمالي الكلي للمورد.
- كل فاتورة بتاريخها ورقمها وإجماليها والمدفوع منها والمتبقي وحالتها (مسددة/جزئية/غير مسددة/مُلغاة).
- الفواتير **المُلغاة تظهر** للمراجعة لكنها **لا تُحتسب** في الإجماليات، ولا يوجد أي تعديل على البيانات من هذه الشاشة.
- زر **تصدير CSV** يحتوي بيانات المورد والفترة والفواتير والإجماليات.

## الدفعات وضريبة القيمة المضافة

- **دفعات الموردين**: من كشف حساب المورد سجّل دفعة مرتبطة بفاتورة معيّنة أو «على الحساب»، بالنقد أو التحويل البنكي أو الشيك أو المحفظة، مع مرجع وملاحظة. تتحدّث معًا: المدفوع على الفاتورة، رصيد المورد، وكشف الحساب. لا يمكن دفع أكثر من المتبقي على فاتورة واحدة، ويمكن حذف أي دفعة (تُسجَّل في سجل التدقيق)، وعكس الفاتورة يحذف دفعاتها.
- **ضريبة القيمة المضافة**: كرت للمدير في تبويب «المبيعات والتقارير» يعرض ضريبة المخرجات من المبيعات المكتملة مقابل ضريبة المدخلات من فواتير المشتريات المستلمة (٣٠ يومًا / ٩٠ يومًا / سنة)، مع الصافي المستحق والوعاء الضريبي وتفصيل يومي وتصدير CSV. الفواتير الملغاة والمبيعات المسترجعة مستثناة، وراجع النسب مع قواعد الضريبة المحلية قبل التقديم.
- **دقة التكلفة**: كل بند بيع يحتفظ بتكلفة الوحدة لحظة البيع، فتظل تقارير الأرباح صحيحة بعد تغيّر التكاليف (البنود القديمة ترجع للتكلفة الحالية).

## تقرير الأرباح والهامش

في تبويب «المبيعات والتقارير» يظهر للمدير كرت **الأرباح والهامش**: اختر ٧ / ٣٠ / ٩٠ يومًا لترى:

- **المبيعات بدون ضريبة** و**تكلفة البضاعة** (كمية كل صنف × تكلفة وحدته المسجّلة) و**الربح الإجمالي** و**الهامش %**.
- تفصيل **يومي** (المبيعات، التكلفة، الربح، الهامش) وجدول **الأعلى ربحًا** لكل صنف.
- تنبيه بعدد الوحدات المباعة التي لا تكلفة مسجّلة لها بعد، وزر **تصدير CSV** (بصيغة عربية/إنجليزية حسب اللغة).
- الفواتير الملغاة والمسترجعة مستثناة، والخصومات ونقاط الولاء تُوزَّع على البنود بنفس نسب البيع الأصلي.

ملاحظة: يُحسب الربح بتكلفة الوحدة **الحالية** من فواتير المشتريات (لا يوجد سجل تاريخي لتكلفة لحظة البيع)، فالبيانات القديمة قبل تسجيل التكلفة تظهر بهامش أعلى.

## Deployment notes

- Run behind a reverse proxy (nginx/Caddy) with **HTTPS** — session cookies are `HttpOnly; SameSite=Lax; Secure` by default. Set `POS_COOKIE_SECURE=false` only for local plain-HTTP development.
- Multiple named registers may use the same running POS server and database; set a distinct terminal/register ID in Settings on each browser. Do not run multiple Node instances against a shared SQLite file—use a dedicated database/sync service before horizontal scaling.
- Hardware: receipt printing uses the browser print dialog (thermal-printer friendly CSS included); barcode scanners in keyboard-wedge mode work without drivers.
