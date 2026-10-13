/** Abandoned carts: a cart with items + a way to reach the buyer, left idle. Listing never changes anything; reminders are sent once automatically
 *  (with consent) and the owner can send or WhatsApp more by hand. */
const Cart = require('../models/Cart');
const { getSettings } = require('../models/Settings');
const { sendEmail } = require('../utils/email');
const { logger } = require('../utils/logger');

const SITE = () => (process.env.SITE_URL || 'https://thecraftlab.co.in').replace(/\/$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IDLE_MIN = () => Math.max(5, parseInt(process.env.ABANDONED_AFTER_MIN, 10) || 30);

const hasContact = { $or: [{ 'contact.email': { $regex: '@' } }, { 'contact.phone': { $regex: '\\d{10}' } }] };
const baseFilter = (idleMin = IDLE_MIN()) => ({ status: { $in: ['active', 'abandoned'] }, updatedAt: { $lt: new Date(Date.now() - idleMin * 60e3) }, 'items.0': { $exists: true }, ...hasContact });

function suggest(c, items) {
  const first = (c.contact.name || '').split(' ')[0] || 'there', list = items.map((i) => i.name).join(', ');
  return c.recoveryMessagesSent === 0 ? `Hi ${first}! We noticed you left ${list} in your Craft Lab cart. Still thinking it over? Happy to answer any questions — just reply here.`
    : c.recoveryMessagesSent === 1 ? `Hi ${first}, your ${list} is still saved for you. Complete your order in the next 24 hours and use code COMEBACK5 for 5% off.`
    : `Hi ${first}, last call on your Craft Lab cart (${list}) — use code COMEBACK10 for 10% off if you complete it today.`;
}

async function list() {
  const carts = await Cart.find(baseFilter()).populate('items.product').sort({ updatedAt: -1 }).limit(300);
  return carts.map((c) => {
    const items = c.items.filter((i) => i.product).map((i) => ({ name: i.product.name, qty: i.qty, price: i.product.price }));
    return { id: c.id, contact: c.contact, consent: !!c.contact?.consentToContact, items, value: items.reduce((s, i) => s + i.price * i.qty, 0), updatedAt: c.updatedAt, recoveryMessagesSent: c.recoveryMessagesSent, lastRecoveryAt: c.lastRecoveryAt, suggestedMessage: suggest(c, items) };
  }).filter((x) => x.items.length);
}

function reminderEmail(cart, items, settings) {
  const first = esc((cart.contact.name || '').split(' ')[0] || 'there');
  const link = `${SITE()}/cart.html?restore=${encodeURIComponent(cart.cartId)}`;
  return { subject: `You left something in your cart — ${settings.businessName || 'The Craft Lab'}`,
    html: `<div style="font-family:sans-serif;max-width:560px;color:#2A2620"><h2 style="color:#544C35;font-weight:500">Still thinking it over, ${first}?</h2><p>Your cart is saved, and you can check out as a guest — no account needed.</p>
      ${items.map((i) => `<p style="margin:6px 0"><strong>${esc(i.name)}</strong> × ${i.qty} — ₹${i.price * i.qty}</p>`).join('')}
      <p style="margin:22px 0"><a href="${link}" style="background:#544C35;color:#fff;padding:13px 24px;border-radius:6px;text-decoration:none">Return to my cart</a></p>
      <p style="color:#6c675f;font-size:13px">Questions about the piece or delivery? Just reply to this email or WhatsApp us — ${esc(settings.supportHours || '')}. Not interested? Simply ignore this message and we won’t email you again about this cart.</p></div>` };
}

/** Emails one reminder for a cart. Returns { sent, reason }. */
async function sendReminder(cart, { manual = false } = {}) {
  const email = String(cart.contact?.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { sent: false, reason: 'This cart has no email address — use WhatsApp instead.' };
  if (!manual && !cart.contact.consentToContact) return { sent: false, reason: 'no_consent' };
  await cart.populate('items.product');
  const items = cart.items.filter((i) => i.product).map((i) => ({ name: i.product.name, qty: i.qty, price: i.product.price }));
  if (!items.length) return { sent: false, reason: 'The products in this cart are no longer available.' };
  const settings = await getSettings(); const m = reminderEmail(cart, items, settings);
  const r = await sendEmail(email, m.subject, m.html, settings.email ? { replyTo: settings.email } : {});
  if (r && (r.skipped || r.error)) return { sent: false, reason: 'Email isn’t set up yet (Admin → Integrations → Email).' };
  cart.recoveryMessagesSent = (cart.recoveryMessagesSent || 0) + 1; cart.lastRecoveryAt = new Date(); await cart.save();
  return { sent: true };
}

/** Job: first reminder 1 hour after the cart went quiet (within 3 days), consenting customers only, never twice. */
async function sendDueReminders() {
  const carts = await Cart.find({ ...baseFilter(60), updatedAt: { $lt: new Date(Date.now() - 60 * 60e3), $gt: new Date(Date.now() - 3 * 86400e3) }, 'contact.consentToContact': true, recoveryMessagesSent: 0, 'contact.email': { $regex: '@' } }).limit(25);
  let n = 0;
  for (const c of carts) { try { if ((await sendReminder(c)).sent) n++; } catch (e) { logger.warn('abandoned_reminder_failed', { error: e.message }); } }
  return n ? { changed: n } : null;
}
module.exports = { list, sendReminder, sendDueReminders };
