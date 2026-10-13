const express = require('express');
const crypto = require('crypto');
const { getSettings } = require('../models/Settings');
const router = express.Router();
const ver = (img) => crypto.createHash('sha1').update(String(img)).digest('hex').slice(0, 10);
const live = (s) => (s.heroSlides || []).filter((x) => x.enabled !== false && x.image);
// GET /api/hero — homepage hero pictures chosen in Admin → Homepage. Pictures are served as real image files (cached for a year, keyed by version),
// so the page itself stays tiny. Empty list = the page keeps its built-in picture.
router.get('/', async (req, res) => {
  const s = await getSettings(); res.set('Cache-Control', 'public, max-age=60');
  res.json({ slides: live(s).map((x, i) => ({ image: /^data:/.test(x.image) ? `/api/hero/img/${i}?v=${ver(x.image)}` : x.image, alt: x.alt || '', link: x.link || '' })) });
});
router.get('/img/:i', async (req, res) => {
  const x = live(await getSettings())[parseInt(req.params.i, 10)]; const m = x && /^data:(image\/[a-z+.-]+);base64,(.+)$/s.exec(x.image);
  if (!m) return res.status(404).end();
  res.set({ 'Content-Type': m[1], 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  res.send(Buffer.from(m[2], 'base64'));
});
module.exports = router;
