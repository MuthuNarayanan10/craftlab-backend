const express = require('express');
const { getSettings } = require('../models/Settings');
const { requireRole } = require('../middleware/adminAuth');
const { audit } = require('../models/AuditLog');
const router = express.Router();
const okImage = (v) => typeof v === 'string' && v.length <= 900000 && (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) || /^https:\/\/[^\s"'<>]+$/.test(v) || /^images\/[\w./-]+$/.test(v));
const okLink = (v) => !v || /^https:\/\/[^\s"'<>]+$/.test(v) || /^[\w./?=&#-]+$/.test(v);
router.get('/', async (req, res) => res.json({ slides: (await getSettings()).heroSlides || [] }));
// PUT /api/admin/hero { slides: [{ image, alt, link, enabled }] }  (2 or more = the homepage shows a carousel)
router.put('/', requireRole('ADMIN'), async (req, res) => {
  const list = Array.isArray(req.body.slides) ? req.body.slides : null;
  if (!list || list.length > 8) return res.status(400).json({ error: 'Send between 0 and 8 pictures' });
  const out = [];
  for (const x of list) {
    if (!okImage(x.image)) return res.status(400).json({ error: 'One picture is missing or too large. Use a JPG/PNG/WebP under about 600 KB.' });
    if (!okLink(String(x.link || ''))) return res.status(400).json({ error: 'A picture link must start with https:// or be a page like shop.html' });
    out.push({ image: x.image, alt: String(x.alt || '').slice(0, 140), link: String(x.link || '').slice(0, 300), enabled: x.enabled !== false });
  }
  const s = await getSettings(); s.heroSlides = out; await s.save();
  await audit({ action: 'hero.updated', actor: req.admin.email, entity: 'settings', summary: `Homepage pictures updated (${out.length})`, req });
  res.json({ slides: out });
});
module.exports = router;
