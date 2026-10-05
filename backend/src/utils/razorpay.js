/** Backwards-compatible helpers — everything now delegates to the payment-provider layer. */
const { getPaymentProvider } = require('./paymentProvider');
const createRazorpayOrder = (amountRupees, receipt) => getPaymentProvider().createOrder(amountRupees, receipt);
const verifyPaymentSignature = (p) => getPaymentProvider().verifyCheckoutSignature(p);
const verifyWebhookSignature = (raw, sig) => getPaymentProvider().verifyWebhookSignature(raw, sig);
module.exports = { getPaymentProvider, createRazorpayOrder, verifyPaymentSignature, verifyWebhookSignature };
