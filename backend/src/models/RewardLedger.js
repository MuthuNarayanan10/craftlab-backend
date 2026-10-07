const mongoose = require('mongoose');
/** Append-only history of a customer's reward points. The live balance is kept on the Customer (atomic); this explains it. */
const schema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  type: { type: String, enum: ['earn', 'credit', 'redeem', 'restore', 'reverse', 'adjust'], required: true },
  source: { type: String, enum: ['purchase', 'cashback', 'order', 'admin'], default: 'purchase' },
  points: { type: Number, required: true },                         // signed
  affects: { type: String, enum: ['balance', 'pending', 'none'], default: 'balance' },
  orderNumber: { type: String, default: '', index: true },
  note: { type: String, default: '', maxlength: 200 },
  actor: { type: String, default: 'system' },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ customerId: 1, createdAt: -1 });
module.exports = mongoose.model('RewardLedger', schema);
