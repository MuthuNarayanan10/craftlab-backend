/** REFUNDS — one function every refund goes through (return refunds, admin goodwill refunds).
 *  Guards: payment must be settled, amount ≤ what's still refundable, no duplicate refund for the same return.
 *  Online orders are refunded through the payment provider; COD orders are recorded as manual refunds (cash / bank transfer). */
const { pushEvent } = require('./orderEvents');

class RefundError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const round2 = (n) => Math.round(n * 100) / 100;

async function issueRefund(order, { amount, reason = '', actor = 'admin', returnId = null, reference = '' }, provider) {
  if (!order.refunds) order.refunds = [];
  const refunded = order.refundedAmount || 0;
  const remaining = round2(order.total - refunded);
  const amt = round2(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) throw new RefundError('Enter a refund amount greater than zero');
  if (amt > remaining) throw new RefundError(`Only ₹${remaining} is still refundable on this order`);
  if (returnId && order.refunds.some((r) => String(r.returnId) === String(returnId) && r.status !== 'failed')) {
    throw new RefundError('A refund has already been issued for this return', 409);
  }

  const cod = order.payment?.method === 'cod';
  const paymentId = order.payment?.razorpayPaymentId;
  if (!cod && order.paymentStatus !== 'Paid' && order.paymentStatus !== 'Refunded') throw new RefundError('This order has no confirmed payment to refund');

  let record;
  if (cod || !paymentId) {
    if (!reference) throw new RefundError(cod ? 'For a Cash on Delivery order, enter how you refunded the customer (e.g. UPI / bank transfer reference)' : 'No online payment found — enter a manual refund reference');
    record = { refundId: 'manual', method: 'manual', amount: amt, status: 'processed', reason, reference, returnId, createdAt: new Date(), actor };
  } else {
    let r;
    try {
      r = await provider.refund(paymentId, { amountRupees: amt, notes: { order: order.orderNumber, reason: reason.slice(0, 200) }, receipt: `rf_${order.orderNumber}_${order.refunds.length + 1}`.slice(0, 40) });
    } catch (e) {
      throw new RefundError(`Razorpay couldn’t create the refund: ${e?.error?.description || e.message || 'unknown error'}`, 502);
    }
    record = { refundId: r.id, method: 'razorpay', amount: amt, status: r.status || 'pending', reason, reference: '', returnId, createdAt: new Date(), actor };
  }

  order.refunds.push(record);
  if (record.status !== 'failed') order.refundedAmount = round2(refunded + amt);
  if (order.refundedAmount >= order.total) order.paymentStatus = 'Refunded';
  pushEvent(order, { label: `Refund of ₹${amt} ${record.status === 'processed' ? 'completed' : 'initiated'}`, stage: '', actor, public: true, type: 'refund' });
  return record;
}

/** Applies a provider status update (from a webhook / sync) to an existing refund record. Returns true if it changed. */
function applyRefundStatus(order, refundId, status) {
  const rec = (order.refunds || []).find((r) => r.refundId === refundId);
  if (!rec || rec.status === status) return false;
  const was = rec.status;
  rec.status = status;
  if (status === 'failed' && was !== 'failed') order.refundedAmount = round2(Math.max(0, (order.refundedAmount || 0) - rec.amount));
  if (status === 'processed') pushEvent(order, { label: `Refund of ₹${rec.amount} completed`, actor: 'razorpay', type: 'refund' });
  if (status === 'failed') pushEvent(order, { label: `Refund of ₹${rec.amount} failed — we’re looking into it`, actor: 'razorpay', type: 'refund' });
  if (order.refundedAmount < order.total && order.paymentStatus === 'Refunded') order.paymentStatus = 'Paid';
  return true;
}

module.exports = { issueRefund, applyRefundStatus, RefundError };
