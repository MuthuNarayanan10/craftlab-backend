const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Return = require('../models/Return');
const { resolveRange, computeAnalytics } = require('../utils/analytics');

// GET /api/admin/analytics?range=today|7d|30d|90d|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/', async (req, res) => {
  let range; try { range = resolveRange({ range: req.query.range, from: req.query.from, to: req.query.to }); } catch (e) { return res.status(400).json({ error: e.message }); }
  const [orders, returns, prior, refunded] = await Promise.all([
    Order.find({ createdAt: { $gte: range.from, $lte: range.to } }).select('createdAt paymentStatus orderStatus total payment items customer.phone attribution shipment.courierName delivery.partner events refunds').lean().limit(20000),
    Return.find({ createdAt: { $gte: range.from, $lte: range.to } }).select('createdAt items').lean(),
    Order.distinct('customer.phone', { createdAt: { $lt: range.from }, paymentStatus: { $in: ['Paid', 'Refunded'] } }),
    // refunds made in the range on orders placed earlier
    Order.find({ createdAt: { $lt: range.from }, 'refunds.createdAt': { $gte: range.from, $lte: range.to } }).select('refunds createdAt').lean(),
  ]);
  const priorPhones = new Set(prior.map((p) => String(p).slice(-10)));
  const a = computeAnalytics({ orders: [...orders, ...refunded], returns, from: range.from, to: range.to, priorPhones });
  res.json({ label: range.label, ...a });
});
module.exports = router;
