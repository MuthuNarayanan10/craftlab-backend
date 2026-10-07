const mongoose = require('mongoose');
const crypto = require('crypto');
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY346789'; // no 0/O, 1/I/L, 2/Z, 5/S — easy to read out over the phone
const newCode = () => { const b = crypto.randomBytes(12); const g = (o) => Array.from({ length: 4 }, (_, i) => ALPHABET[b[o + i] % ALPHABET.length]).join(''); return `GC-${g(0)}-${g(4)}-${g(8)}`; };
const schema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  initialAmount: { type: Number, required: true, min: 1 },
  balance: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  expiresAt: { type: Date, default: null },
  recipientName: { type: String, default: '', maxlength: 80 }, recipientEmail: { type: String, default: '', lowercase: true, maxlength: 120 },
  note: { type: String, default: '', maxlength: 200 }, createdBy: { type: String, default: '' },
  history: [{ type: { type: String }, amount: Number, orderNumber: String, actor: String, at: { type: Date, default: Date.now }, _id: false }],
}, { timestamps: true });
schema.statics.newCode = newCode;
schema.methods.toJSON = function () { const o = this.toObject(); o.id = o._id.toString(); delete o._id; delete o.__v; return o; };
module.exports = mongoose.model('GiftCard', schema);
