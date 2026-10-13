const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  type: { type: String, enum: ['new_order', 'low_stock', 'payment_failed', 'return_requested', 'contact_message', 'support_request', 'reservation_expired', 'review_submitted', 'support_reply', 'guest_return', 'otp_failed', 'tracking_update'], required: true },
  message: { type: String, required: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  read: { type: Boolean, default: false },
  archived: { type: Boolean, default: false },   // dismissed from the bell with × — kept in Notifications → Alerts archive
}, { timestamps: true });

notificationSchema.methods.toJSON = function () {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
};

const Notification = mongoose.model('Notification', notificationSchema);

async function createNotification(type, message, meta = {}) {
  try { await Notification.create({ type, message, meta }); }
  catch (e) { console.error('Notification create failed (non-fatal):', e.message); }
}

module.exports = Notification;
module.exports.createNotification = createNotification;
