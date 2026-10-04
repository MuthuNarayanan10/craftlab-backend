const express = require('express');
const router = express.Router();
const { getSettings } = require('../models/Settings');

// GET /api/config/public — non-sensitive settings the storefront needs
router.get('/public', async (req, res) => {
  const s = await getSettings();
  res.json({
    businessName: s.businessName,
    codEnabled: s.codEnabled,
    codFee: s.codFee,
    prepaidDiscountPercent: s.prepaidDiscountPercent,
    supportWhatsapp: s.supportWhatsapp,
    returnWindowDays: s.returnWindowDays,
    supportEmail: s.email,
  });
});

module.exports = router;
