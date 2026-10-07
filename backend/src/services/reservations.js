/** CHECKOUT STOCK HOLDS — the backend database owns these (never the browser, never Firebase).
 *  Entering checkout reserves stock for `stockHoldMinutes`; paying converts the hold into the order's hold; walking away lets it expire.
 *  Every change to Product.reserved is a single atomic update, so two customers can never both hold the last unit. */
const Product = require('../models/Product');
const StockReservation = require('../models/StockReservation');
const { getSettings } = require('../models/Settings');
const { createNotification } = require('../models/Notification');
const { logger } = require('../utils/logger');

/** Hold `qty` units if (stock − reserved) ≥ qty. Atomic. */
async function reserveUnits(productId, qty) {
  return !!(await Product.findOneAndUpdate({ _id: productId, $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, qty] } }, { $inc: { reserved: qty } }, { new: true }));
}
const releaseUnits = (productId, qty) => Product.findOneAndUpdate({ _id: productId, reserved: { $gte: qty } }, { $inc: { reserved: -qty } });

const sameItems = (a, b) => a.length === b.length && a.every((x) => b.some((y) => String(y.product) === String(x.product) && y.qty === x.qty));

async function releaseReservation(r, status = 'released') {
  const claimed = await StockReservation.findOneAndUpdate({ _id: r._id, status: 'active' }, { status }, { new: true });
  if (!claimed) return false; // someone else (payment, expiry job) already took it
  for (const it of claimed.items) await releaseUnits(it.product, it.qty);
  return true;
}

/** Expire holds whose time is up and give the stock back. Safe to run on every instance, as often as you like. */
async function expireReservations(limit = 200) {
  const due = await StockReservation.find({ status: 'active', expiresAt: { $lt: new Date() } }).limit(limit);
  let n = 0;
  for (const r of due) if (await releaseReservation(r, 'expired')) n++;
  if (n) { logger.info('reservations_expired', { count: n }); await createNotification('reservation_expired', `${n} checkout hold${n > 1 ? 's' : ''} expired — the stock went back on sale`, { count: n }).catch(() => {}); }
  return n;
}

/** Customer entered checkout: validate stock and hold it. Refreshing / re-entering returns the SAME hold (and the same deadline). */
async function reserveCart(cart) {
  await expireReservations();
  const wanted = cart.items.map((i) => ({ product: i.product._id, qty: i.qty }));
  const now = new Date();
  const existing = await StockReservation.findOne({ cartId: cart.cartId, status: 'active', expiresAt: { $gt: now } });
  if (existing && sameItems(existing.items, wanted)) return { reservation: existing, reused: true };
  if (existing) await releaseReservation(existing, 'released'); // the basket changed — start again

  const done = [];
  for (const it of cart.items) {
    if (!it.product || it.product.status !== 'active') { for (const d of done) await releaseUnits(d.product, d.qty); return { error: { code: 'UNAVAILABLE', message: `${it.product?.name || 'An item'} is no longer available` } }; }
    if (!(await reserveUnits(it.product._id, it.qty))) {
      for (const d of done) await releaseUnits(d.product, d.qty);
      const fresh = await Product.findById(it.product._id);
      const left = fresh ? Math.max(0, fresh.stock - fresh.reserved) : 0;
      return { error: { code: 'OUT_OF_STOCK', productId: String(it.product._id), available: left, message: left > 0 ? `Only ${left} of ${it.product.name} ${left === 1 ? 'is' : 'are'} available right now` : `${it.product.name} is currently out of stock` } };
    }
    done.push({ product: it.product._id, qty: it.qty });
  }
  const { stockHoldMinutes } = await getSettings();
  const reservation = await StockReservation.create({ cartId: cart.cartId, items: done, expiresAt: new Date(now.getTime() + stockHoldMinutes * 60e3) });
  return { reservation, reused: false };
}

/** Customer paid / pressed Pay: turn the cart hold into the order's hold. Returns the units now held for the order ([] if there was no usable hold). */
async function takeForCheckout(cartId, wantedItems) {
  const r = await StockReservation.findOneAndUpdate({ cartId, status: 'active', expiresAt: { $gt: new Date() } }, { status: 'converted' }, { new: false });
  if (!r) return [];
  const held = [];
  for (const it of r.items) {
    const want = wantedItems.find((w) => String(w.product) === String(it.product));
    if (!want) { await releaseUnits(it.product, it.qty); continue; }                    // item no longer in the basket
    const keep = Math.min(it.qty, want.qty); held.push({ product: it.product, qty: keep });
    if (it.qty > keep) await releaseUnits(it.product, it.qty - keep);                   // basket shrank
  }
  return held;
}

const releaseCart = async (cartId) => { let n = 0; for (const r of await StockReservation.find({ cartId, status: 'active' })) if (await releaseReservation(r)) n++; return n; };

module.exports = { reserveUnits, releaseUnits, reserveCart, takeForCheckout, releaseCart, releaseReservation, expireReservations };
