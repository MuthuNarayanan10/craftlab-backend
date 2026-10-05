/** Shiprocket adapter — order → AWB → pickup → label → tracking → cancel.
 *  IMPORTANT: written from Shiprocket's public API documentation, NOT yet validated against a live account.
 *  Test it with your own Shiprocket account (Admin → Shipping → "Test connection", then one real order) before relying on it.
 *  Every step is independent: if e.g. AWB assignment fails, the shipment record is still kept and the step can be retried. */
const { normalizeCourierStatus } = require('./status');

class CourierError extends Error { constructor(message, status = 502, step = '') { super(message); this.status = status; this.step = step; } }

function shiprocketProvider({ baseUrl = 'https://apiv2.shiprocket.in/v1/external', fetchImpl = globalThis.fetch } = {}) {
  const tokens = new Map(); // email → { token, exp }

  async function login(creds, force) {
    const c = tokens.get(creds.email);
    if (!force && c && c.exp > Date.now()) return c.token;
    const res = await fetchImpl(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: creds.email, password: creds.password }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) throw new CourierError(`Shiprocket login failed: ${body.message || res.status}`, 401, 'auth');
    tokens.set(creds.email, { token: body.token, exp: Date.now() + 8 * 86400e3 });
    return body.token;
  }
  async function call(creds, method, path, payload, step) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await login(creds, attempt > 0);
      const res = await fetchImpl(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: payload ? JSON.stringify(payload) : undefined });
      if (res.status === 401 && attempt === 0) continue; // token expired → log in again once
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new CourierError(`${body.message || (body.errors ? JSON.stringify(body.errors) : 'Shiprocket error ' + res.status)}`, res.status, step);
      return body;
    }
    throw new CourierError('Shiprocket authentication failed', 401, step);
  }

  const dt = (d) => { const x = new Date(d); const p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`; };

  async function finish(creds, shipmentId) {
    const result = { providerOrderId: '', shipmentId, awb: '', courierName: '', labelUrl: '', pickupScheduledAt: null, trackingUrl: '', warnings: [] };
    try { // AWB (Shiprocket auto-selects the best courier when none is specified)
      const a = await call(creds, 'POST', '/courier/assign/awb', { shipment_id: shipmentId }, 'awb');
      const d = a?.response?.data || a?.data || {};
      result.awb = d.awb_code || ''; result.courierName = d.courier_name || '';
      if (!result.awb) result.warnings.push('AWB was not assigned — retry from the order');
    } catch (e) { result.warnings.push(`AWB: ${e.message}`); }
    if (result.awb) {
      try { const p = await call(creds, 'POST', '/courier/generate/pickup', { shipment_id: [Number(shipmentId)] }, 'pickup'); const d = p?.response || p || {}; result.pickupScheduledAt = d.pickup_scheduled_date ? new Date(d.pickup_scheduled_date) : new Date(); }
      catch (e) { result.warnings.push(`Pickup: ${e.message}`); }
      try { const l = await call(creds, 'POST', '/courier/generate/label', { shipment_id: [Number(shipmentId)] }, 'label'); result.labelUrl = l.label_url || ''; }
      catch (e) { result.warnings.push(`Label: ${e.message}`); }
      result.trackingUrl = `https://shiprocket.co/tracking/${result.awb}`;
    }
    return result;
  }

  return {
    id: 'shiprocket', label: 'Shiprocket', supportsApi: true,
    secrets: ['email', 'password'],
    config: ['pickupLocation', 'defaultWeightKg', 'defaultLengthCm', 'defaultBreadthCm', 'defaultHeightCm'],

    async testConnection(creds) { await login(creds, true); return { ok: true, message: 'Connected to Shiprocket.' }; },

    async serviceability(creds, { pickupPin, deliveryPin, weightKg = 0.5, cod = false }) {
      const body = await call(creds, 'GET', `/courier/serviceability/?pickup_postcode=${pickupPin}&delivery_postcode=${deliveryPin}&weight=${weightKg}&cod=${cod ? 1 : 0}`, null, 'serviceability');
      const list = body?.data?.available_courier_companies || [];
      return { serviceable: list.length > 0, couriers: list.map((c) => ({ id: c.courier_company_id, name: c.courier_name, rate: c.rate, etd: c.etd })) };
    },

    async createShipment(creds, order, cfg = {}) {
      const [first, ...rest] = String(order.customer.name || 'Customer').trim().split(/\s+/);
      const phone = String(order.customer.phone).replace(/\D/g, '').slice(-10);
      const payload = {
        order_id: order.orderNumber, order_date: dt(order.createdAt || Date.now()), pickup_location: cfg.pickupLocation,
        billing_customer_name: first, billing_last_name: rest.join(' ') || '.', billing_address: order.address.line1, billing_address_2: order.address.line2 || '',
        billing_city: order.address.city, billing_pincode: order.address.pincode, billing_state: order.address.state, billing_country: order.address.country || 'India',
        billing_email: order.customer.email, billing_phone: phone, shipping_is_billing: true,
        order_items: order.items.map((i) => ({ name: i.name, sku: i.sku, units: i.qty, selling_price: i.price })),
        payment_method: order.payment?.method === 'cod' ? 'COD' : 'Prepaid', sub_total: order.total,
        length: Number(cfg.defaultLengthCm) || 55, breadth: Number(cfg.defaultBreadthCm) || 25, height: Number(cfg.defaultHeightCm) || 10, weight: Number(cfg.defaultWeightKg) || 1.5,
      };
      if (!payload.pickup_location) throw new CourierError('Set the Shiprocket pickup location name in Admin → Integrations first', 400, 'config');

      const created = await call(creds, 'POST', '/orders/create/adhoc', payload, 'create');
      const result = await finish(creds, String(created.shipment_id));
      result.providerOrderId = String(created.order_id);
      return result;
    },

    /** Finishes (or retries) the steps after the order exists at the courier — AWB, pickup, label — WITHOUT creating the order again. */
    async completeShipment(creds, shipmentId) { return finish(creds, String(shipmentId)); },

    async track(creds, awb) {
      const body = await call(creds, 'GET', `/courier/track/awb/${encodeURIComponent(awb)}`, null, 'track');
      const td = body.tracking_data || {};
      const acts = td.shipment_track_activities || [];
      const latest = acts[0] || {};
      const raw = latest.activity || latest['sr-status-label'] || (td.shipment_track && td.shipment_track[0] && td.shipment_track[0].current_status) || '';
      return {
        status: normalizeCourierStatus(raw), rawStatus: raw, location: latest.location || '', at: latest.date ? new Date(latest.date) : new Date(),
        trackingUrl: td.track_url || '', etd: td.etd ? new Date(td.etd) : null,
        activities: acts.slice(0, 20).map((a) => ({ status: normalizeCourierStatus(a.activity), raw: a.activity, location: a.location || '', at: a.date ? new Date(a.date) : null })),
      };
    },

    async cancel(creds, providerOrderId) { await call(creds, 'POST', '/orders/cancel', { ids: [Number(providerOrderId)] }, 'cancel'); return { ok: true }; },

    /** Webhook body → { awb, rawStatus, status, location, at } (field names vary between Shiprocket event types, so read defensively). */
    parseWebhook(body) {
      const raw = body.current_status || body.shipment_status || body.status || '';
      return { awb: body.awb || body.awb_code || '', rawStatus: raw, status: normalizeCourierStatus(raw), location: body.location || body.current_location || '', at: body.current_timestamp ? new Date(body.current_timestamp) : new Date() };
    },
  };
}
module.exports = { shiprocketProvider, CourierError };
