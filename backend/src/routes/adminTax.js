const express = require('express');
const router = express.Router();
const Order = require('../models/Order');

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const monthKey = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 7);

// GET /api/admin/tax/summary — GST breakup from invoiced orders, by month + invoice register
router.get('/summary', async (req, res) => {
  const orders = await Order.find({ invoiceNumber: { $ne: '' } }).sort({ createdAt: -1 }).limit(2000);
  const months = {};
  for (const o of orders) {
    const key = monthKey(o.createdAt);
    const m = months[key] || (months[key] = { month: key, invoices: 0, gross: 0, taxable: 0, tax: 0 });
    m.invoices += 1;
    m.gross += o.total;
    m.tax += o.taxAmount;
    m.taxable += o.total - o.taxAmount;
  }
  const round = (n) => Math.round(n * 100) / 100;
  const monthly = Object.values(months).sort((a, b) => b.month.localeCompare(a.month))
    .map(m => ({ ...m, gross: round(m.gross), taxable: round(m.taxable), tax: round(m.tax) }));
  const totals = monthly.reduce((t, m) => ({ invoices: t.invoices + m.invoices, gross: t.gross + m.gross, taxable: t.taxable + m.taxable, tax: t.tax + m.tax }), { invoices: 0, gross: 0, taxable: 0, tax: 0 });

  res.json({
    totals: { invoices: totals.invoices, gross: round(totals.gross), taxable: round(totals.taxable), tax: round(totals.tax) },
    monthly,
    invoices: orders.slice(0, 300).map(o => ({
      id: o.id, invoiceNumber: o.invoiceNumber, orderNumber: o.orderNumber, date: o.createdAt,
      customer: o.customer.name, phone: o.customer.phone, total: o.total, taxRate: o.taxRate, taxAmount: o.taxAmount,
    })),
  });
});

module.exports = router;
