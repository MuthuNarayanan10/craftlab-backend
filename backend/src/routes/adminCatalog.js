const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const { getSettings } = require('../models/Settings');
const { requireRole } = require('../middleware/adminAuth');
const { audit } = require('../models/AuditLog');
const KEYS = ['featured', 'new-arrivals', 'best-sellers', 'recommended'];

// GET /api/admin/catalog/collections — settings + which products are in each
router.get('/collections', async (req, res) => {
  const s = await getSettings();
  const products = await Product.find({ status: { $ne: 'archived' } }).select('name sku images collections collectionRank status').sort({ collectionRank: 1, name: 1 });
  res.json({ collections: s.collections.map((c) => ({ ...c.toObject?.() ?? c, productIds: products.filter((p) => p.collections.includes(c.key)).sort((a, b) => a.collectionRank - b.collectionRank).map((p) => p.id) })), products: products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, image: p.images?.[0] || '', status: p.status })) });
});
// PUT /api/admin/catalog/collections — titles, on/off, auto/manual, how many to show
router.put('/collections', requireRole('ADMIN'), async (req, res) => {
  const incoming = Array.isArray(req.body.collections) ? req.body.collections : [];
  const s = await getSettings();
  s.collections = KEYS.map((key) => { const cur = s.collections.find((c) => c.key === key) || {}; const n = incoming.find((c) => c.key === key) || {};
    const auto = ['new-arrivals', 'best-sellers'].includes(key) && n.mode === 'auto';
    return { key, title: String(n.title ?? cur.title ?? key).trim().slice(0, 40) || cur.title, enabled: n.enabled !== undefined ? !!n.enabled : cur.enabled, mode: auto ? 'auto' : 'manual', limit: Math.min(24, Math.max(2, parseInt(n.limit ?? cur.limit, 10) || 8)) }; });
  await s.save(); await audit({ action: 'collections.updated', actor: req.admin.email, entity: 'settings', summary: 'Homepage carousels updated', req });
  res.json(s.collections);
});
// PUT /api/admin/catalog/collections/:key/products {productIds:[…]} — exactly these products, in this order
router.put('/collections/:key/products', requireRole('ADMIN'), async (req, res) => {
  const key = req.params.key; if (!KEYS.includes(key)) return res.status(404).json({ error: 'Unknown collection' });
  const ids = (Array.isArray(req.body.productIds) ? req.body.productIds : []).map(String).slice(0, 60);
  await Product.updateMany({ collections: key, _id: { $nin: ids } }, { $pull: { collections: key } });
  for (let i = 0; i < ids.length; i++) await Product.updateOne({ _id: ids[i] }, { $addToSet: { collections: key }, $set: { collectionRank: i + 1 } });
  await audit({ action: 'collections.products_set', actor: req.admin.email, entity: 'settings', entityId: key, summary: `“${key}” now shows ${ids.length} product${ids.length === 1 ? '' : 's'}`, req });
  res.json({ key, count: ids.length });
});
module.exports = router;
