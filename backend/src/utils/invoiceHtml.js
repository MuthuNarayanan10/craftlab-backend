/** GST tax invoice as a complete, print-ready HTML page (A4). One builder serves the website (shown in a pop-up, printed or saved as PDF),
 *  the e-mail attachment, and the "how does an order ID look?" sample. Prices are GST-inclusive; tax is split out at order level. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SITE = () => (process.env.SITE_URL || 'https://thecraftlab.co.in').replace(/\/$/, '');

/** 1234.5 → "One Thousand Two Hundred Thirty Four Rupees and Fifty Paise Only" (Indian numbering). */
function amountInWords(n) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x) => (x < 20 ? ones[x] : tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : ''));
  const three = (x) => (x >= 100 ? ones[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' + two(x % 100) : '') : two(x));
  const whole = (x) => { if (x === 0) return 'Zero'; const parts = []; const cr = Math.floor(x / 1e7), lk = Math.floor((x % 1e7) / 1e5), th = Math.floor((x % 1e5) / 1e3), rest = x % 1e3;
    if (cr) parts.push(three(cr) + ' Crore'); if (lk) parts.push(two(lk) + ' Lakh'); if (th) parts.push(two(th) + ' Thousand'); if (rest) parts.push(three(rest)); return parts.join(' '); };
  const v = Math.round(Number(n || 0) * 100), r = Math.floor(v / 100), p = v % 100;
  return `${whole(r)} Rupees${p ? ' and ' + two(p) + ' Paise' : ''} Only`;
}

/** @param order  plain order object (see routes/track.js)  @param biz  { legalName, businessName, gstin, pan, address, city, state, pincode, email, phone, hsn }
 *  @param opts   { highlightOrderId: true } draws the "this is your Order ID" marker (used by the sample) */
function invoiceHtml(order, biz = {}, opts = {}) {
  const o = order, a = o.address || {}, rate = Number(o.taxRate || 0), tax = Number(o.taxAmount || 0);
  const sameState = biz.state && a.state && String(biz.state).trim().toLowerCase() === String(a.state).trim().toLowerCase();
  const taxable = Number(o.total || 0) - tax;
  const taxRows = rate <= 0 ? '' : sameState
    ? `<tr><td>CGST @ ${rate / 2}%</td><td>${money(tax / 2)}</td></tr><tr><td>SGST @ ${rate / 2}%</td><td>${money(tax / 2)}</td></tr>`
    : `<tr><td>IGST @ ${rate}%</td><td>${money(tax)}</td></tr>`;
  const method = o.payment?.method === 'cod' ? 'Cash on Delivery' : o.payment?.method === 'wallet' ? 'Rewards / gift card' : 'Paid online (Razorpay)';
  const sellerAddr = [biz.address, biz.city, biz.state, biz.pincode].filter(Boolean).join(', ');
  const date = new Date(o.createdAt || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const mark = (inner) => (opts.highlightOrderId ? `<span class="mark">${inner}<i class="pin">↑ This is your <b>Order ID</b></i></span>` : inner);
  const rows = (o.items || []).map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.name)}${i.sku ? `<div class="cap">SKU ${esc(i.sku)}</div>` : ''}</td>${biz.hsn ? `<td>${esc(biz.hsn)}</td>` : ''}<td class="r">${money(i.price)}</td><td class="r">${i.qty}</td><td class="r">${money(i.price * i.qty)}</td></tr>`).join('');
  const line = (label, v, neg) => `<tr><td>${label}</td><td>${neg ? '−' : ''}${money(v)}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tax Invoice ${esc(o.invoiceNumber)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:#fff;color:#1d1b17;font:13px/1.5 system-ui,-apple-system,Segoe UI,Arial,sans-serif}.inv{max-width:210mm;margin:0 auto;padding:12mm 12mm 10mm}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:12px;border-bottom:2px solid #544C35}.top img{height:46px;display:block}.title{text-align:right}.title b{display:block;font-size:20px;color:#544C35;letter-spacing:.02em}.title small{color:#666}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:14px 0}.box h4{margin:0 0 4px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#6c675f}.box p{margin:0}
.meta{background:#f7f3ec;border-radius:8px;padding:10px 12px;margin:0 0 14px;display:grid;grid-template-columns:repeat(2,1fr);gap:6px 18px}.meta div>span.k{display:block;font-size:10.5px;color:#6c675f;text-transform:uppercase;letter-spacing:.07em}
table{width:100%;border-collapse:collapse}.items th{background:#544C35;color:#fff;text-align:left;font-size:11px;padding:7px 8px;font-weight:600}.items td{padding:8px;border-bottom:1px solid #e7e2d9;vertical-align:top}.r{text-align:right}.cap{font-size:10.5px;color:#777}
.tot{width:62%;margin:12px 0 0 auto}.tot td{padding:4px 8px}.tot td:last-child{text-align:right}.tot .g td{border-top:2px solid #544C35;font-weight:700;font-size:15px;padding-top:8px}
.words{margin:12px 0;padding:9px 12px;border:1px dashed #b9b19f;border-radius:6px}.sig{display:flex;justify-content:space-between;gap:20px;margin-top:22px;align-items:flex-end}.sig .s{text-align:right}.foot{margin-top:16px;padding-top:10px;border-top:1px solid #e7e2d9;font-size:11px;color:#777}
.mark{display:inline-block;padding:2px 8px;border:2px solid #c0392b;border-radius:6px;background:#fff4f2;font-weight:700;color:#c0392b}.pin{display:block;margin-top:4px;font-style:normal;font-weight:500;font-size:12px;color:#c0392b}.pin b{font-weight:700}
@media(max-width:560px){.grid,.meta{grid-template-columns:1fr}.tot{width:100%}}
@media print{@page{size:A4;margin:0}.inv{padding:12mm}}
</style></head><body><div class="inv">
<div class="top"><div><img src="${SITE()}/images/logo-olive.png" alt="${esc(biz.businessName || 'The Craft Lab')}"><p style="margin:6px 0 0"><b>${esc(biz.legalName || biz.businessName || 'The Craft Lab')}</b></p></div>
<div class="title"><b>TAX INVOICE</b><small>Original for recipient</small></div></div>
<div class="grid">
 <div class="box"><h4>Sold by</h4><p><b>${esc(biz.legalName || biz.businessName || 'The Craft Lab')}</b><br>${esc(sellerAddr)}${biz.gstin ? `<br>GSTIN: <b>${esc(biz.gstin)}</b>` : ''}${biz.pan ? `<br>PAN: ${esc(biz.pan)}` : ''}${biz.email ? `<br>${esc(biz.email)}` : ''}${biz.phone ? ` · ${esc(biz.phone)}` : ''}</p></div>
 <div class="box"><h4>Billing &amp; shipping address</h4><p><b>${esc(o.customer?.name)}</b><br>${esc(a.line1)}${a.line2 ? ', ' + esc(a.line2) : ''}<br>${esc(a.city)}, ${esc(a.state)} ${esc(a.pincode)}<br>${esc(o.customer?.phone || '')}${o.customer?.email ? '<br>' + esc(o.customer.email) : ''}</p><p class="cap" style="margin-top:4px">Place of supply: ${esc(a.state || '')}</p></div>
</div>
<div class="meta"><div><span class="k">Order ID</span>${mark(`<b>${esc(o.orderNumber)}</b>`)}</div><div><span class="k">Invoice number</span><b>${esc(o.invoiceNumber)}</b></div><div><span class="k">Order date</span>${date}</div><div><span class="k">Invoice date</span>${date}</div><div><span class="k">Payment</span>${esc(method)}${o.payment?.id ? ` · <span style="font-size:11px;color:#777">Txn ${esc(o.payment.id)}</span>` : ''}</div><div><span class="k">Reverse charge</span>No</div></div>
<table class="items"><thead><tr><th>#</th><th>Description</th>${biz.hsn ? '<th>HSN</th>' : ''}<th class="r">Unit price</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<table class="tot">${line('Items subtotal', o.subtotal)}${o.discount ? line(`Discount${o.couponCode ? ' (' + esc(o.couponCode) + ')' : ''}`, o.discount, true) : ''}${o.prepaidDiscount ? line('Prepaid discount', o.prepaidDiscount, true) : ''}${o.wallet?.pointsValue ? line(`Reward points (${o.wallet.pointsUsed})`, o.wallet.pointsValue, true) : ''}${o.wallet?.giftTotal ? line('Gift card', o.wallet.giftTotal, true) : ''}
<tr><td>Delivery${o.delivery?.name ? ' (' + esc(o.delivery.name) + ')' : ''}</td><td>${o.shipping ? money(o.shipping) : 'Free'}</td></tr>${o.codFee ? line('COD handling fee', o.codFee) : ''}
${rate > 0 ? `<tr><td>Taxable value</td><td>${money(taxable)}</td></tr>${taxRows}` : ''}<tr class="g"><td>Total (inclusive of all taxes)</td><td>${money(o.total)}</td></tr></table>
<div class="words"><b>Amount in words:</b> ${esc(amountInWords(o.total))}</div>
<div class="sig"><div class="cap">${rate > 0 ? 'Prices include GST. ' : ''}This is a computer-generated invoice and needs no signature.<br>Keep this invoice for warranty, returns and exchanges.</div><div class="s"><b>For ${esc(biz.legalName || biz.businessName || 'The Craft Lab')}</b><br><span class="cap">Authorised signatory</span></div></div>
<div class="foot">Thank you for shopping with ${esc(biz.businessName || 'The Craft Lab')} · ${esc(SITE().replace(/^https?:\/\//, ''))}${biz.email ? ' · ' + esc(biz.email) : ''}</div>
</div></body></html>`;
}

/** A made-up order used by the "Where do I find my Order ID?" pop-up — never a real customer's data. */
function sampleOrder() {
  return { orderNumber: 'FY2026CL0042', invoiceNumber: 'INV-0042', createdAt: new Date(), taxRate: 18, taxAmount: 381.2, customer: { name: 'Asha Verma', phone: '+91 98765 43210', email: 'asha@example.com' },
    address: { line1: '12, Lake View Apartments', line2: 'MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' }, items: [{ name: 'Sculptural Wall Hook Rack', sku: 'CRAFTLAB-HNG-01', qty: 1, price: 2499 }],
    subtotal: 2499, shipping: 0, discount: 0, couponCode: '', prepaidDiscount: 0, codFee: 0, total: 2499, wallet: {}, payment: { method: 'online', id: 'pay_SAMPLE12345' }, delivery: { name: 'Standard delivery' } };
}
module.exports = { invoiceHtml, amountInWords, sampleOrder };
