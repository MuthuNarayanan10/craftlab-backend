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
  // Authentication (all editable in Admin → Business settings, enforced on the server)
  customerLoginEnabled: { type: Boolean, default: true },
  customerSignupEnabled: { type: Boolean, default: true },
  otpEnabled: { type: Boolean, default: true },
  otpProvider: { type: String, enum: ['none', 'dev', 'msg91', 'brevo', 'zeptomail', 'firebase'], default: 'none' },
  otpChannel: { type: String, enum: ['sms', 'email'], default: 'sms' }, // only used by the test-mode (dev) provider
  guestCheckoutEnabled: { type: Boolean, default: true },
  autoCreateAccounts: { type: Boolean, default: true },
  requireMobileVerification: { type: Boolean, default: false },
  // Shipping automation
  autoCreateShipment: { type: Boolean, default: false },
  defaultCourierProvider: { type: String, default: 'manual' },
  // Notifications
  notifyEmailEnabled: { type: Boolean, default: true },
  notifyWhatsappEnabled: { type: Boolean, default: false },
  // Returns
  autoApproveReturns: { type: Boolean, default: false },
  // Support
  supportWhatsapp: { type: String, default: '918046800250' },
  returnWindowDays: { type: Number, default: 5 },
  // PIN-code serviceability: 'off' = deliver everywhere (until you load your list); 'registry' = ONLY serviceable PINs in Admin → Pincodes
  pincodeCheckMode: { type: String, enum: ['off', 'registry'], default: 'off' },
  // Rewards (1 point = ₹1). Earn 5% → ₹1000 gives 50 points. Points are credited once the return window after delivery has passed.
  rewardsEnabled: { type: Boolean, default: true },
  rewardEarnPercent: { type: Number, default: 5, min: 0, max: 50 },
  rewardRedeemMaxPercent: { type: Number, default: 20, min: 0, max: 100 },   // most of an order's goods value that points may pay for
  rewardRedeemMinPoints: { type: Number, default: 100, min: 0 },
  cashbackPercent: { type: Number, default: 0, min: 0, max: 50 },            // extra promotional credit on PREPAID orders (paid in points)
  cashbackMinOrder: { type: Number, default: 0, min: 0 },
  giftCardsEnabled: { type: Boolean, default: true },
  stockHoldMinutes: { type: Number, default: 10, min: 3, max: 60 }, // how long stock is held for a customer in checkout / awaiting payment
  supportHours: { type: String, default: 'Mon–Sat 10 AM – 6 PM IST' },
  collections: { type: [{ key: String, title: String, enabled: { type: Boolean, default: true }, mode: { type: String, default: 'manual' }, limit: { type: Number, default: 8 }, _id: false }], default: [
    { key: 'featured', title: 'Featured Products', enabled: true, mode: 'manual', limit: 8 }, { key: 'new-arrivals', title: 'New Arrivals', enabled: true, mode: 'auto', limit: 8 },
    { key: 'best-sellers', title: 'Best Sellers', enabled: true, mode: 'auto', limit: 8 }, { key: 'recommended', title: 'Recommended For You', enabled: false, mode: 'manual', limit: 8 }] },
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
