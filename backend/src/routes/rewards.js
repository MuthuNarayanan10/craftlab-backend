const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');
const GiftCard = require('../models/GiftCard');
const RewardLedger = require('../models/RewardLedger');
const { getSettings } = require('../models/Settings');
const { requireCustomer, optionalCustomer } = require('../middleware/customerAuth');
const rewards = require('../services/rewards');
const RM = require('../utils/rewardsMath');

// GET /api/rewards/me — balance, what is pending, the rules, and the history
router.get('/me', requireCustomer, async (req, res) => {
  const [wallet, history] = await Promise.all([rewards.walletView(req.customer), RewardLedger.find({ customerId: req.customer.id }).sort({ createdAt: -1 }).limit(60)]);
  res.json({ ...wallet, history: history.map((h) => ({ type: h.type, source: h.source, points: h.points, affects: h.affects, orderNumber: h.orderNumber, note: h.note, at: h.createdAt })) });
});

// POST /api/rewards/preview — "what would apply?" for the checkout panel. Informational: checkout recomputes everything itself.
router.post('/preview', optionalCustomer, async (req, res) => {
  const s = await getSettings(), b = req.body, num = (v) => Math.max(0, Number(v) || 0);
  const { cards, invalid } = await rewards.loadGiftCards(b.giftCardCodes);
  const balance = req.customer ? req.customer.rewardPoints || 0 : 0;
  const asked = b.usePoints === true ? Infinity : num(b.usePoints);
  const plan = RM.plan({ goodsPayable: num(b.goodsPayable), shipping: num(b.shipping), codFee: num(b.codFee), pointsRequested: req.customer ? asked : 0, balance, giftCards: cards, settings: s });
  const earn = req.customer ? RM.earnFor({ eligible: plan.eligible, paymentMethod: plan.cashTotal === 0 ? 'online' : b.paymentMethod, settings: s }) : { points: 0, cashback: 0 };
  res.json({ loggedIn: !!req.customer, balance, maxPoints: RM.maxRedeemPoints({ goodsPayable: num(b.goodsPayable), balance, settings: s }), pointsUsed: plan.pointsUsed, pointsValue: plan.pointsValue, gift: plan.gift.map((g) => ({ code: g.code, amount: g.amount })), giftTotal: plan.giftTotal, invalid, cashTotal: plan.cashTotal, earn, rules: { enabled: s.rewardsEnabled, earnPercent: s.rewardEarnPercent, redeemMaxPercent: s.rewardRedeemMaxPercent, redeemMinPoints: s.rewardRedeemMinPoints, giftCards: s.giftCardsEnabled } });
});

// POST /api/rewards/gift-card/check {code} → balance. (Rate-limited in app.js; one generic answer so codes can’t be probed.)
router.post('/gift-card/check', async (req, res) => {
  const s = await getSettings(); if (!s.giftCardsEnabled) return res.status(404).json({ error: 'Gift cards are not available' });
  const { cards } = await rewards.loadGiftCards([req.body.code]);
  if (!cards.length) return res.status(404).json({ error: 'That gift card isn’t valid, has expired or has no balance left' });
  const g = await GiftCard.findById(cards[0].id); res.json({ code: g.code, balance: g.balance, expiresAt: g.expiresAt });
});
module.exports = router;
