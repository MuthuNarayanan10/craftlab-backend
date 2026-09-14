const express = require('express');
const router = express.Router();
const Coupon = require('../models/Coupon');

// GET /api/admin/coupons
router.get('/', async (req, res) => {
  const coupons = await Coupon.find().sort({ createdAt: -1 });
  res.json(coupons);
});

// POST /api/admin/coupons
router.post('/', async (req, res) => {
  const coupon = await Coupon.create(req.body);
  res.status(201).json(coupon);
});

// PUT /api/admin/coupons/:id
router.put('/:id', async (req, res) => {
  const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!coupon) return res.status(404).json({ error: 'Coupon not found' });
  res.json(coupon);
});

// DELETE /api/admin/coupons/:id — deactivates rather than deletes
router.delete('/:id', async (req, res) => {
  await Coupon.findByIdAndUpdate(req.params.id, { active: false });
  res.json({ deactivated: true });
});

module.exports = router;
