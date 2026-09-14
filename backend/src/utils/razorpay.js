const Razorpay = require('razorpay');
const crypto = require('crypto');

let razorpayInstance = null;
function getRazorpay() {
  if (!razorpayInstance) {
    razorpayInstance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayInstance;
}

/** Creates a Razorpay order for the given amount (in ₹, converted to paise). */
async function createRazorpayOrder(amountRupees, receipt) {
  const instance = getRazorpay();
  return instance.orders.create({
    amount: Math.round(amountRupees * 100), // Razorpay expects paise
    currency: 'INR',
    receipt,
  });
}

/** Verifies the signature Razorpay Checkout returns after a successful payment.
 *  This is the standard, secure way to confirm a payment server-side — never
 *  trust the frontend's "success" callback alone. */
function verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  return expected === razorpay_signature;
}

/** Verifies the signature on incoming Razorpay webhooks (separate secret,
 *  configured in the Razorpay dashboard under Settings > Webhooks). */
function verifyWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}

module.exports = { getRazorpay, createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature };
