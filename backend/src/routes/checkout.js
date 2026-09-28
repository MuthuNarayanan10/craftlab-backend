const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const jwt = require('jsonwebtoken');
const generateOrderNumber = require('../utils/generateOrderNumber');
const { createRazorpayOrder } = require('../utils/razorpay');

const FLAT_SHIPPING = 0;

// Atomically reserve stock to prevent overselling.
async function reserveStock(productId, qty) {
  const result = await Product.findOneAndUpdate(
    {
      _id: productId,
      $expr: {
        $gte: [
          { $subtract: ['$stock', '$reserved'] },
          qty,
        ],
      },
    },
    { $inc: { reserved: qty } },
    { new: true }
  );

  return !!result;
}

// Release reserved stock.
async function releaseStock(productId, qty) {
  await Product.findByIdAndUpdate(
    productId,
    { $inc: { reserved: -qty } }
  );
}

// Validate coupon and calculate discount.
async function validateCoupon(code, subtotal) {
  if (!code) {
    return { discount: 0, coupon: null };
  }

  const coupon = await Coupon.findOne({
    code: code.toUpperCase(),
    active: true,
  });

  if (!coupon) {
    throw new Error('Invalid coupon code');
  }

  if (coupon.expiresAt && coupon.expiresAt < new Date()) {
    throw new Error('Coupon has expired');
  }

  if (
    coupon.usageLimit !== null &&
    coupon.usedCount >= coupon.usageLimit
  ) {
    throw new Error('Coupon usage limit reached');
  }

  if (subtotal < coupon.minOrderValue) {
    throw new Error(
      `Minimum order value for this coupon is ₹${coupon.minOrderValue}`
    );
  }

  const discount =
    coupon.type === 'percentage'
      ? Math.round(subtotal * (coupon.value / 100))
      : coupon.value;

  return {
    discount: Math.min(discount, subtotal),
    coupon,
  };
}

// POST /api/checkout
router.post('/', async (req, res, next) => {
  const reserved = [];
  let order = null;
  let coupon = null;

  try {
    // Guest checkout is supported.
    let customerId = null;

    const authHeader = req.header('Authorization') || '';

    if (authHeader.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(
          authHeader.slice(7),
          process.env.JWT_SECRET
        );

        if (payload.type === 'customer') {
          customerId = payload.sub;
        }
      } catch (e) {
        // Invalid or expired token falls back to guest checkout.
      }
    }

    const {
      cartId,
      customer,
      address,
      couponCode,
      giftMessage,
    } = req.body || {};

    // Validate customer.
    if (
      !customer?.name ||
      !customer?.phone ||
      !customer?.email
    ) {
      return res.status(400).json({
        error: 'Customer name, phone and email are required',
      });
    }

    // Validate address.
    if (
      !address?.line1 ||
      !address?.city ||
      !address?.state ||
      !address?.pincode
    ) {
      return res.status(400).json({
        error: 'Complete address is required',
      });
    }

    if (!cartId) {
      return res.status(400).json({
        error: 'Cart ID is required',
      });
    }

    // Fetch cart and populate products.
    const cart = await Cart.findOne({ cartId })
      .populate('items.product');

    if (!cart || !cart.items?.length) {
      return res.status(400).json({
        error: 'Cart is empty',
      });
    }

    // Reserve stock for each item.
    for (const item of cart.items) {
      if (
        !item.product ||
        item.product.status !== 'active'
      ) {
        return res.status(400).json({
          error: `${
            item.product?.name || 'A product'
          } is no longer available`,
        });
      }

      if (
        !Number.isInteger(item.qty) ||
        item.qty < 1
      ) {
        return res.status(400).json({
          error: `Invalid quantity for ${item.product.name}`,
        });
      }

      const available = await reserveStock(
        item.product._id,
        item.qty
      );

      if (!available) {
        return res.status(409).json({
          error: `Not enough stock for ${item.product.name}`,
        });
      }

      reserved.push({
        productId: item.product._id,
        qty: item.qty,
      });
    }

    // Calculate subtotal using current database prices.
    const subtotal = cart.items.reduce((sum, item) => {
      const price = Number(item.product.price);

      if (!Number.isFinite(price) || price < 0) {
        throw new Error(
          `Invalid product price for ${item.product.name}`
        );
      }

      return sum + price * item.qty;
    }, 0);

    // Validate coupon.
    const couponResult = await validateCoupon(
      couponCode,
      subtotal
    );

    const discount = couponResult.discount;
    coupon = couponResult.coupon;

    const total =
      subtotal + FLAT_SHIPPING - discount;

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({
        error: 'Order total must be greater than zero',
      });
    }

    // Prepare order items.
    const orderItems = cart.items.map(item => ({
      product: item.product._id,
      name: item.product.name,
      sku: item.product.sku,
      price: item.product.price,
      qty: item.qty,
      image: item.product.images?.[0] || '',
    }));

    // Generate unique order number.
    let orderNumber = await generateOrderNumber();

    const orderData = {
      customerId,
      customer,
      address,
      items: orderItems,
      subtotal,
      shipping: FLAT_SHIPPING,
      discount,
      couponCode: coupon ? coupon.code : '',
      total,
      cartId,
      giftMessage: giftMessage || '',
    };

    // Create database order.
    try {
      order = await Order.create({
        ...orderData,
        orderNumber,
      });
    } catch (createErr) {
      if (createErr.code !== 11000) {
        throw createErr;
      }

      // Retry once if order number is duplicated.
      orderNumber = await generateOrderNumber();

      order = await Order.create({
        ...orderData,
        orderNumber,
      });
    }

    // Create Razorpay order.
    const razorpayOrder = await createRazorpayOrder(
      total,
      order.orderNumber
    );

    if (!razorpayOrder?.id) {
      throw new Error(
        'Razorpay did not return an order ID'
      );
    }

    // Save Razorpay order ID.
    order.payment.razorpayOrderId =
      razorpayOrder.id;

    await order.save();

    // Increment coupon usage.
    if (coupon) {
      coupon.usedCount += 1;
      await coupon.save();
    }

    // Return checkout response.
    return res.status(201).json({
      orderId: order.id,
      orderNumber: order.orderNumber,
      total,
      razorpayOrderId: razorpayOrder.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });

  } catch (err) {
    console.error('Checkout failed:', {
      message: err.message,
      code: err.code,
      name: err.name,
      stack: err.stack,
    });

    // Best-effort rollback of stock reservations.
    for (const reservation of reserved) {
      try {
        await releaseStock(
          reservation.productId,
          reservation.qty
        );
      } catch (releaseErr) {
        console.error(
          'Checkout stock rollback failed:',
          {
            productId: String(reservation.productId),
            message: releaseErr.message,
          }
        );
      }
    }

    if (res.headersSent) {
      return next(err);
    }

    // Known customer-facing validation errors.
    const knownClientErrors = new Set([
      'Invalid coupon code',
      'Coupon has expired',
      'Coupon usage limit reached',
    ]);

    if (
      knownClientErrors.has(err.message) ||
      err.message.startsWith('Minimum order value')
    ) {
      return res.status(400).json({
        error: err.message,
      });
    }

    if (err.name === 'ValidationError') {
      return res.status(400).json({
        error: 'Please check the checkout details and try again.',
      });
    }

    // Unexpected errors are server errors.
    return res.status(500).json({
      error: 'Checkout failed due to a server error. Please try again.',
    });
  }
});

// POST /api/checkout/:orderId/cancel
router.post('/:orderId/cancel', async (req, res, next) => {
  try {
    const order = await Order.findById(
      req.params.orderId
    );

    if (!order) {
      return res.status(404).json({
        error: 'Order not found',
      });
    }

    if (order.paymentStatus === 'Paid') {
      return res.status(400).json({
        error: 'Cannot cancel a paid order this way',
      });
    }

    for (const item of order.items) {
      await releaseStock(
        item.product,
        item.qty
      );
    }

    order.orderStatus = 'Cancelled';
    await order.save();

    return res.json({
      cancelled: true,
    });

  } catch (err) {
    console.error('Checkout cancellation failed:', {
      message: err.message,
      code: err.code,
      stack: err.stack,
    });

    return next(err);
  }
});

module.exports = router;