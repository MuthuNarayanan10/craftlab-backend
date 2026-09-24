const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  name: { type: String, required: true },
  contactPerson: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  address: { type: String, default: '' },
  productsSupplied: { type: String, default: '' }, // free text — e.g. "Sculptural Wall Hook Rack"
  notes: { type: String, default: '' },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
}, { timestamps: true });

supplierSchema.methods.toJSON = function () {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Supplier', supplierSchema);
