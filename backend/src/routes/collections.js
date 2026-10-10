const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const { getSettings } = require('../models/Settings');

const card = (p) => ({ id: p.id, name: p.name, slug: p.slug, sku: p.sku, price: p.price, mrp: p.mrp, category: p.category, subcategory: p.subcategory || '', images: (p.images || []).slice(0, 2), available: Math.max(0, p.stock - (p.reserved || 0)), shortDescription: p.shortDescription });

async function productsFor(c) {
  const limit = Math.min(24, Math.max(1, c.limit || 8));
  if (c.mode === 'auto' && c.key === 'new-arrivals') return (await Product.find({ status: 'active' }).sort({ createdAt: -1 }).limit(limit)).map(card);
  if (c.mode === 'auto' && c.key === 'best-sellers') {
    const since = new Date(Date.now() - 90 * 86400e3);
    const sold = await StockMovement.aggregate([{ $match: { reason: { $in: ['order_paid', 'cod_order'] }, createdAt: { $gte: since } } }, { $group: { _id: '$product', units: { $sum: '$delta' } } }]);
    const ids = sold.filter((s) => s.units < 0).sort((a, b) => a.units - b.units).slice(0, limit).map((s) => s._id);
    const ps = await Product.find({ _id: { $in: ids }, status: 'active' });
    return ids.map((id) => ps.find((p) => String(p._id) === String(id))).filter(Boolean).map(card);
  }
  return (await Product.find({ status: 'active', collections: c.key }).sort({ collectionRank: 1, createdAt: -1 }).limit(limit)).map(card); // admin-picked, in the admin's order
}

// GET /api/collections — the homepage carousels: real products from the database, in the order the admin chose
router.get('/', async (req, res) => {
  const { collections } = await getSettings();
  const out = [];
  for (const c of collections.filter((x) => x.enabled)) { const products = await productsFor(c); if (products.length) out.push({ key: c.key, title: c.title, products }); }
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ collections: out });
});
module.exports = router;
