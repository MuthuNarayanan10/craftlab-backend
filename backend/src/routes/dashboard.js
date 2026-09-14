const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Product = require('../models/Product');
const Cart = require('../models/Cart');

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// GET /api/admin/dashboard/today
router.get('/today', async (req, res) => {
  const today = startOfToday();
  const [ordersToday, revenueAgg, pendingCount, paidCount, cancelledCount, abandonedCount] = await Promise.all([
    Order.countDocuments({ createdAt: { $gte: today } }),
    Order.aggregate([
      { $match: { createdAt: { $gte: today }, paymentStatus: 'Paid' } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),
    Order.countDocuments({ orderStatus: 'Pending' }),
    Order.countDocuments({ createdAt: { $gte: today }, paymentStatus: 'Paid' }),
    Order.countDocuments({ createdAt: { $gte: today }, orderStatus: 'Cancelled' }),
    Cart.countDocuments({ status: 'abandoned' }),
  ]);

  res.json({
    ordersToday,
    revenueToday: revenueAgg[0]?.total || 0,
    pendingOrders: pendingCount,
    paidOrdersToday: paidCount,
    cancelledOrdersToday: cancelledCount,
    abandonedCarts: abandonedCount,
  });
});

// GET /api/admin/dashboard/analytics
router.get('/analytics', async (req, res) => {
  const [totalRevenueAgg, totalOrders, customerCount, salesByProduct, revenueTrend] = await Promise.all([
    Order.aggregate([{ $match: { paymentStatus: 'Paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Order.countDocuments({ paymentStatus: 'Paid' }),
    Order.distinct('customer.email', { paymentStatus: 'Paid' }),
    Order.aggregate([
      { $match: { paymentStatus: 'Paid' } },
      { $unwind: '$items' },
      { $group: { _id: '$items.name', unitsSold: { $sum: '$items.qty' }, revenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } } } },
      { $sort: { revenue: -1 } },
    ]),
    Order.aggregate([
      { $match: { paymentStatus: 'Paid' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $limit: 30 },
    ]),
  ]);

  const totalRevenue = totalRevenueAgg[0]?.total || 0;
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  const totalCartsEver = await Cart.countDocuments({ 'items.0': { $exists: true } });
  const convertedCarts = await Cart.countDocuments({ status: 'converted' });
  const cartAbandonmentRate = totalCartsEver > 0 ? ((totalCartsEver - convertedCarts) / totalCartsEver) * 100 : 0;

  res.json({
    totalRevenue,
    totalOrders,
    avgOrderValue,
    customerCount: customerCount.length,
    cartAbandonmentRate,
    salesByProduct,
    revenueTrend,
  });
});

module.exports = router;
