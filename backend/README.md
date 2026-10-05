# The Craft Lab — Backend API

Production e-commerce backend: Node.js + Express + MongoDB + Razorpay.

## What's real here

- Real MongoDB persistence (Product, Order, Cart, Coupon, Admin, **Customer, Supplier**, AuditLog)
- Real Razorpay order creation + **server-side signature verification** (never trusts the frontend alone)
- Real Razorpay **webhook** handler (independent confirmation, idempotent — safe if it fires twice)
- Atomic stock reservation to prevent overselling when two customers check out the same low-stock item at once
- JWT-based admin login with bcrypt-hashed passwords (not a shared API key — this handles real customer money)
- **Customer accounts** — signup/login with their own JWT namespace (separate from admin tokens, so a customer token can never access admin routes), order history, optional address book
- **Public order tracking** — customers can check status with just order number + email, no login required
- **Supplier/manufacturer records** — simple CRM for who makes/supplies each product
- Abandoned-cart capture (with consent) and **dynamic, rule-based recovery messaging** (escalating discount codes, personalized by name/items) — not a live AI call, see the note on the admin page
- Rate limiting, Helmet security headers, CORS allowlist

## 1. Get MongoDB Atlas (same steps as before, new database)

Follow the same MongoDB Atlas free-tier steps as the previous project
(mongodb.com/cloud/atlas/register → free M0 cluster → database user →
allow access from anywhere → copy connection string), but name this
database `craftlab` instead of reusing an old one:

```
mongodb+srv://<user>:<password>@<cluster>.mongodb.net/craftlab?retryWrites=true&w=majority
```

## 2. Set up environment variables

```bash
cd backend
cp .env.example .env
```

Fill in `.env`:
- `MONGODB_URI` — from step 1
- `JWT_SECRET` — any long random string (`openssl rand -hex 32`)
- `RAZORPAY_KEY_ID` — your test key (already have: `rzp_test_xxxxxxxxxxxxxx`)
- `RAZORPAY_KEY_SECRET` — from Razorpay Dashboard → Settings → API Keys (the secret shown once when you generated the test key)
- `RAZORPAY_WEBHOOK_SECRET` — see step 4 below
- `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` — your first admin login credentials

## 3. Install, seed, run

```bash
npm install
npm run seed    # creates your admin login + both real products (₹2,499 / MRP ₹2,999)
npm start
```

You should see `✅ Connected to MongoDB` and `🚀 The Craft Lab API running on port 4000`.

Test it: `curl http://localhost:4000/api/health`

## 4. Set up the Razorpay webhook

1. Razorpay Dashboard → **Settings → Webhooks → Add New Webhook**
2. Webhook URL: `https://your-backend-url.onrender.com/api/webhooks/razorpay` (use your Render URL once deployed; for local testing you'd need a tool like `ngrok` to expose localhost)
3. Active events: check **payment.captured** and **payment.failed**
4. Set a secret (any string) → this is your `RAZORPAY_WEBHOOK_SECRET` — put it in `.env`
5. Save

## 5. Deploy to Render (same pattern as before)

Root Directory: `backend` (or blank if you upload only this folder's contents — see the note from last time about matching this to your actual repo structure). Build: `npm install`. Start: `npm start`. Add all the `.env` variables under Render's Environment tab.

**After deploying**, come back and:
- Update the webhook URL in Razorpay to your real Render URL
- Update `CORS_ORIGIN` to include your real frontend domain

## API Reference

**Public**
- `GET /api/health`
- `GET /api/products` — catalog
- `GET /api/products/:slug` — single product
- `POST /api/cart` — create a cart, returns `cartId`
- `GET/POST/DELETE /api/cart/:cartId/...` — manage cart items
- `PUT /api/cart/:cartId/contact` — capture contact for abandoned-cart recovery (requires consent)
- `POST /api/checkout` — validates stock, creates Order + Razorpay order
- `POST /api/checkout/:orderId/cancel` — releases reserved stock
- `POST /api/payments/verify` — verifies Razorpay signature, marks order paid
- `POST /api/webhooks/razorpay` — server-to-server payment confirmation
- `POST /api/coupons/validate`
- `POST /api/auth/login` — admin login
- `GET /api/track?orderNumber=&email=` — public order status lookup
- `POST /api/customers/signup`, `POST /api/customers/login`
- `GET/PUT /api/customers/me`, `GET /api/customers/me/orders` (require customer Bearer token)

**Admin (require `Authorization: Bearer <token>` from login)**
- `GET/POST/PUT/DELETE /api/admin/products`
- `GET /api/admin/orders`, `PUT /api/admin/orders/:id/status`, `PUT /api/admin/orders/:id/delivery`
- `POST /api/admin/orders/release-stale` — frees stock held by abandoned checkouts
- `GET/POST/PUT/DELETE /api/admin/coupons`
- `GET /api/admin/abandoned-carts`, `POST /api/admin/abandoned-carts/:id/mark-contacted`
- `GET /api/admin/dashboard/today`, `GET /api/admin/dashboard/analytics`
- `GET /api/admin/customers`, `GET /api/admin/customers/:id`, `PUT /api/admin/customers/:id/status`
- `GET/POST/PUT/DELETE /api/admin/suppliers`

## What's still missing (by design — see the launch guide)

- Product **images** — seed script leaves `images: []`; upload real photos and add URLs via the admin dashboard (built next)
- Frontend storefront + admin UI — coming next
- Email sending (order confirmations etc.) — not yet wired; needs an email provider (e.g. Resend, SendGrid)
- WhatsApp API integration — per the launch guide, start with the WhatsApp Business app manually, wire the API later

---

## v3 additions

**Checkout** — `POST /api/checkout` accepts `paymentMethod: "online" | "cod"`. Totals (coupon, prepaid discount, COD fee) are always computed server-side from the business settings. COD orders are placed immediately (status *Processing*) and become *Paid* when an admin sets them to *Delivered*.

**Public**
- `GET /api/config/public` — non-sensitive store settings (COD, prepaid %, support WhatsApp, return window)
- `POST /api/subscribers` — newsletter signup · `POST /api/contact` — contact form (admin notification + email to support)
- `POST /api/returns` — now accepts `resolution` and up to 4 compressed `images` (data URLs); enforces the return window from settings

**Admin**
- `GET /api/admin/dashboard/overview` — all dashboard figures in one call (revenue windows in IST, trend, pipeline, top products, low stock, COD receivable, GST totals, launch-readiness flags)
- `GET|PUT /api/admin/settings` — business details, GST defaults, COD/prepaid, support WhatsApp, return window
- `GET /api/admin/tax/summary` — GST by month + invoice register
- `GET /api/admin/returns/:id` — full return incl. photos · `GET /api/admin/subscribers`
- `POST /api/admin/quotations/:id/send-email` — email a quotation request to a manufacturer

**Environment variables** are unchanged; `RESEND_*` and `FIREBASE_SERVICE_ACCOUNT_JSON` remain optional. New order alerts are emailed to the *support email* saved in Admin → Business settings.

**Reliability** — async route errors are forwarded to the error handler (`src/utils/asyncErrors.js`); stray promise rejections are logged instead of crashing the process.

---

## v4 additions
**Delivery methods** (`models/DeliveryMethod.js`, `routes/delivery.js`, `routes/adminDelivery.js`): admin-managed methods (courier or own-team/manual), fee, free-above, ETA, COD allowed, PIN prefixes, on/off. `GET /api/delivery/options?pincode=&subtotal=&cod=` for checkout; checkout validates and prices the chosen method server-side and snapshots it on the order.
**Order lifecycle** (`utils/orderStatus.js`, `services/orderService.js`): validated transitions, a timeline of events on every order, a server-built customer journey, atomic idempotent payment confirmation.
**Payments** (`utils/paymentProvider.js`, `routes/payments.js`, `services/reconcile.js`): provider interface; idempotent webhooks (`/api/webhooks/razorpay`), amount verification, reconciliation job, refunds.
**Returns** (`utils/returnStatus.js`): 10-step workflow, line-item returns, photos, restocking, refund linked to Razorpay.
**Auth switches & OTP** (`routes/customerAuth.js`, `utils/otpService.js`): login / sign-up / OTP / guest / mandatory verification, all server-enforced.
**Couriers** (`utils/courier/`): manual + Shiprocket adapter; keys encrypted (`utils/crypto.js`, needs `SECRETS_KEY`).
**Notifications** (`utils/notifications.js`): deduped, logged, retried; email + WhatsApp Cloud adapters.
**Also:** inventory ledger, purchase orders + supplier payments, analytics, audit log, request logging, background jobs (`jobs.js`).

### Tests
- `npm test` — unit + integration (no database needed): 52 tests.
- `npm run test:e2e` — end-to-end against a MongoDB-compatible engine (`FERRET=1` with FerretDB on :27018, or `TEST_MONGO_URI` for any MongoDB): 43 tests.
- `npm run dev:ui` — serves the real backend + storefront + admin on a throw-away database for browser testing (`tests/ui/*.ui.js`, need Playwright). **Never point these at a real database** — they drop it.
- `npm run smoke` — post-deploy check against a live API.
