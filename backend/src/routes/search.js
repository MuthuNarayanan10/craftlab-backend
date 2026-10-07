const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const card = (p) => ({ id: p.id, name: p.name, slug: p.slug, sku: p.sku, price: p.price, mrp: p.mrp, category: p.category, images: (p.images || []).slice(0, 2), available: Math.max(0, p.stock - (p.reserved || 0)), shortDescription: p.shortDescription });
const discount = (p) => (p.mrp > p.price ? (p.mrp - p.price) / p.mrp : 0);

/** Every word must appear in the name, SKU, category, tags or short description. */
function filterFor(q) {
  const tokens = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  const f = { status: 'active' };
  if (tokens.length) f.$and = tokens.map((t) => ({ $or: ['name', 'sku', 'category', 'tags', 'shortDescription'].map((k) => ({ [k]: new RegExp(rx(t), 'i') })) }));
  return { f, tokens };
}
function score(p, tokens, q) {
  const name = p.name.toLowerCase(), sku = String(p.sku || '').toLowerCase(), cat = String(p.category || '').toLowerCase(); let s = 0;
  if (sku === q.toLowerCase()) s += 10; if (name === q.toLowerCase()) s += 8; if (name.startsWith(q.toLowerCase())) s += 5;
  for (const t of tokens) { if (name.startsWith(t)) s += 3; else if (name.includes(t)) s += 2; if (sku.includes(t)) s += 2; if (cat.includes(t)) s += 1; }
  return s;
}

// GET /api/search/suggest?q= — as-you-type suggestions (name, SKU, category) with image and price
router.get('/suggest', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  res.set('Cache-Control', 'public, max-age=20');
  if (q.length < 2) return res.json({ products: [], categories: [] });
  const { f, tokens } = filterFor(q);
  const found = await Product.find(f).limit(40);
  const products = found.map((p) => ({ p, s: score(p, tokens, q) })).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => card(x.p));
  const cats = {}; for (const p of found) if (p.category && p.category.toLowerCase().includes(q.toLowerCase())) cats[p.category] = (cats[p.category] || 0) + 1;
  res.json({ products, categories: Object.entries(cats).map(([name, count]) => ({ name, count })).slice(0, 4) });
});

// GET /api/search?q=&category=&minPrice=&maxPrice=&inStock=1&sort=relevance|price-low|price-high|newest|discount&page=&limit=
router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const { f, tokens } = filterFor(q);
  const all = await Product.find(f).limit(300);
  const facets = { categories: Object.entries(all.reduce((m, p) => ((m[p.category] = (m[p.category] || 0) + 1), m), {})).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), minPrice: all.length ? Math.min(...all.map((p) => p.price)) : 0, maxPrice: all.length ? Math.max(...all.map((p) => p.price)) : 0 };
  let list = all;
  if (req.query.category) list = list.filter((p) => p.category === String(req.query.category));
  const min = Number(req.query.minPrice), max = Number(req.query.maxPrice);
  if (Number.isFinite(min) && min > 0) list = list.filter((p) => p.price >= min); if (Number.isFinite(max) && max > 0) list = list.filter((p) => p.price <= max);
  if (req.query.inStock === '1') list = list.filter((p) => p.stock - (p.reserved || 0) > 0);
  const sort = String(req.query.sort || 'relevance');
  const by = { 'price-low': (a, b) => a.price - b.price, 'price-high': (a, b) => b.price - a.price, newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt), discount: (a, b) => discount(b) - discount(a) }[sort];
  list = by ? [...list].sort(by) : [...list].sort((a, b) => (q ? score(b, tokens, q) - score(a, tokens, q) : 0) || new Date(b.createdAt) - new Date(a.createdAt));
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(48, Math.max(1, parseInt(req.query.limit) || 12));
  res.set('Cache-Control', 'public, max-age=20');
  res.json({ query: q, total: list.length, page, pages: Math.ceil(list.length / limit) || 1, products: list.slice((page - 1) * limit, page * limit).map(card), facets });
});
module.exports = router;
