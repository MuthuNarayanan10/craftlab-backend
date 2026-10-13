const CourierPartner = require('../models/CourierPartner');
const { getSettings } = require('../models/Settings');
/** Loads what's needed to finish a customer-facing journey: courier link templates + the return-window length. */
async function loadCtx() { return { couriers: await CourierPartner.find().lean(), days: (await getSettings()).returnWindowDays }; }
/** Fills courier.trackingUrl ({AWB} replaced; falls back to the courier's tracking page) and adds the return window for delivered orders. */
function finish(journey, order, ctx) {
  const c = journey.courier || {};
  if (c.awb || c.name) {
    let u = c.trackingUrl;
    if (!u && c.name && journey.deliveryMethod?.type !== 'manual') { const m = ctx.couriers.find((x) => x.name.toLowerCase() === String(c.name).toLowerCase()); u = m ? m.trackUrl : ''; }
    u = String(u || '').replace(/\{AWB\}/gi, encodeURIComponent(c.awb || ''));
    journey.courier = { ...c, trackingUrl: u, prefilled: !!(u && c.awb && u.includes(encodeURIComponent(c.awb))) };
  }
  if (journey.status === 'Delivered') {
    const at = new Date(order.deliveredAt || order.updatedAt), deadline = new Date(at.getTime() + ctx.days * 86400000), open = Date.now() <= deadline.getTime();
    journey.returnWindow = { days: ctx.days, deadline, open, daysLeft: open ? Math.max(0, Math.ceil((deadline - Date.now()) / 86400000)) : 0 };
  }
  return journey;
}
module.exports = { loadCtx, finish };
