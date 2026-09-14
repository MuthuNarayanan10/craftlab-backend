const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Cart = require('../models/Cart');
const Product = require('../models/Product');

async function populateCart(cart) {
  const populated = await cart.populate('items.product');
  const items = populated.items
    .filter(i => i.product) // drop items whose product was deleted
    .map(i => ({
      product: i.product,
      qty: i.qty,
      lineTotal: i.product.price * i.qty,
    }));
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  return { id: cart.id, cartId: cart.cartId, items, subtotal, status: cart.status };
}

// POST /api/cart — creates a new empty cart, returns its cartId for the frontend to store
router.post('/', async (req, res) => {
  const cartId = crypto.randomBytes(12).toString('hex');
  const cart = await Cart.create({ cartId, items: [] });
  res.status(201).json({ cartId: cart.cartId });
});

// GET /api/cart/:cartId
router.get('/:cartId', async (req, res) => {
  const cart = await Cart.findOne({ cartId: req.params.cartId });
  if (!cart) return res.status(404).json({ error: 'Cart not found' });
  res.json(await populateCart(cart));
});

// POST /api/cart/:cartId/items — add or update quantity of a product
router.post('/:cartId/items', async (req, res) => {
  const { productId, qty } = req.body;
  if (!productId || !qty) return res.status(400).json({ error: 'productId and qty required' });

  const product = await Product.findById(productId);
  if (!product || product.status !== 'active') return res.status(404).json({ error: 'Product not available' });

  let cart = await Cart.findOne({ cartId: req.params.cartId });
  if (!cart) cart = await Cart.create({ cartId: req.params.cartId, items: [] });

  const existing = cart.items.find(i => i.product.toString() === productId);
  if (existing) existing.qty = qty;
  else cart.items.push({ product: productId, qty });

  cart.status = 'active';
  await cart.save();
  res.json(await populateCart(cart));
});

// DELETE /api/cart/:cartId/items/:productId
router.delete('/:cartId/items/:productId', async (req, res) => {
  const cart = await Cart.findOne({ cartId: req.params.cartId });
  if (!cart) return res.status(404).json({ error: 'Cart not found' });
  cart.items = cart.items.filter(i => i.product.toString() !== req.params.productId);
  await cart.save();
  res.json(await populateCart(cart));
});

// PUT /api/cart/:cartId/contact — captures contact info early for abandoned-cart recovery.
// Requires explicit consent to be recorded before it's usable for follow-up messaging.
router.put('/:cartId/contact', async (req, res) => {
  const { name, phone, email, consentToContact } = req.body;
  const cart = await Cart.findOneAndUpdate(
    { cartId: req.params.cartId },
    { contact: { name, phone, email, consentToContact: !!consentToContact } },
    { new: true }
  );
  if (!cart) return res.status(404).json({ error: 'Cart not found' });
  res.json({ saved: true });
});

module.exports = router;
