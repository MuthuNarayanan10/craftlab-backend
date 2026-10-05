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

module.exports = { devSender, msg91Sender };
