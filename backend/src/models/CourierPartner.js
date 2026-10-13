const mongoose = require('mongoose');
/** A courier the owner books by hand (no API). trackUrl may contain {AWB}; if it doesn't, the customer opens the page and copies the number. */
const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  trackUrl: { type: String, default: '', trim: true, maxlength: 400 },
  active: { type: Boolean, default: true },
  sort: { type: Number, default: 0 },
}, { timestamps: true, toJSON: { virtuals: true, versionKey: false, transform: (d, r) => { delete r._id; return r; } } });
const DEFAULTS = [
  ['Professional Couriers', 'https://www.tpcindia.com/'],
  ['Blue Dart', 'https://www.bluedart.com/tracking'],
  ['DTDC', 'https://www.dtdc.in/tracking.asp'],
];
schema.statics.ensureDefaults = async function () {
  if (await this.estimatedDocumentCount()) return;
  await this.insertMany(DEFAULTS.map(([name, trackUrl], i) => ({ name, trackUrl, sort: i })));
};
/** Final link for a customer: the order's own link, else the courier's template with the AWB filled in. */
schema.statics.linkFor = async function (partner, awb, ownUrl) {
  const fill = (u) => String(u || '').replace(/\{AWB\}/gi, encodeURIComponent(awb || ''));
  if (ownUrl) return fill(ownUrl);
  if (!partner) return '';
  const c = await this.findOne({ name: new RegExp('^' + String(partner).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
  return c ? fill(c.trackUrl) : '';
};
module.exports = mongoose.models.CourierPartner || mongoose.model('CourierPartner', schema);
