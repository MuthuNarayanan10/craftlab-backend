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
const { finalizeCodOrder, confirmPayment } = require('../services/orderService');
const { releaseHold } = require('../services/checkoutHold');
const DeliveryMethod = require('../models/DeliveryMethod');
const { channelOf } = require('../utils/otpChannel');
const { checkPincode } = require('../services/serviceability');
const reservations = require('../services/reservations');
const rewards = require('../services/rewards');
const RM = require('../utils/rewardsMath');
const { isServiceable, feeFor, snapshot, estimatedDate, applicableMethods } = require('../utils/delivery');
const { logger } = require('../utils/logger');
const { audit } = require('../models/AuditLog');

const reserveStock = reservations.reserveUnits;
const releaseStock = reservations.releaseUnits;

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
  const viaEmail = channelOf(settings) === 'email';
  const contactVerified = !!customerAcct && (viaEmail ? customerAcct.emailVerified : customerAcct.phoneVerified);
  if (settings.requireMobileVerification && !contactVerified) return res.status(401).json({ error: viaEmail ? 'Please verify your email with a one-time code to continue' : 'Please verify your mobile number with an OTP to continue', code: 'LOGIN_REQUIRED' });
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
  // a verified contact is the one the order uses — never what the browser sent
  const phone = settings.requireMobileVerification && !viaEmail && customerAcct?.phone ? customerAcct.phone : cleanPhone(customer?.phone);
  if (settings.requireMobileVerification && viaEmail && customerAcct?.email) customer.email = customerAcct.email;
  if (!str(customer?.name, 100).trim() || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customer?.email || ''))) {
    return res.status(400).json({ error: 'Please enter your name, a valid 10-digit mobile number and email' });
  }
  if (!address?.line1 || !address?.city || !address?.state || !/^\d{6}$/.test(address?.pincode || '')) {
    return res.status(400).json({ error: 'Please enter a complete delivery address with a valid 6-digit PIN code' });
  }
  if (paymentMethod === 'cod' && !settings.codEnabled) return res.status(400).json({ error: 'Cash on Delivery is not available right now. Please pay online.' });

  // ---- can we deliver to this PIN at all (admin's PIN registry), and is cash allowed there? ----
  const svc = await checkPincode(address.pincode, { cod: paymentMethod === 'cod' });
  if (!svc.serviceable) return res.status(400).json({ error: `${svc.reason || 'Delivery isn’t available'} (PIN ${address.pincode}). Please use a different address.`, code: 'NOT_SERVICEABLE' });
  if (paymentMethod === 'cod' && !svc.codAvailable) return res.status(400).json({ error: `Cash on Delivery isn’t available for PIN ${address.pincode}. Please pay online.`, code: 'COD_UNAVAILABLE' });

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

  // ---- stock: use the hold made when the customer entered checkout; reserve anything it doesn't cover. All atomic — never oversells. ----
  const reserved = [];
  const rollback = async () => { for (const r of reserved) await releaseStock(r.productId, r.qty).catch(() => {}); };
  for (const item of cart.items) if (!item.product || item.product.status !== 'active') return res.status(400).json({ error: `${item.product?.name || 'An item'} is no longer available` });
  const held = await reservations.takeForCheckout(cartId, cart.items.map((i) => ({ product: i.product._id, qty: i.qty })));
  for (const h of held) reserved.push({ productId: h.product, qty: h.qty });
  for (const item of cart.items) {
    const have = reserved.filter((r) => String(r.productId) === String(item.product._id)).reduce((n, r) => n + r.qty, 0);
    const need = item.qty - have;
    if (need <= 0) continue;
    let ok = await reserveStock(item.product._id, need);
    if (!ok) { await reservations.expireReservations(); ok = await reserveStock(item.product._id, need); } // other customers' expired holds may be blocking
    if (!ok) { await rollback(); return res.status(409).json({ error: `Not enough stock for ${item.product.name}`, code: 'OUT_OF_STOCK' }); }
    reserved.push({ productId: item.product._id, qty: need });
  }

  let order = null;
  try {
    // ---- every price is computed here; the browser's numbers are never trusted ----
    const subtotal = cart.items.reduce((s, i) => s + i.product.price * i.qty, 0);
    const { discount, coupon } = await validateCoupon(couponCode, subtotal);
    const afterCoupon = Math.max(0, subtotal - discount);
    const shippingFee = feeFor(method, afterCoupon);
    // wallet: points (logged-in only) and gift cards (anyone) can pay part — or all — of the order
    if ((req.body.giftCardCodes || []).length && settings.giftCardsEnabled === false) throw new Error('Gift cards are not being accepted right now');
    const { cards, invalid } = await rewards.loadGiftCards(req.body.giftCardCodes);
    if (invalid.length) throw new Error(`Gift card ${invalid[0]} can’t be used — it is invalid, expired or has no balance`);
    const asked = req.body.usePoints === true ? Infinity : Number(req.body.usePoints) || 0;
    if (asked > 0 && !customerAcct) throw new Error('Log in to use your reward points');
    const price = (method_) => {
      const prepaid = method_ === 'online' && settings.prepaidDiscountPercent > 0 ? Math.round(afterCoupon * settings.prepaidDiscountPercent / 100) : 0;
      const fee = method_ === 'cod' ? (settings.codFee || 0) : 0;
      return { prepaidDiscount: prepaid, codFee: fee, wp: RM.plan({ goodsPayable: afterCoupon - prepaid, shipping: shippingFee, codFee: fee, pointsRequested: asked, balance: customerAcct ? (customerAcct.rewardPoints || 0) : 0, giftCards: cards, settings }) };
    };
    let priced = price(paymentMethod);
    let walletOnly = false;
    if (priced.wp.cashTotal === 0 && priced.wp.walletTotal > 0) { walletOnly = true; priced = price('online'); } // fully covered by points / gift cards: treated as a prepaid order, nothing to collect
    const { prepaidDiscount, codFee, wp } = priced;
    const total = wp.cashTotal;
    const earn = customerAcct ? RM.earnFor({ eligible: wp.eligible, paymentMethod: walletOnly ? 'online' : paymentMethod, settings }) : { points: 0, cashback: 0 };
    const attr = req.body.attribution || {};

    const build = (orderNumber) => Order.create({
      orderNumber, customerId: customerAcct ? customerAcct.id : null, idempotencyKey,
      customer: { name: str(customer.name, 100).trim(), phone, email: customer.email },
      address: { line1: str(address.line1, 200), line2: str(address.line2, 200), city: str(address.city, 80), state: str(address.state, 80), pincode: address.pincode, country: 'India' },
      items: cart.items.map((i) => ({ product: i.product._id, name: i.product.name, sku: i.product.sku, price: i.product.price, qty: i.qty, image: i.product.images?.[0] || '' })),
      subtotal, shipping: shippingFee, discount, prepaidDiscount, codFee, couponCode: coupon ? coupon.code : '', total, cartId, giftMessage: str(giftMessage, 300),
      payment: { method: walletOnly ? 'wallet' : paymentMethod === 'cod' ? 'cod' : '' },
      wallet: { pointsUsed: wp.pointsUsed, pointsValue: wp.pointsValue, giftCards: wp.gift.map((g) => ({ card: g.id, code: g.code, amount: g.amount })), giftTotal: wp.giftTotal, pointsEarned: earn.points, cashbackEarned: earn.cashback },
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

    if (wp.walletTotal > 0) await rewards.takeWallet(order, wp, customerAcct); // atomic; throws (and undoes itself) if a balance changed
    await Order.updateOne({ _id: order._id }, { $set: { 'wallet.taken': order.wallet.taken } });

    if (walletOnly) { // nothing left to pay: confirm as paid right now
      await confirmPayment(order.id, { paymentId: 'wallet', method: 'rewards wallet', via: 'wallet', actor: 'customer' });
      return res.status(201).json({ paid: true, cod: false, orderId: order.id, orderNumber: order.orderNumber, total: 0 });
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

// POST /api/checkout/reserve {cartId} — the customer entered checkout: validate stock and hold it for stockHoldMinutes
router.post('/reserve', async (req, res) => {
  const cart = await Cart.findOne({ cartId: String(req.body.cartId || '') }).populate('items.product');
  if (!cart || !cart.items.length) return res.status(400).json({ error: 'Your cart is empty' });
  const r = await reservations.reserveCart(cart);
  if (r.error) return res.status(409).json({ error: r.error.message, code: r.error.code, productId: r.error.productId, available: r.error.available });
  const secondsLeft = Math.max(0, Math.round((r.reservation.expiresAt - Date.now()) / 1000));
  res.json({ reserved: true, reused: r.reused, expiresAt: r.reservation.expiresAt, secondsLeft, holdMinutes: Math.round(secondsLeft / 60) });
});
// DELETE-style release when the customer leaves checkout (POST so navigator.sendBeacon can use it)
router.post('/reserve/release', async (req, res) => res.json({ released: await reservations.releaseCart(String(req.body.cartId || '')) }));

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
