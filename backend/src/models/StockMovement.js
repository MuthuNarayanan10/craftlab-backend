const mongoose = require('mongoose');
/** Every change to sellable stock, with the reason — so inventory can always be explained and reconciled. */
const stockMovementSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  productName: { type: String, default: '' }, sku: { type: String, default: '' },
  delta: { type: Number, required: true },
  stockAfter: { type: Number, required: true },
  reason: { type: String, required: true }, // order_paid | cod_order | order_cancelled | return_restock | po_received | manual_adjustment | …
  ref: { type: String, default: '' },        // order number / PO number / return id
  actor: { type: String, default: 'system' },
  note: { type: String, default: '' },
}, { timestamps: true });
stockMovementSchema.index({ createdAt: -1 });
module.exports = mongoose.model('StockMovement', stockMovementSchema);
