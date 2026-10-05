/** NOTIFICATION CENTER — one place decides who is told what, on which channel.
 *  - every send is logged (NotificationLog) with a unique dedupe key, so retries / double webhooks never double-message a customer
 *  - failures are recorded and retried; a failed channel never blocks the order flow
 *  - channels are plug-ins ({ id, send(msg) }); the website "updates" feed is built from the order timeline (no send needed) */

const SITE = () => (process.env.SITE_URL || 'https://thecraftlab.co.in').replace(/\/$/, '');
const first = (o) => String(o.customer?.name || 'there').split(' ')[0];
const track = (o) => `${SITE()}/order-tracking.html?order=${encodeURIComponent(o.orderNumber)}`;
const manual = (o) => o.delivery?.method?.type === 'manual';
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');

const EVENTS = {
  order_placed:      { title: 'Order confirmed',        text: ({ order: o }) => `Hi ${first(o)}, thank you for your Craft Lab order ${o.orderNumber} (${inr(o.total)}).${o.payment?.method === 'cod' ? ' Please keep the amount ready for delivery.' : ''}` },
  payment_confirmed: { title: 'Payment received',       text: ({ order: o }) => `Hi ${first(o)}, we've received your payment of ${inr(o.total)} for order ${o.orderNumber}. We're getting it ready.` },
  order_packed:      { title: 'Order packed',           text: ({ order: o }) => manual(o) ? `Hi ${first(o)}, your order ${o.orderNumber} is packed and ready for our delivery team.` : `Hi ${first(o)}, your order ${o.orderNumber} is packed and waiting for the courier.` },
  order_shipped:     { title: 'Order shipped',          text: ({ order: o }) => manual(o) ? `Hi ${first(o)}, your order ${o.orderNumber} is with our delivery team${o.delivery?.scheduledFor ? ' and is planned for ' + new Date(o.delivery.scheduledFor).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ' and will reach you soon'}.` : `Hi ${first(o)}, your order ${o.orderNumber} has been handed to the courier${o.shipment?.courierName || o.delivery?.partner ? ' (' + (o.shipment?.courierName || o.delivery.partner) + ')' : ''}${o.shipment?.awb || o.delivery?.trackingId ? '. Tracking: ' + (o.shipment?.awb || o.delivery.trackingId) : ''}.` },
  out_for_delivery:  { title: 'Out for delivery',       text: ({ order: o }) => `Hi ${first(o)}, your order ${o.orderNumber} is out for delivery today${manual(o) && o.delivery?.assignee?.name ? ' with ' + o.delivery.assignee.name + (o.delivery.assignee.phone ? ' (' + o.delivery.assignee.phone + ')' : '') : ''}.` },
  delivered:         { title: 'Delivered',              text: ({ order: o }) => `Hi ${first(o)}, your order ${o.orderNumber} has been delivered. We hope you love it! If anything isn't right, reply here or request a return from My account.` },
  order_cancelled:   { title: 'Order cancelled',        text: ({ order: o }) => `Hi ${first(o)}, your order ${o.orderNumber} has been cancelled. Any payment made will be refunded.` },
  return_approved:   { title: 'Return approved',        text: ({ order: o }) => `Hi ${first(o)}, your return for order ${o.orderNumber} is approved. We'll arrange the pickup and update you.` },
  return_pickup:     { title: 'Return pickup scheduled', text: ({ order: o }) => `Hi ${first(o)}, the pickup for your return (order ${o.orderNumber}) is scheduled. Please keep the item packed with its original packaging.` },
  return_rejected:   { title: 'Return update',          text: ({ order: o }) => `Hi ${first(o)}, we couldn't approve the return for order ${o.orderNumber}. Reply here and we'll explain and see how else we can help.` },
  refund_initiated:  { title: 'Refund initiated',       text: ({ order: o, refund: r }) => `Hi ${first(o)}, your refund of ${inr(r?.amount ?? o.total)} for order ${o.orderNumber} has been initiated. It usually reaches you in 5–7 working days.` },
  refund_completed:  { title: 'Refund completed',       text: ({ order: o, refund: r }) => `Hi ${first(o)}, your refund of ${inr(r?.amount ?? o.total)} for order ${o.orderNumber} is complete.` },
};

function buildMessage(eventKey, ctx) {
  const ev = EVENTS[eventKey];
  if (!ev) throw new Error(`Unknown notification event "${eventKey}"`);
  const text = ev.text(ctx), url = track(ctx.order);
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;color:#2A2620">
    <h2 style="color:#544C35;font-weight:500">${ev.title}</h2><p style="line-height:1.6">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>
    <p><a href="${url}" style="display:inline-block;background:#1b1915;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600">Track your order</a></p>
    <p style="color:#6B6255;font-size:13px">Questions? Reply to this email or write to care@thecraftlab.co.in</p></div>`;
  return { title: ev.title, subject: `${ev.title} — ${ctx.order.orderNumber} | The Craft Lab`, text: `${text}\nTrack: ${url}`, html, trackUrl: url };
}

function dedupeKey(eventKey, ctx, channel) {
  return [eventKey, ctx.order.orderNumber, ctx.ret?.id || ctx.ret?._id || '', ctx.refund?.refundId || '', channel].join(':');
}

/** channels: { email, whatsapp } (each optional); logStore: { claim(key, doc), update(id, patch), findFailed(limit) } */
function createNotifier({ logStore, channels, enabled }) {
  async function deliver(log, channel, msg, to) {
    try { await channels[channel].send({ to, subject: msg.subject, html: msg.html, text: msg.text, title: msg.title, order: log.order }); await logStore.update(log.id, { status: 'sent', error: '', $inc: { attempts: 1 } }); return 'sent'; }
    catch (e) {
      if (e && e.skipped) { await logStore.update(log.id, { status: 'skipped', error: String(e.message).slice(0, 300), $inc: { attempts: 1 } }); return 'skipped'; } // channel not set up — nothing to retry, nothing to alarm about
      await logStore.update(log.id, { status: 'failed', error: String(e.message || e).slice(0, 300), $inc: { attempts: 1 } }); return 'failed';
    }
  }
  async function notify(eventKey, ctx) {
    const msg = buildMessage(eventKey, ctx);
    const out = {};
    for (const channel of Object.keys(channels)) {
      if (!enabled(channel)) continue;
      const to = channel === 'email' ? ctx.order.customer.email : ctx.order.customer.phone;
      if (!to) continue;
      const log = await logStore.claim(dedupeKey(eventKey, ctx, channel), { channel, event: eventKey, to, orderNumber: ctx.order.orderNumber, status: 'pending', payload: { subject: msg.subject, html: msg.html, text: msg.text, title: msg.title }, attempts: 0 });
      if (!log) { out[channel] = 'duplicate'; continue; } // already sent for this exact event
      log.order = ctx.order;
      out[channel] = await deliver(log, channel, msg, to);
    }
    return out;
  }
  async function retryFailed(limit = 25) {
    let n = 0;
    for (const log of await logStore.findFailed(limit)) {
      if (!channels[log.channel] || !enabled(log.channel)) continue;
      const r = await deliver({ id: log.id, order: null }, log.channel, log.payload, log.to);
      if (r === 'sent') n++;
    }
    return n;
  }
  return { notify, retryFailed };
}

/* ------------- real channel adapters ------------- */
function emailChannel(sendEmail) { return { id: 'email', async send({ to, subject, html }) { const r = await sendEmail(to, subject, html); if (r?.skipped) throw Object.assign(new Error('Email is not configured (RESEND_API_KEY / RESEND_FROM)'), { skipped: true }); if (r?.error) throw new Error(r.error); } }; }

/** WhatsApp Business Cloud API (Meta) — sends ONE approved template with 3 body variables: {{1}} name, {{2}} order number, {{3}} message.
 *  Requires a Meta business account, a verified WhatsApp number and an approved template — see docs. Not validated against a live account. */
function whatsappCloudChannel({ phoneNumberId, accessToken, templateName, languageCode = 'en', baseUrl = 'https://graph.facebook.com/v19.0', fetchImpl = globalThis.fetch }) {
  return {
    id: 'whatsapp',
    async send({ to, text, order }) {
      const msg = text.replace(/\s*\n+\s*/g, ' ').slice(0, 900);
      const body = { messaging_product: 'whatsapp', to: String(to).replace(/\D/g, ''), type: 'template', template: { name: templateName, language: { code: languageCode }, components: [{ type: 'body', parameters: [
        { type: 'text', text: String(order?.customer?.name || 'there').split(' ')[0] }, { type: 'text', text: String(order?.orderNumber || '') }, { type: 'text', text: msg }] }] } };
      const res = await fetchImpl(`${baseUrl}/${phoneNumberId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: JSON.stringify(body) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(`WhatsApp API: ${j.error?.message || res.status}`); }
    },
  };
}

module.exports = { EVENTS, buildMessage, dedupeKey, createNotifier, emailChannel, whatsappCloudChannel };
