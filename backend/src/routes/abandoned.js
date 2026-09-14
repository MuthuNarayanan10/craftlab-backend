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

  res.json(carts.map(c => ({
    id: c.id,
    contact: c.contact,
    items: c.items.filter(i => i.product).map(i => ({ name: i.product.name, qty: i.qty, price: i.product.price })),
    updatedAt: c.updatedAt,
    recoveryMessagesSent: c.recoveryMessagesSent,
  })));
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
