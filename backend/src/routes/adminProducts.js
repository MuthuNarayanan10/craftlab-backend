const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const { logAction } = require('../models/AuditLog');

// GET /api/admin/products — all products regardless of status
router.get('/', async (req, res) => {
  const products = await Product.find().sort({ createdAt: -1 });
  res.json(products);
});

// POST /api/admin/products
router.post('/', async (req, res) => {
  const product = await Product.create(req.body);
  await logAction('product.created', req.admin.email, { productId: product.id, name: product.name });
  res.status(201).json(product);
});

// PUT /api/admin/products/:id
router.put('/:id', async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  await logAction('product.updated', req.admin.email, { productId: product.id });
  res.json(product);
});

// DELETE /api/admin/products/:id — archives rather than hard-deletes (preserves order history integrity)
router.delete('/:id', async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, { status: 'archived' }, { new: true });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  await logAction('product.archived', req.admin.email, { productId: product.id });
  res.json({ archived: true });
});

module.exports = router;
