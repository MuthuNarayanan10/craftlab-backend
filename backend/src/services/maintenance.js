const Order = require('../models/Order');
const { getSettings } = require('../models/Settings');
const { releaseHold } = require('./checkoutHold');
const { reconcileOrder } = require('./reconcile');

/** Cancels unpaid online checkouts whose hold has run out and gives their stock/coupon back.
 *  Orders that already opened the payment window get 5 extra minutes (UPI approvals can be slow), and Razorpay is asked first —
 *  an order that was actually paid is confirmed instead of cancelled. */
async function releaseStaleHolds(cutoffMin) {
  const { stockHoldMinutes } = await getSettings();
  const base = cutoffMin || stockHoldMinutes, grace = 5;
  const stale = await Order.find({ orderStatus: 'Pending', paymentStatus: { $in: ['Pending', 'Failed'] }, 'payment.method': { $ne: 'cod' }, createdAt: { $lt: new Date(Date.now() - base * 60e3) } }).limit(200);
  let released = 0;
  for (const o of stale) {
    if (o.payment?.razorpayOrderId) {
      if (o.createdAt > new Date(Date.now() - (base + grace) * 60e3)) continue;      // still inside the payment grace period
      try { const r = await reconcileOrder(o); if (r.status === 'recovered') continue; } catch (e) { /* provider unreachable — fall through; a late payment is flagged, never lost */ }
    }
    if (await releaseHold(o, 'Payment not completed in time', 'system')) released++;
  }
  return released;
}
module.exports = { releaseStaleHolds };
