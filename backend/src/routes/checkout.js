const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const { getSettings } = require('../models/Settings');
const { createNotification } = require('../models/Notification');
const { logAction } = require('../models/AuditLog');
const generateOrderNumber = require('../utils/generateOrderNumber');
const { createRazorpayOrder } = require('../utils/razorpay');
const { sendEmail, orderConfirmationEmail, newOrderAlertEmail } = require('../utils/email');

const FLAT_SHIPPING = 0; // free shipping across India

/** Atomically reserves stock for one item (prevents overselling when two
 *  customers check out the last unit at the same time). */
async function reserveStock(productId, qty) {
  const result = await Product.findOneAndUpdate(
    { _id: productId, $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, qty] } },
    { $inc: { reserved: qty } },
    { new: true }
  );
  return !!result;
}
async function releaseStock(productId, qty) {
  await Product.findByIdAndUpdate(productId, { $inc: { reserved: -qty } });
}

async function validateCoupon(code, subtotal) {
  if (!code) return { discount: 0, coupon: null };
  const coupon = await Coupon.findOne({ code: code.toUpperCase(), active: true });
  if (!coupon) throw new Error('Invalid coupon code');
  if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new Error('Coupon has expired');
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) throw new Error('Coupon usage limit reached');
  if (subtotal < coupon.minOrderValue) throw new Error(`Minimum order value for this coupon is ₹${coupon.minOrderValue}`);
  const discount = coupon.type === 'percentage' ? Math.round(subtotal * (coupon.value / 100)) : coupon.value;
  return { discount: Math.min(discount, subtotal), coupon };
}

function cleanPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return ten.length === 10 ? '+91' + ten : '';
}

function errorMessage(err) {
  // Razorpay's SDK rejects with a plain object ({ statusCode, error: { description } }), not an Error.
  return err?.message || err?.error?.description || 'Something went wrong. Please try again.';
}

// POST /api/checkout
router.post('/', async (req, res) => {
  // Optional customer login (guest checkout still works with no token)
  let customerId = null;
  const authHeader = req.header('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
      if (payload.type === 'customer') customerId = payload.sub;
    } catch (e) { /* bad/expired token → treat as guest */ }
  }

  const { cartId, customer, address, couponCode, giftMessage } = req.body;
  const paymentMethod = req.body.paymentMethod === 'cod' ? 'cod' : 'online';

  const phone = cleanPhone(customer?.phone);
  if (!customer?.name || !phone || !customer?.email) {
    return res.status(400).json({ error: 'Please enter your name, a valid 10-digit mobile number and email' });
  }
  if (!address?.line1 || !address?.city || !address?.state || !/^\d{6}$/.test(address?.pincode || '')) {
    return res.status(400).json({ error: 'Please enter a complete delivery address with a valid 6-digit PIN code' });
  }

  const settings = await getSettings();
  if (paymentMethod === 'cod' && !settings.codEnabled) {
    return res.status(400).json({ error: 'Cash on Delivery is not available right now. Please pay online.' });
  }

  const cart = await Cart.findOne({ cartId }).populate('items.product');
  if (!cart || !cart.items.length) return res.status(400).json({ error: 'Your cart is empty' });

  // Reserve stock for every item; roll back anything reserved if a later item fails.
  const reserved = [];
  for (const item of cart.items) {
    if (!item.product || item.product.status !== 'active') {
      for (const r of reserved) await releaseStock(r.productId, r.qty);
      return res.status(400).json({ error: `${item.product?.name || 'An item'} is no longer available` });
    }
    const ok = await reserveStock(item.product._id, item.qty);
    if (!ok) {
      for (const r of reserved) await releaseStock(r.productId, r.qty);
      return res.status(409).json({ error: `Not enough stock for ${item.product.name}` });
    }
    reserved.push({ productId: item.product._id, qty: item.qty });
  }

  let order = null;
  try {
    // All pricing is computed here — the browser's numbers are never trusted.
    const subtotal = cart.items.reduce((s, i) => s + i.product.price * i.qty, 0);
    const { discount, coupon } = await validateCoupon(couponCode, subtotal);
    const afterCoupon = Math.max(0, subtotal - discount);
    const prepaidDiscount = paymentMethod === 'online' && settings.prepaidDiscountPercent > 0
      ? Math.round(afterCoupon * settings.prepaidDiscountPercent / 100) : 0;
    const codFee = paymentMethod === 'cod' ? (settings.codFee || 0) : 0;
    const total = afterCoupon - prepaidDiscount + FLAT_SHIPPING + codFee;

    const buildOrder = (orderNumber) => Order.create({
      orderNumber, customerId,
      customer: { name: customer.name.trim(), phone, email: customer.email },
      address: { ...address, country: address.country || 'India' },
      items: cart.items.map(i => ({
        product: i.product._id, name: i.product.name, sku: i.product.sku,
        price: i.product.price, qty: i.qty, image: i.product.images?.[0] || '',
      })),
      subtotal, shipping: FLAT_SHIPPING, discount, prepaidDiscount, codFee,
      couponCode: coupon ? coupon.code : '', total, cartId,
      giftMessage: giftMessage || '',
      payment: { method: paymentMethod === 'cod' ? 'cod' : '' },
    });

    try {
      order = await buildOrder(await generateOrderNumber());
    } catch (createErr) {
      if (createErr.code === 11000) order = await buildOrder(await generateOrderNumber()); // one retry
      else throw createErr;
    }

    if (coupon) { coupon.usedCount += 1; await coupon.save(); }

    // ---------- Cash on Delivery: order is placed immediately ----------
    if (paymentMethod === 'cod') {
      order.orderStatus = 'Processing';
      await order.save();
      for (const item of order.items) {
        const updated = await Product.findByIdAndUpdate(
          item.product, { $inc: { stock: -item.qty, reserved: -item.qty } }, { new: true });
        if (updated && updated.stock <= updated.lowStockThreshold) {
          await createNotification('low_stock', `${updated.name} is low on stock (${updated.stock} left)`, { productId: updated.id });
        }
      }
      await Cart.findOneAndUpdate({ cartId }, { status: 'converted', convertedToOrder: order._id });
      await createNotification('new_order', `New COD order ${order.orderNumber} — ₹${order.total}`, { orderNumber: order.orderNumber });
      await logAction('order.cod_placed', 'customer', { orderNumber: order.orderNumber });

      const others = await Product.find({ _id: { $nin: order.items.map(i => i.product) }, status: 'active' }).limit(2);
      const mail = orderConfirmationEmail(order, others);
      sendEmail(order.customer.email, mail.subject, mail.html); // fire-and-forget
      if (settings.email) { const alert = newOrderAlertEmail(order); sendEmail(settings.email, alert.subject, alert.html); }
      return res.status(201).json({ cod: true, orderId: order.id, orderNumber: order.orderNumber, total });
    }

    // ---------- Online payment via Razorpay ----------
    const razorpayOrder = await createRazorpayOrder(total, order.orderNumber);
    order.payment.razorpayOrderId = razorpayOrder.id;
    await order.save();

    res.status(201).json({
      orderId: order.id, orderNumber: order.orderNumber, total,
      razorpayOrderId: razorpayOrder.id, razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    for (const r of reserved) await releaseStock(r.productId, r.qty).catch(() => {});
    if (order && order.orderStatus === 'Pending') {
      order.orderStatus = 'Cancelled';
      await order.save().catch(() => {});
    }
    console.error('Checkout failed:', errorMessage(err));
    res.status(400).json({ error: errorMessage(err) });
  }
});

// POST /api/checkout/:orderId/cancel — customer closed the payment window before paying
router.post('/:orderId/cancel', async (req, res) => {
  const order = await Order.findById(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.paymentStatus === 'Paid') return res.status(400).json({ error: 'Cannot cancel a paid order this way' });
  if (order.orderStatus === 'Cancelled') return res.json({ cancelled: true });

  for (const item of order.items) await releaseStock(item.product, item.qty);
  order.orderStatus = 'Cancelled';
  await order.save();
  res.json({ cancelled: true });
});

module.exports = router;
