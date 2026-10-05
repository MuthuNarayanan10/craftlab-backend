const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const { adjustStock } = require('../services/inventory');
const { audit } = require('../models/AuditLog');

// GET /api/admin/inventory — stock position per product (+ 30-day sales velocity and integrity flags)
router.get('/', async (req, res) => {
  const since = new Date(Date.now() - 30 * 86400e3);
  const [products, sold] = await Promise.all([
    Product.find({ status: { $ne: 'archived' } }).sort({ name: 1 }),
    StockMovement.aggregate([{ $match: { reason: { $in: ['order_paid', 'cod_order'] }, createdAt: { $gte: since } } }, { $group: { _id: '$product', units: { $sum: '$delta' } } }]),
  ]);
  const soldMap = Object.fromEntries(sold.map((s) => [String(s._id), -s.units])); // sales are negative movements
  const items = products.map((p) => {
    const units30 = soldMap[p.id] || 0, available = p.stock - p.reserved;
    return { id: p.id, name: p.name, sku: p.sku, image: p.images?.[0] || '', stock: p.stock, reserved: p.reserved, available, lowStockThreshold: p.lowStockThreshold, price: p.price, stockValue: p.stock * p.price, sold30: units30,
      daysCover: units30 > 0 ? Math.floor(available / (units30 / 30)) : null,
      flags: [...(p.stock < 0 ? ['negative_stock'] : []), ...(p.reserved > p.stock ? ['reserved_exceeds_stock'] : []), ...(p.stock <= p.lowStockThreshold ? ['low_stock'] : [])] };
  });
  res.json({ items, totals: { units: items.reduce((s, i) => s + i.stock, 0), value: items.reduce((s, i) => s + i.stockValue, 0), low: items.filter((i) => i.flags.includes('low_stock')).length, problems: items.filter((i) => i.flags.some((f) => f !== 'low_stock')).length } });
});

// GET /api/admin/inventory/movements?product=&page=
router.get('/movements', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = 30;
  const filter = req.query.product ? { product: req.query.product } : {};
  const [rows, total] = await Promise.all([StockMovement.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), StockMovement.countDocuments(filter)]);
  res.json({ movements: rows.map((m) => m.toObject()), total, page, pages: Math.ceil(total / limit) || 1 });
});

// POST /api/admin/inventory/adjust {productId, delta, reason, note}
router.post('/adjust', async (req, res) => {
  const delta = parseInt(req.body.delta, 10);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) return res.status(400).json({ error: 'Enter a whole number to add (e.g. 10) or remove (e.g. -2)' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Choose a reason — every stock change is recorded' });
  try {
    const p = await adjustStock(req.body.productId, delta, { reason: 'manual_adjustment', note: reason + (req.body.note ? ` — ${String(req.body.note).slice(0, 150)}` : ''), actor: req.admin.email });
    await audit({ action: 'inventory.adjusted', actor: req.admin.email, entity: 'product', entityId: p.id, summary: `${p.name}: ${delta > 0 ? '+' : ''}${delta} (${reason}) → ${p.stock} in stock`, after: { stock: p.stock }, req });
    res.json({ id: p.id, stock: p.stock });
  } catch (e) { res.status(409).json({ error: e.message === 'Not enough stock for that change' ? 'You can’t remove more units than are in stock' : e.message }); }
});
module.exports = router;
