const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { buildJourney } = require('../utils/orderStatus');
const { getSettings } = require('../models/Settings');
const { loadCtx, finish } = require('../services/trackLink');
const { invoiceHtml, sampleOrder } = require('../utils/invoiceHtml');
const businessOf = async () => { const s = await getSettings(); return { legalName: s.legalName || s.businessName, businessName: s.businessName, gstin: s.gstin, pan: s.pan, address: s.address, city: s.city, state: s.state, pincode: s.pincode, phone: s.phone, email: s.email, hsn: s.hsnCode || '' }; };
/** Only what belongs on an invoice - nothing internal. */
const publicInvoiceOrder = (order) => { const o = order.toJSON(); return {
  invoiceNumber: o.invoiceNumber, orderNumber: o.orderNumber, createdAt: o.createdAt, taxRate: o.taxRate, taxAmount: o.taxAmount,
  customer: { name: o.customer.name, phone: o.customer.phone, email: o.customer.email }, address: o.address,
  items: o.items.map((i) => ({ name: i.name, sku: i.sku, qty: i.qty, price: i.price })),
  subtotal: o.subtotal, shipping: o.shipping, discount: o.discount, couponCode: o.couponCode, prepaidDiscount: o.prepaidDiscount, codFee: o.codFee, total: o.total,
  wallet: { pointsUsed: o.wallet?.pointsUsed || 0, pointsValue: o.wallet?.pointsValue || 0, giftTotal: o.wallet?.giftTotal || 0 },
  payment: { method: o.payment?.method || '', id: o.payment?.razorpayPaymentId || '' }, delivery: { name: o.delivery?.method?.name || '' } }; };

// GET /api/track?orderNumber=CL-1001&email=…  (or &phone=…)
// Public, but needs BOTH the order number and the email/phone on that order — guessing sequential numbers reveals nothing.
router.get('/', async (req, res) => {
  const orderNumber = String(req.query.orderNumber || '').trim().toUpperCase().replace(/^#/, '').replace(/\s+/g, '');
  const email = String(req.query.email || '').trim().toLowerCase();
  const phone = String(req.query.phone || '').replace(/\D/g, '').slice(-10);
  if (!orderNumber || (!email && phone.length !== 10)) return res.status(400).json({ error: 'Enter your order number and the email or mobile number used for the order' });

  const order = await Order.findOne({ orderNumber: { $in: [orderNumber, orderNumber.replace(/-/g, '')] }, ...(email ? { 'customer.email': email } : { 'customer.phone': { $regex: phone + '$' } }) });
  if (!order) return res.status(404).json({ error: 'No order found matching those details' });

  const o = order.toJSON(); const ctx = await loadCtx();
  res.json({
    orderNumber: o.orderNumber, createdAt: o.createdAt, total: o.total, paymentStatus: o.paymentStatus, orderStatus: o.orderStatus,
    items: o.items.map((i) => ({ name: i.name, qty: i.qty, image: i.image })),
    city: o.address.city,
    wallet: { pointsValue: o.wallet?.pointsValue || 0, giftTotal: o.wallet?.giftTotal || 0 },
    journey: finish(buildJourney(o), o, ctx),
    // kept for older clients
    delivery: { partner: o.shipment?.courierName || o.delivery?.partner || '', trackingId: o.shipment?.awb || o.delivery?.trackingId || '' },
  });
});

// GET /api/track/invoice?orderNumber=…&email=… (or &phone=…) — the GST tax invoice for one order, for guests and logged-in customers alike.
// Same rule as tracking: you need the order number AND the contact used on it.
router.get('/invoice', async (req, res) => {
  const orderNumber = String(req.query.orderNumber || '').trim().toUpperCase().replace(/^#/, '').replace(/\s+/g, '');
  const email = String(req.query.email || '').trim().toLowerCase();
  const phone = String(req.query.phone || '').replace(/\D/g, '').slice(-10);
  if (!orderNumber || (!email && phone.length !== 10)) return res.status(400).json({ error: 'Enter your order number and the email or mobile number used for the order' });
  const order = await Order.findOne({ orderNumber: { $in: [orderNumber, orderNumber.replace(/-/g, '')] }, ...(email ? { 'customer.email': email } : { 'customer.phone': { $regex: phone + '$' } }) });
  if (!order) return res.status(404).json({ error: 'No order found matching those details' });
  if (!order.invoiceNumber) return res.status(409).json({ error: 'Your invoice is issued as soon as the payment is confirmed. Please check again in a minute.' });
  res.json({ html: invoiceHtml(publicInvoiceOrder(order), await businessOf()), invoiceNumber: order.invoiceNumber });
});

// GET /api/track/sample-invoice - a made-up invoice with the Order ID marked, for the "Where do I find my Order ID?" pop-up
router.get('/sample-invoice', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ html: invoiceHtml(sampleOrder(), await businessOf(), { highlightOrderId: true }) });
});
module.exports = router;

module.exports.publicInvoiceOrder = publicInvoiceOrder; module.exports.businessOf = businessOf;
