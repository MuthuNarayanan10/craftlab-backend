const express = require('express');
const router = express.Router();
const Subscriber = require('../models/Subscriber');
router.get('/', async (req, res) => {
  const subs = await Subscriber.find().sort({ createdAt: -1 }).limit(1000);
  res.json(subs.map(s => ({ id: s.id, email: s.email, createdAt: s.createdAt })));
});
module.exports = router;
