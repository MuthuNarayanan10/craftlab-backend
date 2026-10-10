const mongoose = require('mongoose');
const STATUSES = ['New', 'Open', 'InProgress', 'WaitingCustomer', 'Resolved', 'Closed'];
const messageSchema = new mongoose.Schema({
  from: { type: String, enum: ['customer', 'admin', 'note'], required: true }, // 'note' = internal, never shown to the customer
  text: { type: String, required: true, maxlength: 4000 }, by: { type: String, default: '' }, at: { type: Date, default: Date.now },
}, { _id: false });
const ticketSchema = new mongoose.Schema({
  ticketNumber: { type: String, required: true, unique: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
  name: { type: String, required: true, maxlength: 80 }, phone: { type: String, default: '' }, email: { type: String, default: '', lowercase: true, trim: true },
  orderNumber: { type: String, default: '', index: true },
  subject: { type: String, required: true, maxlength: 140 },
  queryType: { type: String, default: '', maxlength: 40 },   // pre-defined topic picked on the form (Product question, Shipping, …)
  category: { type: String, default: '', maxlength: 80 }, subcategory: { type: String, default: '', maxlength: 80 },
  productName: { type: String, default: '', maxlength: 140 }, productSku: { type: String, default: '', maxlength: 60 },
  status: { type: String, enum: STATUSES, default: 'New' },
  messages: [messageSchema],
  lastCustomerMessageAt: { type: Date, default: Date.now },
}, { timestamps: true });
ticketSchema.index({ status: 1, createdAt: -1 });
module.exports = mongoose.model('SupportTicket', ticketSchema);
module.exports.STATUSES = STATUSES;
