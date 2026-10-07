const mongoose = require('mongoose');
/** A temporary hold on stock while a customer is in checkout (before any order exists). The BACKEND database owns this — never the browser or Firebase. */
const reservationSchema = new mongoose.Schema({
  cartId: { type: String, required: true, index: true },
  items: [{ product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true }, qty: { type: Number, required: true, min: 1 }, _id: false }],
  status: { type: String, enum: ['active', 'converted', 'expired', 'released'], default: 'active' },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
reservationSchema.index({ status: 1, expiresAt: 1 });
module.exports = mongoose.model('StockReservation', reservationSchema);
