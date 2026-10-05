const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['ADMIN', 'STAFF'], default: 'STAFF' },
  active: { type: Boolean, default: true },
  failedLogins: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },
}, { timestamps: true });

adminSchema.methods.setPassword = async function (plainPassword) {
  this.passwordHash = await bcrypt.hash(plainPassword, 12);
};

adminSchema.methods.checkPassword = function (plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

adminSchema.methods.toJSON = function () {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  delete obj.passwordHash;
  delete obj.failedLogins;
  delete obj.lockUntil;
  return obj;
};

module.exports = mongoose.model('Admin', adminSchema);
