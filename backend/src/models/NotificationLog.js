const mongoose = require('mongoose');
const notificationLogSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // dedupe key: event + order + (return/refund) + channel
  channel: { type: String, enum: ['email', 'whatsapp'], required: true },
  event: { type: String, required: true },
  to: { type: String, default: '' },
  orderNumber: { type: String, default: '', index: true },
  status: { type: String, enum: ['pending', 'sent', 'failed', 'skipped'], default: 'pending' },
  error: { type: String, default: '' },
  attempts: { type: Number, default: 0 },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });
notificationLogSchema.index({ status: 1, createdAt: -1 });
notificationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 86400 });
module.exports = mongoose.model('NotificationLog', notificationLogSchema);
