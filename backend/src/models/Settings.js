const mongoose = require('mongoose');

/** Single-document business settings, editable from the admin portal. */
const settingsSchema = new mongoose.Schema({
  key: { type: String, default: 'business', unique: true },
  // Business / invoice details
  businessName: { type: String, default: 'The Craft Lab' },
  legalName: { type: String, default: '' },
  gstin: { type: String, default: '' },
  pan: { type: String, default: '' },
  address: { type: String, default: '' },
  city: { type: String, default: '' },
  state: { type: String, default: '' },
  pincode: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: 'care@thecraftlab.co.in' },
  invoicePrefix: { type: String, default: 'INV' },
  defaultTaxRate: { type: Number, default: 0 },
  // Checkout / payments
  codEnabled: { type: Boolean, default: false },
  codFee: { type: Number, default: 0 },
  prepaidDiscountPercent: { type: Number, default: 0 },
  // Support
  supportWhatsapp: { type: String, default: '' },
  returnWindowDays: { type: Number, default: 7 },
}, { timestamps: true });

const Settings = mongoose.model('Settings', settingsSchema);

async function getSettings() {
  let doc = await Settings.findOne({ key: 'business' });
  if (!doc) {
    try { doc = await Settings.create({ key: 'business' }); }
    catch (e) { doc = await Settings.findOne({ key: 'business' }); } // lost a creation race — unique index guarantees one doc
  }
  return doc;
}

module.exports = Settings;
module.exports.getSettings = getSettings;
