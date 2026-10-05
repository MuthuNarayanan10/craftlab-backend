const mongoose = require('mongoose');

/** Who did what, to which record, and what changed. Append-only. */
const auditLogSchema = new mongoose.Schema({
  action: { type: String, required: true, index: true },   // e.g. order.status_changed, refund.issued, settings.updated
  actor: { type: String, default: 'system' },               // admin email | customer | system | razorpay | courier
  entity: { type: String, default: '' },                    // order | product | customer | return | settings | integration | purchase_order …
  entityId: { type: String, default: '', index: true },
  summary: { type: String, default: '' },                   // human sentence, e.g. "Refunded Order CL-1234 — ₹2,499"
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
}, { timestamps: true });
auditLogSchema.index({ createdAt: -1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

/** Structured audit entry. Never throws — an audit failure must not break the business action. */
async function audit({ action, actor = 'system', entity = '', entityId = '', summary = '', before = null, after = null, meta = {}, req = null }) {
  try {
    await AuditLog.create({ action, actor, entity, entityId: String(entityId || ''), summary, before, after, meta,
      ip: req ? (req.ip || '') : '', userAgent: req ? String(req.header?.('user-agent') || '').slice(0, 200) : '' });
  } catch (e) { console.error('Audit log failed (non-fatal):', e.message); }
}
/** Legacy helper kept for existing call sites: logAction(action, actor, meta). */
const logAction = (action, actor, meta = {}) => audit({ action, actor, meta, summary: action });

module.exports = AuditLog;
module.exports.audit = audit;
module.exports.logAction = logAction;
