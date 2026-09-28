
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

// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

function getErrorMessage(err) {
  if (err instanceof Error && err.message) {
    return err.message;
  }

  if (typeof err === 'string' && err) {
    return err;
  }

  return 'Unknown checkout error';
}

// --------------------------------------------------
// STOCK MANAGEMENT
// --------------------------------------------------

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
    {
      $inc: { reserved: qty },
    },
    {
      new: true,
    }
  );

  return !!result;
}

async function releaseStock(productId, qty) {
  await Product.findOneAndUpdate(
    {
      _id: productId,
      reserved: { $gte: qty },
    },
    {
      $inc: { reserved: -qty },
    }
  );
}

// Best-effort stock rollback.
// Each reservation is attempted independently.
async function rollbackStock(reserved) {
  for (const reservation of reserved) {
    try {
      await releaseStock(
        reservation.productId,
        reservation.qty
      );
    } catch (err) {
      console.error('Stock rollback failed:', {
        productId: String(reservation.productId),
        message: getErrorMessage(err),
      });
    }
  }
}

// --------------------------------------------------
// COUPON VALIDATION
// --------------------------------------------------

async function validateCoupon(code, subtotal) {
  if (!code || !String(code).trim()) {
    return {
      discount: 0,
      coupon: null,
    };
  }

  const normalizedCode = String(code)
    .trim()
    .toUpperCase();

  const coupon = await Coupon.findOne({
    code: normalizedCode,
    active: true,
  });

  if (!coupon) {
    const err = new Error('Invalid coupon code');
    err.statusCode = 400;
    throw err;
  }

  if (
    coupon.expiresAt &&
    new Date(coupon.expiresAt) < new Date()
  ) {
    const err = new Error('Coupon has expired');
    err.statusCode = 400;
    throw err;
  }

  if (
    coupon.usageLimit !== null &&
    coupon.usageLimit !== undefined &&
    coupon.usedCount >= coupon.usageLimit
  ) {
    const err = new Error('Coupon usage limit reached');
    err.statusCode = 400;
    throw err;
  }

  if (subtotal < (coupon.minOrderValue || 0)) {
    const err = new Error(
      `Minimum order value for this coupon is ₹${coupon.minOrderValue}`
    );

    err.statusCode = 400;
    throw err;
  }

  let discount = 0;

  if (coupon.type === 'percentage') {
    discount = Math.round(
      subtotal * (coupon.value / 100)
    );
  } else {
    discount = coupon.value;
  }

  return {
    discount: Math.min(discount, subtotal),
    coupon,
  };
}

// --------------------------------------------------
// POST /api/checkout
// --------------------------------------------------

router.post('/', async (req, res, next) => {
  const reserved = [];

  let order = null;
  let coupon = null;
  let razorpayOrderCreated = false;

  try {
    // ------------------------------------------------
    // 1. CUSTOMER AUTHENTICATION
    // ------------------------------------------------

    let customerId = null;

    const authHeader =
      req.header('Authorization') || '';

    if (authHeader.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(
          authHeader.slice(7),
          process.env.JWT_SECRET
        );

        if (payload.type === 'customer') {
          customerId = payload.sub;
        }
      } catch (authErr) {
        // Invalid or expired token falls back to guest checkout.
      }
    }

    // ------------------------------------------------
    // 2. REQUEST VALIDATION
    // ------------------------------------------------

    const {
      cartId,
      customer,
      address,
      couponCode,
      giftMessage,
    } = req.body || {};

    if (
      !customer?.name ||
      !customer?.phone ||
      !customer?.email
    ) {
      return res.status(400).json({
        error:
          'Customer name, phone and email are required',
      });
    }

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

    // ------------------------------------------------
    // 3. FETCH CART
    // ------------------------------------------------

    const cart = await Cart.findOne({
      cartId,
    }).populate('items.product');

    if (!cart || !cart.items?.length) {
      return res.status(400).json({
        error: 'Cart is empty',
      });
    }

    // ------------------------------------------------
    // 4. VALIDATE PRODUCTS AND RESERVE STOCK
    // ------------------------------------------------

    for (const item of cart.items) {
      if (
        !item.product ||
        item.product.status !== 'active'
      ) {
        const err = new Error(
          `${item.product?.name || 'A product'} is no longer available`
        );

        err.statusCode = 400;
        throw err;
      }

      if (
        !Number.isInteger(item.qty) ||
        item.qty < 1
      ) {
        const err = new Error(
          `Invalid quantity for ${item.product.name}`
        );

        err.statusCode = 400;
        throw err;
      }

      const available = await reserveStock(
        item.product._id,
        item.qty
      );

      if (!available) {
        const err = new Error(
          `Not enough stock for ${item.product.name}`
        );

        err.statusCode = 409;
        throw err;
      }

      reserved.push({
        productId: item.product._id,
        qty: item.qty,
      });
    }

    // ------------------------------------------------
    // 5. CALCULATE ORDER TOTAL
    // ------------------------------------------------

    const subtotal = cart.items.reduce(
      (sum, item) => {
        const price = Number(item.product.price);

        if (
          !Number.isFinite(price) ||
          price < 0
        ) {
          throw new Error(
            `Invalid product price for ${item.product.name}`
          );
        }

        return sum + price * item.qty;
      },
      0
    );

    const couponResult = await validateCoupon(
      couponCode,
      subtotal
    );

    coupon = couponResult.coupon;

    const discount = couponResult.discount;

    const total =
      subtotal + FLAT_SHIPPING - discount;

    if (
      !Number.isFinite(total) ||
      total <= 0
    ) {
      const err = new Error(
        'Order total must be greater than zero'
      );

      err.statusCode = 400;
      throw err;
    }

    // ------------------------------------------------
    // 6. PREPARE ORDER DATA
    // ------------------------------------------------

    const orderItems = cart.items.map(item => ({
      product: item.product._id,
      name: item.product.name,
      sku: item.product.sku,
      price: item.product.price,
      qty: item.qty,
      image: item.product.images?.[0] || '',
    }));

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

    // ------------------------------------------------
    // 7. CREATE DATABASE ORDER
    // ------------------------------------------------

    let orderNumber = await generateOrderNumber();

    try {
      order = await Order.create({
        ...orderData,
        orderNumber,
      });
    } catch (createErr) {
      if (createErr?.code !== 11000) {
        throw createErr;
      }

      // Retry once for duplicate order number.
      orderNumber = await generateOrderNumber();

      order = await Order.create({
        ...orderData,
        orderNumber,
      });
    }

    // ------------------------------------------------
    // 8. CREATE RAZORPAY ORDER
    // ------------------------------------------------

    const razorpayOrder = await createRazorpayOrder(
      total,
      order.orderNumber
    );

    if (!razorpayOrder?.id) {
      throw new Error(
        'Razorpay did not return an order ID'
      );
    }

    razorpayOrderCreated = true;

    // ------------------------------------------------
    // 9. SAVE RAZORPAY ORDER ID
    // ------------------------------------------------

    if (!order.payment) {
      order.payment = {};
    }

    order.payment.razorpayOrderId =
      razorpayOrder.id;

    await order.save();

    // ------------------------------------------------
    // 10. UPDATE COUPON USAGE
    // ------------------------------------------------

    if (coupon) {
      coupon.usedCount += 1;
      await coupon.save();
    }

    // ------------------------------------------------
    // 11. RETURN CHECKOUT RESPONSE
    // ------------------------------------------------

    return res.status(201).json({
      orderId: order.id,
      orderNumber: order.orderNumber,
      total,
      razorpayOrderId: razorpayOrder.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });

  } catch (err) {
    // ------------------------------------------------
    // 12. LOG ORIGINAL ERROR SAFELY
    // ------------------------------------------------

    const errorMessage = getErrorMessage(err);

    console.error('Checkout failed:', {
      message: errorMessage,
      code: err?.code,
      name: err?.name,
      stack: err?.stack,
      error: err,
      orderId: order?._id,
      razorpayOrderCreated,
    });

    // ------------------------------------------------
    // 13. ROLLBACK RESERVED STOCK
    // ------------------------------------------------

    await rollbackStock(reserved);

    if (res.headersSent) {
      return next(err);
    }

    // ------------------------------------------------
    // 14. RETURN APPROPRIATE ERROR
    // ------------------------------------------------

    if (err?.statusCode === 400) {
      return res.status(400).json({
        error: errorMessage,
      });
    }

    if (err?.statusCode === 409) {
      return res.status(409).json({
        error: errorMessage,
      });
    }

    if (err?.name === 'ValidationError') {
      return res.status(400).json({
        error:
          'Please check the checkout details and try again.',
      });
    }

    if (err?.code === 11000) {
      return res.status(409).json({
        error:
          'A duplicate order was detected. Please try again.',
      });
    }

    // Unknown errors are server errors.
    return res.status(500).json({
      error:
        'Checkout failed due to a server error. Please try again.',
    });
  }
});

// --------------------------------------------------
// POST /api/checkout/:orderId/cancel
// --------------------------------------------------

router.post(
  '/:orderId/cancel',
  async (req, res, next) => {
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
          error:
            'Cannot cancel a paid order this way',
        });
      }

      if (order.orderStatus === 'Cancelled') {
        return res.json({
          cancelled: true,
          message: 'Order is already cancelled',
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
      console.error(
        'Checkout cancellation failed:',
        {
          message: getErrorMessage(err),
          code: err?.code,
          stack: err?.stack,
        }
      );

      return next(err);
    }
  }
);

module.exports = router;