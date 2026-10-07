/** PIN code helpers — pure. */
const normalizePin = (p) => String(p || '').replace(/\D/g, '');
const validPin = (p) => /^[1-9]\d{5}$/.test(normalizePin(p));   // Indian PINs are 6 digits and never start with 0

const yes = (v, dflt = true) => { const s = String(v ?? '').trim().toLowerCase(); if (!s) return dflt; if (['1', 'y', 'yes', 'true', 'available', 'serviceable'].includes(s)) return true; if (['0', 'n', 'no', 'false', 'unavailable', 'not serviceable'].includes(s)) return false; return dflt; };

/** Minimal CSV parser (quotes, commas, CRLF). Returns array of string arrays. */
function csvRows(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** CSV → { rows:[{pincode,city,state,serviceable,codAvailable,etaDays}], errors:[ 'line 4: …' ] }
 *  Columns by header name (pincode|pin, city|district, state, serviceable, cod, eta|etadays) — or, with no header, pincode,city,state. */
function parsePincodeCsv(text, { max = 25000 } = {}) {
  const all = csvRows(String(text || '').replace(/^\uFEFF/, ''));
  const errors = []; const out = new Map();
  if (!all.length) return { rows: [], errors: ['The file is empty'] };
  const head = all[0].map((h) => h.trim().toLowerCase());
  const hasHeader = head.some((h) => ['pincode', 'pin', 'pin code', 'postcode'].includes(h));
  const col = (names, dflt) => { const i = head.findIndex((h) => names.includes(h)); return i >= 0 ? i : dflt; };
  const idx = hasHeader ? { pin: col(['pincode', 'pin', 'pin code', 'postcode'], 0), city: col(['city', 'district', 'officename', 'taluk'], -1), state: col(['state', 'statename'], -1), svc: col(['serviceable', 'service', 'available'], -1), cod: col(['cod', 'cod available', 'codavailable'], -1), eta: col(['eta', 'etadays', 'eta days', 'days'], -1) } : { pin: 0, city: 1, state: 2, svc: -1, cod: -1, eta: -1 };
  const body = hasHeader ? all.slice(1) : all;
  if (body.length > max) return { rows: [], errors: [`Too many rows (${body.length}). Import up to ${max} at a time.`] };
  body.forEach((r, n) => {
    const line = n + (hasHeader ? 2 : 1); const pin = normalizePin(r[idx.pin]);
    if (!validPin(pin)) { if (errors.length < 20) errors.push(`line ${line}: “${String(r[idx.pin] || '').trim()}” is not a valid 6-digit PIN code`); return; }
    const eta = idx.eta >= 0 ? parseInt(r[idx.eta], 10) : 0;
    out.set(pin, { pincode: pin, city: idx.city >= 0 ? String(r[idx.city] || '').trim().slice(0, 80) : '', state: idx.state >= 0 ? String(r[idx.state] || '').trim().slice(0, 80) : '', serviceable: idx.svc >= 0 ? yes(r[idx.svc], true) : true, codAvailable: idx.cod >= 0 ? yes(r[idx.cod], true) : true, etaDays: Number.isFinite(eta) && eta >= 0 && eta <= 60 ? eta : 0 });
  });
  return { rows: [...out.values()], errors };
}

/** Expected delivery window from today, using the PIN's own ETA if it has one, else the delivery method's. */
function expectedDelivery(method, pinRow, from = new Date()) {
  const max = (pinRow && pinRow.etaDays) || (method && method.etaMaxDays) || 0;
  const min = (pinRow && pinRow.etaDays) || (method && method.etaMinDays) || max;
  if (!max) return null;
  const add = (d) => new Date(from.getTime() + d * 86400e3);
  const fmt = (d) => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const earliest = add(min), latest = add(max);
  return { earliest, latest, text: min === max || max <= 1 ? `Delivery by ${fmt(latest)}` : `Delivery between ${fmt(earliest)} and ${fmt(latest)}` };
}
module.exports = { normalizePin, validPin, parsePincodeCsv, expectedDelivery, csvRows };
