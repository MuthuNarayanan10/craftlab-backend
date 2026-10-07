/** Pure money maths for rewards. 1 point = ₹pointValue (default ₹1). Defaults: earn 5% (₹1000 → 50 points, ₹500 → 25). */
const POINT_VALUE = 1;

/** Points (and promotional cashback, also paid in points) earned by an order. `eligible` = goods actually paid in cash/online
 *  — never delivery or COD fees, never the part paid with points or a gift card. */
function earnFor({ eligible, paymentMethod, settings }) {
  if (!settings.rewardsEnabled || eligible <= 0) return { points: 0, cashback: 0 };
  const points = Math.floor((eligible * (settings.rewardEarnPercent || 0)) / 100 / POINT_VALUE);
  const cashback = settings.cashbackPercent > 0 && eligible >= (settings.cashbackMinOrder || 0) && paymentMethod === 'online' ? Math.floor((eligible * settings.cashbackPercent) / 100 / POINT_VALUE) : 0;
  return { points, cashback };
}

/** Most points a customer may spend on this order: capped by their balance and by a share of the goods value. */
function maxRedeemPoints({ goodsPayable, balance, settings }) {
  if (!settings.rewardsEnabled || goodsPayable <= 0 || balance <= 0) return 0;
  const cap = Math.floor((goodsPayable * (settings.rewardRedeemMaxPercent || 0)) / 100 / POINT_VALUE);
  const n = Math.min(balance, cap);
  return n >= (settings.rewardRedeemMinPoints || 0) ? n : 0;
}

/** Splits what the customer owes into points, gift cards and cash. */
function plan({ goodsPayable, shipping = 0, codFee = 0, pointsRequested = 0, balance = 0, giftCards = [], settings }) {
  const cap = maxRedeemPoints({ goodsPayable, balance, settings });
  let pointsUsed = Math.max(0, Math.min(Math.floor(pointsRequested) || 0, cap));
  if (pointsUsed < (settings.rewardRedeemMinPoints || 0)) pointsUsed = 0; // asking for fewer than the minimum applies nothing
  const pointsValue = pointsUsed * POINT_VALUE;
  let remaining = Math.max(0, goodsPayable - pointsValue) + shipping + codFee;
  const gift = [];
  if (settings.giftCardsEnabled !== false) for (const c of giftCards) { const amount = Math.min(c.balance, remaining); if (amount > 0) { gift.push({ id: c.id, code: c.code, amount }); remaining -= amount; } }
  const giftTotal = gift.reduce((s, g) => s + g.amount, 0);
  const cashTotal = remaining;
  const eligible = Math.max(0, cashTotal - shipping - codFee);
  return { pointsUsed, pointsValue, maxPoints: cap, gift, giftTotal, cashTotal, eligible, walletTotal: pointsValue + giftTotal };
}

/** A cash refund `c` for an order that was part-paid from the wallet ↔ the matching wallet share. */
const walletShareOfCash = (order, cash) => { const w = (order.wallet?.pointsValue || 0) + (order.wallet?.giftTotal || 0); return !w || !order.total ? 0 : Math.round((cash * w) / order.total); };

module.exports = { POINT_VALUE, earnFor, maxRedeemPoints, plan, walletShareOfCash };
