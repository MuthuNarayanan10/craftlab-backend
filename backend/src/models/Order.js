const mongoose = require('mongoose');
const { STATUSES } = require('../utils/orderStatus');

const orderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, required: true },   // snapshot at time of order
  sku: { type: String, required: true },
  price: { type: Number, required: true },  // snapshot — later price changes never alter past orders
  qty: { type: Number, required: true },
  image: { type: String, default: '' },
}, { _id: false });

/** Every lifecycle step is appended here — the audit trail AND the customer-facing timeline. */
const eventSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  label: { type: String, required: true },
  stage: { type: String, default: '' },       // journey stage this event belongs to (placed, paid, processing, packed, handed, transit, out, delivered)
  actor: { type: String, default: 'system' }, // system | customer | razorpay | courier | admin email
  note: { type: String, default: '' },
  location: { type: String, default: '' },
  public: { type: Boolean, default: true },   // false = internal only, never shown to the customer
  type: { type: String, default: '' },
}, { _id: false });

const refundSchema = new mongoose.Schema({
  refundId: { type: String, default: '' },
  method: { type: String, enum: ['razorpay', 'manual'], default: 'razorpay' },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'processed', 'failed'], default: 'pending' },
  reason: { type: String, default: '' },
  reference: { type: String, default: '' },
  returnId: { type: String, default: null },
  actor: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null }, // null = guest checkout
  idempotencyKey: { type: String, default: undefined },                                   // dedupes double-clicks / refreshes at checkout

  customer: {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
  },
  address: {
    line1: { type: String, required: true }, line2: { type: String, default: '' },
    city: { type: String, required: true }, state: { type: String, required: true },
    pincode: { type: String, required: true }, country: { type: String, default: 'India' },
  },

  items: [orderItemSchema],
  giftMessage: { type: String, default: '' },
  invoiceNumber: { type: String, default: '' },
  taxRate: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  prepaidDiscount: { type: Number, default: 0 },
  codFee: { type: Number, default: 0 },
  deliveredAt: { type: Date, default: null },
  estimatedDelivery: { type: Date, default: null },

  subtotal: { type: Number, required: true },
  shipping: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  couponCode: { type: String, default: '' },
  total: { type: Number, required: true },

  paymentStatus: { type: String, enum: ['Pending', 'Paid', 'Failed', 'Refunded'], default: 'Pending' },
  orderStatus: { type: String, enum: STATUSES, default: 'Pending' },

  payment: {
    method: { type: String, default: '' }, // '' (online, method decided by Razorpay) | 'cod'
    razorpayOrderId: { type: String, default: '' },
    razorpayPaymentId: { type: String, default: '' },
    razorpaySignature: { type: String, default: '' },
    razorpayMethod: { type: String, default: '' }, // upi / card / netbanking / wallet — as reported by Razorpay
    verifiedAt: { type: Date, default: null },
    verifiedVia: { type: String, enum: ['', 'checkout-callback', 'webhook', 'reconcile'], default: '' },
  },
  refunds: [refundSchema],
  refundedAmount: { type: Number, default: 0 },

  delivery: { // how it travels: the method the customer chose (snapshot) + manual dispatch details
    method: { key: { type: String, default: '' }, name: { type: String, default: '' }, type: { type: String, default: '' }, fee: { type: Number, default: 0 }, etaMinDays: { type: Number, default: 0 }, etaMaxDays: { type: Number, default: 0 }, courierProvider: { type: String, default: '' } },
    assignee: { name: { type: String, default: '' }, phone: { type: String, default: '' } },   // manual delivery: who is delivering
    scheduledFor: { type: Date, default: null },                                                // manual delivery: planned delivery time
    partner: { type: String, default: '' }, trackingId: { type: String, default: '' },
    dispatchDate: { type: Date, default: null }, expectedDelivery: { type: Date, default: null }, notes: { type: String, default: '' },
  },
  shipment: { // courier-API shipment (optional)
    provider: { type: String, default: '' }, providerOrderId: { type: String, default: '' }, shipmentId: { type: String, default: '' },
    awb: { type: String, default: '' }, courierName: { type: String, default: '' }, labelUrl: { type: String, default: '' }, trackingUrl: { type: String, default: '' },
    status: { type: String, default: '' }, pickupScheduledAt: { type: Date, default: null }, lastSyncAt: { type: Date, default: null },
    lastAlert: { type: String, default: '' }, error: { type: String, default: '' }, attempts: { type: Number, default: 0 },
  },

  events: [eventSchema],
  attribution: { source: { type: String, default: '' }, medium: { type: String, default: '' }, campaign: { type: String, default: '' }, referrer: { type: String, default: '' } },
  cartId: { type: String, default: '' },
  notes: { type: String, default: '' },
}, { timestamps: true });

// Indexes for the queries that run constantly (admin lists, customer history, payment lookups, courier sync)
orderSchema.index({ createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ customerId: 1, createdAt: -1 });
orderSchema.index({ 'customer.phone': 1 });
orderSchema.index({ 'customer.email': 1 });
orderSchema.index({ 'payment.razorpayOrderId': 1 });
orderSchema.index({ 'payment.razorpayPaymentId': 1 });
orderSchema.index({ 'shipment.awb': 1 });
orderSchema.index({ paymentStatus: 1, orderStatus: 1, createdAt: 1 });
orderSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

orderSchema.methods.toJSON = function () {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id; delete obj.__v;
  if (obj.payment) delete obj.payment.razorpaySignature;
  return obj;
};

module.exports = mongoose.model('Order', orderSchema);
