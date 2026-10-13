const express = require('express');
const crypto = require('crypto');
const { ingestReply } = require('../services/inboundMail');
const router = express.Router();
const token = () => process.env.INBOUND_MAIL_TOKEN || (process.env.JWT_SECRET ? crypto.createHmac('sha256', process.env.JWT_SECRET).update('inbound-mail').digest('hex').slice(0, 32) : '');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
router.inboundToken = token;
// POST /api/webhooks/inbound-mail?token=…   Brevo "Inbound parsing" webhook ({items:[{From:{Address},Subject,RawTextBody,MessageId}]}) or a simple {from,subject,text}
router.post('/inbound-mail', async (req, res) => {
  if (!same(req.query.token || req.header('x-webhook-token') || '', token())) return res.status(401).json({ error: 'Unauthorized' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body || {}];
  const results = [];
  for (const m of items.slice(0, 20)) {
    const from = m.From?.Address || m.from?.address || (typeof m.from === 'string' ? m.from : '') || m.sender || '';
    const text = m.ExtractedMarkdownMessage || m.RawTextBody || m.text || m.body || '';
    results.push(await ingestReply({ from, name: m.From?.Name || '', subject: m.Subject || m.subject || '', text, messageId: m.MessageId || m['message-id'] || m.messageId || '' }).catch((e) => ({ error: e.message })));
  }
  res.json({ ok: true, results });
});
module.exports = router;
