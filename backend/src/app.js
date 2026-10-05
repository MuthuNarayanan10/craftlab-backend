require('./utils/asyncErrors'); // forward async route errors to the error handler (Express 4 doesn't)
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { requireAdmin } = require('./middleware/adminAuth');
const { requestLogger, logger } = require('./utils/logger');
const { sanitizeRequest } = require('./utils/sanitize');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);          // behind Render/Cloudflare: real client IPs for rate limiting
  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use(helmet());
  app.use(compression());

  // CORS — only the storefront/admin origins you list in CORS_ORIGIN may call the API from a browser.
  const allowed = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const isProd = process.env.NODE_ENV === 'production';
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);                           // server-to-server (webhooks, health checks)
      if (allowed.includes(origin) || (!isProd && allowed.length === 0)) return cb(null, true);
      const e = new Error('Origin not allowed'); e.status = 403; cb(e);
    },
    exposedHeaders: ['X-Request-Id'],
  }));

  // Rate limits: generous for browsing, strict for login / OTP / checkout (shared mobile networks mean one IP can be many people)
  const limiter = (windowMin, max, message) => rateLimit({ windowMs: windowMin * 60e3, max, standardHeaders: true, legacyHeaders: false, message: { error: message || 'Too many requests. Please slow down and try again shortly.' } });
  app.use('/api/', limiter(15, 1500));
  app.use('/api/auth/login', limiter(15, 20, 'Too many login attempts. Try again in a few minutes.'));
  app.use(['/api/customers/login', '/api/customers/signup', '/api/customers/otp-login'], limiter(15, 20, 'Too many attempts. Try again in a few minutes.'));
  app.use('/api/customers/otp/send', limiter(15, 10, 'Too many OTP requests from this network. Please wait a few minutes.'));
  app.use('/api/customers/otp/verify', limiter(15, 30, 'Too many verification attempts. Please wait a few minutes.'));
  app.use('/api/checkout', limiter(15, 60, 'Too many checkout attempts. Please wait a few minutes.'));
  app.use(['/api/contact', '/api/subscribers'], limiter(60, 20));

  // Razorpay needs the RAW body to verify its signature, so it is mounted before any JSON parser.
  const payments = require('./routes/payments');
  app.use('/api/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), payments.webhookRouter);

  app.use('/api/returns', express.json({ limit: '8mb' }));          // customer damage photos
  app.use('/api/admin/products', express.json({ limit: '10mb' }));  // product photos (base64)
  app.use('/api/admin/purchase-orders', express.json({ limit: '3mb' })); // scanned supplier invoices
  app.use(express.json({ limit: '2mb' }));
  app.use(sanitizeRequest);                                          // strips $operators from all input

  app.get('/api/health', (req, res) => {
    const up = mongoose.connection.readyState === 1;
    res.status(up ? 200 : 503).json({ status: up ? 'ok' : 'degraded', database: up ? 'connected' : 'disconnected', uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() });
  });

  /* ---- public ---- */
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/products', require('./routes/products'));
  app.use('/api/cart', require('./routes/cart'));
  app.use('/api/checkout', require('./routes/checkout'));
  app.use('/api/payments', payments);
  app.use('/api/coupons', require('./routes/coupons'));
  app.use('/api/track', require('./routes/track'));
  app.use('/api/customers', require('./routes/customerAuth'));
  app.use('/api/returns', require('./routes/returns'));
  app.use('/api/config', require('./routes/publicConfig'));
  app.use('/api/delivery', require('./routes/delivery'));
  app.use('/api/webhooks', require('./routes/webhooks'));            // courier tracking pushes (shared-secret token)
  app.use('/api', require('./routes/publicForms'));                  // /subscribers, /contact

  /* ---- admin: every route below needs a valid ADMIN/STAFF token ---- */
  const admin = (path, file) => app.use(`/api/admin/${path}`, requireAdmin, require(`./routes/${file}`));
  admin('dashboard', 'dashboard');
  admin('orders', 'adminOrders');
  admin('payments', 'adminPayments');
  admin('returns', 'adminReturns');
  admin('customers', 'adminCustomers');
  admin('products', 'adminProducts');
  admin('inventory', 'adminInventory');
  admin('delivery', 'adminDelivery');
  admin('coupons', 'adminCoupons');
  admin('abandoned-carts', 'abandoned');
  admin('suppliers', 'adminSuppliers');
  admin('quotations', 'adminQuotations');
  admin('purchase-orders', 'adminPurchaseOrders');
  admin('analytics', 'adminAnalytics');
  admin('integrations', 'adminIntegrations');
  admin('settings', 'adminSettings');
  admin('tax', 'adminTax');
  admin('subscribers', 'adminSubscribers');
  admin('notifications', 'adminNotifications');
  admin('', 'adminOps');                                              // /audit, /notification-log, /system/health

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // Errors: customers only ever see a safe message; the details (with the request id) go to the logs.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large. Please use smaller photos.' });
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ error: 'Malformed request' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    logger.error('unhandled_error', { id: req.id, method: req.method, path: req.path, error: err.message, stack: isProd ? undefined : err.stack });
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.', requestId: req.id });
  });
  return app;
}
module.exports = { createApp };
