const express = require('express');
const router = express.Router();
const Quotation = require('../models/Quotation');
const Supplier = require('../models/Supplier');
const { getSettings } = require('../models/Settings');
const { getNextSequence } = require('../models/Counter');
const { sendEmail, quotationRequestEmail } = require('../utils/email');
const { logAction } = require('../models/AuditLog');

// GET /api/admin/quotations
router.get('/', async (req, res) => res.json(await Quotation.find().sort({ createdAt: -1 })));

// POST /api/admin/quotations
router.post('/', async (req, res) => {
  const { supplierId, supplierName, items, notes } = req.body;
  if (!supplierId || !items?.length) return res.status(400).json({ error: 'Choose a supplier and add at least one item' });
  const quotationNumber = `QT-${await getNextSequence('quotationNumber')}`;
  const quotation = await Quotation.create({ quotationNumber, supplier: supplierId, supplierName, items, notes });
  res.status(201).json(quotation);
});

// PUT /api/admin/quotations/:id/status
router.put('/:id/status', async (req, res) => {
  const quotation = await Quotation.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
  if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
  res.json(quotation);
});

// POST /api/admin/quotations/:id/send-email — emails the quotation request to the supplier
router.post('/:id/send-email', async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
  const supplier = await Supplier.findById(quotation.supplier);
  if (!supplier?.email) return res.status(400).json({ error: 'This supplier has no email address saved. Add one under Manufacturers, or use WhatsApp.' });

  const settings = await getSettings();
  const { subject, html } = quotationRequestEmail(quotation, supplier, settings);
  const result = await sendEmail(supplier.email, subject, html);
  if (result.skipped) return res.status(503).json({ error: 'Email sending is not configured yet (set RESEND_API_KEY and RESEND_FROM on the server). Use WhatsApp for now.' });

  if (quotation.status === 'Draft') { quotation.status = 'Sent'; await quotation.save(); }
  await logAction('quotation.emailed', req.admin.email, { quotationNumber: quotation.quotationNumber, to: supplier.email });
  res.json({ sent: true, to: supplier.email });
});

module.exports = router;
