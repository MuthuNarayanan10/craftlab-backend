const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Return = require('../models/Return');
const { getSettings } = require('../models/Settings');
const { createNotification } = require('../models/Notification');
const { requireCustomer } = require('../middleware/customerAuth');

const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 900000; // ~650KB per photo after base64; client compresses well below this

// POST /api/returns — logged-in customers only, must own the order
router.post('/', requireCustomer, async (req, res) => {
  const { orderId, reason, comments, resolution, images } = req.body;
  if (!orderId || !reason) return res.status(400).json({ error: 'Please choose a reason for the return' });

  const order = await Order.findOne({ _id: orderId, customerId: req.customer.id });
  if (!order) return res.status(404).json({ error: 'Order not found on your account' });
  if (order.orderStatus !== 'Delivered') return res.status(400).json({ error: 'Returns can only be requested for delivered orders' });

  const settings = await getSettings();
  const deliveredAt = order.deliveredAt || order.updatedAt;
  const daysSince = (Date.now() - new Date(deliveredAt).getTime()) / 86400000;
  if (daysSince > settings.returnWindowDays) {
    return res.status(400).json({ error: `The ${settings.returnWindowDays}-day return window for this order has closed. Please contact support on WhatsApp.` });
  }

  const existing = await Return.findOne({ order: order._id });
  if (existing) return res.status(409).json({ error: 'A return request already exists for this order', status: existing.status });

  let cleanImages = [];
  if (images !== undefined) {
    if (!Array.isArray(images) || images.length > MAX_IMAGES) return res.status(400).json({ error: `You can attach up to ${MAX_IMAGES} photos` });
    for (const img of images) {
      if (typeof img !== 'string' || !img.startsWith('data:image/') || img.length > MAX_IMAGE_CHARS) {
        return res.status(400).json({ error: 'One of the photos is invalid or too large' });
      }
    }
    cleanImages = images;
  }

  const returnReq = await Return.create({
    order: order._id, orderNumber: order.orderNumber, customerId: req.customer.id,
    customerEmail: order.customer.email, customerPhone: order.customer.phone, customerName: order.customer.name,
    items: order.items.map(i => ({ name: i.name, qty: i.qty })),
    reason, comments: comments || '',
    resolution: ['Refund', 'Replacement', 'Other'].includes(resolution) ? resolution : 'Refund',
    images: cleanImages,
  });

  await createNotification('return_requested', `Return requested for ${order.orderNumber} — ${reason}${cleanImages.length ? ` (${cleanImages.length} photo${cleanImages.length > 1 ? 's' : ''})` : ''}`, { orderNumber: order.orderNumber });
  res.status(201).json({ id: returnReq.id, status: returnReq.status });
});

// GET /api/returns/mine — this customer's own requests (photos omitted to keep it light)
router.get('/mine', requireCustomer, async (req, res) => {
  const returns = await Return.find({ customerId: req.customer.id }).select('-images').sort({ createdAt: -1 });
  res.json(returns);
});

module.exports = router;
