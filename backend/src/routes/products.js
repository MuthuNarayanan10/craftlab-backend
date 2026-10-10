const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

// GET /api/products — storefront catalog (active only). Cacheable by the CDN/browser for a minute.
router.get('/', async (req, res) => {
  const filter = { status: 'active' };
  if (req.query.category) filter.category = String(req.query.category);
  if (req.query.subcategory) filter.subcategory = String(req.query.subcategory);
  const sort = req.query.sort === 'price-low' ? { price: 1 } : req.query.sort === 'price-high' ? { price: -1 } : { createdAt: -1 };
  const limit = Math.min(100, parseInt(req.query.limit) || 100);
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  res.json(await Product.find(filter).sort(sort).limit(limit));
});

router.get('/:slug', async (req, res) => {
  const product = await Product.findOne({ slug: String(req.params.slug).toLowerCase(), status: 'active' });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  res.json(product);
});
module.exports = router;
