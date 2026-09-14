const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  action: { type: String, required: true },        // e.g. 'order.status_changed', 'admin.login'
  actor: { type: String, default: 'system' },       // admin email, or 'system' for automated events
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

module.exports = mongoose.model('AuditLog', auditLogSchema);

async function logAction(action, actor, meta = {}) {
  try {
    await mongoose.model('AuditLog').create({ action, actor, meta });
  } catch (e) {
    console.error('Audit log failed (non-fatal):', e.message);
  }
}
module.exports.logAction = logAction;
