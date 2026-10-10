const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const { requireRole } = require('../middleware/adminAuth');
const { audit } = require('../models/AuditLog');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/admin/customers?q=&page=   — one aggregation for all stats (no per-customer queries)
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, parseInt(req.query.limit) || 25);
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || '');
  const filter0 = q ? { $or: [{ name: new RegExp(esc(q), 'i') }, { email: new RegExp('^' + esc(q), 'i') }, ...(q.replace(/\D/g, '').length >= 4 ? [{ phone: new RegExp(q.replace(/\D/g, '') + '$') }] : [])] } : {};
  const filter = type === 'guest' ? { ...filter0, isGuest: true } : type === 'registered' ? { ...filter0, isGuest: { $ne: true } } : filter0;
  const [customers, total] = await Promise.all([Customer.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), Customer.countDocuments(filter)]);
  const ids = customers.map((c) => c._id);
  const [counts, spend] = await Promise.all([ // orders = everything that wasn't cancelled; spend = money actually received
    Order.aggregate([{ $match: { customerId: { $in: ids }, orderStatus: { $ne: 'Cancelled' } } }, { $group: { _id: '$customerId', orderCount: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { customerId: { $in: ids }, paymentStatus: { $in: ['Paid', 'Refunded'] } } }, { $group: { _id: '$customerId', totalSpend: { $sum: '$total' } } }]),
  ]);
  const byId = {}; for (const c of counts) byId[String(c._id)] = { orderCount: c.orderCount }; for (const s of spend) byId[String(s._id)] = { ...(byId[String(s._id)] || {}), totalSpend: s.totalSpend };
  // most recent order per customer (indexed lookups; one page of customers at a time)
  const lastOrders = await Promise.all(customers.map((c) => Order.findOne({ customerId: c._id, paymentStatus: { $in: ['Paid', 'Refunded'] } }).sort({ createdAt: -1 }).select('createdAt').lean()));
  const lastBy = Object.fromEntries(customers.map((c, i) => [c.id, lastOrders[i]?.createdAt || null]));
  // guests have no orders attached (contact record only): count theirs by the contact they typed
  const contactOf = (c) => [...(c.phone ? [{ 'customer.phone': c.phone }] : []), ...(c.email ? [{ 'customer.email': c.email }] : [])];
  const guestStats = {};
  await Promise.all(customers.filter((c) => c.isGuest && contactOf(c).length).map(async (c) => {
    const os = await Order.find({ $or: contactOf(c), orderStatus: { $ne: 'Cancelled' } }).select('total paymentStatus createdAt').lean();
    guestStats[c.id] = { orderCount: os.length, totalSpend: os.filter((o) => ['Paid', 'Refunded'].includes(o.paymentStatus)).reduce((n, o) => n + o.total, 0), lastOrderAt: os.map((o) => o.createdAt).sort().pop() || null };
  }));
  res.json({ customers: customers.map((c) => ({ ...c.toJSON(), orderCount: guestStats[c.id]?.orderCount ?? (byId[c.id]?.orderCount || 0), totalSpend: guestStats[c.id]?.totalSpend ?? (byId[c.id]?.totalSpend || 0), lastOrderAt: guestStats[c.id] ? guestStats[c.id].lastOrderAt : lastBy[c.id] })), total, page, pages: Math.ceil(total / limit) || 1 });
});

router.get('/:id', async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const orders = await Order.find({ $or: [{ customerId: customer._id }, ...(customer.isGuest ? [...(customer.phone ? [{ 'customer.phone': customer.phone }] : []), ...(customer.email ? [{ 'customer.email': customer.email }] : [])] : []), ...(customer.phoneVerified && customer.phone ? [{ 'customer.phone': customer.phone }] : []), ...(customer.emailVerified && customer.email ? [{ 'customer.email': customer.email }] : [])] }).select('orderNumber total orderStatus paymentStatus createdAt').sort({ createdAt: -1 }).limit(50);
  res.json({ ...customer.toJSON(), orders: orders.map((o) => o.toJSON()) });
});

router.put('/:id/status', requireRole('ADMIN'), async (req, res) => {
  if (!['active', 'blocked'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  const c = await Customer.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  await audit({ action: 'customer.status_changed', actor: req.admin.email, entity: 'customer', entityId: c.id, summary: `${req.body.status === 'blocked' ? 'Blocked' : 'Unblocked'} customer ${c.name}`, req });
  res.json(c);
});
module.exports = router;
