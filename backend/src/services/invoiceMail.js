/** E-mails the GST tax invoice (as an attachment you can open, print or save as PDF) right after payment / COD confirmation. Fire-and-forget. */
const { sendEmail } = require('../utils/email');
const { invoiceHtml } = require('../utils/invoiceHtml');
const { publicInvoiceOrder } = require('../routes/track');
const { logger } = require('../utils/logger');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendInvoiceEmail(order, settings) {
  const to = order.customer?.email; if (!to || !order.invoiceNumber) return { skipped: true };
  const biz = { legalName: settings.legalName || settings.businessName, businessName: settings.businessName, gstin: settings.gstin, pan: settings.pan, address: settings.address, city: settings.city, state: settings.state, pincode: settings.pincode, phone: settings.phone, email: settings.email, hsn: settings.hsnCode || '' };
  const html = invoiceHtml(publicInvoiceOrder(order), biz);
  const first = esc(String(order.customer.name || '').split(' ')[0] || 'there');
  const r = await sendEmail(to, `Your tax invoice ${order.invoiceNumber} — order ${order.orderNumber}`,
    `<div style="font-family:sans-serif;max-width:540px;color:#2A2620"><h2 style="color:#544C35;font-weight:500">Thank you, ${first}!</h2><p>Your GST tax invoice for order <strong>${esc(order.orderNumber)}</strong> is attached. Open it in your browser and use <em>Print → Save as PDF</em> to keep a copy.</p><p style="color:#6c675f;font-size:13px">Invoice ${esc(order.invoiceNumber)} · ₹${order.total}. You can also see it any time under <em>Track your order</em> on our website with your order number.</p></div>`,
    { ...(settings.email ? { replyTo: settings.email } : {}), attachments: [{ name: `Invoice-${order.invoiceNumber}.html`, content: html }] });
  if (r && r.error) logger.warn('invoice_email_failed', { order: order.orderNumber, error: r.error });
  return r;
}
module.exports = { sendInvoiceEmail };
