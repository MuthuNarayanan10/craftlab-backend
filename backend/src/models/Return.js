const mongoose = require('mongoose');
const { STATUSES } = require('../utils/returnStatus');

const historySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now }, status: String, actor: { type: String, default: 'system' }, note: { type: String, default: '' }, visible: { type: Boolean, default: true },
}, { _id: false });

const returnSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  orderNumber: { type: String, required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  customerEmail: { type: String, default: '' }, customerPhone: { type: String, default: '' }, customerName: { type: String, default: '' },
  items: [{ index: Number, name: String, sku: String, qty: Number, price: Number }],
  amount: { type: Number, default: 0 },           // refundable amount for the returned lines
  reason: { type: String, required: true },
  comments: { type: String, default: '' },
  resolution: { type: String, enum: ['Refund', 'Replacement', 'Other'], default: 'Refund' },
  images: [{ type: String }],                      // evidence photos (compressed data URLs)
  imageCount: { type: Number, default: 0 },         // kept separately so lists can show it without loading the photos
  // legacy values are kept valid so older documents still load; they are normalised on read
  status: { type: String, enum: [...STATUSES, 'Requested', 'Approved', 'Rejected', 'PickedUp', 'Refunded'], default: 'REQUESTED' },
  pickup: { scheduledAt: { type: Date, default: null }, courier: { type: String, default: '' }, awb: { type: String, default: '' }, selfShip: { type: Boolean, default: false } },
  inspection: { result: { type: String, enum: ['', 'passed', 'partial', 'failed'], default: '' }, notes: { type: String, default: '' }, restock: { type: Boolean, default: false }, restocked: { type: Boolean, default: false } },
  refund: { amount: { type: Number, default: 0 }, refundId: { type: String, default: '' }, status: { type: String, default: '' }, issuedAt: { type: Date, default: null } },
  rejectionReason: { type: String, default: '' },
  adminNotes: { type: String, default: '' },
  history: [historySchema],
}, { timestamps: true });
returnSchema.index({ status: 1, createdAt: -1 });
returnSchema.index({ customerId: 1, createdAt: -1 });

returnSchema.methods.toJSON = function () {
  const obj = this.toObject(); obj.id = obj._id.toString(); delete obj._id; delete obj.__v; return obj;
};
module.exports = mongoose.model('Return', returnSchema);
