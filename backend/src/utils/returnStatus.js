/** RETURN WORKFLOW — statuses, allowed transitions, the customer's simplified journey, and refund maths. */
const STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'INSPECTION', 'REFUND_PENDING', 'REFUNDED', 'CLOSED'];
const LEGACY = { Requested: 'REQUESTED', Approved: 'APPROVED', Rejected: 'REJECTED', PickedUp: 'PICKED_UP', Refunded: 'REFUNDED' };
const normalize = (s) => LEGACY[s] || s;

const NEXT = {
  REQUESTED: ['APPROVED', 'REJECTED'],
  APPROVED: ['PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'CLOSED'], // customers who self-ship skip the pickup steps
  REJECTED: ['CLOSED'],
  PICKUP_SCHEDULED: ['PICKED_UP', 'RECEIVED'],
  PICKED_UP: ['RECEIVED'],
  RECEIVED: ['INSPECTION', 'REFUND_PENDING'],
  INSPECTION: ['REFUND_PENDING', 'CLOSED'],
  REFUND_PENDING: ['REFUNDED', 'CLOSED'],
  REFUNDED: ['CLOSED'],
  CLOSED: [],
};
const LABEL = { REQUESTED: 'Return requested', APPROVED: 'Approved', REJECTED: 'Not approved', PICKUP_SCHEDULED: 'Pickup scheduled', PICKED_UP: 'Picked up', RECEIVED: 'Received by us', INSPECTION: 'Quality check', REFUND_PENDING: 'Refund being processed', REFUNDED: 'Refunded', CLOSED: 'Closed' };

function canTransition(from, to) {
  from = normalize(from);
  if (!STATUSES.includes(to)) return { ok: false, reason: `Unknown status "${to}"` };
  return (NEXT[from] || []).includes(to) ? { ok: true } : { ok: false, reason: `A return that is "${LABEL[from] || from}" can't move to "${LABEL[to]}"` };
}
const allowedNext = (from) => NEXT[normalize(from)] || [];

/** Simplified 5-step view for the customer. */
const CUSTOMER_STEPS = [
  { key: 'requested', label: 'Requested', statuses: ['REQUESTED'] },
  { key: 'approved', label: 'Approved', statuses: ['APPROVED'] },
  { key: 'pickup', label: 'Pickup', statuses: ['PICKUP_SCHEDULED', 'PICKED_UP'] },
  { key: 'received', label: 'Received & checked', statuses: ['RECEIVED', 'INSPECTION'] },
  { key: 'refund', label: 'Refund', statuses: ['REFUND_PENDING', 'REFUNDED', 'CLOSED'] },
];
function customerJourney(ret) {
  const s = normalize(ret.status);
  if (s === 'REJECTED') return { rejected: true, label: LABEL[s], steps: [{ key: 'requested', label: 'Requested', state: 'done' }, { key: 'rejected', label: 'Not approved', state: 'current' }] };
  let cur = CUSTOMER_STEPS.findIndex((st) => st.statuses.includes(s));
  if (cur < 0) cur = 0;
  const finished = s === 'REFUNDED' || s === 'CLOSED';
  return {
    rejected: false, label: LABEL[s] || s,
    steps: CUSTOMER_STEPS.map((st, i) => ({ key: st.key, label: st.label, state: finished || i < cur ? 'done' : i === cur ? 'current' : 'upcoming' })),
  };
}

/** Quantity of each order line still eligible for return (rejected requests don't count). */
function eligibleQuantities(order, existingReturns) {
  return order.items.map((it, index) => {
    const used = existingReturns.filter((r) => normalize(r.status) !== 'REJECTED')
      .reduce((s, r) => s + (r.items || []).filter((x) => x.index === index).reduce((q, x) => q + x.qty, 0), 0);
    return { index, name: it.name, sku: it.sku, price: it.price, ordered: it.qty, eligible: Math.max(0, it.qty - used) };
  });
}

/** Refundable amount for returned lines = their share of what the customer actually paid (after discounts),
 *  excluding any COD handling fee or shipping. */
function refundableAmount(order, lines) {
  const itemsValue = lines.reduce((s, l) => s + l.price * l.qty, 0);
  if (!order.subtotal || itemsValue <= 0) return 0;
  const base = order.total - (order.codFee || 0) - (order.shipping || 0);
  return Math.min(Math.round(base * (itemsValue / order.subtotal)), Math.max(0, order.total - (order.refundedAmount || 0)));
}

module.exports = { STATUSES, LABEL, normalize, canTransition, allowedNext, customerJourney, eligibleQuantities, refundableAmount };
