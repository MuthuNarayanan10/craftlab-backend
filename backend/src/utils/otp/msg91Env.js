/** Mobile (SMS) OTP configured purely from environment variables — nothing to set up in the admin.
 *    MSG91_AUTH_KEY      (required)  MSG91 → Settings → API → Auth Key
 *    MSG91_TEMPLATE_ID   (required)  the DLT-approved OTP template id from MSG91 → OTP → Templates
 *  SMS in India is only delivered for DLT-registered senders/templates, so the template must be approved first. */
function msg91FromEnv(env = process.env) {
  const authKey = String(env.MSG91_AUTH_KEY || '').trim(), templateId = String(env.MSG91_TEMPLATE_ID || '').trim();
  if (!authKey || !templateId) return null;
  return { authKey, templateId };
}
module.exports = { msg91FromEnv };
