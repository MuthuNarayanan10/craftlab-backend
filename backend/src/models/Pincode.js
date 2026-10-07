const mongoose = require('mongoose');
/** One row per Indian PIN code the store has decided about. With "registry" mode on, ONLY serviceable rows can be delivered to. */
const pincodeSchema = new mongoose.Schema({
  pincode: { type: String, required: true, unique: true, match: /^\d{6}$/ },
  city: { type: String, default: '', trim: true, maxlength: 80 },
  state: { type: String, default: '', trim: true, maxlength: 80 },
  serviceable: { type: Boolean, default: true },
  codAvailable: { type: Boolean, default: true },
  etaDays: { type: Number, default: 0, min: 0, max: 60 }, // 0 = use the delivery method's own ETA; otherwise overrides it for this PIN
  note: { type: String, default: '', maxlength: 120 },
}, { timestamps: true });
pincodeSchema.index({ state: 1, city: 1 });
pincodeSchema.methods.toJSON = function () { const o = this.toObject(); o.id = o._id.toString(); delete o._id; delete o.__v; return o; };
module.exports = mongoose.model('Pincode', pincodeSchema);
