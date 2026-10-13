const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { getSettings } = require('../models/Settings');
const { getNextSequence } = require('../models/Counter');
const { audit } = require('../models/AuditLog');
const { requireRole } = require('../middleware/adminAuth');
const { canTransition, allowedNext, buildJourney, STATUSES } = require('../utils/orderStatus');
const { pushEvent } = require('../utils/orderEvents');
const { changeStatus } = require('../services/orderService');
const shipments = require('../services/shipmentService');
const { reconcilePending } = require('../services/reconcile');
const { releaseStaleHolds } = require('../services/maintenance');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const listItem = (o) => ({
  id: o.id, orderNumber: o.orderNumber, createdAt: o.createdAt, customer: o.customer, total: o.total,
  items: o.items.map((i) => ({ name: i.name, qty: i.qty })), payment: { method: o.payment?.method || '' }, paymentStatus: o.paymentStatus, orderStatus: o.orderStatus,
  refundedAmount: o.refundedAmount, shipment: { awb: o.shipment?.awb, courierName: o.shipment?.courierName, status: o.shipment?.status, error: o.shipment?.error }, delivery: { partner: o.delivery?.partner, trackingId: o.delivery?.trackingId, trackingUrl: o.delivery?.trackingUrl, method: o.delivery?.method?.name || '', type: o.delivery?.method?.type || '', assignee: o.delivery?.assignee?.name || '' },
});

// GET /api/admin/orders?page=&limit=&status=&mode=&q=&from=&to=   (server-side paging & search — safe at 10,000+ orders)
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
  const filter = {};
  if (STATUSES.includes(req.query.status)) filter.orderStatus = req.query.status;
  else if (req.query.statuses) filter.orderStatus = { $in: String(req.query.statuses).split(',').filter((x) => STATUSES.includes(x)) };
  if (req.query.needsAttention === '1') filter['shipment.error'] = { $ne: '' };
  if (req.query.mode === 'cod') filter['payment.method'] = 'cod'; else if (req.query.mode === 'online') filter['payment.method'] = { $ne: 'cod' };
  if (req.query.from || req.query.to) { filter.createdAt = {}; if (req.query.from) filter.createdAt.$gte = new Date(req.query.from); if (req.query.to) filter.createdAt.$lte = new Date(req.query.to); }
  const q = String(req.query.q || '').trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    filter.$or = [{ orderNumber: new RegExp('^' + esc(q), 'i') }, { 'customer.email': new RegExp('^' + esc(q), 'i') }, { 'customer.name': new RegExp(esc(q), 'i') }, ...(digits.length >= 4 ? [{ 'customer.phone': new RegExp(digits + '$') }] : [])];
  }
  const [docs, total, byStatus] = await Promise.all([
    Order.find(filter).select('-events -payment.razorpaySignature').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Order.countDocuments(filter),
    Order.aggregate([{ $group: { _id: '$orderStatus', n: { $sum: 1 } } }]),
  ]);
  res.json({ orders: docs.map(listItem), total, page, pages: Math.ceil(total / limit) || 1, counts: Object.fromEntries(byStatus.map((s) => [s._id, s.n])) });
});

// POST /api/admin/orders/manual — the owner records an order taken by phone / WhatsApp / in person.
// body: { customer:{name,phone,email}, address:{line1,line2,city,state,pincode}, items:[{productId,qty}], shipping, discount, payment:'cod'|'paid', paymentNote, deliveryMethod? }
router.post('/manual', async (req, res) => {
  const Product = require('../models/Product'); const generateOrderNumber = require('../utils/generateOrderNumber');
  const reservations = require('../services/reservations'); const DeliveryMethod = require('../models/DeliveryMethod'); const { snapshot, estimatedDate } = require('../utils/delivery');
  const { finalizeCodOrder, confirmPayment } = require('../services/orderService'); const { captureGuest } = require('../services/guestCapture');
  const b = req.body || {}, c = b.customer || {}, a = b.address || {};
  const d = String(c.phone || '').replace(/\D/g, ''), t = d.length > 10 ? d.slice(-10) : d;
  if (!String(c.name || '').trim() || !/^[6-9]\d{9}$/.test(t)) return res.status(400).json({ error: 'Enter the customer’s name and a valid 10-digit mobile number' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.email || ''))) return res.status(400).json({ error: 'Enter the customer’s email (the invoice is sent there)' });
  if (!a.line1 || !a.city || !a.state || !/^\d{6}$/.test(String(a.pincode || ''))) return res.status(400).json({ error: 'Enter a complete address with a 6-digit PIN code' });
  const wanted = Array.isArray(b.items) ? b.items.filter((i) => i && i.productId && parseInt(i.qty, 10) >= 1) : [];
  if (!wanted.length) return res.status(400).json({ error: 'Add at least one product' });
  const items = [], held = [];
  const undo = async () => { for (const h of held) await reservations.releaseUnits(h.id, h.qty).catch(() => {}); };
  for (const w of wanted) {
    const p = await Product.findById(w.productId); const qty = parseInt(w.qty, 10);
    if (!p || p.status !== 'active') { await undo(); return res.status(400).json({ error: 'One of the products is no longer available' }); }
    if (!(await reservations.reserveUnits(p._id, qty))) { await undo(); return res.status(409).json({ error: `Not enough stock for ${p.name}` }); }
    held.push({ id: p._id, qty }); items.push({ product: p._id, name: p.name, sku: p.sku, price: p.price, qty, image: p.images?.[0] || '' });
  }
  const subtotal = items.reduce((n, i) => n + i.price * i.qty, 0), shipping = Math.max(0, Math.round(Number(b.shipping) || 0)), discount = Math.min(subtotal, Math.max(0, Math.round(Number(b.discount) || 0)));
  const methods = await DeliveryMethod.listAll(); const method = methods.find((m) => m.key === b.deliveryMethod) || methods.find((m) => m.enabled);
  const paid = b.payment === 'paid';
  try {
    const order = await Order.create({
      orderNumber: await generateOrderNumber(), customerId: null,
      customer: { name: String(c.name).trim().slice(0, 100), phone: '+91' + t, email: String(c.email).toLowerCase() },
      address: { line1: String(a.line1).slice(0, 200), line2: String(a.line2 || '').slice(0, 200), city: String(a.city).slice(0, 80), state: String(a.state).slice(0, 80), pincode: a.pincode, country: 'India' },
      items, subtotal, shipping, discount, total: subtotal - discount + shipping,
      payment: { method: paid ? '' : 'cod' }, delivery: { method: method ? snapshot(method, subtotal - discount) : {} }, estimatedDelivery: method ? estimatedDate(method) : undefined,
      attribution: { source: 'admin', medium: 'manual' }, events: [{ label: 'Order placed', stage: 'placed', actor: req.admin.email, type: 'placed' }],
    });
    await captureGuest(order.customer).catch(() => {});
    if (paid) await confirmPayment(order.id, { paymentId: 'manual-' + Date.now(), method: String(b.paymentNote || 'recorded by admin').slice(0, 40), via: 'admin', actor: req.admin.email });
    else await finalizeCodOrder(order);
    await audit({ action: 'order.manual_created', actor: req.admin.email, entity: 'order', entityId: order.id, summary: `Manual order ${order.orderNumber} — ₹${order.total} (${paid ? 'paid' : 'COD'})`, req });
    res.status(201).json({ id: order.id, orderNumber: order.orderNumber, total: order.total });
  } catch (e) { await undo(); res.status(400).json({ error: e.message || 'Could not create the order' }); }
});

// GET /api/admin/orders/:id — everything, including the complete timeline
router.get('/:id', async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const o = order.toJSON(); const ctx0 = await require('../services/trackLink').loadCtx();
  const courierApi = !!(await require('../models/Integration').exists({ provider: { $in: ['shiprocket', 'delhivery'] }, enabled: true })) || !!require('../utils/courier/env').courierFromEnv('shiprocket') || !!require('../utils/courier/env').courierFromEnv('delhivery');
  res.json({ ...o, courierApi, allowedNext: allowedNext(o).filter((s) => s !== 'Refunded'), journey: require('../services/trackLink').finish(buildJourney(o), o, ctx0), returnWindowDays: ctx0.days });
});

// PUT /api/admin/orders/:id/status
router.put('/:id/status', async (req, res) => {
  const { orderStatus, note } = req.body;
  if (orderStatus === 'Refunded') return res.status(400).json({ error: 'Orders become “Refunded” automatically once the full amount is refunded — use the Refund action.' });
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const check = canTransition(order, orderStatus);
  if (!check.ok) return res.status(409).json({ error: check.reason });
  const { from } = await changeStatus(order, orderStatus, { actor: req.admin.email, note: String(note || '').slice(0, 300) });
  await audit({ action: 'order.status_changed', actor: req.admin.email, entity: 'order', entityId: order.id, summary: `Order ${order.orderNumber}: ${from} → ${orderStatus}`, before: { status: from }, after: { status: orderStatus }, req });
  res.json({ ...order.toJSON(), allowedNext: allowedNext(order).filter((s) => s !== 'Refunded') });
});

// PUT /api/admin/orders/:id/delivery — courier details (tracking number) OR, for manual delivery, who is delivering and when
router.put('/:id/delivery', async (req, res) => {
  const { partner, trackingId, trackingUrl, dispatchDate, expectedDelivery, notes, assignee, scheduledFor, notifyCustomer } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const before = { partner: order.delivery.partner, trackingId: order.delivery.trackingId, assignee: order.delivery.assignee?.name };
  const sig = () => JSON.stringify([order.delivery.partner, order.delivery.trackingId, order.delivery.trackingUrl, order.delivery.dispatchDate && +new Date(order.delivery.dispatchDate), order.delivery.expectedDelivery && +new Date(order.delivery.expectedDelivery), order.delivery.assignee?.name, order.delivery.assignee?.phone, order.delivery.scheduledFor && +new Date(order.delivery.scheduledFor)]);
  const sigBefore = sig();
  const d = order.delivery;                                       // field by field — the chosen delivery method must never be overwritten
  if (partner !== undefined) d.partner = String(partner).slice(0, 60);
  if (trackingId !== undefined) d.trackingId = String(trackingId).slice(0, 60);
  if (trackingUrl !== undefined) { const u = String(trackingUrl).trim().slice(0, 400); if (u && !/^https?:\/\/[^\s"'<>]+$/.test(u)) return res.status(400).json({ error: 'The tracking link must start with https://' }); d.trackingUrl = u; }
  if (dispatchDate !== undefined) d.dispatchDate = dispatchDate || null;
  if (expectedDelivery !== undefined) { d.expectedDelivery = expectedDelivery || null; if (expectedDelivery) order.estimatedDelivery = expectedDelivery; }
  if (notes !== undefined) d.notes = String(notes).slice(0, 500);
  if (scheduledFor !== undefined) { d.scheduledFor = scheduledFor || null; if (scheduledFor) order.estimatedDelivery = scheduledFor; }
  if (assignee !== undefined) {
    const name = String(assignee?.name || '').trim().slice(0, 60), phone = String(assignee?.phone || '').replace(/[^\d+]/g, '').slice(0, 15);
    if (order.delivery.method?.type === 'manual' && !name) return res.status(400).json({ error: 'Enter the delivery person’s name' });
    d.assignee = { name, phone };
    if (name && name !== before.assignee) pushEvent(order, { label: 'Delivery person assigned', actor: req.admin.email, note: name, type: 'assignee' });
  }
  if (trackingId && trackingId !== before.trackingId) pushEvent(order, { label: 'Tracking number added', actor: req.admin.email, note: `${partner || 'Courier'} · ${trackingId}`, type: 'tracking' });
  await order.save();
  const sigAfter = sig(); let notified = false;
  const hasInfo = order.delivery.trackingId || order.delivery.partner || order.delivery.assignee?.name || order.delivery.expectedDelivery || order.delivery.scheduledFor;
  if (notifyCustomer !== false && sigAfter !== sigBefore && hasInfo && !['Cancelled', 'Refunded'].includes(order.orderStatus)) {
    notified = true; pushEvent(order, { label: 'Delivery details sent to customer', actor: 'system', public: false, type: 'tracking_notice' }); await order.save();
    require('../services/notifier').notifyOrder('tracking_update', { order, rev: require('crypto').createHash('sha1').update(sigAfter).digest('hex').slice(0, 10) });
  }
  await audit({ action: 'order.delivery_updated', actor: req.admin.email, entity: 'order', entityId: order.id, summary: `Delivery details updated for ${order.orderNumber}`, before, after: { partner: d.partner, trackingId: d.trackingId, assignee: d.assignee?.name }, req });
  res.json({ ...order.toJSON(), notified });
});

// POST /api/admin/orders/:id/note — internal note (default) or a message visible on the customer's tracking page
router.post('/:id/note', async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const text = String(req.body.note || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Write a note first' });
  pushEvent(order, { label: req.body.visibleToCustomer ? 'Update from The Craft Lab' : 'Internal note', note: text, actor: req.admin.email, public: !!req.body.visibleToCustomer, type: 'note' });
  await order.save();
  res.json({ ok: true });
});

// POST /api/admin/orders/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const check = canTransition(order, 'Cancelled');
  if (!check.ok) return res.status(409).json({ error: check.reason });
  const paidOnline = order.paymentStatus === 'Paid' && order.payment.method !== 'cod';
  if (order.shipment?.providerOrderId && order.shipment.status !== 'cancelled') { try { await shipments.cancelShipment(order, req.admin.email); } catch (e) { /* courier cancel is best effort — the order can still be cancelled */ } }
  const { from } = await changeStatus(order, 'Cancelled', { actor: req.admin.email, note: String(req.body.reason || '').slice(0, 300) });
  await audit({ action: 'order.cancelled', actor: req.admin.email, entity: 'order', entityId: order.id, summary: `Cancelled Order ${order.orderNumber}`, before: { status: from }, after: { status: 'Cancelled' }, req });
  res.json({ cancelled: true, refundDue: paidOnline, total: order.total });
});

// DELETE /api/admin/orders/:id — permanently removes an order (store owner only). A live order is cancelled first so its stock goes back on sale.
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.orderStatus !== 'Cancelled' && canTransition(order, 'Cancelled').ok) {
    if (order.shipment?.providerOrderId && order.shipment.status !== 'cancelled') { try { await shipments.cancelShipment(order, req.admin.email); } catch (e) { /* best effort */ } }
    try { await changeStatus(order, 'Cancelled', { actor: req.admin.email, note: 'Order deleted by admin' }); } catch (e) { /* still deletable */ }
  }
  await Order.deleteOne({ _id: order._id });
  await audit({ action: 'order.deleted', actor: req.admin.email, entity: 'order', entityId: order.id, summary: `Deleted order ${order.orderNumber} (₹${order.total}, ${order.paymentStatus})`, before: { orderStatus: order.orderStatus, paymentStatus: order.paymentStatus, total: order.total }, req });
  res.json({ deleted: true, orderNumber: order.orderNumber, wasPaid: order.paymentStatus === 'Paid' });
});

/* ---------- courier shipments ---------- */
router.post('/shipments/sync-all', async (req, res) => res.json(await shipments.syncAll(50)));
router.post('/:id/shipment', async (req, res) => { res.status(201).json(await shipments.createForOrder(req.params.id, { actor: req.admin.email, provider: req.body.provider })); });
router.post('/:id/shipment/sync', async (req, res) => {
  const order = await Order.findById(req.params.id); if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(await shipments.syncOrder(order, req.admin.email));
});
router.delete('/:id/shipment', async (req, res) => {
  const order = await Order.findById(req.params.id); if (!order) return res.status(404).json({ error: 'Order not found' });
  await shipments.cancelShipment(order, req.admin.email); res.json({ cancelled: true });
});

// POST /api/admin/orders/release-stale — first asks Razorpay what really happened, then frees holds on checkouts that never completed
router.post('/release-stale', async (req, res) => {
  const reconcile = await reconcilePending({ olderThanMin: 5 }).catch(() => ({ errors: 1 }));
  const released = await releaseStaleHolds(parseInt(req.body.cutoffMinutes) || 30);
  await audit({ action: 'orders.stale_released', actor: req.admin.email, summary: `Released ${released} stale checkout(s); recovered ${reconcile.recovered || 0} payment(s)`, req });
  res.json({ released, recovered: reconcile.recovered || 0 });
});

// PUT /api/admin/orders/:id/invoice — (re)issue a tax invoice with the GST rate you choose
router.put('/:id/invoice', async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const settings = await getSettings();
  if (!order.invoiceNumber) order.invoiceNumber = `${settings.invoicePrefix || 'INV'}-${await getNextSequence('invoiceNumber')}`;
  const parsed = parseFloat(req.body.taxRate);
  const rate = Number.isFinite(parsed) ? parsed : settings.defaultTaxRate || 0;
  order.taxRate = rate;
  order.taxAmount = rate > 0 ? Math.round((order.total - order.total / (1 + rate / 100)) * 100) / 100 : 0;
  await order.save();
  await audit({ action: 'order.invoice_generated', actor: req.admin.email, entity: 'order', entityId: order.id, summary: `Invoice ${order.invoiceNumber} for ${order.orderNumber} (GST ${rate}%)`, req });
  res.json(order);
});

module.exports = router;
