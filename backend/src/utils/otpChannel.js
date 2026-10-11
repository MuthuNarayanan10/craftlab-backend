/** Which identifier does OTP verify — a mobile number (SMS) or an email address?
 *  A store can offer BOTH at once: email codes (Brevo) and mobile codes (MSG91). The customer picks; the server decides what is allowed. */
const { brevoFromEnv } = require('./otp/brevoEnv');
const { msg91FromEnv } = require('./otp/msg91Env');
const EMAIL_PROVIDERS = ['brevo', 'zeptomail'];
const SERVER_PROVIDERS = ['dev', 'msg91', ...EMAIL_PROVIDERS]; // providers whose codes are generated and checked by our server

/** Channels this store can really send on right now, in preference order (email first: it is free). */
function availableChannels(s, env = process.env) {
  const out = [];
  if (EMAIL_PROVIDERS.includes(s.otpProvider) || brevoFromEnv(env) || (s.otpProvider === 'dev' && s.otpChannel === 'email')) out.push('email');
  if (s.otpProvider === 'msg91' || msg91FromEnv(env) || (s.otpProvider === 'dev' && s.otpChannel !== 'email')) out.push('phone');
  if (s.otpProvider === 'firebase') return ['phone']; // Firebase handles its own phone verification
  return out.length ? out : ['phone'];
}
/** The default channel shown first. */
const channelOf = (s, env = process.env) => availableChannels(s, env)[0];
/** The channel to use for ONE request: what the customer asked for, if the store offers it, else the default. */
const pickChannel = (s, requested, env = process.env) => { const a = availableChannels(s, env); const r = requested === 'email' || requested === 'phone' ? requested : ''; return r && a.includes(r) ? r : a[0]; };
module.exports = { channelOf, availableChannels, pickChannel, EMAIL_PROVIDERS, SERVER_PROVIDERS };
