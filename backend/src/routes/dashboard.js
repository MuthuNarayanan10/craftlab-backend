const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const Customer = require('../models/Customer');
const Return = require('../models/Return');
const Supplier = require('../models/Supplier');
const Quotation = require('../models/Quotation');
const NotificationLog = require('../models/NotificationLog');
const WebhookEvent = require('../models/WebhookEvent');
const { getSettings } = require('../models/Settings');

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** Midnight (IST) at the start of today, as a real UTC Date. */
function istStartOfToday() {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}
function addDays(date, days) { return new Date(date.getTime() + days * 86400000); }
const PAID = { paymentStatus: 'Paid' };

async function sumPaid(from) {
  const match = from ? { ...PAID, createdAt: { $gte: from } } : { ...PAID };
  const r = await Order.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }]);
  return r[0] ? { total: r[0].total, count: r[0].count } : { total: 0, count: 0 };
}

// GET /api/admin/dashboard/today (kept for compatibility)
router.get('/today', async (req, res) => {
  const today = istStartOfToday();
  const [paidToday, ordersToday, pending, abandoned] = await Promise.all([
    sumPaid(today),
    Order.countDocuments({ createdAt: { $gte: today } }),
    Order.countDocuments({ orderStatus: 'Pending' }),
    Cart.countDocuments({ status: 'abandoned' }),
  ]);
  res.json({ ordersToday, revenueToday: paidToday.total, pendingOrders: pending, abandonedCarts: abandoned });
});

// GET /api/admin/dashboard/overview — everything the dashboard needs in one call
router.get('/overview', async (req, res) => {
  const today = istStartOfToday();
  const d7 = addDays(today, -6);
  const d30 = addDays(today, -29);
  const d14 = addDays(today, -13);
  const settings = await getSettings();

  const [
    revToday, rev7, rev30, revAll, ordersToday, ordersTotal,
    byStatusAgg, trendAgg, topProducts, lowStock, recentOrders, recentCustomers,
    customersTotal, openReturns, abandonedCarts, codPendingAgg, taxAllAgg, tax30Agg,
    suppliersActive, suppliersPending, quotationsOpen, activeProducts, productsWithImages,
  ] = await Promise.all([
    sumPaid(today), sumPaid(d7), sumPaid(d30), sumPaid(null),
    Order.countDocuments({ createdAt: { $gte: today } }),
    Order.countDocuments({}),
    Order.aggregate([{ $group: { _id: '$orderStatus', count: { $sum: 1 } } }]),
    // portable (works on any MongoDB-compatible engine): bucket the last 14 days by India-time day in code
    Order.find({ ...PAID, createdAt: { $gte: d14 } }).select('createdAt total').lean().then((rows) => {
      const m = {}; for (const o of rows) { const k = new Date(new Date(o.createdAt).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10); const e = m[k] || (m[k] = { _id: k, revenue: 0, orders: 0 }); e.revenue += o.total; e.orders++; }
      return Object.values(m);
    }),
    Order.aggregate([{ $match: PAID }, { $unwind: '$items' }, { $group: { _id: { name: '$items.name', price: '$items.price' }, units: { $sum: '$items.qty' } } }]).then((rows) => {
      const m = {}; for (const r of rows) { const e = m[r._id.name] || (m[r._id.name] = { _id: r._id.name, units: 0, revenue: 0 }); e.units += r.units; e.revenue += r.units * r._id.price; }
      return Object.values(m).sort((x, y) => y.revenue - x.revenue).slice(0, 5);
    }),
    Product.find({ status: 'active' }).select('name sku stock lowStockThreshold images').lean().then((ps) => ps.filter((p) => p.stock <= p.lowStockThreshold).slice(0, 10)),
    Order.find().sort({ createdAt: -1 }).limit(6).select('orderNumber customer total orderStatus paymentStatus payment createdAt'),
    Customer.find().sort({ createdAt: -1 }).limit(5).select('name phone email createdAt'),
    Customer.countDocuments({}),
    Return.countDocuments({ status: { $in: ['REQUESTED', 'APPROVED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'INSPECTION', 'REFUND_PENDING', 'Requested', 'Approved', 'PickedUp'] } }),
    Cart.countDocuments({ status: 'abandoned' }),
    Order.aggregate([
      { $match: { 'payment.method': 'cod', paymentStatus: 'Pending', orderStatus: { $nin: ['Cancelled', 'Refunded'] } } },
      { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } },
    ]),
    Order.aggregate([{ $match: { invoiceNumber: { $ne: '' } } }, { $group: { _id: null, tax: { $sum: '$taxAmount' }, gross: { $sum: '$total' }, count: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { invoiceNumber: { $ne: '' }, createdAt: { $gte: d30 } } }, { $group: { _id: null, tax: { $sum: '$taxAmount' }, gross: { $sum: '$total' }, count: { $sum: 1 } } }]),
    Supplier.countDocuments({ status: 'active' }),
    Supplier.countDocuments({ status: 'active', onboardingStatus: 'Pending' }),
    Quotation.countDocuments({ status: { $in: ['Draft', 'Sent'] } }),
    Product.countDocuments({ status: 'active' }),
    Product.countDocuments({ status: 'active', 'images.0': { $exists: true } }),
  ]);

  // Fill missing days with zero so the chart has a continuous x-axis.
  const trendMap = Object.fromEntries(trendAgg.map(t => [t._id, t]));
  const trend = [];
  for (let i = 0; i < 14; i++) {
    const day = addDays(d14, i);
    const key = new Date(day.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
    trend.push({ date: key, revenue: trendMap[key]?.revenue || 0, orders: trendMap[key]?.orders || 0 });
  }

  const byStatus = Object.fromEntries(byStatusAgg.map(s => [s._id, s.count]));
  const env = process.env;

  const [paidToday, pendingToday, failedToday, toReview, refundsPending, awaitingPickup, inTransit, shipErrors, failedNotifs, failedHooks, pendingPay] = await Promise.all([
    Order.countDocuments({ paymentStatus: 'Paid', 'payment.verifiedAt': { $gte: today } }),
    Order.countDocuments({ paymentStatus: 'Pending', 'payment.method': { $ne: 'cod' }, orderStatus: 'Pending', createdAt: { $gte: today } }),
    Order.countDocuments({ paymentStatus: 'Failed', createdAt: { $gte: today } }),
    Return.countDocuments({ status: { $in: ['REQUESTED', 'Requested'] } }),
    Return.countDocuments({ status: 'REFUND_PENDING' }),
    Order.countDocuments({ 'shipment.awb': { $ne: '' }, orderStatus: { $in: ['Paid', 'Processing', 'Packed'] } }),
    Order.countDocuments({ orderStatus: { $in: ['Dispatched', 'InTransit', 'OutForDelivery'] } }),
    Order.countDocuments({ 'shipment.error': { $ne: '' }, orderStatus: { $nin: ['Cancelled', 'Delivered', 'Refunded'] } }),
    NotificationLog.countDocuments({ status: 'failed', createdAt: { $gte: new Date(Date.now() - 7 * 86400e3) } }),
    WebhookEvent.countDocuments({ status: 'failed', createdAt: { $gte: new Date(Date.now() - 7 * 86400e3) } }),
    Order.countDocuments({ paymentStatus: { $in: ['Pending', 'Failed'] }, 'payment.method': { $ne: 'cod' }, orderStatus: 'Pending' }),
  ]);
  const extra = { payments: { paidToday, pendingToday, failedToday, pendingTotal: pendingPay }, returnsToReview: toReview, refundsPending, awaitingPickup, inTransit, health: { shipmentErrors: shipErrors, failedNotifications: failedNotifs, failedWebhooks: failedHooks } };

  res.json({
    ...extra,
    revenue: { today: revToday.total, last7: rev7.total, last30: rev30.total, allTime: revAll.total },
    paidOrders: { today: revToday.count, last30: rev30.count, allTime: revAll.count },
    avgOrderValue: revAll.count ? revAll.total / revAll.count : 0,
    orders: { today: ordersToday, total: ordersTotal, byStatus },
    trend, topProducts, lowStock,
    recentOrders: recentOrders.map(o => ({
      id: o.id, orderNumber: o.orderNumber, customer: o.customer.name, total: o.total,
      orderStatus: o.orderStatus, paymentStatus: o.paymentStatus, method: o.payment?.method === 'cod' ? 'COD' : 'Online', createdAt: o.createdAt,
    })),
    recentCustomers: recentCustomers.map(c => c.toJSON()),
    customersTotal, openReturns, abandonedCarts,
    codPending: codPendingAgg[0] ? { total: codPendingAgg[0].total, count: codPendingAgg[0].count } : { total: 0, count: 0 },
    tax: {
      allTime: taxAllAgg[0] || { tax: 0, gross: 0, count: 0 },
      last30: tax30Agg[0] || { tax: 0, gross: 0, count: 0 },
    },
    procurement: { suppliersActive, suppliersPending, quotationsOpen },
    catalog: { activeProducts, productsWithImages },
    // Honest launch checklist: each flag reflects what is actually configured right now.
    readiness: {
      razorpayConfigured: !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
      razorpayLive: (env.RAZORPAY_KEY_ID || '').startsWith('rzp_live_'),
      webhookSecret: !!env.RAZORPAY_WEBHOOK_SECRET,
      emailConfigured: !!(env.RESEND_API_KEY && env.RESEND_FROM),
      otpConfigured: !!env.FIREBASE_SERVICE_ACCOUNT_JSON,
      gstinSet: !!settings.gstin,
      whatsappSet: !!settings.supportWhatsapp,
      codEnabled: settings.codEnabled,
      productsReady: activeProducts > 0 && productsWithImages === activeProducts,
    },
  });
});

// GET /api/admin/dashboard/analytics (kept for compatibility)
router.get('/analytics', async (req, res) => {
  const [totalRevenueAgg, totalOrders, salesByProduct] = await Promise.all([
    Order.aggregate([{ $match: PAID }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Order.countDocuments(PAID),
    Order.aggregate([
      { $match: PAID }, { $unwind: '$items' },
      { $group: { _id: '$items.name', unitsSold: { $sum: '$items.qty' }, revenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } } } },
      { $sort: { revenue: -1 } },
    ]),
  ]);
  const totalRevenue = totalRevenueAgg[0]?.total || 0;
  res.json({ totalRevenue, totalOrders, avgOrderValue: totalOrders ? totalRevenue / totalOrders : 0, salesByProduct });
});

module.exports = router;
