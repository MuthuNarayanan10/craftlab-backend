const express = require('express');
const router = express.Router();
const cats = require('../services/categories');
const Product = require('../models/Product');
const { requireRole } = require('../middleware/adminAuth');
const { audit } = require('../models/AuditLog');

// GET /api/admin/categories — the tree plus how many products use each
router.get('/', async (req, res) => {
  const tree = await cats.getTree();
  const ps = await Product.find({ status: { $ne: 'archived' } }).select('category subcategory').lean();
  res.json({ categories: tree.map((c) => ({ ...c, productCount: ps.filter((p) => cats.same(p.category, c.name)).length, subcategories: c.subcategories.map((x) => ({ ...x, productCount: ps.filter((p) => cats.same(p.category, c.name) && cats.same(p.subcategory, x.name)).length })) })) });
});
// PUT /api/admin/categories { categories: [{ name, was?, subcategories: [{ name, was? }] }] }
router.put('/', requireRole('ADMIN'), async (req, res) => {
  const r = await cats.saveTree(req.body.categories);
  if (r.error) return res.status(400).json({ error: r.error });
  await audit({ action: 'categories.updated', actor: req.admin.email, entity: 'settings', summary: `Categories updated (${r.tree.length} categories)`, req });
  res.json({ categories: r.tree });
});
module.exports = router;
