const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const addressSchema = new mongoose.Schema({
  label: { type: String, default: 'Home' },
  receiverName: { type: String, default: '' },
  receiverPhone: { type: String, default: '' },
  line1: { type: String, required: true },
  line2: { type: String, default: '' },
  city: { type: String, required: true },
  state: { type: String, required: true },
  pincode: { type: String, required: true },
  country: { type: String, default: 'India' },
}, { _id: true });

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  // Either email+password OR phone+OTP (Firebase) — not both required.
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  phone: { type: String, unique: true, sparse: true, trim: true }, // E.164, e.g. +919876543210
  firebaseUid: { type: String, unique: true, sparse: true },
  authMethod: { type: String, enum: ['password', 'otp'], default: 'password' },
  passwordHash: { type: String, default: '' },
  addresses: [addressSchema],
  status: { type: String, enum: ['active', 'blocked'], default: 'active' },
}, { timestamps: true });

customerSchema.methods.setPassword = async function (plainPassword) {
  this.passwordHash = await bcrypt.hash(plainPassword, 12);
};
customerSchema.methods.checkPassword = function (plainPassword) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plainPassword, this.passwordHash);
};
customerSchema.methods.toJSON = function () {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  delete obj.passwordHash;
  delete obj.firebaseUid;
  return obj;
};

module.exports = mongoose.model('Customer', customerSchema);
