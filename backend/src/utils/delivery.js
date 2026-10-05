/** DELIVERY METHODS — pure rules: which options a customer can choose, what they cost, how long they take.
 *  Methods are admin-managed records (see models/DeliveryMethod.js); a courier method ships through a courier integration,
 *  a manual method is delivered by your own team (local delivery / own transport). */
const digits = (p) => String(p || '').replace(/\D/g, '');

/** Empty PIN lists = deliverable everywhere in India. Otherwise the PIN must match an exact PIN or start with a listed prefix. */
function isServiceable(method, pincode) {
  const pin = digits(pincode);
  if (pin.length !== 6) return false;
  const exact = (method.pincodes || []).map(digits).filter(Boolean);
  const prefixes = (method.pincodePrefixes || []).map(digits).filter(Boolean);
  if (!exact.length && !prefixes.length) return true;
  return exact.includes(pin) || prefixes.some((p) => pin.startsWith(p));
}

/** Delivery charge for an order whose goods total (after coupon) is `amount`. */
function feeFor(method, amount) {
  if (method.freeAbove > 0 && amount >= method.freeAbove) return 0;
  return Math.max(0, Number(method.fee) || 0);
}

function etaText(m) {
  const a = Number(m.etaMinDays) || 0, b = Number(m.etaMaxDays) || 0;
  if (!b) return 'Ready soon';
  if (b <= 1) return 'Within 1 day';
  return a && a !== b ? `${a}–${b} days` : `${b} days`;
}

/** Options to show at checkout for this PIN / basket / payment type. */
function applicableMethods(methods, { pincode, subtotal = 0, cod = false } = {}) {
  return methods.filter((m) => m.enabled && (!pincode || isServiceable(m, pincode))).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((m) => ({ key: m.key, name: m.name, description: m.description || '', type: m.type, fee: feeFor(m, subtotal), freeAbove: m.freeAbove || 0, etaText: etaText(m), etaMinDays: m.etaMinDays, etaMaxDays: m.etaMaxDays, codAllowed: !!m.codAllowed, selectable: !cod || !!m.codAllowed }));
}

/** What is stored on the order, so later edits to a method never change past orders. */
const snapshot = (m, amount) => ({ key: m.key, name: m.name, type: m.type, fee: feeFor(m, amount), etaMinDays: m.etaMinDays || 0, etaMaxDays: m.etaMaxDays || 0, courierProvider: m.courierProvider || '' });
const estimatedDate = (m, from = new Date()) => (m.etaMaxDays ? new Date(from.getTime() + m.etaMaxDays * 86400e3) : null);

module.exports = { isServiceable, feeFor, etaText, applicableMethods, snapshot, estimatedDate, digits };
