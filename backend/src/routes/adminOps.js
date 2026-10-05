const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const AuditLog = require('../models/AuditLog');
const NotificationLog = require('../models/NotificationLog');
const WebhookEvent = require('../models/WebhookEvent');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Integration = require('../models/Integration');
const { getSettings } = require('../models/Settings');
const { retryFailedNotifications } = require('../services/notifier');
const { requireRole } = require('../middleware/adminAuth');
const { isConfigured } = require('../utils/crypto');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/admin/audit?q=&action=&entity=&page=
router.get('/audit', requireRole('ADMIN'), async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 40));
  const f = {};
  if (req.query.action) f.action = new RegExp('^' + esc(req.query.action));
  if (req.query.entity) f.entity = req.query.entity;
  if (req.query.q) f.$or = [{ summary: new RegExp(esc(req.query.q), 'i') }, { actor: new RegExp(esc(req.query.q), 'i') }, { entityId: String(req.query.q) }];
  const [rows, total] = await Promise.all([AuditLog.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), AuditLog.countDocuments(f)]);
  res.json({ entries: rows.map((r) => r.toObject()), total, page, pages: Math.ceil(total / limit) || 1 });
});

// GET /api/admin/notification-log?status=&page=   ·   POST /api/admin/notification-log/retry
router.get('/notification-log', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = 40;
  const f = req.query.status ? { status: req.query.status } : {};
  const [rows, total, counts] = await Promise.all([NotificationLog.find(f).select('-payload.html').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), NotificationLog.countDocuments(f), NotificationLog.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])]);
  res.json({ logs: rows.map((r) => r.toObject()), total, page, pages: Math.ceil(total / limit) || 1, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
});
router.post('/notification-log/retry', async (req, res) => res.json({ sent: await retryFailedNotifications() }));

// GET /api/admin/system/health — the business-level health checks (what actually needs attention)
router.get('/system/health', async (req, res) => {
  const week = new Date(Date.now() - 7 * 86400e3), stale = new Date(Date.now() - 30 * 60e3);
  const settings = await getSettings();
  const [failedNotifs, failedHooks, shipmentErrors, stalePending, badStock, courierOn, waOn, smsOn] = await Promise.all([
    NotificationLog.countDocuments({ status: 'failed', createdAt: { $gte: week } }),
    WebhookEvent.countDocuments({ status: 'failed', createdAt: { $gte: week } }),
    Order.countDocuments({ 'shipment.error': { $ne: '' }, orderStatus: { $nin: ['Cancelled', 'Delivered', 'Refunded'] } }),
    Order.countDocuments({ orderStatus: 'Pending', paymentStatus: { $in: ['Pending', 'Failed'] }, 'payment.method': { $ne: 'cod' }, createdAt: { $lt: stale } }),
    Product.countDocuments({ $or: [{ stock: { $lt: 0 } }, { $expr: { $gt: ['$reserved', '$stock'] } }] }),
    Integration.countDocuments({ kind: 'courier', enabled: true }),
    Integration.countDocuments({ kind: 'whatsapp', enabled: true }),
    Integration.countDocuments({ kind: 'otp', enabled: true }),
  ]);
  const env = process.env;
  res.json({
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    problems: { failedNotifications: failedNotifs, failedWebhooks: failedHooks, shipmentErrors, stalePendingPayments: stalePending, inventoryInconsistencies: badStock },
    config: {
      razorpayConfigured: !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET), razorpayLive: (env.RAZORPAY_KEY_ID || '').startsWith('rzp_live_'), webhookSecret: !!env.RAZORPAY_WEBHOOK_SECRET,
      emailConfigured: !!(env.RESEND_API_KEY && env.RESEND_FROM), secretsStorageReady: isConfigured(),
      otpReady: settings.otpEnabled && (settings.otpProvider === 'dev' ? env.NODE_ENV !== 'production' : settings.otpProvider === 'firebase' ? !!env.FIREBASE_SERVICE_ACCOUNT_JSON : settings.otpProvider === 'msg91' && smsOn > 0),
      otpProvider: settings.otpProvider, courierEnabled: courierOn > 0, whatsappEnabled: waOn > 0 && settings.notifyWhatsappEnabled, nodeEnv: env.NODE_ENV || 'development',
    },
  });
});
module.exports = router;
