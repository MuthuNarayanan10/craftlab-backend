/** REWARDS WALLET — points, cashback and gift cards. Every change to a balance is ONE atomic database update that checks the
 *  balance in the same operation, so a customer can never spend the same points / gift-card money twice (even from two phones). */
const Customer = require('../models/Customer');
const GiftCard = require('../models/GiftCard');
const RewardLedger = require('../models/RewardLedger');
const Order = require('../models/Order');
const Return = require('../models/Return');
const { getSettings } = require('../models/Settings');
const { logger } = require('../utils/logger');
const M = require('../utils/rewardsMath');

const note = (customerId, e) => RewardLedger.create({ customerId, ...e }).catch((err) => logger.error('ledger_failed', { error: err.message }));
const normCode = (c) => String(c || '').toUpperCase().replace(/\s+/g, '').trim();
const now = () => new Date();
const liveCard = (extra = {}) => ({ status: 'active', balance: { $gt: 0 }, $or: [{ expiresAt: null }, { expiresAt: { $gt: now() } }], ...extra });

/** Cards the customer typed, that can really be used right now (unknown, disabled, expired, empty ones are dropped). */
async function loadGiftCards(codes) {
  const list = [...new Set((codes || []).map(normCode).filter(Boolean))].slice(0, 5);
  if (!list.length) return { cards: [], invalid: [] };
  const found = await GiftCard.find({ code: { $in: list }, ...liveCard() });
  const cards = list.map((c) => found.find((f) => f.code === c)).filter(Boolean).map((c) => ({ id: c.id, code: c.code, balance: c.balance }));
  return { cards, invalid: list.filter((c) => !cards.some((x) => x.code === c)) };
}

/** Deducts points and gift-card balance for an order — atomically. Throws (and undoes anything partly taken) if a balance changed. */
async function takeWallet(order, plan, customer) {
  const taken = { points: 0, cards: [] };
  try {
    if (plan.pointsUsed > 0) {
      if (!customer) throw new Error('Log in to use your reward points');
      const ok = await Customer.findOneAndUpdate({ _id: customer._id, rewardPoints: { $gte: plan.pointsUsed } }, { $inc: { rewardPoints: -plan.pointsUsed } });
      if (!ok) throw new Error('Your reward points balance changed — please review your order');
      taken.points = plan.pointsUsed;
      await note(customer._id, { type: 'redeem', source: 'order', points: -plan.pointsUsed, orderNumber: order.orderNumber, note: `Used on order ${order.orderNumber}` });
    }
    for (const g of plan.gift) {
      const ok = await GiftCard.findOneAndUpdate({ _id: g.id, ...liveCard({ balance: { $gte: g.amount } }) }, { $inc: { balance: -g.amount }, $push: { history: { type: 'use', amount: -g.amount, orderNumber: order.orderNumber, actor: 'checkout' } } });
      if (!ok) throw new Error(`Gift card ${g.code} no longer has enough balance — please review your order`);
      taken.cards.push(g);
    }
  } catch (e) {
    if (taken.points) { await Customer.updateOne({ _id: customer._id }, { $inc: { rewardPoints: taken.points } }); await note(customer._id, { type: 'restore', source: 'order', points: taken.points, orderNumber: order.orderNumber, note: 'Checkout could not complete' }); }
    for (const g of taken.cards) await GiftCard.updateOne({ _id: g.id }, { $inc: { balance: g.amount }, $push: { history: { type: 'restore', amount: g.amount, orderNumber: order.orderNumber, actor: 'checkout' } } });
    throw e;
  }
  order.wallet.taken = true;
}

/** Gives wallet value back (cancellation / return). Idempotent: never returns more than was taken. Split points ↔ gift cards as originally paid. */
async function restoreWallet(order, rupees, reason = 'Order cancelled') {
  const w = order.wallet || {}, total = (w.pointsValue || 0) + (w.giftTotal || 0);
  if (!w.taken || !total) return 0;
  const fresh = await Order.findById(order._id).select('wallet customerId orderNumber'); // latest restored amount
  const left = total - (fresh.wallet.restored || 0); const give = Math.max(0, Math.min(Math.round(rupees), left)); if (!give) return 0;
  const claimed = await Order.findOneAndUpdate({ _id: order._id, 'wallet.restored': fresh.wallet.restored || 0 }, { $inc: { 'wallet.restored': give } });
  if (!claimed) return restoreWallet(order, rupees, reason); // raced with another restore — recompute
  const pointsPart = Math.min(w.pointsValue || 0, Math.round((give * (w.pointsValue || 0)) / total)); let giftPart = give - pointsPart;
  if (pointsPart > 0 && order.customerId) { await Customer.updateOne({ _id: order.customerId }, { $inc: { rewardPoints: pointsPart } }); await note(order.customerId, { type: 'restore', source: 'order', points: pointsPart, orderNumber: order.orderNumber, note: reason }); }
  if (giftPart > 0) {
    const arr = (fresh.wallet.giftCards || []).map((g) => ({ card: g.card, code: g.code, amount: g.amount, restored: g.restored || 0 }));
    for (let i = arr.length - 1; i >= 0 && giftPart > 0; i--) { // latest card first
      const add = Math.min(giftPart, arr[i].amount - arr[i].restored); if (add <= 0) continue;
      await GiftCard.updateOne({ _id: arr[i].card }, { $inc: { balance: add }, $push: { history: { type: 'restore', amount: add, orderNumber: order.orderNumber, actor: reason } } });
      arr[i].restored += add; giftPart -= add;
    }
    await Order.updateOne({ _id: order._id }, { $set: { 'wallet.giftCards': arr } });
  }
  return give;
}

/** Order confirmed (paid / COD): the planned points start counting as PENDING. Idempotent. */
async function recordEarn(order) {
  const planned = (order.wallet?.pointsEarned || 0) + (order.wallet?.cashbackEarned || 0);
  if (!order.customerId || !planned) return false;
  const claimed = await Order.findOneAndUpdate({ _id: order._id, 'wallet.earnStatus': 'none' }, { $set: { 'wallet.earnStatus': 'pending' } });
  if (!claimed) return false;
  if (order.wallet) order.wallet.earnStatus = 'pending';
  await Customer.updateOne({ _id: order.customerId }, { $inc: { rewardPending: planned } });
  if (order.wallet.pointsEarned) await note(order.customerId, { type: 'earn', source: 'purchase', points: order.wallet.pointsEarned, affects: 'pending', orderNumber: order.orderNumber, note: 'Earned — credited after the return window' });
  if (order.wallet.cashbackEarned) await note(order.customerId, { type: 'earn', source: 'cashback', points: order.wallet.cashbackEarned, affects: 'pending', orderNumber: order.orderNumber, note: 'Cashback — credited after the return window' });
  return true;
}

/** Claws back earned points for a cancellation (fraction 1) or a return (fraction = share of the order returned). */
async function reverseEarn(order, fraction, why = 'Order cancelled') {
  const fresh = await Order.findById(order._id).select('wallet customerId orderNumber');
  const w = fresh.wallet, planned = (w.pointsEarned || 0) + (w.cashbackEarned || 0);
  if (!fresh.customerId || !planned || !['pending', 'credited'].includes(w.earnStatus)) return 0;
  // `fraction` = the share of the order being reversed NOW (each return counts only itself); never more than what is left
  const amount = Math.max(0, Math.min(Math.round(planned * Math.min(1, fraction)), planned - (w.earnReversed || 0))); if (!amount) return 0;
  const set = { $inc: { 'wallet.earnReversed': amount } }; if (w.earnStatus === 'pending' && (w.earnReversed || 0) + amount >= planned) set.$set = { 'wallet.earnStatus': 'void' };
  const ok = await Order.findOneAndUpdate({ _id: order._id, 'wallet.earnReversed': w.earnReversed || 0 }, set); if (!ok) return reverseEarn(order, fraction, why);
  if (w.earnStatus === 'pending') { await Customer.updateOne({ _id: fresh.customerId }, { $inc: { rewardPending: -amount } }); await note(fresh.customerId, { type: 'reverse', source: 'order', points: -amount, affects: 'pending', orderNumber: fresh.orderNumber, note: why }); }
  else { await Customer.updateOne({ _id: fresh.customerId }, { $inc: { rewardPoints: -amount } }); await note(fresh.customerId, { type: 'reverse', source: 'order', points: -amount, affects: 'balance', orderNumber: fresh.orderNumber, note: why }); }
  return amount;
}

/** The order was cancelled: everything given back, nothing kept. */
async function onCancelled(order) {
  const w = order.wallet || {};
  await restoreWallet(order, (w.pointsValue || 0) + (w.giftTotal || 0), 'Order cancelled');
  await reverseEarn(order, 1, 'Order cancelled');
}

/** A return refund of `fullValue` (₹ of goods) → how much goes back as cash and how much to the wallet. */
function refundSplit(order, fullValue) {
  const wallet = (order.wallet?.pointsValue || 0) + (order.wallet?.giftTotal || 0), sale = order.total + wallet;
  if (!sale) return { cash: 0, wallet: 0 };
  const cashLeft = Math.max(0, order.total - (order.refundedAmount || 0)), walletLeft = Math.max(0, wallet - (order.wallet?.restored || 0));
  const cash = Math.min(Math.round((fullValue * order.total) / sale), cashLeft);
  return { cash, wallet: Math.min(Math.max(0, Math.round(fullValue) - cash), walletLeft) };
}

/** Return refunded: wallet share restored + the matching share of earned points clawed back. */
async function onReturnRefund(order, split, fullValue) {
  if (split.wallet > 0) await restoreWallet(order, split.wallet, 'Return refunded');
  const sale = order.total + (order.wallet?.pointsValue || 0) + (order.wallet?.giftTotal || 0);
  if (sale > 0) await reverseEarn(order, fullValue / sale, 'Return refunded');
}

/** Job: credit pending points once the return window after delivery has passed (and no return is still open). */
async function creditPending(at = new Date()) {
  const { returnWindowDays } = await getSettings();
  const due = await Order.find({ 'wallet.earnStatus': 'pending', orderStatus: 'Delivered', deliveredAt: { $lte: new Date(at.getTime() - returnWindowDays * 86400e3) } }).limit(200);
  let n = 0;
  for (const o of due) {
    if (await Return.exists({ order: o._id, status: { $nin: ['REFUNDED', 'REJECTED', 'CLOSED'] } })) continue;
    const planned = (o.wallet.pointsEarned || 0) + (o.wallet.cashbackEarned || 0), amount = planned - (o.wallet.earnReversed || 0);
    const claimed = await Order.findOneAndUpdate({ _id: o._id, 'wallet.earnStatus': 'pending' }, { $set: { 'wallet.earnStatus': 'credited', 'wallet.creditedAt': at } });
    if (!claimed || amount <= 0) continue;
    await Customer.updateOne({ _id: o.customerId }, { $inc: { rewardPoints: amount, rewardPending: -amount } });
    await note(o.customerId, { type: 'credit', source: 'purchase', points: amount, orderNumber: o.orderNumber, note: 'Return window ended — points are now yours to spend' }); n++;
  }
  return n;
}

/** Owner correction (goodwill, fixing a mistake). Negative adjustments can never push the balance below zero. */
async function adjust(customerId, points, why, actor) {
  const p = Math.trunc(points); if (!p || Math.abs(p) > 100000) throw new Error('Enter a whole number of points (not zero)');
  const filter = p < 0 ? { _id: customerId, rewardPoints: { $gte: -p } } : { _id: customerId };
  const c = await Customer.findOneAndUpdate(filter, { $inc: { rewardPoints: p } }, { new: true });
  if (!c) throw new Error(p < 0 ? 'That would take the balance below zero' : 'Customer not found');
  await note(customerId, { type: 'adjust', source: 'admin', points: p, note: String(why || '').slice(0, 200), actor });
  return c;
}

const walletView = async (customer) => { const s = await getSettings(); return { points: customer.rewardPoints || 0, pending: customer.rewardPending || 0, value: (customer.rewardPoints || 0) * M.POINT_VALUE, rules: { enabled: s.rewardsEnabled, earnPercent: s.rewardEarnPercent, redeemMaxPercent: s.rewardRedeemMaxPercent, redeemMinPoints: s.rewardRedeemMinPoints, cashbackPercent: s.cashbackPercent, cashbackMinOrder: s.cashbackMinOrder, returnWindowDays: s.returnWindowDays, giftCards: s.giftCardsEnabled } }; };

module.exports = { loadGiftCards, takeWallet, restoreWallet, recordEarn, reverseEarn, onCancelled, refundSplit, onReturnRefund, creditPending, adjust, walletView, normCode };
