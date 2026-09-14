const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  type: { type: String, enum: ['percentage', 'fixed'], required: true },
  value: { type: Number, required: true },       // 10 (%) or 500 (₹)
  minOrderValue: { type: Number, default: 0 },
  expiresAt: { type: Date, default: null },
  usageLimit: { type: Number, default: null },   // null = unlimited
  usedCount: { type: Number, default: 0 },
  productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }], // empty = applies to all
  active: { type: Boolean, default: true },
}, { timestamps: true });

couponSchema.methods.toJSON = function () {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Coupon', couponSchema);
