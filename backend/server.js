require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./src/db');
const { createApp } = require('./src/app');
const { startJobs } = require('./src/jobs');
const { logger } = require('./src/utils/logger');

process.on('unhandledRejection', (err) => logger.error('unhandled_rejection', { error: err && err.message }));
process.on('uncaughtException', (err) => { logger.error('uncaught_exception', { error: err.message }); setTimeout(() => process.exit(1), 500); });

// ---- refuse to boot in an unsafe configuration ----
const env = process.env, prod = env.NODE_ENV === 'production';
if (!env.JWT_SECRET || env.JWT_SECRET.length < 24 || /change-this|secret$/i.test(env.JWT_SECRET)) { logger.error('config_invalid', { error: 'JWT_SECRET must be a long random string (24+ characters)' }); process.exit(1); }
if (prod && !env.CORS_ORIGIN) { logger.error('config_invalid', { error: 'CORS_ORIGIN must list your storefront/admin domains in production' }); process.exit(1); }
if (prod && env.RAZORPAY_KEY_ID?.startsWith('rzp_live_') && !env.RAZORPAY_WEBHOOK_SECRET) logger.warn('config_warning', { warning: 'Live Razorpay keys without RAZORPAY_WEBHOOK_SECRET — payments will only confirm via the browser callback + reconciliation' });
if (!env.SECRETS_KEY) logger.warn('config_warning', { warning: 'SECRETS_KEY is not set — courier / SMS / WhatsApp API keys cannot be stored from the admin until it is' });

const PORT = env.PORT || 4000;
connectDB().then(() => {
  const server = createApp().listen(PORT, () => logger.info('server_started', { port: PORT, env: env.NODE_ENV || 'development' }));
  startJobs();
  const shutdown = (signal) => {
    logger.info('shutdown', { signal });
    server.close(async () => { await mongoose.disconnect(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref(); // never hang a deploy
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});
