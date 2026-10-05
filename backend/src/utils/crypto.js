/** Encrypts integration secrets (courier / SMS / WhatsApp API keys) before they are stored in the database.
 *  AES-256-GCM with a key derived from SECRETS_KEY (set on the server, never in the database or frontend). */
const crypto = require('crypto');

function key() {
  const raw = process.env.SECRETS_KEY;
  if (!raw || raw.length < 16) return null;
  return crypto.scryptSync(raw, 'craftlab-secrets-v1', 32);
}
const isConfigured = () => !!key();

function encrypt(plain) {
  const k = key();
  if (!k) throw new Error('SECRETS_KEY is not set on the server — it is required to store API keys securely.');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(blob) {
  const k = key();
  if (!k) throw new Error('SECRETS_KEY is not set on the server.');
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/** "••••1234" — what the admin UI is allowed to see of a stored secret. */
const mask = (s) => (!s ? '' : '••••' + String(s).slice(-4));

module.exports = { encrypt, decrypt, mask, isConfigured };
