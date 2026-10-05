const express = require('express');
const router = express.Router();
const DeliveryMethod = require('../models/DeliveryMethod');
const { applicableMethods } = require('../utils/delivery');

// GET /api/delivery/options?pincode=600001&subtotal=2499&cod=1 — the delivery choices this customer can pick (enabled + serviceable), with their price
router.get('/options', async (req, res) => {
  const pincode = String(req.query.pincode || '').replace(/\D/g, '');
  const options = applicableMethods(await DeliveryMethod.listAll(), { pincode: pincode.length === 6 ? pincode : '', subtotal: Number(req.query.subtotal) || 0, cod: req.query.cod === '1' });
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ options, pincodeChecked: pincode.length === 6 });
});
module.exports = router;
