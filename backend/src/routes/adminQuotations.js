const express = require('express');
const router = express.Router();
const Quotation = require('../models/Quotation');

async function nextQuotationNumber() {
  const count = await Quotation.countDocuments();
  return `QT-${1001 + count}`;
}

// GET /api/admin/quotations
router.get('/', async (req, res) => {
  const quotations = await Quotation.find().sort({ createdAt: -1 });
  res.json(quotations);
});

// POST /api/admin/quotations
router.post('/', async (req, res) => {
  const { supplierId, supplierName, items, notes } = req.body;
  if (!supplierId || !items?.length) return res.status(400).json({ error: 'supplierId and at least one item are required' });
  const quotationNumber = await nextQuotationNumber();
  const quotation = await Quotation.create({ quotationNumber, supplier: supplierId, supplierName, items, notes });
  res.status(201).json(quotation);
});

// PUT /api/admin/quotations/:id/status
router.put('/:id/status', async (req, res) => {
  const quotation = await Quotation.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
  if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
  res.json(quotation);
});

module.exports = router;
