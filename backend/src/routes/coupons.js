const express = require('express');
const router = express.Router();
const Coupon = require('../models/Coupon');

// POST /api/coupons/validate — public, used by the cart page to preview a discount
router.post('/validate', async (req, res) => {
  const { code, subtotal } = req.body;
  const coupon = await Coupon.findOne({ code: (code || '').toUpperCase(), active: true });
  if (!coupon) return res.status(404).json({ error: 'Invalid coupon code' });
  if (coupon.expiresAt && coupon.expiresAt < new Date()) return res.status(400).json({ error: 'Coupon has expired' });
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) return res.status(400).json({ error: 'Coupon usage limit reached' });
  if (subtotal < coupon.minOrderValue) return res.status(400).json({ error: `Minimum order value is ₹${coupon.minOrderValue}` });

  const discount = coupon.type === 'percentage' ? Math.round(subtotal * (coupon.value / 100)) : coupon.value;
  res.json({ valid: true, discount: Math.min(discount, subtotal), code: coupon.code });
});

module.exports = router;
