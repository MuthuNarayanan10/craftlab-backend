const mongoose = require('mongoose');
const otpRequestSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },   // HMAC of the code — the code itself is never stored
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  consumed: { type: Boolean, default: false },
  ip: { type: String, default: '', index: true },
}, { timestamps: true });
otpRequestSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 }); // auto-delete after a day
module.exports = mongoose.model('OtpRequest', otpRequestSchema);
