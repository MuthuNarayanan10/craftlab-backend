const Order = require('../models/Order');

/** Generates a sequential, human-friendly order number like CL-1001.
 *  Uses the current order count — fine at this scale; move to a dedicated
 *  counter document if order volume grows into concurrent-heavy territory. */
async function generateOrderNumber() {
  const count = await Order.countDocuments();
  return `CL-${1001 + count}`;
}

module.exports = generateOrderNumber;
