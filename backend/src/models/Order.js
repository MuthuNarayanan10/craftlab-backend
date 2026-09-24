const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, required: true },   // snapshot at time of order
  sku: { type: String, required: true },
  price: { type: Number, required: true },  // snapshot — price changes later shouldn't alter past orders
  qty: { type: Number, required: true },
  image: { type: String, default: '' },
}, { _id: false });

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true }, // e.g. CL-1001
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null }, // null = guest checkout

  customer: {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
  },
  address: {
    line1: { type: String, required: true },
    line2: { type: String, default: '' },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    country: { type: String, default: 'India' },
  },

  items: [orderItemSchema],
  giftMessage: { type: String, default: '' },

  subtotal: { type: Number, required: true },
  shipping: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  couponCode: { type: String, default: '' },
  total: { type: Number, required: true },

  paymentStatus: { type: String, enum: ['Pending', 'Paid', 'Failed', 'Refunded'], default: 'Pending' },
  orderStatus: {
    type: String,
    enum: ['Pending', 'Paid', 'Processing', 'Packed', 'Dispatched', 'Delivered', 'Cancelled', 'Refunded'],
    default: 'Pending'
  },

  payment: {
    method: { type: String, default: '' }, // upi / card / netbanking / wallet
    razorpayOrderId: { type: String, default: '' },
    razorpayPaymentId: { type: String, default: '', index: true },
    razorpaySignature: { type: String, default: '' },
    verifiedAt: { type: Date, default: null },
    verifiedVia: { type: String, enum: ['', 'checkout-callback', 'webhook'], default: '' },
  },

  delivery: {
    partner: { type: String, default: '' },
    trackingId: { type: String, default: '' },
    dispatchDate: { type: Date, default: null },
    expectedDelivery: { type: Date, default: null },
    notes: { type: String, default: '' },
  },

  cartId: { type: String, default: '' }, // links back to the Cart this order converted from
  notes: { type: String, default: '' },
}, { timestamps: true });

orderSchema.methods.toJSON = function () {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Order', orderSchema);
