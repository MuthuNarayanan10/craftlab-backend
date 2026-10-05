const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { buildJourney } = require('../utils/orderStatus');

// GET /api/track?orderNumber=CL-1001&email=…  (or &phone=…)
// Public, but needs BOTH the order number and the email/phone on that order — guessing sequential numbers reveals nothing.
router.get('/', async (req, res) => {
  const orderNumber = String(req.query.orderNumber || '').trim().toUpperCase();
  const email = String(req.query.email || '').trim().toLowerCase();
  const phone = String(req.query.phone || '').replace(/\D/g, '').slice(-10);
  if (!orderNumber || (!email && phone.length !== 10)) return res.status(400).json({ error: 'Enter your order number and the email or mobile number used for the order' });

  const order = await Order.findOne({ orderNumber, ...(email ? { 'customer.email': email } : { 'customer.phone': { $regex: phone + '$' } }) });
  if (!order) return res.status(404).json({ error: 'No order found matching those details' });

  const o = order.toJSON();
  res.json({
    orderNumber: o.orderNumber, createdAt: o.createdAt, total: o.total, paymentStatus: o.paymentStatus, orderStatus: o.orderStatus,
    items: o.items.map((i) => ({ name: i.name, qty: i.qty, image: i.image })),
    city: o.address.city,
    journey: buildJourney(o),
    // kept for older clients
    delivery: { partner: o.shipment?.courierName || o.delivery?.partner || '', trackingId: o.shipment?.awb || o.delivery?.trackingId || '' },
  });
});
module.exports = router;
