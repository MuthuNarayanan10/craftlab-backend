/** Email OTP configured purely from environment variables — nothing to set up in the admin.
 *    BREVO_API_KEY       (required)  the API key from Brevo → SMTP & API → API keys
 *    BREVO_SENDER_EMAIL  (required)  the sender address (your Brevo sign-up email works straight away)
 *    BREVO_SENDER_NAME   (optional)  defaults to the business name
 */
function brevoFromEnv(env = process.env) {
  const apiKey = String(env.BREVO_API_KEY || '').trim(), senderEmail = String(env.BREVO_SENDER_EMAIL || '').trim();
  if (!apiKey || !senderEmail) return null;
  return { apiKey, senderEmail, senderName: String(env.BREVO_SENDER_NAME || '').trim() || undefined };
}
module.exports = { brevoFromEnv };
