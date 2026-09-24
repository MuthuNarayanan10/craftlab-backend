const express = require('express');
const router = express.Router();
const Return = require('../models/Return');
const Order = require('../models/Order');

// GET /api/admin/returns
router.get('/', async (req, res) => {
  const returns = await Return.find().sort({ createdAt: -1 });
  res.json(returns);
});

// PUT /api/admin/returns/:id/status
router.put('/:id/status', async (req, res) => {
  const { status, adminNotes } = req.body;
  const returnReq = await Return.findByIdAndUpdate(req.params.id, { status, adminNotes }, { new: true });
  if (!returnReq) return res.status(404).json({ error: 'Return request not found' });

  if (status === 'Refunded') {
    await Order.findByIdAndUpdate(returnReq.order, { paymentStatus: 'Refunded', orderStatus: 'Refunded' });
  }
  res.json(returnReq);
});

module.exports = router;
