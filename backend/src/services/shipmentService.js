/** COURIER SHIPMENTS — create (order → AWB → pickup → label), sync tracking, cancel.
 *  Failures NEVER touch payment or order status: they are recorded on the order (visible to admin, retryable). */
const Order = require('../models/Order');
const Integration = require('../models/Integration');
const { getSettings } = require('../models/Settings');
const { getCourier } = require('../utils/courier');
const { applyTrackingUpdate } = require('../utils/trackingUpdate');
const { pushEvent } = require('../utils/orderEvents');
const { afterStatusChange } = require('./orderService');
const { audit } = require('../models/AuditLog');

async function load(providerId) {
  if (!providerId || providerId === 'manual') { const e = new Error('No courier is connected. Connect one under Admin → Integrations, then choose it as the default courier in Settings (or on the delivery method). Until then, enter the tracking number by hand.'); e.status = 400; throw e; }
  const integration = await Integration.findOne({ provider: providerId });
  if (!integration || !integration.enabled) { const e = new Error(`${providerId} is not enabled. Configure it under Admin → Integrations.`); e.status = 400; throw e; }
  return { adapter: getCourier(providerId), creds: integration.getSecrets(), cfg: integration.config || {}, integration };
}

const manualGuard = (order) => { if (order.delivery?.method?.type === 'manual') { const e = new Error('This order uses manual delivery (our own team) — there is no courier shipment. Assign a delivery person instead.'); e.status = 409; throw e; } };

async function createForOrder(orderId, { actor = 'admin', provider, auto = false } = {}) {
  const order = await Order.findById(orderId);
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }
  manualGuard(order);
  if (['Cancelled', 'Refunded', 'Delivered'].includes(order.orderStatus)) { const e = new Error(`A ${order.orderStatus.toLowerCase()} order can't be shipped`); e.status = 409; throw e; }
  if (order.paymentStatus !== 'Paid' && order.payment?.method !== 'cod') { const e = new Error('Payment has not been confirmed for this order'); e.status = 409; throw e; }
  if (order.shipment?.shipmentId && order.shipment?.awb && order.shipment.status !== 'cancelled') { const e = new Error('A shipment already exists for this order'); e.status = 409; throw e; }

  const settings = await getSettings();
  const providerId = provider || order.delivery?.method?.courierProvider || settings.defaultCourierProvider;
  try {
    const { adapter, creds, cfg } = await load(providerId);
    // A shipment that exists at the courier but is missing its AWB is COMPLETED, never re-created (that would duplicate the courier order).
    const resume = order.shipment?.shipmentId && order.shipment.status !== 'cancelled' && adapter.completeShipment;
    const r = resume ? { ...(await adapter.completeShipment(creds, order.shipment.shipmentId)), providerOrderId: order.shipment.providerOrderId } : await adapter.createShipment(creds, order, cfg);
    order.shipment = { ...(order.shipment?.toObject?.() || {}), provider: providerId, providerOrderId: r.providerOrderId, shipmentId: r.shipmentId, awb: r.awb, courierName: r.courierName, labelUrl: r.labelUrl, trackingUrl: r.trackingUrl, pickupScheduledAt: r.pickupScheduledAt, status: r.awb ? 'pickup_scheduled' : 'created', error: r.warnings.join(' · '), attempts: (order.shipment?.attempts || 0) + 1, lastSyncAt: new Date() };
    if (r.awb) { order.delivery.partner = r.courierName || order.delivery.partner; order.delivery.trackingId = r.awb; }
    pushEvent(order, { label: 'Shipment created', actor, public: false, type: 'shipment', note: `${r.courierName || providerId} ${r.awb ? '· AWB ' + r.awb : ''}` });
    if (r.pickupScheduledAt) pushEvent(order, { label: 'Courier pickup scheduled', stage: '', actor, type: 'shipment', note: r.courierName || '' });
    await order.save();
    await audit({ action: 'shipment.created', actor, entity: 'order', entityId: order.id, summary: `Shipment created for ${order.orderNumber} (${providerId}${r.awb ? ', AWB ' + r.awb : ''})`, meta: { warnings: r.warnings } });
    return order;
  } catch (e) {
    order.shipment = { ...(order.shipment?.toObject?.() || {}), error: String(e.message).slice(0, 300), attempts: (order.shipment?.attempts || 0) + 1 };
    pushEvent(order, { label: 'Shipment creation failed', actor, public: false, type: 'shipment_error', note: e.message });
    await order.save();
    await audit({ action: 'shipment.failed', actor, entity: 'order', entityId: order.id, summary: `Shipment failed for ${order.orderNumber}: ${e.message}` });
    throw e;
  }
}

async function syncOrder(order, actor = 'system') {
  manualGuard(order);
  const awb = order.shipment?.awb;
  if (!awb || !order.shipment.provider) { const e = new Error('This order has no courier shipment to track'); e.status = 400; throw e; }
  const { adapter, creds } = await load(order.shipment.provider);
  const u = await adapter.track(creds, awb);
  const from = order.orderStatus;
  const r = applyTrackingUpdate(order, u, 'courier');
  await order.save();
  if (r.changed && order.orderStatus !== from) { await afterStatusChange(order, from, order.orderStatus, 'courier'); await order.save(); }
  return { changed: r.changed, status: order.orderStatus, raw: u.rawStatus, location: u.location };
}

async function syncAll(limit = 50) {
  const orders = await Order.find({ 'shipment.awb': { $ne: '' }, orderStatus: { $in: ['Packed', 'Dispatched', 'InTransit', 'OutForDelivery'] } }).sort({ 'shipment.lastSyncAt': 1 }).limit(limit);
  let changed = 0, failed = 0;
  for (const o of orders) { try { const r = await syncOrder(o); if (r.changed) changed++; } catch (e) { failed++; } }
  return { checked: orders.length, changed, failed };
}

async function cancelShipment(order, actor = 'admin') {
  if (!order.shipment?.providerOrderId) { const e = new Error('No courier shipment to cancel'); e.status = 400; throw e; }
  if (['Dispatched', 'InTransit', 'OutForDelivery', 'Delivered'].includes(order.orderStatus)) { const e = new Error('The parcel has already left — contact the courier to stop it'); e.status = 409; throw e; }
  const { adapter, creds } = await load(order.shipment.provider);
  await adapter.cancel(creds, order.shipment.providerOrderId);
  order.shipment = { ...order.shipment.toObject(), status: 'cancelled', awb: '', labelUrl: '', pickupScheduledAt: null };
  pushEvent(order, { label: 'Courier shipment cancelled', actor, public: false, type: 'shipment' });
  await order.save();
  await audit({ action: 'shipment.cancelled', actor, entity: 'order', entityId: order.id, summary: `Shipment cancelled for ${order.orderNumber}` });
  return order;
}

module.exports = { createForOrder, syncOrder, syncAll, cancelShipment, load };
