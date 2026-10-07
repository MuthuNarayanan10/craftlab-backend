const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const { createNotification } = require('../models/Notification');

/** The ONLY way sellable stock changes. Atomic ($inc with a guard), and every change is written to the stock ledger.
 *  delta < 0 refuses to go below zero unless `force` (used when a customer has already paid — never lose a paid order over a count). */
async function adjustStock(productId, delta, { reason, ref = '', actor = 'system', note = '', releaseReserved = 0, force = false, respectReserved = false } = {}) {
  // respectReserved: a manual removal may only take what is NOT being held for customers in checkout
  const filter = delta < 0 && !force ? (respectReserved ? { _id: productId, $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, -delta] } } : { _id: productId, stock: { $gte: -delta } }) : { _id: productId };
  const inc = { stock: delta };
  if (releaseReserved) inc.reserved = -releaseReserved;
  const p = await Product.findOneAndUpdate(filter, { $inc: inc }, { new: true });
  if (!p) {
    const cur = respectReserved ? await Product.findById(productId) : null;
    if (cur && cur.reserved > 0) throw new Error(`${cur.reserved} unit${cur.reserved === 1 ? ' is' : 's are'} currently held for customers in checkout — you can remove at most ${Math.max(0, cur.stock - cur.reserved)} right now`);
    throw new Error('Not enough stock for that change');
  }
  await StockMovement.create({ product: p._id, productName: p.name, sku: p.sku, delta, stockAfter: p.stock, reason, ref, actor, note });
  if (delta < 0 && p.stock <= p.lowStockThreshold) await createNotification('low_stock', `${p.name} is low on stock (${p.stock} left)`, { productId: p.id });
  return p;
}
module.exports = { adjustStock };
