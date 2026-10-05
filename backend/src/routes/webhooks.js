const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Order = require('../models/Order');
const Integration = require('../models/Integration');
const WebhookEvent = require('../models/WebhookEvent');
const { getCourier } = require('../utils/courier');
const { applyTrackingUpdate } = require('../utils/trackingUpdate');
const { afterStatusChange } = require('../services/orderService');
const { logger } = require('../utils/logger');

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// POST /api/webhooks/courier/:provider?token=…  — courier tracking pushes. The token is the shared secret shown in Admin → Integrations.
router.post('/courier/:provider', async (req, res) => {
  const doc = await Integration.findOne({ provider: req.params.provider, enabled: true });
  const token = req.query.token || req.header('x-webhook-token') || '';
  if (!doc || !doc.webhookToken || !same(token, doc.webhookToken)) return res.status(401).json({ error: 'Unauthorized' });

  const eventId = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
  try { await WebhookEvent.create({ provider: req.params.provider, eventId, type: 'tracking' }); } catch (e) { if (e.code === 11000) return res.json({ received: true, duplicate: true }); throw e; }

  try {
    const u = getCourier(req.params.provider).parseWebhook(req.body);
    const order = u.awb && (await Order.findOne({ 'shipment.awb': u.awb }));
    if (!order) { await WebhookEvent.updateOne({ provider: req.params.provider, eventId }, { status: 'ignored', ref: u.awb || '' }); return res.json({ received: true }); }
    const from = order.orderStatus;
    const r = applyTrackingUpdate(order, u, 'courier');
    await order.save();
    if (r.changed && order.orderStatus !== from) { await afterStatusChange(order, from, order.orderStatus, 'courier'); await order.save(); }
    await WebhookEvent.updateOne({ provider: req.params.provider, eventId }, { status: 'processed', ref: order.orderNumber });
    res.json({ received: true });
  } catch (e) {
    logger.error('courier_webhook_failed', { provider: req.params.provider, error: e.message });
    await WebhookEvent.updateOne({ provider: req.params.provider, eventId }, { status: 'failed', error: String(e.message).slice(0, 300) });
    res.status(500).json({ error: 'Processing failed' });
  }
});
module.exports = router;
