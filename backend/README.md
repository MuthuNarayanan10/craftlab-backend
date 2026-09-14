# The Craft Lab — Backend API

Production e-commerce backend: Node.js + Express + MongoDB + Razorpay.

## What's real here

- Real MongoDB persistence (Product, Order, Cart, Coupon, Admin, AuditLog)
- Real Razorpay order creation + **server-side signature verification** (never trusts the frontend alone)
- Real Razorpay **webhook** handler (independent confirmation, idempotent — safe if it fires twice)
- Atomic stock reservation to prevent overselling when two customers check out the same low-stock item at once
- JWT-based admin login with bcrypt-hashed passwords (not a shared API key — this handles real customer money)
- Abandoned-cart capture (with consent) and admin recovery tracking
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
- `RAZORPAY_KEY_ID` — your test key (already have: `rzp_test_Tb6dEjqrGHZh7yV`)
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

**Admin (require `Authorization: Bearer <token>` from login)**
- `GET/POST/PUT/DELETE /api/admin/products`
- `GET /api/admin/orders`, `PUT /api/admin/orders/:id/status`, `PUT /api/admin/orders/:id/delivery`
- `POST /api/admin/orders/release-stale` — frees stock held by abandoned checkouts
- `GET/POST/PUT/DELETE /api/admin/coupons`
- `GET /api/admin/abandoned-carts`, `POST /api/admin/abandoned-carts/:id/mark-contacted`
- `GET /api/admin/dashboard/today`, `GET /api/admin/dashboard/analytics`

## What's still missing (by design — see the launch guide)

- Product **images** — seed script leaves `images: []`; upload real photos and add URLs via the admin dashboard (built next)
- Frontend storefront + admin UI — coming next
- Email sending (order confirmations etc.) — not yet wired; needs an email provider (e.g. Resend, SendGrid)
- WhatsApp API integration — per the launch guide, start with the WhatsApp Business app manually, wire the API later
