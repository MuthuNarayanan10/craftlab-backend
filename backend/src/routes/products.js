const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

// GET /api/products — storefront catalog (active products only)
router.get('/', async (req, res) => {
  const { category, sort } = req.query;
  const filter = { status: 'active' };
  if (category) filter.category = category;

  let query = Product.find(filter);
  if (sort === 'price-low') query = query.sort({ price: 1 });
  else if (sort === 'price-high') query = query.sort({ price: -1 });
  else query = query.sort({ createdAt: -1 });

  const products = await query;
  res.json(products);
});

// GET /api/products/:slug — single product by slug (for the product page)
router.get('/:slug', async (req, res) => {
  const product = await Product.findOne({ slug: req.params.slug, status: 'active' });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

module.exports = router;
