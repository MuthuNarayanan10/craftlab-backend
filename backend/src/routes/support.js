const express = require('express');
const router = express.Router();
const SupportTicket = require('../models/SupportTicket');
const Order = require('../models/Order');
const { getSettings } = require('../models/Settings');
const { getNextSequence } = require('../models/Counter');
const { createNotification } = require('../models/Notification');
const { optionalCustomer, requireCustomer } = require('../middleware/customerAuth');
const { sendEmail, ownerRecipients } = require('../utils/email');
const Product = require('../models/Product');
const QUERY_TYPES = ['Product question', 'Order status', 'Shipping & delivery', 'Return / exchange / refund', 'Payment', 'Custom or bulk order', 'Other'];
const { ownedOrdersFilter } = require('../utils/ownership');
const { audit } = require('../models/AuditLog');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (s, n) => String(s || '').trim().slice(0, n);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const customerView = (t) => ({ id: t.id, ticketNumber: t.ticketNumber, subject: t.subject, queryType: t.queryType, category: t.category, subcategory: t.subcategory, productName: t.productName, status: t.status, orderNumber: t.orderNumber, createdAt: t.createdAt, updatedAt: t.updatedAt, messages: t.messages.filter((m) => m.from !== 'note').map((m) => ({ from: m.from, text: m.text, at: m.at })) });
const mailTo = (to, subject, html, opts) => sendEmail(to, subject, html, opts).catch(() => {});

// POST /api/support — a logged-in customer's details are filled in from their account (the browser can't override them)
router.post('/', optionalCustomer, async (req, res) => {
  const c = req.customer, b = req.body;
  const name = clean(c ? (c.name && c.name !== 'Craft Lab Customer' ? c.name : b.name) : b.name, 80);
  const phone = clean(c?.phone || b.phone, 20).replace(/[^\d+]/g, ''), email = clean(c?.email || b.email, 120).toLowerCase();
  const subject = clean(b.subject, 140), message = clean(b.message, 4000), orderNumber = clean(b.orderNumber, 24).toUpperCase().replace(/^#/, '');
  if (!name) return res.status(400).json({ error: 'Please enter your name' });
  if (!email && !phone) return res.status(400).json({ error: 'Please give us an email or a mobile number so we can reply' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (phone && phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please enter a valid mobile number' });
  const queryType = QUERY_TYPES.includes(b.queryType) ? b.queryType : '';
  let category = clean(b.category, 80), subcategory = clean(b.subcategory, 80), productName = '', productSku = '';
  const slug = clean(b.productSlug, 120);
  if (slug) { const p = await Product.findOne({ slug }).select('name sku category subcategory').lean().catch(() => null); if (p) { productName = p.name; productSku = p.sku || ''; category = p.category || category; subcategory = p.subcategory || subcategory; } }
  if (!category) subcategory = '';
  if (subject.length < 3) return res.status(400).json({ error: 'Please add a subject' });
  if (message.length < 5) return res.status(400).json({ error: 'Please tell us a little more in your message' });

  const ticket = await SupportTicket.create({ ticketNumber: `TKT-${await getNextSequence('ticket')}`, customerId: c ? c.id : null, name, phone, email, orderNumber, subject, queryType, category, subcategory, productName, productSku, status: 'New', messages: [{ from: 'customer', text: message, by: name }] });
  await createNotification('support_request', `New support request ${ticket.ticketNumber} from ${name}: ${subject}`, { ticketNumber: ticket.ticketNumber });
  const settings = await getSettings();
  const topic = [queryType, category && (category + (subcategory ? ' › ' + subcategory : '')), productName].filter(Boolean).map(esc).join(' · ');
  const to = ownerRecipients(settings);
  if (to.length) mailTo(to, `New support request ${ticket.ticketNumber} — ${subject}`, `<div style="font-family:sans-serif"><h3>${esc(ticket.ticketNumber)} — ${esc(subject)}</h3><p><strong>${esc(name)}</strong> · ${esc(phone)} · ${esc(email)}${orderNumber ? ' · order ' + esc(orderNumber) : ''}</p>${topic ? `<p style="color:#8C593C"><strong>Topic:</strong> ${topic}</p>` : ''}<p style="white-space:pre-wrap">${esc(message)}</p><p>Reply from Admin → Support, or just reply to this email to write to the customer.</p></div>`, email ? { replyTo: email } : {});
  if (email) mailTo(email, `We’ve received your request ${ticket.ticketNumber}`, `<div style="font-family:sans-serif;max-width:520px"><h3 style="color:#544C35">Thank you, ${esc(name.split(' ')[0])}</h3><p>We’ve received your message and will reply within one working day (${esc(settings.supportHours)}).</p><p><strong>Your reference:</strong> ${esc(ticket.ticketNumber)}<br><strong>Subject:</strong> ${esc(subject)}</p></div>`);
  res.status(201).json({ ticketNumber: ticket.ticketNumber, id: ticket.id });
});

// GET /api/support/mine — the logged-in customer's tickets
router.get('/mine', requireCustomer, async (req, res) => {
  const or = [{ customerId: req.customer.id }, ...(req.customer.emailVerified && req.customer.email ? [{ email: req.customer.email, customerId: null }] : [])];
  res.json((await SupportTicket.find({ $or: or }).sort({ updatedAt: -1 }).limit(50)).map(customerView));
});
// POST /api/support/mine/:id/reply {message}
router.post('/mine/:id/reply', requireCustomer, async (req, res) => {
  const t = await SupportTicket.findOne({ _id: req.params.id, customerId: req.customer.id });
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const text = clean(req.body.message, 4000); if (text.length < 2) return res.status(400).json({ error: 'Write your reply first' });
  t.messages.push({ from: 'customer', text, by: t.name }); t.lastCustomerMessageAt = new Date();
  if (['WaitingCustomer', 'Resolved', 'Closed'].includes(t.status)) t.status = 'Open';
  await t.save(); await createNotification('support_request', `Customer replied on ${t.ticketNumber}`, { ticketNumber: t.ticketNumber });
  res.json(customerView(t));
});
router.get('/query-types', (req, res) => res.json({ queryTypes: QUERY_TYPES }));
module.exports = router;
