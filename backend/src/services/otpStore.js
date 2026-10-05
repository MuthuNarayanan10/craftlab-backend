const OtpRequest = require('../models/OtpRequest');
const wrap = (d) => d && { id: d.id, phone: d.phone, codeHash: d.codeHash, expiresAt: d.expiresAt, attempts: d.attempts, createdAt: d.createdAt, consumed: d.consumed };
module.exports = {
  latest: async (phone) => wrap(await OtpRequest.findOne({ phone }).sort({ createdAt: -1 })),
  latestActive: async (phone) => wrap(await OtpRequest.findOne({ phone, consumed: false }).sort({ createdAt: -1 })),
  countRecent: ({ phone, ip, since }) => OtpRequest.countDocuments({ ...(phone ? { phone } : { ip }), createdAt: { $gte: since } }),
  create: async (d) => wrap(await OtpRequest.create(d)),
  incrementAttempts: async (id) => (await OtpRequest.findByIdAndUpdate(id, { $inc: { attempts: 1 } }, { new: true })).attempts,
  consume: (id) => OtpRequest.findByIdAndUpdate(id, { consumed: true }),
  invalidate: (phone) => OtpRequest.updateMany({ phone, consumed: false }, { consumed: true }),
};
