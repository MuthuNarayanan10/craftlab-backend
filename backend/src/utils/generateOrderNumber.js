const { getNextSequence } = require('../models/Counter');

/** Generates a sequential, human-friendly order number like CL-1001.
 *  Uses an atomic MongoDB counter (see models/Counter.js) — safe under
 *  concurrent checkouts, unlike counting existing Order documents, which
 *  can collide (two orders created near-simultaneously, or a gap from a
 *  deleted test order) and throw a duplicate-key error at insert time. */
async function generateOrderNumber() {
  const seq = await getNextSequence('orderNumber');
  return `CL-${seq}`;
}

module.exports = generateOrderNumber;
