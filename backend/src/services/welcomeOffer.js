/** WELCOME OFFER — the scratch-card popup's coupon. One shared public code (default WELCOME5 = 5% off) that is kept in sync with Admin → Settings.
 *  It is an ordinary coupon, so the owner can also see it, set an expiry or a usage limit under Admin → Coupons. */
const Coupon = require('../models/Coupon');

const cleanCode = (c, pct) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || `WELCOME${pct}`;
let synced = '';
async function ensureWelcomeCoupon(s) {
  if (!s.welcomeOfferEnabled) return null;
  const code = cleanCode(s.welcomeOfferCode, s.welcomeOfferPercent), sig = [code, s.welcomeOfferPercent, s.welcomeOfferMinOrder].join('|');
  if (synced === sig) return code;
  const c = await Coupon.findOne({ code });
  if (!c) await Coupon.create({ code, type: 'percentage', value: s.welcomeOfferPercent, minOrderValue: s.welcomeOfferMinOrder || 0, active: true });
  else { // keep value/minimum in step with Settings; the owner's expiry / usage limit on the coupon are left alone
    let ch = false; if (c.type !== 'percentage') { c.type = 'percentage'; ch = true; } if (c.value !== s.welcomeOfferPercent) { c.value = s.welcomeOfferPercent; ch = true; } if ((c.minOrderValue || 0) !== (s.welcomeOfferMinOrder || 0)) { c.minOrderValue = s.welcomeOfferMinOrder || 0; ch = true; } if (!c.active) { c.active = true; ch = true; }
    if (ch) await c.save();
  }
  synced = sig; return code;
}
module.exports = { ensureWelcomeCoupon, cleanCode };
