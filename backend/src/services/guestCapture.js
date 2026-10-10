const Customer = require('../models/Customer');
const { logger } = require('../utils/logger');

/**
 * Guest checkout still leaves a record: the buyer's name, phone and email are saved as a Customer with isGuest=true,
 * so the admin can see and contact everyone who ordered. It is a CONTACT record only — orders are not attached to it
 * (no reward points are earned and nothing about the guest's order becomes readable by anyone who types the same phone).
 * If this person later logs in with a verified OTP, the same record becomes a normal account.
 */
async function captureGuest({ name, phone, email }) {
  try {
    const em = String(email || '').toLowerCase().trim() || undefined;
    const ph = String(phone || '').trim() || undefined;
    if (!em && !ph) return null;
    let c = (ph && await Customer.findOne({ phone: ph })) || (em && await Customer.findOne({ email: em })) || null;
    if (c) { // known contact: only fill gaps, never overwrite verified details
      const set = {};
      if (c.isGuest) {
        if (name && (!c.name || c.name === 'Craft Lab Customer')) set.name = String(name).trim();
        if (!c.phone && ph) set.phone = ph;
        if (!c.email && em) set.email = em;
      } else {
        if (name && c.name === 'Craft Lab Customer') set.name = String(name).trim();
      }
      if (Object.keys(set).length) await Customer.updateOne({ _id: c._id }, { $set: set }).catch(() => {});
      return c;
    }
    return await Customer.create({ name: String(name || 'Guest').trim() || 'Guest', ...(ph ? { phone: ph } : {}), ...(em ? { email: em } : {}), isGuest: true, authMethod: 'otp' });
  } catch (e) { logger.warn('guest_capture_failed', { error: e.message }); return null; }
}
module.exports = { captureGuest };
