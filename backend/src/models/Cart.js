const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  qty: { type: Number, required: true, min: 1 },
}, { _id: false });

const cartSchema = new mongoose.Schema({
  cartId: { type: String, required: true, unique: true, index: true }, // random id, stored client-side
  items: [cartItemSchema],

  // Captured as early as UX-appropriate (e.g. at checkout step 1) for abandoned-cart recovery.
  // Only populated once the customer provides it, and only used for recovery with consent.
  contact: {
    name: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    consentToContact: { type: Boolean, default: false },
  },

  status: { type: String, enum: ['active', 'converted', 'abandoned'], default: 'active' },
  convertedToOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },

  recoveryMessagesSent: { type: Number, default: 0 },
  lastRecoveryAt: { type: Date, default: null },
}, { timestamps: true });

cartSchema.methods.toJSON = function () {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Cart', cartSchema);
