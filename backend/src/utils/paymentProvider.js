/** Payment provider interface. Razorpay is the first implementation; another gateway can be added by
 *  returning the same shape: { id, createOrder, verifyCheckoutSignature, verifyWebhookSignature, refund, fetchOrderPayments, fetchPayment }. */
const crypto = require('crypto');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function razorpayProvider({ keyId, keySecret, webhookSecret, client }) {
  let rz = client;
  const api = () => { if (!rz) { const Razorpay = require('razorpay'); rz = new Razorpay({ key_id: keyId, key_secret: keySecret }); } return rz; };
  return {
    id: 'razorpay',
    publicKey: keyId,
    createOrder: (amountRupees, receipt, notes = {}) => api().orders.create({ amount: Math.round(amountRupees * 100), currency: 'INR', receipt, notes }),
    verifyCheckoutSignature: ({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) => {
      if (!keySecret || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;
      return safeEqual(crypto.createHmac('sha256', keySecret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex'), razorpay_signature);
    },
    verifyWebhookSignature: (rawBody, signature) => {
      if (!webhookSecret || !signature) return false;
      return safeEqual(crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex'), signature);
    },
    /** Refund (full or partial) against a captured payment. Amount in rupees. */
    refund: (paymentId, { amountRupees, notes = {}, receipt }) => api().payments.refund(paymentId, { amount: Math.round(amountRupees * 100), speed: 'normal', notes, receipt }),
    fetchOrderPayments: (orderId) => api().orders.fetchPayments(orderId),
    fetchPayment: (paymentId) => api().payments.fetch(paymentId),
  };
}

let _default = null;
function getPaymentProvider() {
  if (!_default) _default = razorpayProvider({ keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET, webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET });
  return _default;
}
const setPaymentProvider = (p) => { _default = p; }; // used by tests

module.exports = { razorpayProvider, getPaymentProvider, setPaymentProvider };
