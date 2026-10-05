const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const { adjustStock } = require('../services/inventory');
const { audit } = require('../models/AuditLog');

const FIELDS = ['name', 'slug', 'sku', 'shortDescription', 'longDescription', 'price', 'mrp', 'category', 'tags', 'material', 'dimensions', 'weight', 'features', 'careInstructions', 'whatsIncluded', 'images', 'lowStockThreshold', 'seoTitle', 'seoDescription', 'status'];
const pick = (body) => Object.fromEntries(FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

router.get('/', async (req, res) => res.json(await Product.find().sort({ createdAt: -1 })));

router.post('/', async (req, res) => {
  const data = pick(req.body);
  const initial = Math.max(0, parseInt(req.body.stock, 10) || 0);
  const product = await Product.create({ ...data, stock: 0 });
  if (initial) await adjustStock(product.id, initial, { reason: 'initial_stock', actor: req.admin.email });
  await audit({ action: 'product.created', actor: req.admin.email, entity: 'product', entityId: product.id, summary: `Created product ${product.name} (₹${product.price})`, req });
  res.status(201).json(await Product.findById(product.id));
});

router.put('/:id', async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const before = { price: product.price, mrp: product.mrp, status: product.status };
  Object.assign(product, pick(req.body));
  await product.save();
  // stock is only ever changed through the ledger, so every change has a reason and a history
  if (req.body.stock !== undefined) {
    const target = parseInt(req.body.stock, 10);
    const fresh = await Product.findById(product.id);
    if (Number.isInteger(target) && target >= 0 && target !== fresh.stock) {
      try { await adjustStock(product.id, target - fresh.stock, { reason: 'manual_adjustment', actor: req.admin.email, note: 'Edited in Products' }); }
      catch (e) { return res.status(409).json({ error: 'Stock changed while you were editing — refresh and try again' }); }
    }
  }
  const after = { price: product.price, mrp: product.mrp, status: product.status };
  if (JSON.stringify(before) !== JSON.stringify(after)) await audit({ action: 'product.updated', actor: req.admin.email, entity: 'product', entityId: product.id, summary: `Updated ${product.name}`, before, after, req });
  res.json(await Product.findById(product.id));
});

router.delete('/:id', async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, { status: 'archived' }, { new: true });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  await audit({ action: 'product.archived', actor: req.admin.email, entity: 'product', entityId: product.id, summary: `Archived ${product.name}`, req });
  res.json({ archived: true });
});
module.exports = router;
