const mongoose = require('mongoose');

const returnSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  orderNumber: { type: String, required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  customerEmail: { type: String, required: true },
  items: [{ name: String, qty: Number }],
  reason: { type: String, required: true },
  comments: { type: String, default: '' },
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
