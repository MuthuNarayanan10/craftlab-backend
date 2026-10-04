/** Sends transactional email via Resend (resend.com) — free tier available.
 *  Requires RESEND_API_KEY and RESEND_FROM in .env. If not configured, this
 *  silently skips sending rather than crashing checkout/order flows — email
 *  is a nice-to-have, never a blocker for a real order completing. */
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    console.log(`[email skipped — RESEND_API_KEY/RESEND_FROM not set] Would have sent "${subject}" to ${to}`);
    return { skipped: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) console.error('Email send failed:', await res.text());
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

module.exports = { sendEmail, orderConfirmationEmail, orderStatusEmail };
