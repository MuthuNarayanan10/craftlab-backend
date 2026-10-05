const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const { pushEvent } = require('../utils/orderEvents');

/** Gives back everything an unpaid checkout was holding (reserved stock, coupon use) and cancels the order. Idempotent. */
async function releaseHold(order, reason = 'Checkout not completed', actor = 'system') {
  if (order.orderStatus === 'Cancelled' || order.paymentStatus === 'Paid') return false;
  for (const it of order.items) await Product.findByIdAndUpdate(it.product, { $inc: { reserved: -it.qty } });
  if (order.couponCode) await Coupon.updateOne({ code: order.couponCode, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
  order.orderStatus = 'Cancelled';
  pushEvent(order, { label: 'Order cancelled', actor, note: reason, type: 'status', public: true });
  await order.save();
  return true;
}
module.exports = { releaseHold };
