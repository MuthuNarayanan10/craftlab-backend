const express = require('express');
const router = express.Router();
const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');
const { getNextSequence } = require('../models/Counter');
const { requireRole } = require('../middleware/adminAuth');
const { adjustStock } = require('../services/inventory');
const { audit } = require('../models/AuditLog');

const FLOW = { Draft: ['Sent', 'Cancelled'], Sent: ['Confirmed', 'Cancelled'], Confirmed: ['Cancelled'], PartiallyReceived: [], Received: [], Cancelled: [] };
const MAX_FILE = 1_500_000;

// GET /api/admin/purchase-orders?status=&supplier=&pay=&page=
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = 25;
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.supplier) filter.supplier = req.query.supplier;
  const docs = await PurchaseOrder.find(filter).select('-invoice.file').sort({ createdAt: -1 });
  let rows = docs.map((d) => d.toJSON());
  if (req.query.pay) rows = rows.filter((r) => r.paymentStatus === req.query.pay);
  res.json({ purchaseOrders: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, pages: Math.ceil(rows.length / limit) || 1 });
});

// GET /api/admin/purchase-orders/summary — what is owed to whom
router.get('/summary', async (req, res) => {
  const docs = await PurchaseOrder.find({ status: { $ne: 'Cancelled' } }).select('-invoice.file');
  const bySupplier = {};
  let payable = 0, paid = 0, outstanding = 0, awaitingInvoice = 0, awaitingVerification = 0;
  for (const d of docs) {
    const o = d.toJSON();
    payable += o.payable; paid += o.paid; outstanding += o.outstanding;
    if (['Received', 'PartiallyReceived'].includes(o.status) && !o.invoice.number) awaitingInvoice++;
    if (o.invoice.number && !o.invoice.verified) awaitingVerification++;
    const s = bySupplier[o.supplierName] || (bySupplier[o.supplierName] = { supplier: o.supplierName, orders: 0, payable: 0, paid: 0, outstanding: 0 });
    s.orders++; s.payable += o.payable; s.paid += o.paid; s.outstanding += o.outstanding;
  }
  res.json({ totals: { payable, paid, outstanding, awaitingInvoice, awaitingVerification, openOrders: docs.filter((d) => ['Draft', 'Sent', 'Confirmed', 'PartiallyReceived'].includes(d.status)).length }, bySupplier: Object.values(bySupplier).sort((a, b) => b.outstanding - a.outstanding) });
});

router.get('/:id', async (req, res) => {
  const d = await PurchaseOrder.findById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Purchase order not found' });
  res.json({ ...d.toJSON(), nextStatuses: FLOW[d.status] || [] });
});

// POST /api/admin/purchase-orders
router.post('/', async (req, res) => {
  const { supplierId, items, expectedDate, notes } = req.body;
  const supplier = await Supplier.findById(supplierId);
  if (!supplier) return res.status(400).json({ error: 'Choose a manufacturer' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Add at least one item' });
  const clean = items.map((i) => ({ description: String(i.description || '').trim().slice(0, 150), product: i.productId || null, qty: parseInt(i.qty, 10), unitCost: Number(i.unitCost) }));
  if (clean.some((i) => !i.description || !(i.qty >= 1) || !(i.unitCost >= 0))) return res.status(400).json({ error: 'Each item needs a description, a quantity of at least 1 and a cost' });
  const po = await PurchaseOrder.create({ poNumber: `PO-${await getNextSequence('poNumber')}`, supplier: supplier._id, supplierName: supplier.name, items: clean, expectedDate: expectedDate || null, notes: String(notes || '').slice(0, 500), createdBy: req.admin.email });
  await audit({ action: 'po.created', actor: req.admin.email, entity: 'purchase_order', entityId: po.id, summary: `Created ${po.poNumber} for ${supplier.name} — ₹${po.total}`, req });
  res.status(201).json(po);
});

// PUT /api/admin/purchase-orders/:id/status
router.put('/:id/status', async (req, res) => {
  const po = await PurchaseOrder.findById(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (!(FLOW[po.status] || []).includes(req.body.status)) return res.status(409).json({ error: `A ${po.status} order can't be marked ${req.body.status}` });
  if (req.body.status === 'Cancelled' && po.items.some((i) => i.receivedQty > 0)) return res.status(409).json({ error: 'Goods have already been received against this order' });
  const before = po.status; po.status = req.body.status; await po.save();
  await audit({ action: 'po.status_changed', actor: req.admin.email, entity: 'purchase_order', entityId: po.id, summary: `${po.poNumber}: ${before} → ${po.status}`, req });
  res.json(po);
});

// POST /api/admin/purchase-orders/:id/receive {lines:[{itemId, qty}]} — goods arrived: stock goes up, recorded in the stock ledger
router.post('/:id/receive', async (req, res) => {
  const po = await PurchaseOrder.findById(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (['Draft', 'Cancelled', 'Received'].includes(po.status)) return res.status(409).json({ error: `Goods can't be received on a ${po.status} order` });
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  for (const l of lines) {
    const item = po.items.id(l.itemId); const qty = parseInt(l.qty, 10);
    if (!item || !(qty >= 1) || qty > item.qty - item.receivedQty) return res.status(400).json({ error: 'Received quantity can’t exceed what is still outstanding on that item' });
  }
  for (const l of lines) {
    const item = po.items.id(l.itemId); const qty = parseInt(l.qty, 10);
    item.receivedQty += qty;
    if (item.product) await adjustStock(item.product, qty, { reason: 'po_received', ref: po.poNumber, actor: req.admin.email, note: item.description });
  }
  po.status = po.items.every((i) => i.receivedQty >= i.qty) ? 'Received' : 'PartiallyReceived';
  await po.save();
  await audit({ action: 'po.received', actor: req.admin.email, entity: 'purchase_order', entityId: po.id, summary: `${po.poNumber}: goods received (${po.status})`, req });
  res.json(po);
});

// PUT /api/admin/purchase-orders/:id/invoice — record the manufacturer's invoice (number, amount, scanned copy)
router.put('/:id/invoice', async (req, res) => {
  const po = await PurchaseOrder.findById(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.invoice.verified) return res.status(409).json({ error: 'This invoice is already verified and locked' });
  const amount = Number(req.body.amount);
  if (!String(req.body.number || '').trim() || !(amount > 0)) return res.status(400).json({ error: 'Enter the invoice number and amount' });
  if (req.body.file) { if (!/^data:(image\/(jpeg|png|webp)|application\/pdf);base64,/.test(req.body.file) || req.body.file.length > MAX_FILE) return res.status(400).json({ error: 'Attach a JPG, PNG or PDF under ~1 MB' }); po.invoice.file = req.body.file; }
  po.invoice.number = String(req.body.number).trim().slice(0, 40); po.invoice.amount = amount; po.invoice.date = req.body.date || new Date();
  await po.save();
  await audit({ action: 'po.invoice_recorded', actor: req.admin.email, entity: 'purchase_order', entityId: po.id, summary: `${po.poNumber}: invoice ${po.invoice.number} ₹${amount} recorded`, req });
  res.json(po);
});
router.get('/:id/invoice-file', async (req, res) => { const po = await PurchaseOrder.findById(req.params.id).select('invoice.file'); res.json({ file: po?.invoice?.file || '' }); });

// POST /api/admin/purchase-orders/:id/invoice/verify — owner confirms the invoice matches what was ordered/received
router.post('/:id/invoice/verify', requireRole('ADMIN'), async (req, res) => {
  const po = await PurchaseOrder.findById(req.params.id);
  if (!po || !po.invoice.number) return res.status(400).json({ error: 'Record the invoice first' });
  po.invoice.verified = true; po.invoice.verifiedBy = req.admin.email; po.invoice.verifiedAt = new Date(); await po.save();
  await audit({ action: 'po.invoice_verified', actor: req.admin.email, entity: 'purchase_order', entityId: po.id, summary: `${po.poNumber}: invoice ${po.invoice.number} verified (₹${po.invoice.amount})`, req });
  res.json(po);
});

// POST /api/admin/purchase-orders/:id/payments — record a payment made to the manufacturer (owner only, verified invoice required)
router.post('/:id/payments', requireRole('ADMIN'), async (req, res) => {
  const po = await PurchaseOrder.findById(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (!po.invoice.verified) return res.status(409).json({ error: 'Verify the manufacturer’s invoice before recording a payment' });
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter the amount paid' });
  if (amount > po.outstanding) return res.status(400).json({ error: `Only ₹${po.outstanding} is outstanding on this order` });
  po.payments.push({ amount, method: String(req.body.method || 'bank_transfer').slice(0, 30), reference: String(req.body.reference || '').slice(0, 80), paidAt: req.body.paidAt || new Date(), note: String(req.body.note || '').slice(0, 200), recordedBy: req.admin.email });
  await po.save();
  await audit({ action: 'po.payment_recorded', actor: req.admin.email, entity: 'purchase_order', entityId: po.id, summary: `${po.poNumber}: paid ₹${amount} to ${po.supplierName} (${po.paymentStatus})`, req });
  res.status(201).json(po);
});
module.exports = router;
