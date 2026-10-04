const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const Customer = require('../models/Customer');
const Return = require('../models/Return');
const Supplier = require('../models/Supplier');
const Quotation = require('../models/Quotation');
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
    Order.aggregate([
      { $match: { ...PAID, createdAt: { $gte: d14 } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: PAID }, { $unwind: '$items' },
      { $group: { _id: '$items.name', units: { $sum: '$items.qty' }, revenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } } } },
      { $sort: { revenue: -1 } }, { $limit: 5 },
    ]),
    Product.find({ status: 'active', $expr: { $lte: ['$stock', '$lowStockThreshold'] } }).select('name sku stock lowStockThreshold images').limit(10),
    Order.find().sort({ createdAt: -1 }).limit(6).select('orderNumber customer total orderStatus paymentStatus payment createdAt'),
    Customer.find().sort({ createdAt: -1 }).limit(5).select('name phone email createdAt'),
    Customer.countDocuments({}),
    Return.countDocuments({ status: { $in: ['Requested', 'Approved', 'PickedUp'] } }),
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

  res.json({
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
