const Order = require('../models/Order');
const { releaseHold } = require('./checkoutHold');

/** Cancels unpaid online checkouts older than `cutoffMin` and gives their stock/coupon back. Run AFTER reconciliation. */
async function releaseStaleHolds(cutoffMin = 30) {
  const stale = await Order.find({ orderStatus: 'Pending', paymentStatus: { $in: ['Pending', 'Failed'] }, 'payment.method': { $ne: 'cod' }, createdAt: { $lt: new Date(Date.now() - cutoffMin * 60e3) } }).limit(200);
  let released = 0;
  for (const o of stale) if (await releaseHold(o, 'Payment not completed in time', 'system')) released++;
  return released;
}
module.exports = { releaseStaleHolds };
