/** ANALYTICS — pure functions. The route loads orders/returns for a range; everything is computed here (and unit-tested). */
const IST = 5.5 * 3600e3;
const istDay = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const startOfIstDay = (d) => { const x = new Date(new Date(d).getTime() + IST); x.setUTCHours(0, 0, 0, 0); return new Date(x.getTime() - IST); };
const round2 = (n) => Math.round(n * 100) / 100;

/** { range: 'today'|'7d'|'30d'|'90d'|'custom', from, to } → { from, to, label } with India-time day boundaries. */
function resolveRange({ range = '30d', from, to } = {}, now = new Date()) {
  const todayStart = startOfIstDay(now);
  const endOfToday = new Date(todayStart.getTime() + 86400e3 - 1);
  const days = { today: 1, '7d': 7, '30d': 30, '90d': 90 }[range];
  if (days) return { from: new Date(todayStart.getTime() - (days - 1) * 86400e3), to: endOfToday, label: range };
  if (range === 'custom' && from && to) {
    const f = startOfIstDay(from), t = new Date(startOfIstDay(to).getTime() + 86400e3 - 1);
    if (isNaN(f) || isNaN(t) || f > t) throw new Error('Choose a valid date range');
    if ((t - f) / 86400e3 > 400) throw new Error('Date range is too long (max 400 days)');
    return { from: f, to: t, label: 'custom' };
  }
  return resolveRange({ range: '30d' }, now);
}

function computeAnalytics({ orders, returns = [], from, to, priorPhones = new Set() }) {
  const inRange = (d) => { const t = new Date(d).getTime(); return t >= from.getTime() && t <= to.getTime(); };
  const placed = orders.filter((o) => inRange(o.createdAt));
  const paid = placed.filter((o) => o.paymentStatus === 'Paid' || o.paymentStatus === 'Refunded');
  const revenue = paid.reduce((s, o) => s + o.total, 0);

  // refunds issued within the range (by refund date), regardless of when the order was placed
  let refundAmount = 0;
  for (const o of orders) for (const r of o.refunds || []) if (r.status !== 'failed' && inRange(r.createdAt)) refundAmount += r.amount;

  // customers: "new" = first-ever paid order falls in this range
  const seen = new Set(); let newC = 0, retC = 0;
  for (const o of [...paid].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
    const p = (o.customer?.phone || '').slice(-10);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    priorPhones.has(p) ? retC++ : newC++;
  }

  const prod = {};
  for (const o of paid) for (const i of o.items) { const p = prod[i.name] || (prod[i.name] = { name: i.name, units: 0, revenue: 0, returned: 0 }); p.units += i.qty; p.revenue += i.price * i.qty; }
  const rangeReturns = returns.filter((r) => inRange(r.createdAt));
  for (const r of rangeReturns) for (const it of r.items || []) if (prod[it.name]) prod[it.name].returned += it.qty;

  const delivered = placed.filter((o) => o.orderStatus === 'Delivered');
  const online = placed.filter((o) => o.payment?.method !== 'cod');
  const failed = online.filter((o) => o.paymentStatus !== 'Paid' && o.paymentStatus !== 'Refunded');

  const couriers = {};
  for (const o of delivered) {
    const name = o.shipment?.courierName || o.delivery?.partner || 'Unspecified';
    const ev = o.events || [];
    const out = ev.find((e) => e.stage === 'handed'), done = ev.find((e) => e.stage === 'delivered');
    const c = couriers[name] || (couriers[name] = { name, shipments: 0, days: 0, timed: 0 });
    c.shipments++;
    if (out && done) { c.days += (new Date(done.at) - new Date(out.at)) / 86400e3; c.timed++; }
  }

  const src = {};
  for (const o of paid) { const s = o.attribution?.source || 'direct'; const x = src[s] || (src[s] = { source: s, orders: 0, revenue: 0 }); x.orders++; x.revenue += o.total; }

  const daily = {};
  for (let t = startOfIstDay(from).getTime(); t <= to.getTime(); t += 86400e3) daily[istDay(t)] = { date: istDay(t), revenue: 0, orders: 0 };
  for (const o of paid) { const k = istDay(o.createdAt); if (daily[k]) { daily[k].revenue += o.total; daily[k].orders++; } }

  return {
    range: { from, to },
    revenue: round2(revenue), refundAmount: round2(refundAmount), netRevenue: round2(revenue - refundAmount),
    orders: { placed: placed.length, paid: paid.length, cancelled: placed.filter((o) => o.orderStatus === 'Cancelled').length, cod: placed.filter((o) => o.payment?.method === 'cod').length, delivered: delivered.length },
    avgOrderValue: paid.length ? round2(revenue / paid.length) : 0,
    customers: { new: newC, returning: retC },
    products: Object.values(prod).sort((a, b) => b.revenue - a.revenue),
    returns: { count: rangeReturns.length, rate: delivered.length ? round2((rangeReturns.length / delivered.length) * 100) : 0 },
    payments: { onlineAttempts: online.length, failedOrAbandoned: failed.length, failureRate: online.length ? round2((failed.length / online.length) * 100) : 0 },
    couriers: Object.values(couriers).map((c) => ({ name: c.name, shipments: c.shipments, avgDeliveryDays: c.timed ? round2(c.days / c.timed) : null })),
    sources: Object.values(src).sort((a, b) => b.revenue - a.revenue),
    daily: Object.values(daily),
    conversion: null, // needs storefront session tracking (not collected) — see docs
  };
}
module.exports = { resolveRange, computeAnalytics, istDay, startOfIstDay };
