const mongoose = require('mongoose');

const returnSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  orderNumber: { type: String, required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  customerEmail: { type: String, default: '' },
  customerPhone: { type: String, default: '' },
  customerName: { type: String, default: '' },
  items: [{ name: String, qty: Number }],
  reason: { type: String, required: true },
  comments: { type: String, default: '' },
  resolution: { type: String, enum: ['Refund', 'Replacement', 'Other'], default: 'Refund' },
  // Evidence photos (compressed client-side, stored as data URLs — fine for
  // a handful of damage photos; move to object storage if volume grows).
  images: [{ type: String }],
  status: { type: String, enum: ['Requested', 'Approved', 'Rejected', 'PickedUp', 'Refunded'], default: 'Requested' },
  adminNotes: { type: String, default: '' },
}, { timestamps: true });

returnSchema.methods.toJSON = function () {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Return', returnSchema);
