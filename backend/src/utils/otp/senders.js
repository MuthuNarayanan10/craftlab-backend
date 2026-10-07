/** SMS senders for the OTP service. Each: { id, send(phone, code) } — throws on failure. */

/** Development only: prints the code to the server log instead of sending an SMS. Refused in production. */
function devSender({ isProduction = process.env.NODE_ENV === 'production', allow = process.env.ALLOW_DEV_OTP === 'true' } = {}) {
  return {
    id: 'dev',
    async send(phone, code) {
      if (isProduction && !allow) throw new Error('The dev OTP provider is disabled in production. Configure a real SMS provider.');
      console.log(`[DEV OTP] ${phone} → ${code}`);
    },
  };
}

/** MSG91 "Send OTP" (India, DLT-compliant). Needs an MSG91 account, an approved DLT template and its template id.
 *  Written against MSG91's public API docs — validate with your own account before relying on it. */
function msg91Sender({ authKey, templateId, baseUrl = 'https://control.msg91.com', fetchImpl = globalThis.fetch }) {
  if (!authKey || !templateId) throw new Error('MSG91 needs an auth key and a template id');
  return {
    id: 'msg91',
    async send(phone, code) {
      const mobile = phone.replace(/\D/g, ''); // 91XXXXXXXXXX
      const url = `${baseUrl}/api/v5/otp?template_id=${encodeURIComponent(templateId)}&mobile=${mobile}&authkey=${encodeURIComponent(authKey)}&otp=${encodeURIComponent(code)}`;
      const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.type === 'error') throw new Error(`MSG91 rejected the request: ${body.message || res.status}`);
    },
  };
}

const otpEmail = (code, brand) => ({
  subject: `${code} is your ${brand} login code`,
  html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:420px;margin:0 auto;color:#2A2620"><h2 style="color:#544C35;font-weight:500">Your login code</h2>
    <p style="font-size:34px;letter-spacing:10px;font-weight:700;margin:18px 0">${code}</p>
    <p style="color:#6B6255;font-size:14px;line-height:1.5">Enter this code to log in to ${brand}. It is valid for 5 minutes and can be used once. If you didn’t ask for it, you can ignore this email — nobody can log in without it.</p></div>`,
});

/** Brevo transactional email (free plan: 300 emails/day). Written from Brevo's public API docs — validate with your own account.
 *  Needs an API key and a VERIFIED sender address (Brevo → Senders & IP). */
function brevoSender({ apiKey, senderEmail, senderName = 'The Craft Lab', baseUrl = 'https://api.brevo.com', fetchImpl = globalThis.fetch }) {
  if (!apiKey || !senderEmail) throw new Error('Brevo needs an API key and a verified sender email');
  return {
    id: 'brevo',
    async send(email, code) {
      const m = otpEmail(code, senderName);
      const res = await fetchImpl(`${baseUrl}/v3/smtp/email`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': apiKey }, body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email }], subject: m.subject, htmlContent: m.html }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(`Brevo rejected the email: ${j.message || res.status}`); }
    },
  };
}

/** Zoho ZeptoMail (first 10,000 emails free, then pay-as-you-go). Written from ZeptoMail's public API docs — validate with your own account.
 *  `region`: "in" (India data centre), "com" (US) or "eu" — it must match the account where you created the Mail Agent. */
function zeptomailSender({ sendMailToken, senderEmail, senderName = 'The Craft Lab', region = 'in', baseUrl, fetchImpl = globalThis.fetch }) {
  if (!sendMailToken || !senderEmail) throw new Error('ZeptoMail needs a Send Mail token and a verified sender email');
  const base = baseUrl || `https://api.zeptomail.${['in', 'com', 'eu'].includes(region) ? region : 'in'}`;
  const token = /^Zoho-enczapikey /i.test(sendMailToken) ? sendMailToken : `Zoho-enczapikey ${sendMailToken}`;
  return {
    id: 'zeptomail',
    async send(email, code) {
      const m = otpEmail(code, senderName);
      const res = await fetchImpl(`${base}/v1.1/email`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: token }, body: JSON.stringify({ from: { address: senderEmail, name: senderName }, to: [{ email_address: { address: email } }], subject: m.subject, htmlbody: m.html }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(`ZeptoMail rejected the email: ${j.error?.message || j.message || res.status}`); }
    },
  };
}

module.exports = { devSender, msg91Sender, brevoSender, zeptomailSender, otpEmail };
