const mongoose = require('mongoose');
/** Every webhook received, once. The unique eventId is what makes duplicate deliveries harmless. */
const webhookEventSchema = new mongoose.Schema({
  provider: { type: String, required: true }, // razorpay | shiprocket
  eventId: { type: String, required: true },
  type: { type: String, default: '' },
  status: { type: String, enum: ['processing', 'processed', 'failed', 'ignored'], default: 'processing' },
  error: { type: String, default: '' },
  ref: { type: String, default: '' },
}, { timestamps: true });
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 }); // keep 90 days
module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
