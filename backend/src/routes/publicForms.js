const express = require('express');
const router = express.Router();
const Subscriber = require('../models/Subscriber');
const { createNotification } = require('../models/Notification');
const { getSettings } = require('../models/Settings');
const { sendEmail } = require('../utils/email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// POST /api/subscribers — newsletter signup
router.post('/subscribers', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  await Subscriber.updateOne({ email }, { $setOnInsert: { email } }, { upsert: true });
  res.status(201).json({ subscribed: true });
});

// POST /api/contact — contact form: stored as an admin notification and emailed to support
router.post('/contact', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim();
  const message = String(req.body.message || '').trim().slice(0, 2000);
  const orderNumber = String(req.body.orderNumber || '').trim().slice(0, 20);
  if (!name || !EMAIL_RE.test(email) || message.length < 5) {
    return res.status(400).json({ error: 'Please enter your name, a valid email and a message' });
  }
  await createNotification('contact_message',
    `Message from ${name} (${email})${orderNumber ? ` re ${orderNumber}` : ''}: ${message.slice(0, 260)}`,
    { name, email, orderNumber, message });
  const settings = await getSettings();
  if (settings.email) {
    sendEmail(settings.email, `Website enquiry from ${name}`,
      `<p><strong>${esc(name)}</strong> &lt;${esc(email)}&gt;${orderNumber ? ` — order ${esc(orderNumber)}` : ''}</p><p>${esc(message).replace(/\n/g, '<br>')}</p>`);
  }
  res.status(201).json({ received: true });
});

module.exports = router;
