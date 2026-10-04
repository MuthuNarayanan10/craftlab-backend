const mongoose = require('mongoose');

const quotationItemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  qty: { type: Number, required: true },
  unitPrice: { type: Number, required: true },
}, { _id: false });

const quotationSchema = new mongoose.Schema({
  quotationNumber: { type: String, required: true, unique: true },
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  supplierName: { type: String, required: true },
  items: [quotationItemSchema],
  notes: { type: String, default: '' },
  status: { type: String, enum: ['Draft', 'Sent', 'Accepted', 'Rejected'], default: 'Draft' },
}, { timestamps: true });

quotationSchema.virtual('total').get(function () {
  return this.items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
});
quotationSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, obj) => { obj.id = obj._id.toString(); delete obj._id; delete obj.__v; return obj; }
});

module.exports = mongoose.model('Quotation', quotationSchema);
