const express = require('express');
const router = express.Router();
const Cart = require('../models/Cart');

// GET /api/admin/abandoned-carts — carts with contact info, inactive for 30+ minutes, not converted
router.get('/', async (req, res) => {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const carts = await Cart.find({
    status: 'active',
    'contact.consentToContact': true,
    updatedAt: { $lt: cutoff },
    'items.0': { $exists: true }, // has at least one item
  })
    .populate('items.product')
    .sort({ updatedAt: -1 });

  // Mark them as abandoned now that they've been surfaced (idempotent to re-run)
  await Cart.updateMany({ _id: { $in: carts.map(c => c._id) } }, { status: 'abandoned' });

  res.json(carts.map(c => {
    const items = c.items.filter(i => i.product).map(i => ({ name: i.product.name, qty: i.qty, price: i.product.price }));
    const value = items.reduce((s, i) => s + i.price * i.qty, 0);
    const firstName = (c.contact.name || '').split(' ')[0] || 'there';
    const itemList = items.map(i => i.name).join(', ');

    // Dynamic, rule-based message templating — escalates gently with each
    // follow-up. Not a live AI/LLM call (see the note on the admin page).
    let suggestedMessage;
    if (c.recoveryMessagesSent === 0) {
      suggestedMessage = `Hi ${firstName}! We noticed you left ${itemList} in your Craft Lab cart. Still thinking it over? Happy to answer any questions — just reply here.`;
    } else if (c.recoveryMessagesSent === 1) {
      suggestedMessage = `Hi ${firstName}, your ${itemList} is still saved for you. Complete your order in the next 24 hours and use code COMEBACK5 for 5% off.`;
    } else {
      suggestedMessage = `Hi ${firstName}, last call on your Craft Lab cart (${itemList}) — use code COMEBACK10 for 10% off if you complete it today.`;
    }

    return {
      id: c.id,
      contact: c.contact,
      items,
      value,
      updatedAt: c.updatedAt,
      recoveryMessagesSent: c.recoveryMessagesSent,
      suggestedMessage,
    };
  }));
});

// POST /api/admin/abandoned-carts/:id/mark-contacted — logs a manual WhatsApp/email follow-up
router.post('/:id/mark-contacted', async (req, res) => {
  const cart = await Cart.findByIdAndUpdate(
    req.params.id,
    { $inc: { recoveryMessagesSent: 1 }, lastRecoveryAt: new Date() },
    { new: true }
  );
  if (!cart) return res.status(404).json({ error: 'Cart not found' });
  res.json({ recoveryMessagesSent: cart.recoveryMessagesSent });
});

module.exports = router;
