const express = require('express');
const router = express.Router();
const Supplier = require('../models/Supplier');

// GET /api/admin/suppliers
router.get('/', async (req, res) => {
  const suppliers = await Supplier.find().sort({ createdAt: -1 });
  res.json(suppliers);
});

// POST /api/admin/suppliers
router.post('/', async (req, res) => {
  const supplier = await Supplier.create(req.body);
  res.status(201).json(supplier);
});

// PUT /api/admin/suppliers/:id
router.put('/:id', async (req, res) => {
  const supplier = await Supplier.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  res.json(supplier);
});

// DELETE /api/admin/suppliers/:id
router.delete('/:id', async (req, res) => {
  await Supplier.findByIdAndUpdate(req.params.id, { status: 'inactive' });
  res.json({ deactivated: true });
});

module.exports = router;
