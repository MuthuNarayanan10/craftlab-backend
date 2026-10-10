const express = require('express');
const router = express.Router();
const { publicTree } = require('../services/categories');
// GET /api/categories — categories (and their sub-categories) that have live products
router.get('/', async (req, res) => { res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120'); res.json({ categories: await publicTree() }); });
module.exports = router;
