const express = require('express');
const router = express.Router();
const Return = require('../models/Return');
const Order = require('../models/Order');
const { logAction } = require('../models/AuditLog');

// GET /api/admin/returns — list (photos omitted; fetch one by id for the photos)
router.get('/', async (req, res) => {
  const docs = await Return.find().sort({ createdAt: -1 }).lean();
  res.json(docs.map(d => ({ ...d, id: String(d._id), imageCount: (d.images || []).length, images: undefined, _id: undefined, __v: undefined })));
});

// GET /api/admin/returns/:id — full detail including photos
router.get('/:id', async (req, res) => {
  const r = await Return.findById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Return request not found' });
  res.json(r);
});

// PUT /api/admin/returns/:id/status
router.put('/:id/status', async (req, res) => {
  const { status, adminNotes } = req.body;
  const returnReq = await Return.findByIdAndUpdate(req.params.id, { status, adminNotes }, { new: true });
  if (!returnReq) return res.status(404).json({ error: 'Return request not found' });

  if (status === 'Refunded') {
    await Order.findByIdAndUpdate(returnReq.order, { paymentStatus: 'Refunded', orderStatus: 'Refunded' });
  }
  await logAction('return.status_changed', req.admin.email, { orderNumber: returnReq.orderNumber, status });
  res.json({ ...returnReq.toJSON(), images: undefined });
});

module.exports = router;
