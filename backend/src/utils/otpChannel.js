/** Which identifier does OTP verify — a mobile number (SMS) or an email address? Decided by the chosen provider. */
const EMAIL_PROVIDERS = ['brevo', 'zeptomail'];
const SERVER_PROVIDERS = ['dev', 'msg91', ...EMAIL_PROVIDERS]; // providers whose codes are generated and checked by our server
const channelOf = (s) => (EMAIL_PROVIDERS.includes(s.otpProvider) || (s.otpProvider === 'dev' && s.otpChannel === 'email') ? 'email' : 'phone');
module.exports = { channelOf, EMAIL_PROVIDERS, SERVER_PROVIDERS };
