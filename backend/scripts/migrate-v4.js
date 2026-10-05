/** One-time (safe to re-run) upgrade of existing data for v4:
 *  - return statuses → the new 10-step workflow
 *  - orders without a timeline get one reconstructed from what is already known, so tracking pages work for old orders
 *  - default business settings (auth switches etc.) created
 *  Usage: npm run migrate */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/db');
const Order = require('../src/models/Order');
const Return = require('../src/models/Return');
const { getSettings } = require('../src/models/Settings');
const { LEGACY } = (() => { const r = require('../src/utils/returnStatus'); return { LEGACY: { Requested: 'REQUESTED', Approved: 'APPROVED', Rejected: 'REJECTED', PickedUp: 'PICKED_UP', Refunded: 'REFUNDED' } }; })();

(async () => {
  await connectDB();
  await getSettings();

  let ret = 0;
  for (const [from, to] of Object.entries(LEGACY)) { const r = await Return.updateMany({ status: from }, { $set: { status: to } }); ret += r.modifiedCount || 0; }
  console.log(`✅ returns migrated: ${ret}`);

  let rebuilt = 0;
  const cursor = Order.find({ $or: [{ events: { $exists: false } }, { events: { $size: 0 } }] }).cursor();
  for await (const o of cursor) {
    const ev = [{ at: o.createdAt, label: 'Order placed', stage: 'placed', actor: 'system', type: 'placed' }];
    const cod = o.payment?.method === 'cod';
    if (o.paymentStatus === 'Paid' || o.paymentStatus === 'Refunded') ev.push({ at: o.payment?.verifiedAt || o.createdAt, label: 'Payment confirmed', stage: 'paid', actor: 'system', type: 'payment' });
    else if (cod) ev.push({ at: o.createdAt, label: 'Order confirmed (pay on delivery)', stage: 'paid', actor: 'system', type: 'confirmed' });
    const rank = { Processing: 'processing', Packed: 'packed', Dispatched: 'handed', InTransit: 'transit', OutForDelivery: 'out', Delivered: 'delivered' };
    const order = ['processing', 'packed', 'handed', 'transit', 'out', 'delivered'];
    const reached = rank[o.orderStatus] ? order.indexOf(rank[o.orderStatus]) : (['Paid'].includes(o.orderStatus) ? 0 : -1);
    const labels = { processing: 'Processing', packed: 'Packed', handed: 'Handed to courier', transit: 'In transit', out: 'Out for delivery', delivered: 'Delivered' };
    order.slice(0, Math.max(0, reached + 1)).forEach((st) => ev.push({ at: st === 'delivered' && o.deliveredAt ? o.deliveredAt : st === 'handed' && o.delivery?.dispatchDate ? o.delivery.dispatchDate : o.updatedAt, label: labels[st], stage: st, actor: 'system', type: 'status' }));
    if (o.orderStatus === 'Cancelled') ev.push({ at: o.updatedAt, label: 'Order cancelled', actor: 'system', type: 'status' });
    await Order.updateOne({ _id: o._id }, { $set: { events: ev } });
    rebuilt++;
  }
  console.log(`✅ order timelines rebuilt: ${rebuilt}`);

  await Promise.all([Order.syncIndexes(), Return.syncIndexes()]);
  console.log('✅ indexes in sync');
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
