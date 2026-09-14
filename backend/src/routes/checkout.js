const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const generateOrderNumber = require('../utils/generateOrderNumber');
const { createRazorpayOrder } = require('../utils/razorpay');

const FLAT_SHIPPING = 0; // Free shipping by default — revisit once real shipping costs are known.

/** Atomically reserves stock for one item. Returns true if successful,
 *  false if there isn't enough available stock (prevents overselling
 *  when two customers check out the same low-stock item at once). */
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

// POST /api/checkout
router.post('/', async (req, res) => {
  const { cartId, customer, address, couponCode } = req.body;
  if (!customer?.name || !customer?.phone || !customer?.email) {
    return res.status(400).json({ error: 'Customer name, phone and email are required' });
  }
  if (!address?.line1 || !address?.city || !address?.state || !address?.pincode) {
    return res.status(400).json({ error: 'Complete address is required' });
  }

  const cart = await Cart.findOne({ cartId }).populate('items.product');
  if (!cart || !cart.items.length) return res.status(400).json({ error: 'Cart is empty' });

  // Reserve stock for every item atomically — roll back anything already
  // reserved in this loop if a later item fails.
  const reserved = [];
  for (const item of cart.items) {
    if (!item.product || item.product.status !== 'active') {
      for (const r of reserved) await releaseStock(r.productId, r.qty);
      return res.status(400).json({ error: `${item.product?.name || 'A product'} is no longer available` });
    }
    const ok = await reserveStock(item.product._id, item.qty);
    if (!ok) {
      for (const r of reserved) await releaseStock(r.productId, r.qty);
      return res.status(409).json({ error: `Not enough stock for ${item.product.name}` });
    }
    reserved.push({ productId: item.product._id, qty: item.qty });
  }

  try {
    const subtotal = cart.items.reduce((s, i) => s + i.product.price * i.qty, 0);
    const { discount, coupon } = await validateCoupon(couponCode, subtotal);
    const total = subtotal + FLAT_SHIPPING - discount;

    const orderNumber = await generateOrderNumber();
    const order = await Order.create({
      orderNumber,
      customer,
      address,
      items: cart.items.map(i => ({
        product: i.product._id,
        name: i.product.name,
        sku: i.product.sku,
        price: i.product.price,
        qty: i.qty,
        image: i.product.images?.[0] || '',
      })),
      subtotal,
      shipping: FLAT_SHIPPING,
      discount,
      couponCode: coupon ? coupon.code : '',
      total,
      cartId,
    });

    const razorpayOrder = await createRazorpayOrder(total, order.orderNumber);
    order.payment.razorpayOrderId = razorpayOrder.id;
    await order.save();

    if (coupon) {
      coupon.usedCount += 1;
      await coupon.save();
    }

    res.status(201).json({
      orderId: order.id,
      orderNumber: order.orderNumber,
      total,
      razorpayOrderId: razorpayOrder.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    for (const r of reserved) await releaseStock(r.productId, r.qty);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/checkout/:orderId/cancel — releases reserved stock if the customer backs out before paying
router.post('/:orderId/cancel', async (req, res) => {
  const order = await Order.findById(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.paymentStatus === 'Paid') return res.status(400).json({ error: 'Cannot cancel a paid order this way' });

  for (const item of order.items) await releaseStock(item.product, item.qty);
  order.orderStatus = 'Cancelled';
  await order.save();
  res.json({ cancelled: true });
});

module.exports = router;
