/** Couriers configured purely from environment variables — nothing to type into the admin, no SECRETS_KEY needed.
 *    SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD, SHIPROCKET_PICKUP_LOCATION   (+ optional SHIPROCKET_WEIGHT_KG / _LENGTH_CM / _BREADTH_CM / _HEIGHT_CM)
 *    DELHIVERY_API_TOKEN, DELHIVERY_PICKUP_LOCATION                      (+ same optional size/weight, DELHIVERY_BASE_URL for staging)
 *    COURIERS_DISABLED=true   → ignores every courier variable (kill switch; the shop falls back to manual dispatch)
 *  An integration saved in Admin → Integrations (and enabled) still takes priority, so nothing already set up breaks. */
const crypto = require('crypto');

const DEFS = {
  shiprocket: { prefix: 'SHIPROCKET', secrets: { email: 'EMAIL', password: 'PASSWORD' }, required: ['EMAIL', 'PASSWORD', 'PICKUP_LOCATION'] },
  delhivery: { prefix: 'DELHIVERY', secrets: { apiToken: 'API_TOKEN' }, required: ['API_TOKEN', 'PICKUP_LOCATION'] },
};
const val = (env, p, k) => String(env[`${p}_${k}`] || '').trim();

function envStatus(id, env = process.env) {
  const d = DEFS[id]; if (!d) return null;
  const missing = d.required.filter((k) => !val(env, d.prefix, k)).map((k) => `${d.prefix}_${k}`);
  const disabled = String(env.COURIERS_DISABLED || '').toLowerCase() === 'true';
  return { configured: !missing.length && !disabled, missing, disabled, vars: d.required.map((k) => `${d.prefix}_${k}`) };
}
/** Deterministic per-provider webhook secret (override with <PREFIX>_WEBHOOK_TOKEN). Derived from a server secret so it survives restarts with no DB row. */
function webhookTokenFor(id, env = process.env) {
  const d = DEFS[id]; if (!d) return '';
  const set = val(env, d.prefix, 'WEBHOOK_TOKEN'); if (set) return set;
  const base = env.SECRETS_KEY || env.JWT_SECRET || ''; if (!base) return '';
  return crypto.createHmac('sha256', base).update(`courier-webhook:${id}`).digest('hex').slice(0, 36);
}
function courierFromEnv(id, env = process.env) {
  const d = DEFS[id]; const s = envStatus(id, env); if (!d || !s || !s.configured) return null;
  const creds = Object.fromEntries(Object.entries(d.secrets).map(([name, k]) => [name, val(env, d.prefix, k)]));
  const cfg = { pickupLocation: val(env, d.prefix, 'PICKUP_LOCATION'), defaultWeightKg: val(env, d.prefix, 'WEIGHT_KG'), defaultLengthCm: val(env, d.prefix, 'LENGTH_CM'), defaultBreadthCm: val(env, d.prefix, 'BREADTH_CM'), defaultHeightCm: val(env, d.prefix, 'HEIGHT_CM'),
    returnAddress: val(env, d.prefix, 'RETURN_ADDRESS'), returnPin: val(env, d.prefix, 'RETURN_PIN'), returnCity: val(env, d.prefix, 'RETURN_CITY'), returnState: val(env, d.prefix, 'RETURN_STATE'), returnPhone: val(env, d.prefix, 'RETURN_PHONE') };
  creds._cfg = cfg;
  return { creds, cfg, webhookToken: webhookTokenFor(id, env) };
}
module.exports = { DEFS, envStatus, courierFromEnv, webhookTokenFor };
