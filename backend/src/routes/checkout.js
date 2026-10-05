const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const { getSettings } = require('../models/Settings');
const generateOrderNumber = require('../utils/generateOrderNumber');
const { getPaymentProvider } = require('../utils/paymentProvider');
const { optionalCustomer } = require('../middleware/customerAuth');
const { finalizeCodOrder } = require('../services/orderService');
const { releaseHold } = require('../services/checkoutHold');
const DeliveryMethod = require('../models/DeliveryMethod');
const { isServiceable, feeFor, snapshot, estimatedDate, applicableMethods } = require('../utils/delivery');
const { logger } = require('../utils/logger');
const { audit } = require('../models/AuditLog');

async function reserveStock(productId, qty) {
  const r = await Product.findOneAndUpdate({ _id: productId, $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, qty] } }, { $inc: { reserved: qty } }, { new: true });
  return !!r;
}
const releaseStock = (productId, qty) => Product.findByIdAndUpdate(productId, { $inc: { reserved: -qty } });

async function validateCoupon(code, subtotal) {
  if (!code) return { discount: 0, coupon: null };
  const coupon = await Coupon.findOne({ code: String(code).toUpperCase(), active: true });
  if (!coupon) throw new Error('Invalid coupon code');
  if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new Error('Coupon has expired');
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) throw new Error('Coupon usage limit reached');
  if (subtotal < coupon.minOrderValue) throw new Error(`Minimum order value for this coupon is ₹${coupon.minOrderValue}`);
  const discount = coupon.type === 'percentage' ? Math.round(subtotal * (coupon.value / 100)) : coupon.value;
  return { discount: Math.min(discount, subtotal), coupon };
}
const cleanPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); const t = d.length > 10 ? d.slice(-10) : d; return /^[6-9]\d{9}$/.test(t) ? '+91' + t : ''; };
const errorMessage = (e) => e?.message || e?.error?.description || 'Something went wrong. Please try again.';
const str = (v, n = 60) => String(v || '').slice(0, n);

// POST /api/checkout
router.post('/', optionalCustomer, async (req, res) => {
  const settings = await getSettings();
  const customerAcct = req.customer || null;

  // ---- who may check out (settings are enforced here, not just hidden in the UI) ----
  if (settings.requireMobileVerification && !(customerAcct && customerAcct.phoneVerified)) return res.status(401).json({ error: 'Please verify your mobile number with an OTP to continue', code: 'LOGIN_REQUIRED' });
  if (!settings.guestCheckoutEnabled && !customerAcct) return res.status(401).json({ error: 'Please log in to place an order', code: 'LOGIN_REQUIRED' });

  const { cartId, customer, address, couponCode, giftMessage } = req.body;
  const paymentMethod = req.body.paymentMethod === 'cod' ? 'cod' : 'online';
  const idempotencyKey = typeof req.body.idempotencyKey === 'string' && /^[\w-]{8,64}$/.test(req.body.idempotencyKey) ? req.body.idempotencyKey : undefined;

  // ---- duplicate submission (double-click, refresh, retry): return the order we already made ----
  if (idempotencyKey) {
    const prior = await Order.findOne({ idempotencyKey });
    if (prior && prior.orderStatus !== 'Cancelled') {
      if (prior.paymentStatus === 'Paid' || prior.payment.method === 'cod') return res.status(200).json({ duplicate: true, cod: prior.payment.method === 'cod', alreadyPaid: prior.paymentStatus === 'Paid', orderId: prior.id, orderNumber: prior.orderNumber, total: prior.total });
      return res.status(200).json({ duplicate: true, orderId: prior.id, orderNumber: prior.orderNumber, total: prior.total, razorpayOrderId: prior.payment.razorpayOrderId, razorpayKeyId: process.env.RAZORPAY_KEY_ID });
    }
    if (prior) await Order.updateOne({ _id: prior._id }, { $unset: { idempotencyKey: '' } }); // cancelled attempt: free the key for a fresh try
  }

  // a verified account's phone is the order's phone
  const phone = settings.requireMobileVerification && customerAcct?.phone ? customerAcct.phone : cleanPhone(customer?.phone);
  if (!str(customer?.name, 100).trim() || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customer?.email || ''))) {
    return res.status(400).json({ error: 'Please enter your name, a valid 10-digit mobile number and email' });
  }
  if (!address?.line1 || !address?.city || !address?.state || !/^\d{6}$/.test(address?.pincode || '')) {
    return res.status(400).json({ error: 'Please enter a complete delivery address with a valid 6-digit PIN code' });
  }
  if (paymentMethod === 'cod' && !settings.codEnabled) return res.status(400).json({ error: 'Cash on Delivery is not available right now. Please pay online.' });

  // ---- delivery method: must exist, be switched on, serve this PIN and (for COD) allow cash ----
  const allMethods = await DeliveryMethod.listAll();
  let method;
  if (req.body.deliveryMethod) method = allMethods.find((m) => m.key === String(req.body.deliveryMethod));
  else method = allMethods.find((m) => applicableMethods([m], { pincode: address.pincode, cod: paymentMethod === 'cod' })[0]?.selectable);
  if (!method || !method.enabled) return res.status(400).json({ error: allMethods.some((m) => m.enabled) ? 'Please choose an available delivery option' : 'Delivery isn’t available right now. Please try again later.' });
  if (!isServiceable(method, address.pincode)) return res.status(400).json({ error: `${method.name} isn’t available for PIN code ${address.pincode}. Please choose another delivery option.` });
  if (paymentMethod === 'cod' && !method.codAllowed) return res.status(400).json({ error: `Cash on Delivery isn’t available with ${method.name}. Please pay online or choose another delivery option.` });

  const cart = await Cart.findOne({ cartId }).populate('items.product');
  if (!cart || !cart.items.length) return res.status(400).json({ error: 'Your cart is empty' });

  // ---- reserve stock atomically (never oversell, even with simultaneous buyers) ----
  const reserved = [];
  for (const item of cart.items) {
    if (!item.product || item.product.status !== 'active') { for (const r of reserved) await releaseStock(r.productId, r.qty); return res.status(400).json({ error: `${item.product?.name || 'An item'} is no longer available` }); }
    if (!(await reserveStock(item.product._id, item.qty))) { for (const r of reserved) await releaseStock(r.productId, r.qty); return res.status(409).json({ error: `Not enough stock for ${item.product.name}` }); }
    reserved.push({ productId: item.product._id, qty: item.qty });
  }

  let order = null;
  try {
    // ---- every price is computed here; the browser's numbers are never trusted ----
    const subtotal = cart.items.reduce((s, i) => s + i.product.price * i.qty, 0);
    const { discount, coupon } = await validateCoupon(couponCode, subtotal);
    const afterCoupon = Math.max(0, subtotal - discount);
    const prepaidDiscount = paymentMethod === 'online' && settings.prepaidDiscountPercent > 0 ? Math.round(afterCoupon * settings.prepaidDiscountPercent / 100) : 0;
    const codFee = paymentMethod === 'cod' ? (settings.codFee || 0) : 0;
    const shippingFee = feeFor(method, afterCoupon);
    const total = afterCoupon - prepaidDiscount + shippingFee + codFee;
    const attr = req.body.attribution || {};

    const build = (orderNumber) => Order.create({
      orderNumber, customerId: customerAcct ? customerAcct.id : null, idempotencyKey,
      customer: { name: str(customer.name, 100).trim(), phone, email: customer.email },
      address: { line1: str(address.line1, 200), line2: str(address.line2, 200), city: str(address.city, 80), state: str(address.state, 80), pincode: address.pincode, country: 'India' },
      items: cart.items.map((i) => ({ product: i.product._id, name: i.product.name, sku: i.product.sku, price: i.product.price, qty: i.qty, image: i.product.images?.[0] || '' })),
      subtotal, shipping: shippingFee, discount, prepaidDiscount, codFee, couponCode: coupon ? coupon.code : '', total, cartId, giftMessage: str(giftMessage, 300),
      payment: { method: paymentMethod === 'cod' ? 'cod' : '' },
      delivery: { method: snapshot(method, afterCoupon) }, estimatedDelivery: estimatedDate(method),
      attribution: { source: str(attr.source, 40).toLowerCase(), medium: str(attr.medium, 40).toLowerCase(), campaign: str(attr.campaign, 60), referrer: str(attr.referrer, 80) },
      events: [{ label: 'Order placed', stage: 'placed', actor: 'customer', type: 'placed' }],
    });
    try { order = await build(await generateOrderNumber()); }
    catch (e) { if (e.code === 11000 && !String(e.message).includes('idempotencyKey')) order = await build(await generateOrderNumber()); else throw e; }

    if (coupon) { // atomic: the usage limit can never be exceeded by simultaneous checkouts
      const ok = await Coupon.findOneAndUpdate({ _id: coupon._id, $or: [{ usageLimit: null }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] }, { $inc: { usedCount: 1 } });
      if (!ok) throw new Error('Coupon usage limit reached');
    }

    if (paymentMethod === 'cod') {
      await finalizeCodOrder(order);
      return res.status(201).json({ cod: true, orderId: order.id, orderNumber: order.orderNumber, total });
    }

    const rz = await getPaymentProvider().createOrder(total, order.orderNumber, { orderId: order.id });
    order.payment.razorpayOrderId = rz.id;
    await order.save();
    res.status(201).json({ orderId: order.id, orderNumber: order.orderNumber, total, razorpayOrderId: rz.id, razorpayKeyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    logger.error('checkout_failed', { error: errorMessage(err), order: order?.orderNumber });
    if (order && order.orderStatus !== 'Cancelled' && order.paymentStatus !== 'Paid' && order.payment.method !== 'cod') await releaseHold(order, 'Could not start payment').catch(() => {});
    else if (!order) for (const r of reserved) await releaseStock(r.productId, r.qty).catch(() => {});
    res.status(400).json({ error: errorMessage(err) });
  }
});

// POST /api/checkout/:orderId/cancel — the customer closed the payment window before paying
router.post('/:orderId/cancel', async (req, res) => {
  const order = await Order.findById(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.paymentStatus === 'Paid') return res.status(400).json({ error: 'This order is already paid' });
  if (order.payment.method === 'cod') return res.status(400).json({ error: 'Use the cancellation option in your account' });
  if (order.payment.razorpayOrderId && req.body.razorpayOrderId !== order.payment.razorpayOrderId) return res.status(403).json({ error: 'Not allowed' }); // knowing the id alone is not enough
  await releaseHold(order, 'Payment window closed', 'customer');
  res.json({ cancelled: true });
});

module.exports = router;
