
const Razorpay = require('razorpay');
const crypto = require('crypto');

let razorpayInstance = null;

function getRazorpay() {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();

  if (!keyId || !keySecret) {
    throw new Error('Razorpay API credentials are missing.');
  }

  if (!razorpayInstance) {
    razorpayInstance = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });
  }

  return razorpayInstance;
}

// Create INR order. Amount input is in rupees.
async function createRazorpayOrder(amountRupees, receipt) {
  if (
    !Number.isFinite(amountRupees) ||
    amountRupees <= 0
  ) {
    throw new Error('Invalid payment amount.');
  }

  if (!receipt || typeof receipt !== 'string') {
    throw new Error('Invalid order receipt.');
  }

  const amountPaise = Math.round(amountRupees * 100);

  if (!Number.isSafeInteger(amountPaise)) {
    throw new Error('Invalid amount in paise.');
  }

  try {
    const instance = getRazorpay();

    return await instance.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
    });
  } catch (error) {
    console.error('Razorpay order creation failed:', {
      statusCode: error.statusCode,
      code: error.error?.code,
      description: error.error?.description,
    });

    throw error;
  }
}

// Verify Razorpay Checkout payment signature.
function verifyPaymentSignature({
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
}) {
  const secret = process.env.RAZORPAY_KEY_SECRET;

  if (
    !secret ||
    !razorpay_order_id ||
    !razorpay_payment_id ||
    !razorpay_signature
  ) {
    return false;
  }

  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(
        `${razorpay_order_id}|${razorpay_payment_id}`
      )
      .digest();

    const received = Buffer.from(
      razorpay_signature,
      'hex'
    );

    return (
      received.length === expected.length &&
      crypto.timingSafeEqual(expected, received)
    );
  } catch {
    return false;
  }
}

// Verify webhook using the raw HTTP request body.
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!secret || !rawBody || !signature) {
    return false;
  }

  try {
    const body = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(rawBody);

    const expected = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest();

    const received = Buffer.from(signature, 'hex');

    return (
      received.length === expected.length &&
      crypto.timingSafeEqual(expected, received)
    );
  } catch {
    return false;
  }
}

module.exports = {
  getRazorpay,
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
};