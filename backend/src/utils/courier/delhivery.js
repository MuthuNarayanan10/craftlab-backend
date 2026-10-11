/** Delhivery (direct, B2C "Express") adapter — order → waybill → pickup → tracking → cancel.
 *  IMPORTANT: written from Delhivery's public developer-portal documentation and NOT yet validated against a live account.
 *  Test with the STAGING host first (DELHIVERY_BASE_URL=https://staging-express.delhivery.com), then one real order.
 *  Needs: an approved Delhivery client account, an API token, and a pickup location (warehouse) registered under that exact name. */
const { normalizeCourierStatus } = require('./status');
class CourierError extends Error { constructor(message, status = 502, step = '') { super(message); this.status = status; this.step = step; } }

function delhiveryProvider({ baseUrl = 'https://track.delhivery.com', fetchImpl = globalThis.fetch } = {}) {
  const hdr = (creds, extra = {}) => ({ Authorization: `Token ${creds.apiToken}`, Accept: 'application/json', ...extra });
  async function call(creds, method, path, { json, form } = {}, step) {
    const headers = hdr(creds, json ? { 'Content-Type': 'application/json' } : form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {});
    const res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: json ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined });
    const text = await res.text().catch(() => ''); let body = {}; try { body = JSON.parse(text); } catch (e) { body = { raw: text.slice(0, 200) }; }
    if (res.status === 401 || res.status === 403) throw new CourierError('Delhivery rejected the API token — check DELHIVERY_API_TOKEN (and that it matches staging vs production)', 401, 'auth');
    if (!res.ok) throw new CourierError(String(body.rmk || body.error || body.message || body.raw || `Delhivery error ${res.status}`).slice(0, 250), res.status, step);
    return body;
  }
  const ymd = (d) => { const x = new Date(d); const p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; };

  return {
    id: 'delhivery', label: 'Delhivery (direct)', supportsApi: true,
    secrets: ['apiToken'],
    config: ['pickupLocation', 'defaultWeightKg', 'defaultLengthCm', 'defaultBreadthCm', 'defaultHeightCm', 'returnAddress', 'returnPin', 'returnCity', 'returnState', 'returnPhone'],

    async testConnection(creds) { const b = await call(creds, 'GET', '/c/api/pin-codes/json/?filter_codes=110001', {}, 'auth'); if (!b.delivery_codes) throw new CourierError('Delhivery answered, but not as expected — check the token and base URL', 502, 'auth'); return { ok: true, message: 'Connected to Delhivery.' }; },

    async serviceability(creds, { deliveryPin, cod = false }) {
      const b = await call(creds, 'GET', `/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(deliveryPin)}`, {}, 'serviceability');
      const p = b.delivery_codes?.[0]?.postal_code; const ok = !!p && (cod ? p.cod === 'Y' : p.pre_paid === 'Y');
      return { serviceable: ok, couriers: ok ? [{ id: 'delhivery', name: 'Delhivery', rate: null, etd: '' }] : [] };
    },

    async createShipment(creds, order, cfg = {}) {
      if (!cfg.pickupLocation) throw new CourierError('Set the Delhivery pickup location name (DELHIVERY_PICKUP_LOCATION) — it must match your registered warehouse', 400, 'config');
      const cod = order.payment?.method === 'cod';
      const phone = String(order.customer.phone).replace(/\D/g, '').slice(-10);
      const shipment = {
        name: order.customer.name, add: [order.address.line1, order.address.line2].filter(Boolean).join(', '), pin: order.address.pincode, city: order.address.city, state: order.address.state, country: order.address.country || 'India', phone,
        order: order.orderNumber, payment_mode: cod ? 'COD' : 'Prepaid', cod_amount: cod ? String(order.total) : '0', total_amount: String(order.total),
        products_desc: order.items.map((i) => `${i.name} x${i.qty}`).join(', ').slice(0, 200), quantity: String(order.items.reduce((n, i) => n + i.qty, 0)), order_date: ymd(order.createdAt || Date.now()),
        weight: String(Math.round((Number(cfg.defaultWeightKg) || 1.5) * 1000)), shipment_length: String(Number(cfg.defaultLengthCm) || 55), shipment_width: String(Number(cfg.defaultBreadthCm) || 25), shipment_height: String(Number(cfg.defaultHeightCm) || 10),
        shipping_mode: 'Surface', waybill: '',
        ...(cfg.returnPin ? { return_pin: cfg.returnPin, return_city: cfg.returnCity || '', return_state: cfg.returnState || '', return_add: cfg.returnAddress || '', return_phone: cfg.returnPhone || '', return_country: 'India' } : {}),
      };
      const b = await call(creds, 'POST', '/api/cmu/create.json', { form: { format: 'json', data: JSON.stringify({ shipments: [shipment], pickup_location: { name: cfg.pickupLocation } }) } }, 'create');
      const pkg = b.packages?.[0];
      if (!pkg || !pkg.waybill || /fail|error/i.test(String(pkg.status))) throw new CourierError(`Delhivery did not accept the order: ${[].concat(pkg?.remarks || b.rmk || 'unknown reason').join('; ')}`.slice(0, 250), 422, 'create');
      const result = { providerOrderId: String(pkg.waybill), shipmentId: String(pkg.waybill), awb: String(pkg.waybill), courierName: 'Delhivery', labelUrl: '', pickupScheduledAt: null, trackingUrl: `https://www.delhivery.com/track-v2/package/${pkg.waybill}`, warnings: [] };
      return this.completeShipment(creds, result.awb, { cfg, result });
    },

    /** Schedules pickup (and tries the label). Safe to retry; never re-creates the waybill. */
    async completeShipment(creds, awb, extra = {}) {
      const cfg = extra.cfg || creds._cfg || {}; const result = extra.result || { providerOrderId: String(awb), shipmentId: String(awb), awb: String(awb), courierName: 'Delhivery', labelUrl: '', pickupScheduledAt: null, trackingUrl: `https://www.delhivery.com/track-v2/package/${awb}`, warnings: [] };
      if (cfg.pickupLocation) {
        try { const when = new Date(Date.now() + 86400e3); await call(creds, 'POST', '/fm/request/new/', { json: { pickup_time: '11:00:00', pickup_date: ymd(when), pickup_location: cfg.pickupLocation, expected_package_count: 1 } }, 'pickup'); result.pickupScheduledAt = when; }
        catch (e) { result.warnings.push(`Pickup: ${e.message}`); }
      }
      try { const l = await call(creds, 'GET', `/api/p/packing_slip?wbns=${encodeURIComponent(awb)}&pdf=true`, {}, 'label'); const link = l.packages?.[0]?.pdf_download_link || l.packages?.[0]?.pdf; if (link && /^https?:/.test(link)) result.labelUrl = link; else result.warnings.push('Label: print it from Delhivery One (the API did not return a link)'); }
      catch (e) { result.warnings.push(`Label: ${e.message}`); }
      return result;
    },

    async track(creds, awb) {
      const b = await call(creds, 'GET', `/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`, {}, 'track');
      const s = b.ShipmentData?.[0]?.Shipment || {}; const st = s.Status || {}; const raw = st.Status || '';
      const acts = (s.Scans || []).map((x) => x.ScanDetail || x).reverse();
      return {
        status: normalizeCourierStatus(raw === 'Pending' || raw === 'Manifested' ? 'pickup scheduled' : raw), rawStatus: raw, location: st.StatusLocation || '', at: st.StatusDateTime ? new Date(st.StatusDateTime) : new Date(),
        trackingUrl: `https://www.delhivery.com/track-v2/package/${awb}`, etd: s.ExpectedDeliveryDate ? new Date(s.ExpectedDeliveryDate) : null,
        activities: acts.slice(0, 20).map((a) => ({ status: normalizeCourierStatus(a.Scan), raw: a.Scan || '', location: a.ScannedLocation || '', at: a.ScanDateTime ? new Date(a.ScanDateTime) : null })),
      };
    },

    async cancel(creds, waybill) { const b = await call(creds, 'POST', '/api/p/edit', { json: { waybill: String(waybill), cancellation: 'true' } }, 'cancel'); if (b.status === false || b.success === false) throw new CourierError(String(b.error || b.rmk || 'Delhivery could not cancel this waybill'), 422, 'cancel'); return { ok: true }; },

    /** Delhivery's push body: { Shipment: { AWB, Status: { Status, StatusLocation, StatusDateTime } } } (read defensively). */
    parseWebhook(body) {
      const s = body.Shipment || body.shipment || body; const st = s.Status || s.status || {}; const raw = typeof st === 'string' ? st : (st.Status || st.status || '');
      return { awb: String(s.AWB || s.awb || s.waybill || ''), rawStatus: raw, status: normalizeCourierStatus(raw === 'Manifested' || raw === 'Pending' ? 'pickup scheduled' : raw), location: st.StatusLocation || '', at: st.StatusDateTime ? new Date(st.StatusDateTime) : new Date() };
    },
  };
}
module.exports = { delhiveryProvider, CourierError };
