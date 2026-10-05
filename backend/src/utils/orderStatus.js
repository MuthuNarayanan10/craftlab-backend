/** ORDER STATE — the single source of truth.
 *  Every status change (admin, webhook, courier sync, customer cancel) goes through canTransition();
 *  every customer-facing progress view is produced by buildJourney(). */

const STATUSES = ['Pending', 'Paid', 'Processing', 'Packed', 'Dispatched', 'InTransit', 'OutForDelivery', 'Delivered', 'Cancelled', 'Refunded'];
const RANK = { Pending: 0, Paid: 1, Processing: 2, Packed: 3, Dispatched: 4, InTransit: 5, OutForDelivery: 6, Delivered: 7 };
const LABEL = { Pending: 'Awaiting payment', Paid: 'Payment confirmed', Processing: 'Processing', Packed: 'Packed', Dispatched: 'Handed to courier', InTransit: 'In transit', OutForDelivery: 'Out for delivery', Delivered: 'Delivered', Cancelled: 'Cancelled', Refunded: 'Refunded' };

const isCod = (o) => o?.payment?.method === 'cod';
const isPaidOrCod = (o) => o?.paymentStatus === 'Paid' || isCod(o);

/** Can this order move from its current status to `to`? Returns { ok, reason }. */
function canTransition(order, to) {
  const from = order.orderStatus;
  if (!STATUSES.includes(to)) return { ok: false, reason: `Unknown status "${to}"` };
  if (from === to) return { ok: false, reason: `Order is already ${LABEL[to]}` };
  if (from === 'Cancelled' || from === 'Refunded') return { ok: false, reason: `A ${from.toLowerCase()} order cannot change status` };

  if (to === 'Cancelled') {
    if (from === 'Delivered') return { ok: false, reason: 'A delivered order can’t be cancelled — use a return and refund instead' };
    return { ok: true };
  }
  if (to === 'Refunded') {
    return RANK[from] >= RANK.Paid || order.paymentStatus === 'Paid' ? { ok: true } : { ok: false, reason: 'Only paid orders can be refunded' };
  }
  if (to === 'Paid') return from === 'Pending' ? { ok: true } : { ok: false, reason: 'Payment can only be confirmed for an order awaiting payment' };

  // Fulfilment steps only move forward, and only once payment is settled (or COD).
  if (RANK[to] <= RANK[from]) return { ok: false, reason: `Can't move back from ${LABEL[from]} to ${LABEL[to]}` };
  if (!isPaidOrCod(order)) return { ok: false, reason: 'Payment has not been confirmed for this order yet' };
  return { ok: true };
}

/** Statuses the admin UI may offer as the next step. */
const allowedNext = (order) => STATUSES.filter((s) => canTransition(order, s).ok);

/* ---------------- Customer-facing journey ---------------- */
const STAGES = [
  { key: 'placed', label: 'Order placed' },
  { key: 'paid', label: 'Payment confirmed' },
  { key: 'processing', label: 'Processing' },
  { key: 'packed', label: 'Packed' },
  { key: 'handed', label: 'Handed to courier' },
  { key: 'transit', label: 'In transit' },
  { key: 'out', label: 'Out for delivery' },
  { key: 'delivered', label: 'Delivered' },
];
// index of the stage that is "happening now" for each status
const CURRENT_STAGE = { Pending: 1, Paid: 2, Processing: 2, Packed: 3, Dispatched: 4, InTransit: 5, OutForDelivery: 6, Delivered: 7 };

function buildJourney(order) {
  const meth = order.delivery?.method || {};
  const manual = meth.type === 'manual';           // delivered by the store's own team — no courier / AWB
  const events = (order.events || []).filter((e) => e.public !== false);
  const cod = isCod(order);
  const status = order.orderStatus;
  const terminalBad = status === 'Cancelled' || status === 'Refunded';

  // For a cancelled order, show progress up to the last fulfilment stage reached.
  let current = CURRENT_STAGE[status];
  if (terminalBad) {
    const reached = events.map((e) => STAGES.findIndex((s) => s.key === e.stage)).filter((i) => i >= 0);
    current = reached.length ? Math.max(...reached) : 0;
  }
  const delivered = status === 'Delivered';

  const stages = STAGES.map((s, i) => {
    const ev = [...events].reverse().find((e) => e.stage === s.key);
    let state = i < current ? 'done' : i === current ? 'current' : 'upcoming';
    if (delivered) state = 'done';
    if (terminalBad && i === current) state = 'done';
    let label = s.label;
    if (manual && s.key === 'handed') label = 'Handed to our delivery team';
    if (s.key === 'paid') label = cod ? 'Order confirmed (pay on delivery)' : s.label;
    if (s.key === 'paid' && status === 'Pending') label = 'Awaiting payment';
    return { key: s.key, label, state, at: ev ? ev.at : null, note: ev ? ev.note || '' : '' };
  });

  const last = [...events].reverse().find((e) => e.location);
  const ship = order.shipment || {};
  const dlv = order.delivery || {};
  const awb = manual ? '' : (ship.awb || dlv.trackingId || '');
  const partner = manual ? 'Our delivery team' : (ship.courierName || dlv.partner || '');
  const etaWindow = meth.etaMaxDays ? (meth.etaMinDays && meth.etaMinDays !== meth.etaMaxDays ? `${meth.etaMinDays}–${meth.etaMaxDays} days` : `${meth.etaMaxDays} days`) : '5–7 business days';

  let headline;
  if (status === 'Cancelled') headline = 'This order was cancelled';
  else if (status === 'Refunded') headline = 'This order was refunded';
  else if (delivered) headline = 'Delivered' + (order.deliveredAt ? ' on ' + new Date(order.deliveredAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
  else headline = { Pending: 'Waiting for your payment', Paid: 'Payment received — we’re getting your order ready', Processing: 'We’re preparing your order', Packed: 'Packed and waiting for the courier', Dispatched: 'Handed to the courier', InTransit: 'On its way to you', OutForDelivery: 'Out for delivery today' }[status] || LABEL[status];

  return {
    status, statusLabel: LABEL[status] || status, headline, cod,
    stages, currentIndex: current,
    progressPct: delivered ? 100 : terminalBad ? Math.round((current / (STAGES.length - 1)) * 100) : Math.round(((current + (status === 'Pending' ? 0 : 0.5)) / (STAGES.length - 1)) * 100),
    estimatedDelivery: order.estimatedDelivery || null,
    deliveryWindowText: order.estimatedDelivery ? null : ['Dispatched', 'InTransit', 'OutForDelivery'].includes(status) ? null : (terminalBad || delivered ? null : `${etaWindow} after dispatch`),
    deliveryMethod: { key: meth.key || '', name: meth.name || '', type: meth.type || '', fee: meth.fee || 0 },
    courier: { name: partner, awb, trackingUrl: manual ? '' : ship.trackingUrl || '' },
    assignee: manual && dlv.assignee?.name ? { name: dlv.assignee.name, phone: ['Dispatched', 'InTransit', 'OutForDelivery'].includes(status) ? dlv.assignee.phone || '' : '' } : null,
    scheduledFor: manual ? dlv.scheduledFor || null : null,
    lastLocation: last ? { text: last.location, at: last.at } : null,
    events: events.map((e) => ({ at: e.at, label: e.label, note: e.note || '', location: e.location || '' })),
  };
}

module.exports = { STATUSES, RANK, LABEL, STAGES, canTransition, allowedNext, buildJourney, isCod, isPaidOrCod };
