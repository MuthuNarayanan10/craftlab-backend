const mongoose = require('mongoose');

const poItemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null }, // link to a product so receiving stock updates inventory
  qty: { type: Number, required: true, min: 1 },
  receivedQty: { type: Number, default: 0 },
  unitCost: { type: Number, required: true, min: 0 },
}, { _id: true });

const paymentSchema = new mongoose.Schema({
  amount: { type: Number, required: true, min: 0.01 }, method: { type: String, default: 'bank_transfer' }, reference: { type: String, default: '' },
  paidAt: { type: Date, default: Date.now }, note: { type: String, default: '' }, recordedBy: { type: String, default: '' },
}, { _id: true });

/** Business-side purchasing from manufacturers — kept completely separate from customer payments. */
const purchaseOrderSchema = new mongoose.Schema({
  poNumber: { type: String, required: true, unique: true },
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
  supplierName: { type: String, required: true },
  items: [poItemSchema],
  status: { type: String, enum: ['Draft', 'Sent', 'Confirmed', 'PartiallyReceived', 'Received', 'Cancelled'], default: 'Draft' },
  expectedDate: { type: Date, default: null },
  notes: { type: String, default: '' },
  invoice: {
    number: { type: String, default: '' }, date: { type: Date, default: null }, amount: { type: Number, default: 0 },
    file: { type: String, default: '' }, // scanned invoice (compressed image data URL)
    verified: { type: Boolean, default: false }, verifiedBy: { type: String, default: '' }, verifiedAt: { type: Date, default: null },
  },
  payments: [paymentSchema],
  createdBy: { type: String, default: '' },
}, { timestamps: true });

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
purchaseOrderSchema.virtual('total').get(function () { return sum(this.items, (i) => i.qty * i.unitCost); });
purchaseOrderSchema.virtual('paid').get(function () { return sum(this.payments, (p) => p.amount); });
/** What is owed: the verified invoice amount if there is one, otherwise the PO total. */
purchaseOrderSchema.virtual('payable').get(function () { return this.invoice?.verified && this.invoice.amount ? this.invoice.amount : this.total; });
purchaseOrderSchema.virtual('outstanding').get(function () { return Math.max(0, Math.round((this.payable - this.paid) * 100) / 100); });
purchaseOrderSchema.virtual('paymentStatus').get(function () { return this.paid <= 0 ? 'Unpaid' : this.outstanding <= 0 ? 'Paid' : 'PartiallyPaid'; });
purchaseOrderSchema.set('toJSON', { virtuals: true, transform: (d, o) => { o.id = o._id.toString(); delete o._id; delete o.__v; if (o.invoice) o.invoice.hasFile = !!o.invoice.file; return o; } });
purchaseOrderSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
