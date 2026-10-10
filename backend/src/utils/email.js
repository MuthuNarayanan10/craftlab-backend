/** Sends transactional email. Provider order:
 *    1. Brevo   — BREVO_API_KEY + BREVO_SENDER_EMAIL (+ BREVO_SENDER_NAME); the same two variables that power login codes
 *    2. Resend  — RESEND_API_KEY + RESEND_FROM (older option, still supported)
 *  If neither is configured this silently skips rather than crashing checkout — email is never a blocker for an order.
 *  opts.replyTo sets a Reply-To address (used for support alerts so "Reply" goes to the customer). */
const { brevoFromEnv } = require('./otp/brevoEnv');

function isEmailConfigured(env = process.env) {
  return !!(brevoFromEnv(env) || (env.RESEND_API_KEY && env.RESEND_FROM));
}
function emailProviderName(env = process.env) { return brevoFromEnv(env) ? 'Brevo' : (env.RESEND_API_KEY && env.RESEND_FROM) ? 'Resend' : 'none'; }

/** Where "new order" and "new ticket" alerts go: OWNER_ALERT_EMAIL (comma separated) → Settings email → care@thecraftlab.co.in */
function ownerRecipients(settings, env = process.env) {
  const raw = String(env.OWNER_ALERT_EMAIL || settings?.email || 'care@thecraftlab.co.in');
  return raw.split(',').map((x) => x.trim()).filter(Boolean);
}

async function sendViaBrevo(cfg, to, subject, html, opts) {
  const recipients = (Array.isArray(to) ? to : [to]).map((email) => ({ email }));
  const body = { sender: { email: cfg.senderEmail, name: cfg.senderName || 'The Craft Lab' }, to: recipients, subject, htmlContent: html };
  if (opts.replyTo) body.replyTo = { email: opts.replyTo };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const hint = res.status === 401 ? ' — the API key is wrong or deleted' : /sender|not.*valid|domain/i.test(String(j.message)) ? ' — the sender address is not verified in Brevo (Senders, Domains & Dedicated IPs → Senders)' : '';
    console.error('Brevo email failed:', res.status, j.message || '');
    return { error: `Brevo rejected the email: ${j.message || res.status}${hint}` };
  }
  return res.json().catch(() => ({ ok: true }));
}

async function sendEmail(to, subject, html, opts = {}) {
  const brevo = brevoFromEnv();
  if (brevo) {
    try { return await sendViaBrevo(brevo, to, subject, html, opts); }
    catch (err) { console.error('Email send error (non-fatal):', err.message); return { error: err.message }; }
  }
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    console.log(`[email skipped — set BREVO_API_KEY + BREVO_SENDER_EMAIL] Would have sent "${subject}" to ${to}`);
    return { skipped: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: Array.isArray(to) && to.length === 1 ? to[0] : to, subject, html, ...(opts.replyTo ? { reply_to: opts.replyTo } : {}) }),
    });
    if (!res.ok) { // surface provider rejections (bad key, unverified domain, …) so callers — and the notification log — never record a failed email as sent
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      console.error('Email send failed:', res.status, detail);
      return { error: `Email provider returned ${res.status}: ${detail}` };
    }
    return res.json();
  } catch (err) {
    console.error('Email send error (non-fatal):', err.message);
    return { error: err.message };
  }
}

function orderConfirmationEmail(order, suggestedProducts = []) {
  const suggestionsHtml = suggestedProducts.length ? `
    <div style="margin-top:24px;padding-top:20px;border-top:1px solid #eee;">
      <p style="font-size:13px;color:#6B6255;margin-bottom:12px;">You might also like</p>
      <div style="display:flex;gap:12px;">
        ${suggestedProducts.map(p => `
          <a href="https://thecraftlab.co.in/product.html?slug=${p.slug}" style="text-decoration:none;color:#2A2620;flex:1;">
            <img src="${p.images?.[0] ? 'https://thecraftlab.co.in/' + p.images[0] : ''}" style="width:100%;border-radius:4px;margin-bottom:6px;">
            <p style="font-size:12px;">${p.name}</p>
            <p style="font-size:12px;font-weight:700;">₹${p.price}</p>
          </a>
        `).join('')}
      </div>
    </div>` : '';

  return {
    subject: `Order Confirmed — ${order.orderNumber} | The Craft Lab`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#2A2620;">
        <h2 style="color:#544C35;">Thank you, ${order.customer.name.split(' ')[0]}!</h2>
        <p>Your order <strong>${order.orderNumber}</strong> is confirmed.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          ${order.items.map(i => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">${i.name} × ${i.qty}</td><td style="text-align:right;">₹${i.price * i.qty}</td></tr>`).join('')}
        </table>
        <p><strong>Total: ₹${order.total}</strong></p>
        <p style="color:#6B6255;font-size:13px;margin-top:20px;">Estimated delivery: 5–7 business days. Track anytime at thecraftlab.co.in/order-tracking.html</p>
        <p style="color:#6B6255;font-size:13px;">Questions? Reply to this email or reach care@thecraftlab.co.in</p>
        ${suggestionsHtml}
      </div>`
  };
}

function orderStatusEmail(order) {
  return {
    subject: `Order Update — ${order.orderNumber} is now ${order.orderStatus} | The Craft Lab`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#2A2620;">
        <h2 style="color:#544C35;">Your order is ${order.orderStatus}</h2>
        <p>Order <strong>${order.orderNumber}</strong> status has been updated to <strong>${order.orderStatus}</strong>.</p>
        ${order.delivery?.trackingId ? `<p>Tracking ID: <strong>${order.delivery.trackingId}</strong> (${order.delivery.partner || ''})</p>` : ''}
        <p style="color:#6B6255;font-size:13px;margin-top:20px;">Track anytime at thecraftlab.co.in/order-tracking.html</p>
      </div>`
  };
}


function quotationRequestEmail(quotation, supplier, settings) {
  const rows = quotation.items.map(i => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">${i.description}</td><td style="text-align:center;">${i.qty}</td><td style="text-align:right;">₹${i.unitPrice}</td></tr>`).join('');
  return {
    subject: `Quotation request ${quotation.quotationNumber} — ${settings.businessName || 'The Craft Lab'}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#2A2620;">
        <p>Hello ${supplier.contactPerson || supplier.name},</p>
        <p>${settings.businessName || 'The Craft Lab'} would like to request a quotation (ref <strong>${quotation.quotationNumber}</strong>) for the following:</p>
        <table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;">
          <tr style="border-bottom:1px solid #999;"><th style="text-align:left;">Item</th><th>Qty</th><th style="text-align:right;">Our reference price</th></tr>
          ${rows}
        </table>
        ${quotation.notes ? `<p><strong>Notes:</strong> ${quotation.notes}</p>` : ''}
        <p>Please reply with your best price, lead time and GST details.</p>
        <p style="color:#6B6255;font-size:13px;margin-top:18px;">${settings.businessName || 'The Craft Lab'}${settings.gstin ? ` · GSTIN ${settings.gstin}` : ''}<br>${settings.email || ''} ${settings.phone ? '· ' + settings.phone : ''}</p>
      </div>`
  };
}

function newOrderAlertEmail(order) {
  const cod = order.payment?.method === 'cod';
  return {
    subject: `New ${cod ? 'COD ' : ''}order ${order.orderNumber} — ₹${order.total}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#2A2620;">
        <h2 style="color:#544C35;">New order ${order.orderNumber}</h2>
        <p><strong>${cod ? 'Cash on Delivery — collect ₹' + order.total + ' on delivery' : 'Paid online — ₹' + order.total}</strong></p>
        <p>${order.customer.name} · ${order.customer.phone} · ${order.customer.email}</p>
        <p>${order.address.line1}${order.address.line2 ? ', ' + order.address.line2 : ''}, ${order.address.city}, ${order.address.state} ${order.address.pincode}</p>
        <table style="width:100%;border-collapse:collapse;margin:12px 0;">${order.items.map(i => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">${i.name} × ${i.qty}</td><td style="text-align:right;">₹${i.price * i.qty}</td></tr>`).join('')}</table>
        ${order.giftMessage ? `<p><strong>Gift message:</strong> ${order.giftMessage}</p>` : ''}
        <p style="color:#6B6255;font-size:13px;">Open the admin dashboard → Orders to pack, print the label and add tracking.</p>
      </div>`
  };
}

module.exports = { isEmailConfigured, emailProviderName, ownerRecipients, newOrderAlertEmail, quotationRequestEmail, sendEmail, orderConfirmationEmail, orderStatusEmail };
