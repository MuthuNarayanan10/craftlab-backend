const mongoose = require('mongoose');
/** A customer's review of their order. Written only by the customer (checked against their order number + email/phone); the owner can hide, feature, reply to or delete it. */
const reviewSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
  orderNumber: { type: String, required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  name: { type: String, required: true, maxlength: 60 },          // shown publicly, e.g. "Muthu N."
  city: { type: String, default: '', maxlength: 60 },
  rating: { type: Number, required: true, min: 1, max: 5 },
  title: { type: String, default: '', maxlength: 90 },
  text: { type: String, required: true, maxlength: 1500 },
  items: { type: [String], default: [] },                          // product names on the order
  status: { type: String, enum: ['published', 'pending', 'hidden'], default: 'published', index: true },
  featured: { type: Boolean, default: false },
  reply: { text: { type: String, default: '' }, at: { type: Date, default: null } },
}, { timestamps: true });
reviewSchema.index({ status: 1, featured: -1, createdAt: -1 });
reviewSchema.methods.toPublic = function () { return { id: this.id, name: this.name, city: this.city, rating: this.rating, title: this.title, text: this.text, items: this.items, featured: this.featured, reply: this.reply && this.reply.text ? { text: this.reply.text, at: this.reply.at } : null, at: this.createdAt, verified: true }; };
module.exports = mongoose.models.Review || mongoose.model('Review', reviewSchema);
