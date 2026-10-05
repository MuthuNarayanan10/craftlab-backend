const mongoose = require('mongoose');
const { encrypt, decrypt, mask, isConfigured } = require('../utils/crypto');

/** Third-party integration settings (courier, SMS, WhatsApp). Secrets are encrypted at rest (AES-256-GCM) and never sent back to the browser. */
const integrationSchema = new mongoose.Schema({
  provider: { type: String, required: true, unique: true }, // shiprocket | msg91 | whatsapp_cloud
  kind: { type: String, enum: ['courier', 'otp', 'whatsapp'], required: true },
  enabled: { type: Boolean, default: false },
  config: { type: mongoose.Schema.Types.Mixed, default: {} },  // non-secret (pickup location, template name…)
  secretsEnc: { type: String, default: '' },                   // encrypted JSON of secrets
  secretKeys: [{ type: String }],                              // names of stored secrets (for the UI)
  secretHints: { type: mongoose.Schema.Types.Mixed, default: {} }, // masked tails, e.g. {password:'••••1234'}
  webhookToken: { type: String, default: '' },
  lastTest: { at: Date, ok: Boolean, message: String },
  updatedBy: { type: String, default: '' },
}, { timestamps: true });

integrationSchema.methods.getSecrets = function () { return this.secretsEnc ? JSON.parse(decrypt(this.secretsEnc)) : {}; };
integrationSchema.methods.setSecrets = function (incoming) {
  // blank values keep the existing secret; only provided values are replaced
  const merged = { ...this.getSecrets() };
  for (const [k, v] of Object.entries(incoming || {})) if (typeof v === 'string' && v.trim()) merged[k] = v.trim();
  if (!isConfigured()) throw new Error('SECRETS_KEY is not set on the server — API keys cannot be stored until it is.');
  this.secretsEnc = encrypt(JSON.stringify(merged));
  this.secretKeys = Object.keys(merged);
  this.secretHints = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, mask(v)]));
  this.markModified('secretHints');
};
/** Safe shape for the admin UI — never includes secrets. */
integrationSchema.methods.toPublic = function () {
  return { provider: this.provider, kind: this.kind, enabled: this.enabled, config: this.config || {}, secretHints: this.secretHints || {}, hasSecrets: !!this.secretsEnc, webhookToken: this.webhookToken, lastTest: this.lastTest || null, updatedAt: this.updatedAt };
};
module.exports = mongoose.model('Integration', integrationSchema);
