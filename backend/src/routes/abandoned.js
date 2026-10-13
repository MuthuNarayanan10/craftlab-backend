const express = require('express');
const router = express.Router();
const Cart = require('../models/Cart');
const svc = require('../services/abandonedCarts');
const { audit } = require('../models/AuditLog');
const { requireRole } = require('../middleware/adminAuth');

// GET /api/admin/abandoned-carts — carts with items and a way to reach the buyer, idle for 30+ minutes, not converted. Viewing never changes them.
router.get('/', async (req, res) => res.json(await svc.list()));
// POST /api/admin/abandoned-carts/:id/mark-contacted — logs a manual WhatsApp follow-up
router.post('/:id/mark-contacted', async (req, res) => {
  const cart = await Cart.findByIdAndUpdate(req.params.id, { $inc: { recoveryMessagesSent: 1 }, lastRecoveryAt: new Date() }, { new: true });
  if (!cart) return res.status(404).json({ error: 'Cart not found' });
  res.json({ recoveryMessagesSent: cart.recoveryMessagesSent });
});
// POST /api/admin/abandoned-carts/:id/send-email — one reminder email with a "return to my cart" button
router.post('/:id/send-email', async (req, res) => {
  const cart = await Cart.findById(req.params.id); if (!cart) return res.status(404).json({ error: 'Cart not found' });
  const r = await svc.sendReminder(cart, { manual: true });
  if (!r.sent) return res.status(400).json({ error: r.reason });
  await audit({ action: 'cart.reminder_sent', actor: req.admin.email, entity: 'cart', entityId: cart.id, summary: `Cart reminder emailed to ${cart.contact.email}`, req });
  res.json({ sent: true, recoveryMessagesSent: cart.recoveryMessagesSent });
});
// DELETE /api/admin/abandoned-carts/:id — remove a cart from the list
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  const c = await Cart.findByIdAndDelete(req.params.id); if (!c) return res.status(404).json({ error: 'Cart not found' });
  await audit({ action: 'cart.deleted', actor: req.admin.email, entity: 'cart', entityId: c.id, summary: 'Deleted an abandoned cart', req });
  res.json({ deleted: true });
});
module.exports = router;
