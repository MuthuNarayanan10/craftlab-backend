const express = require('express');
const router = express.Router();
const { getSettings } = require('../models/Settings');
const { channelOf } = require('../utils/otpChannel');

// GET /api/config/public — non-sensitive settings the storefront needs (cached briefly by browsers / CDN)
router.get('/public', async (req, res) => {
  const s = await getSettings();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    businessName: s.businessName, supportEmail: s.email, supportWhatsapp: s.supportWhatsapp, supportHours: s.supportHours,
    rewards: { enabled: s.rewardsEnabled, earnPercent: s.rewardEarnPercent, redeemMaxPercent: s.rewardRedeemMaxPercent, redeemMinPoints: s.rewardRedeemMinPoints, cashbackPercent: s.cashbackPercent, cashbackMinOrder: s.cashbackMinOrder, giftCards: s.giftCardsEnabled }, returnWindowDays: s.returnWindowDays,
    codEnabled: s.codEnabled, codFee: s.codFee, prepaidDiscountPercent: s.prepaidDiscountPercent,
    auth: { loginEnabled: s.customerLoginEnabled, signupEnabled: s.customerSignupEnabled, otpEnabled: s.otpEnabled && s.otpProvider !== 'none', otpProvider: s.otpProvider, otpChannel: channelOf(s), guestCheckoutEnabled: s.guestCheckoutEnabled && !s.requireMobileVerification, requireMobileVerification: s.requireMobileVerification },
    // printed on customer-visible invoices
    business: { legalName: s.legalName || s.businessName, gstin: s.gstin, pan: s.pan, address: s.address, city: s.city, state: s.state, pincode: s.pincode, phone: s.phone, email: s.email },
  });
});
module.exports = router;
