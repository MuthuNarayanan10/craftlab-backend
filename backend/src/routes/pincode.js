const express = require('express');
const router = express.Router();
const { checkPincode } = require('../services/serviceability');

// GET /api/pincode/:pin?subtotal=&cod=1 — "Delivery available by Fri, 9 Oct" / "Delivery not available"
router.get('/:pin', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json(await checkPincode(req.params.pin, { subtotal: Number(req.query.subtotal) || 0, cod: req.query.cod === '1' }));
});
module.exports = router;
