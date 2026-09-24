require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDB = require('./src/db');
const { requireAdmin } = require('./src/middleware/adminAuth');

const authRoutes = require('./src/routes/auth');
const productRoutes = require('./src/routes/products');
const adminProductRoutes = require('./src/routes/adminProducts');
const cartRoutes = require('./src/routes/cart');
const checkoutRoutes = require('./src/routes/checkout');
const paymentRoutes = require('./src/routes/payments');
const adminOrderRoutes = require('./src/routes/adminOrders');
const couponRoutes = require('./src/routes/coupons');
const adminCouponRoutes = require('./src/routes/adminCoupons');
const abandonedRoutes = require('./src/routes/abandoned');
const dashboardRoutes = require('./src/routes/dashboard');
const trackRoutes = require('./src/routes/track');
const customerAuthRoutes = require('./src/routes/customerAuth');
const adminCustomerRoutes = require('./src/routes/adminCustomers');
const adminSupplierRoutes = require('./src/routes/adminSuppliers');
const returnsRoutes = require('./src/routes/returns');
const adminReturnsRoutes = require('./src/routes/adminReturns');
const adminNotificationsRoutes = require('./src/routes/adminNotifications');

const app = express();
const PORT = process.env.PORT || 4000;

app.set('trust proxy', 1); // needed behind Render's reverse proxy for correct rate-limiting/IPs

app.use(helmet());

const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS: ' + origin));
  }
}));

// Rate limiting — generous for browsing, tighter for auth/checkout to slow down abuse.
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/', generalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/customers/login', authLimiter);
app.use('/api/customers/signup', authLimiter);

// IMPORTANT: the Razorpay webhook needs the raw request body to verify its
// signature, so it must be mounted with express.raw() BEFORE the global
// express.json() parser below (which would otherwise consume the body first).
app.use('/api/webhooks/razorpay', express.raw({ type: '*/*' }), paymentRoutes);

app.use(express.json({ limit: '2mb' }));

// --- Public health check ---
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// --- Public routes ---
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/payments', paymentRoutes); // /verify — public callback, but signature-verified inside
app.use('/api/coupons', couponRoutes);   // /validate only
app.use('/api/track', trackRoutes);      // public order tracking (requires order number + email)
app.use('/api/customers', customerAuthRoutes); // signup/login/me — customer JWT, separate from admin
app.use('/api/returns', returnsRoutes); // customer-facing return requests (requires customer login)

// --- Admin routes (everything below requires a valid admin JWT) ---
app.use('/api/admin/products', requireAdmin, adminProductRoutes);
app.use('/api/admin/orders', requireAdmin, adminOrderRoutes);
app.use('/api/admin/coupons', requireAdmin, adminCouponRoutes);
app.use('/api/admin/abandoned-carts', requireAdmin, abandonedRoutes);
app.use('/api/admin/dashboard', requireAdmin, dashboardRoutes);
app.use('/api/admin/customers', requireAdmin, adminCustomerRoutes);
app.use('/api/admin/suppliers', requireAdmin, adminSupplierRoutes);
app.use('/api/admin/returns', requireAdmin, adminReturnsRoutes);
app.use('/api/admin/notifications', requireAdmin, adminNotificationsRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err); // server-side only — never leak stack traces to the client
  res.status(500).json({ error: 'Server error' });
});

connectDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 The Craft Lab API running on port ${PORT}`));
});
