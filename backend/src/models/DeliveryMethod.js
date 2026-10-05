const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9-]{2,30}$/ },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, default: '', maxlength: 200 },
  type: { type: String, enum: ['courier', 'manual'], default: 'courier' }, // courier = shipped by a courier API/partner · manual = delivered by your own team
  enabled: { type: Boolean, default: false },
  fee: { type: Number, default: 0, min: 0 },
  freeAbove: { type: Number, default: 0, min: 0 },           // 0 = never free automatically
  etaMinDays: { type: Number, default: 0, min: 0 },
  etaMaxDays: { type: Number, default: 0, min: 0 },
  codAllowed: { type: Boolean, default: true },
  courierProvider: { type: String, default: '' },            // courier type only: '' = use the store default
  pincodes: [{ type: String }],                              // exact PINs (empty + no prefixes = everywhere)
  pincodePrefixes: [{ type: String }],                       // e.g. "600" = all Chennai PINs
  sortOrder: { type: Number, default: 0 },
  isDefault: { type: Boolean, default: false },              // built-in methods can be edited and disabled but not deleted
}, { timestamps: true });

/** The methods every store starts with. Only "Standard" is on by default; the owner switches the others on. */
const DEFAULTS = [
  { key: 'standard', name: 'Standard delivery', description: 'Shipped by courier to your doorstep', type: 'courier', enabled: true, fee: 0, etaMinDays: 5, etaMaxDays: 7, codAllowed: true, sortOrder: 1, isDefault: true },
  { key: 'express', name: 'Express delivery', description: 'Priority courier service', type: 'courier', enabled: false, fee: 149, etaMinDays: 2, etaMaxDays: 3, codAllowed: false, sortOrder: 2, isDefault: true },
  { key: 'manual', name: 'Local delivery by our team', description: 'Delivered by our own delivery team', type: 'manual', enabled: false, fee: 0, etaMinDays: 1, etaMaxDays: 2, codAllowed: true, sortOrder: 3, isDefault: true },
];

schema.statics.ensureDefaults = async function () {
  if ((await this.countDocuments({})) > 0) return;
  for (const d of DEFAULTS) { try { await this.create(d); } catch (e) { if (e.code !== 11000) throw e; } } // concurrent first requests are harmless
};
schema.statics.listAll = async function () { await this.ensureDefaults(); return this.find().sort({ sortOrder: 1, createdAt: 1 }); };
schema.methods.toJSON = function () { const o = this.toObject(); o.id = o._id.toString(); delete o._id; delete o.__v; return o; };

module.exports = mongoose.model('DeliveryMethod', schema);
module.exports.DEFAULTS = DEFAULTS;
