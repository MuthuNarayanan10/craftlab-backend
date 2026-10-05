/** Applies a normalised courier tracking update to an order — the ONLY place courier events change order status. */
const { canTransition } = require('./orderStatus');
const { pushEvent } = require('./orderEvents');

const TARGET = { picked_up: 'Dispatched', in_transit: 'InTransit', out_for_delivery: 'OutForDelivery', delivered: 'Delivered' };
const STAGE = { Dispatched: 'handed', InTransit: 'transit', OutForDelivery: 'out', Delivered: 'delivered' };
const LABEL = { Dispatched: 'Handed to courier', InTransit: 'In transit', OutForDelivery: 'Out for delivery', Delivered: 'Delivered' };

function applyTrackingUpdate(order, u, actor = 'courier') {
  if (!order.shipment) order.shipment = {};
  const ship = order.shipment;
  ship.lastSyncAt = new Date();
  if (u.trackingUrl) ship.trackingUrl = u.trackingUrl;
  if (u.etd) order.estimatedDelivery = u.etd;
  if (u.rawStatus) ship.status = u.status || ship.status;

  const result = { changed: false, status: order.orderStatus };
  if (u.status === 'pickup_scheduled' && !ship.pickupScheduledAt) { ship.pickupScheduledAt = u.at || new Date(); }
  if (u.status === 'rto' || u.status === 'exception' || u.status === 'cancelled') {
    const key = `${u.status}:${u.rawStatus}`;
    if (ship.lastAlert !== key) { ship.lastAlert = key; pushEvent(order, { label: u.status === 'rto' ? 'Returning to sender' : 'Delivery issue reported by courier', note: u.rawStatus, location: u.location, actor, public: u.status !== 'cancelled', type: 'courier_alert', at: u.at }); result.changed = true; result.alert = u.status; }
    return result;
  }

  let target = TARGET[u.status];
  if (!target) return result;
  // Couriers sometimes skip states (e.g. report "delivered" straight after pickup): walk forward, but never backwards.
  const chain = ['Dispatched', 'InTransit', 'OutForDelivery', 'Delivered'];
  for (const step of chain.slice(0, chain.indexOf(target) + 1)) {
    if (canTransition(order, step).ok) {
      order.orderStatus = step;
      const isFinal = step === target;
      pushEvent(order, { label: LABEL[step], stage: STAGE[step], note: isFinal ? u.rawStatus || '' : '', location: isFinal ? u.location || '' : '', actor, type: 'courier', at: u.at });
      if (step === 'Delivered') order.deliveredAt = u.at || new Date();
      if (step === 'Dispatched' && !order.delivery?.dispatchDate) { order.delivery = order.delivery || {}; order.delivery.dispatchDate = u.at || new Date(); }
      result.changed = true; result.status = step;
    }
  }
  if (!result.changed && u.location && u.rawStatus) { // same status, new location — add a breadcrumb only if different from the last one
    const last = [...(order.events || [])].reverse().find((e) => e.location);
    if (!last || last.location !== u.location) { pushEvent(order, { label: LABEL[order.orderStatus] || order.orderStatus, stage: STAGE[order.orderStatus] || '', note: u.rawStatus, location: u.location, actor, type: 'courier', at: u.at }); result.changed = true; }
  }
  return result;
}
module.exports = { applyTrackingUpdate };
