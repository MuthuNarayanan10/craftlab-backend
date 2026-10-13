const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Return = require('../models/Return');
const { getSettings } = require('../models/Settings');
const { createNotification } = require('../models/Notification');
const { requireCustomer } = require('../middleware/customerAuth');
const { ownedOrdersFilter } = require('../utils/ownership');
const { eligibleQuantities, refundableAmount, customerJourney, normalize } = require('../utils/returnStatus');
const { notifyOrder } = require('../services/notifier');
const { audit } = require('../models/AuditLog');

const MAX_IMAGES = 4, MAX_IMAGE_CHARS = 900000;
const REASONS = ['Damaged on arrival', 'Defective or not working', 'Wrong item received', 'Not as described', 'Quality not as expected', 'Changed my mind', 'Other'];

async function ownedOrder(req, id) {
  const o = await Order.findOne({ _id: id, ...ownedOrdersFilter(req.customer) });
  return o;
}
function windowState(order, settings) {
  const deliveredAt = order.deliveredAt || order.updatedAt;
  const days = (Date.now() - new Date(deliveredAt).getTime()) / 86400000;
  return { open: days <= settings.returnWindowDays, daysLeft: Math.max(0, Math.ceil(settings.returnWindowDays - days)), deadline: new Date(new Date(deliveredAt).getTime() + settings.returnWindowDays * 86400000) };
}

// GET /api/returns/eligible/:orderId — which lines can still be returned, and for how long
const eligibleHandler = async (req, res) => {
  const order = req.order;
  const settings = await getSettings();
  if (order.orderStatus !== 'Delivered') return res.json({ eligible: false, reason: 'Returns open once your order is delivered.' });
  const win = windowState(order, settings);
  if (!win.open) return res.json({ eligible: false, reason: `The ${settings.returnWindowDays}-day return window for this order has closed. You can still contact support.`, window: win });
  const lines = eligibleQuantities(order, await Return.find({ order: order._id }));
  res.json({ eligible: lines.some((l) => l.eligible > 0), lines, window: win, reasons: REASONS });
};

// POST /api/returns
const createHandler = async (req, res) => {
  const { items, reason, comments, resolution, images } = req.body;
  if (!REASONS.includes(reason)) return res.status(400).json({ error: 'Please choose a reason for the return' });
  const order = req.order;
  if (order.orderStatus !== 'Delivered') return res.status(400).json({ error: 'Returns can only be requested for delivered orders' });
  const settings = await getSettings();
  const win = windowState(order, settings);
  if (!win.open) return res.status(400).json({ error: `The ${settings.returnWindowDays}-day return window for this order has closed. Please contact support on WhatsApp.` });

  const lines = eligibleQuantities(order, await Return.find({ order: order._id }));
  // default (no items given) = everything still eligible
  const wanted = Array.isArray(items) && items.length ? items : lines.filter((l) => l.eligible > 0).map((l) => ({ index: l.index, qty: l.eligible }));
  const chosen = [];
  for (const w of wanted) {
    const line = lines[w.index];
    const qty = parseInt(w.qty, 10);
    if (!line || !(qty >= 1) || qty > line.eligible) return res.status(400).json({ error: 'One of the selected items can’t be returned in that quantity' });
    chosen.push({ index: line.index, name: line.name, sku: line.sku, qty, price: line.price });
  }
  if (!chosen.length) return res.status(409).json({ error: 'Everything in this order has already been returned or is being returned' });

  let cleanImages = [];
  if (images !== undefined) {
    if (!Array.isArray(images) || images.length > MAX_IMAGES) return res.status(400).json({ error: `You can attach up to ${MAX_IMAGES} photos` });
    for (const img of images) if (typeof img !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > MAX_IMAGE_CHARS) return res.status(400).json({ error: 'One of the photos is invalid or too large' });
    cleanImages = images;
  }
  const ret = await Return.create({
    order: order._id, orderNumber: order.orderNumber, customerId: req.customer ? req.customer.id : (order.customerId || undefined),
    customerEmail: order.customer.email, customerPhone: order.customer.phone, customerName: order.customer.name,
    items: chosen, amount: refundableAmount(order, chosen), reason: String(reason), comments: String(comments || '').slice(0, 1000),
    resolution: ['Refund', 'Replacement', 'Other'].includes(resolution) ? resolution : 'Refund', images: cleanImages, imageCount: cleanImages.length,
    status: 'REQUESTED', history: [{ status: 'REQUESTED', actor: 'customer', note: reason }],
  });
  if (settings.autoApproveReturns) {
    ret.status = 'APPROVED'; ret.history.push({ status: 'APPROVED', actor: 'system', note: 'Auto-approved by store settings' }); await ret.save();
    notifyOrder('return_approved', { order, ret });
  }
  await createNotification('return_requested', `Return requested for ${order.orderNumber} — ${reason}${cleanImages.length ? ` (${cleanImages.length} photo${cleanImages.length > 1 ? 's' : ''})` : ''}`, { orderNumber: order.orderNumber });
  await audit({ action: 'return.requested', actor: req.customer ? 'customer' : 'guest', entity: 'return', entityId: ret.id, summary: `Return requested for ${order.orderNumber}: ${reason}`, req });
  res.status(201).json({ id: ret.id, status: ret.status, amount: ret.amount });
};

// ---- logged-in customers ----
const loadOwned = async (req, res, next) => { const id = req.params.orderId || req.body.orderId; const order = id && /^[a-f0-9]{24}$/i.test(String(id)) ? await ownedOrder(req, id) : null; if (!order) return res.status(404).json({ error: 'Order not found on your account' }); req.order = order; next(); };
router.get('/eligible/:orderId', requireCustomer, loadOwned, eligibleHandler);
router.post('/', requireCustomer, loadOwned, createHandler);

// ---- guests: the order number AND the email/phone used on it (same proof as order tracking) ----
const loadGuest = async (req, res, next) => {
  const src = { ...req.query, ...(req.body || {}) };
  const orderNumber = String(src.orderNumber || '').trim().toUpperCase().replace(/^#/, '').replace(/\s+/g, '');
  const email = String(src.email || '').trim().toLowerCase(), phone = String(src.phone || '').replace(/\D/g, '').slice(-10);
  if (!orderNumber || (!email && phone.length !== 10)) return res.status(400).json({ error: 'Enter your order number and the email or mobile used for the order' });
  const order = await Order.findOne({ orderNumber: { $in: [orderNumber, orderNumber.replace(/-/g, '')] }, ...(email ? { 'customer.email': email } : { 'customer.phone': { $regex: phone + '$' } }) });
  if (!order) return res.status(404).json({ error: 'No order found matching those details' });
  req.order = order; next();
};
router.get('/guest/eligible', loadGuest, eligibleHandler);
router.post('/guest', loadGuest, createHandler);

// GET /api/returns/mine — this customer's requests (no photos), with the simplified journey
router.get('/mine', requireCustomer, async (req, res) => {
  const list = await Return.find({ customerId: req.customer.id }).select('-images').sort({ createdAt: -1 });
  res.json(list.map((r) => ({ ...r.toJSON(), status: normalize(r.status), journey: customerJourney(r), history: r.history.filter((h) => h.visible !== false) })));
});

module.exports = router;
