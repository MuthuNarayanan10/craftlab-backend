/** PAYMENT RECONCILIATION — if a webhook was missed (or the customer's browser died after paying), ask Razorpay what actually happened
 *  and bring the order in line. Safe to run as often as you like: confirmPayment() is idempotent. */
const Order = require('../models/Order');
const { getPaymentProvider } = require('../utils/paymentProvider');
const { confirmPayment } = require('./orderService');
const { logger } = require('../utils/logger');
const { audit } = require('../models/AuditLog');

async function reconcileOrder(order, provider = getPaymentProvider()) {
  if (!order.payment?.razorpayOrderId) return { status: 'skipped' };
  const res = await provider.fetchOrderPayments(order.payment.razorpayOrderId);
  const items = res?.items || [];
  const captured = items.find((p) => p.status === 'captured' && p.amount === Math.round(order.total * 100) && p.currency === 'INR');
  if (!captured) {
    const wrong = items.find((p) => p.status === 'captured');
    if (wrong) { logger.error('payment_amount_mismatch', { order: order.orderNumber, expected: Math.round(order.total * 100), got: wrong.amount }); return { status: 'amount_mismatch' }; }
    return { status: items.length ? 'not_captured' : 'no_payment' };
  }
  const r = await confirmPayment(order.id, { paymentId: captured.id, method: captured.method, via: 'reconcile', actor: 'reconciliation' });
  if (!r.already) await audit({ action: 'payment.reconciled', actor: 'system', entity: 'order', entityId: order.id, summary: `Recovered missed payment for ${order.orderNumber} (${captured.id})` });
  return { status: r.already ? 'already_paid' : 'recovered' };
}

async function reconcilePending({ olderThanMin = 5, limit = 50 } = {}) {
  const orders = await Order.find({
    paymentStatus: { $in: ['Pending', 'Failed'] }, 'payment.method': { $ne: 'cod' }, 'payment.razorpayOrderId': { $ne: '' },
    createdAt: { $lt: new Date(Date.now() - olderThanMin * 60e3), $gt: new Date(Date.now() - 72 * 3600e3) },
    orderStatus: { $in: ['Pending', 'Cancelled'] },
  }).sort({ createdAt: 1 }).limit(limit);
  const out = { checked: orders.length, recovered: 0, errors: 0, mismatches: 0 };
  for (const o of orders) {
    try { const r = await reconcileOrder(o); if (r.status === 'recovered') out.recovered++; if (r.status === 'amount_mismatch') out.mismatches++; }
    catch (e) { out.errors++; logger.warn('reconcile_error', { order: o.orderNumber, error: e?.error?.description || e.message }); }
  }
  return out;
}
module.exports = { reconcileOrder, reconcilePending };
