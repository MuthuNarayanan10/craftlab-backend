/** ORDER LIFECYCLE — every payment confirmation and status change goes through here, so the database, the timeline,
 *  inventory and notifications can never disagree. */
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const { getSettings } = require('../models/Settings');
const { getNextSequence } = require('../models/Counter');
const rewards = require('./rewards');
const { createNotification } = require('../models/Notification');
const { adjustStock } = require('./inventory');
const { notifyOrder } = require('./notifier');
const { canTransition, isCod } = require('../utils/orderStatus');
const { pushEvent } = require('../utils/orderEvents');
const { audit } = require('../models/AuditLog');
const { logger } = require('../utils/logger');
const { sendEmail, newOrderAlertEmail } = require('../utils/email');

const STAGE = { Processing: 'processing', Packed: 'packed', Dispatched: 'handed', InTransit: 'transit', OutForDelivery: 'out', Delivered: 'delivered' };
const NOTIFY = { Packed: 'order_packed', Dispatched: 'order_shipped', OutForDelivery: 'out_for_delivery', Delivered: 'delivered', Cancelled: 'order_cancelled' };
// our own delivery team (manual method) never involves a courier, so the wording differs
const MANUAL_LABEL = { Packed: 'Packed and ready for delivery', Dispatched: 'Handed to our delivery team' };
const LABEL = { Processing: 'Order is being prepared', Packed: 'Packed and ready for the courier', Dispatched: 'Handed to courier', InTransit: 'In transit', OutForDelivery: 'Out for delivery', Delivered: 'Delivered', Cancelled: 'Order cancelled' };

/** Tax invoice number + GST breakup (GST-inclusive pricing). Idempotent. */
async function ensureInvoice(order, settings) {
  settings = settings || (await getSettings());
  if (!order.invoiceNumber) order.invoiceNumber = `${settings.invoicePrefix || 'INV'}-${await getNextSequence('invoiceNumber')}`;
  if (!order.taxRate && settings.defaultTaxRate > 0) {
    order.taxRate = settings.defaultTaxRate;
    order.taxAmount = Math.round((order.total - order.total / (1 + order.taxRate / 100)) * 100) / 100;
  }
}

async function alertOwner(order, settings) {
  if (!settings.email) return;
  const a = newOrderAlertEmail(order);
  sendEmail(settings.email, a.subject, a.html);
}

function triggerAutoShipment(order, settings) {
  if (order.delivery?.method?.type === 'manual') return; // our own team delivers — no courier booking
  if (!settings.autoCreateShipment || !settings.defaultCourierProvider || settings.defaultCourierProvider === 'manual') return;
  setImmediate(() => require('./shipmentService').createForOrder(order.id, { actor: 'system', auto: true }).catch((e) => logger.warn('auto_shipment_failed', { order: order.orderNumber, error: e.message })));
}

/** Online payment confirmed (checkout callback, Razorpay webhook, or reconciliation). Safe to call any number of times:
 *  the atomic claim below guarantees stock is deducted and notifications are sent exactly once. */
async function confirmPayment(orderId, { paymentId, signature = '', method = '', via, actor = 'razorpay' }) {
  const claimed = await Order.findOneAndUpdate(
    { _id: orderId, paymentStatus: { $in: ['Pending', 'Failed'] } },
    { $set: { paymentStatus: 'Paid', 'payment.razorpayPaymentId': paymentId, 'payment.razorpaySignature': signature, 'payment.razorpayMethod': method, 'payment.verifiedAt': new Date(), 'payment.verifiedVia': via } },
    { new: true }
  );
  if (!claimed) return { order: await Order.findById(orderId), already: true };
  const order = claimed;
  const settings = await getSettings();

  if (order.orderStatus === 'Cancelled') {
    // Money arrived for an order that was already cancelled (e.g. the payment window was closed, then the payment completed).
    pushEvent(order, { label: 'Payment received after the order was cancelled', actor, public: false, type: 'payment_late' });
    await order.save();
    await createNotification('payment_failed', `Payment received for CANCELLED order ${order.orderNumber} (₹${order.total}) — refund it or reinstate the order`, { orderNumber: order.orderNumber });
    await audit({ action: 'payment.late_on_cancelled', actor, entity: 'order', entityId: order.id, summary: `Payment on cancelled order ${order.orderNumber}` });
    return { order, lateOnCancelled: true };
  }

  order.orderStatus = 'Paid';
  pushEvent(order, { label: 'Payment confirmed', stage: 'paid', actor, type: 'payment', note: method ? `Paid via ${method}` : '' });
  pushEvent(order, { label: 'Order confirmed', stage: 'processing', actor: 'system', type: 'confirmed' });
  for (const it of order.items) await adjustStock(it.product, -it.qty, { reason: 'order_paid', ref: order.orderNumber, actor, releaseReserved: it.qty, force: true });
  pushEvent(order, { label: 'Inventory updated', actor: 'system', public: false, type: 'inventory' });
  await ensureInvoice(order, settings);
  pushEvent(order, { label: 'Invoice generated', actor: 'system', public: false, type: 'invoice', note: order.invoiceNumber });
  await order.save();

  await rewards.recordEarn(order).catch(() => {});
  if (order.cartId) await Cart.findOneAndUpdate({ cartId: order.cartId }, { status: 'converted', convertedToOrder: order._id });
  await createNotification('new_order', `New order ${order.orderNumber} — ₹${order.total}`, { orderNumber: order.orderNumber });
  await audit({ action: 'order.paid', actor, entity: 'order', entityId: order.id, summary: `Order ${order.orderNumber} paid — ₹${order.total} (${via})` });
  notifyOrder('order_placed', { order }); notifyOrder('payment_confirmed', { order });
  alertOwner(order, settings);
  triggerAutoShipment(order, settings);
  return { order, already: false };
}

/** Cash-on-delivery order placed: confirmed immediately, stock deducted, invoice issued. */
async function finalizeCodOrder(order) {
  const settings = await getSettings();
  order.orderStatus = 'Processing';
  pushEvent(order, { label: 'Order confirmed (pay on delivery)', stage: 'paid', actor: 'system', type: 'confirmed' });
  pushEvent(order, { label: 'Order is being prepared', stage: 'processing', actor: 'system', type: 'status' });
  for (const it of order.items) await adjustStock(it.product, -it.qty, { reason: 'cod_order', ref: order.orderNumber, releaseReserved: it.qty, force: true });
  pushEvent(order, { label: 'Inventory updated', actor: 'system', public: false, type: 'inventory' });
  await ensureInvoice(order, settings);
  await order.save();
  await rewards.recordEarn(order).catch(() => {});
  await Cart.findOneAndUpdate({ cartId: order.cartId }, { status: 'converted', convertedToOrder: order._id });
  await createNotification('new_order', `New COD order ${order.orderNumber} — ₹${order.total}`, { orderNumber: order.orderNumber });
  await audit({ action: 'order.cod_placed', actor: 'customer', entity: 'order', entityId: order.id, summary: `COD order ${order.orderNumber} — ₹${order.total}` });
  notifyOrder('order_placed', { order });
  alertOwner(order, settings);
  triggerAutoShipment(order, settings);
}

/** Stock effects + notifications after a status change has been applied to `order`. */
async function afterStatusChange(order, from, to, actor) {
  if (to === 'Cancelled') {
    const deducted = order.paymentStatus === 'Paid' || isCod(order); // only paid / COD orders have had stock permanently deducted
    for (const it of order.items) {
      if (deducted) await adjustStock(it.product, it.qty, { reason: 'order_cancelled', ref: order.orderNumber, actor });
      else await require('../models/Product').findByIdAndUpdate(it.product, { $inc: { reserved: -it.qty } });
    }
    await rewards.onCancelled(order).catch((e) => logger.error('rewards_cancel_failed', { error: e.message })); // points + gift-card money back, earned points withdrawn
    if (order.paymentStatus === 'Paid' && !isCod(order) && order.total > 0 && !(order.refundedAmount >= order.total)) {
      pushEvent(order, { label: 'Refund due — payment was received before cancellation', actor: 'system', public: false, type: 'refund_due' });
      await createNotification('payment_failed', `Order ${order.orderNumber} was cancelled after payment — issue a refund (₹${order.total})`, { orderNumber: order.orderNumber });
    }
  }
  if (to === 'Delivered') {
    if (!order.deliveredAt) order.deliveredAt = new Date();
    if (isCod(order) && order.paymentStatus === 'Pending') { order.paymentStatus = 'Paid'; order.payment.verifiedAt = new Date(); pushEvent(order, { label: 'Cash collected on delivery', actor, public: false, type: 'payment' }); }
  }
  if (NOTIFY[to]) notifyOrder(NOTIFY[to], { order });
}

/** Admin / system status change. Validates the transition, writes the timeline, applies side effects. Caller saves nothing — this saves. */
async function changeStatus(order, to, { actor = 'admin', note = '' } = {}) {
  const check = canTransition(order, to);
  if (!check.ok) { const e = new Error(check.reason); e.status = 409; throw e; }
  const from = order.orderStatus;
  order.orderStatus = to;
  const stage = STAGE[to];
  if (!(stage === 'processing' && (order.events || []).some((e) => e.stage === 'processing'))) {
    const label = order.delivery?.method?.type === 'manual' && MANUAL_LABEL[to] ? MANUAL_LABEL[to] : (LABEL[to] || to);
    pushEvent(order, { label, stage: stage || '', actor, note, type: 'status' });
  }
  if (to === 'Dispatched' && !order.delivery?.dispatchDate) { order.delivery = order.delivery || {}; order.delivery.dispatchDate = new Date(); }
  await afterStatusChange(order, from, to, actor);
  await order.save();
  return { from, to };
}

module.exports = { confirmPayment, finalizeCodOrder, changeStatus, afterStatusChange, ensureInvoice };
