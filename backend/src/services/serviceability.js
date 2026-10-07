const Pincode = require('../models/Pincode');
const DeliveryMethod = require('../models/DeliveryMethod');
const { getSettings } = require('../models/Settings');
const { applicableMethods } = require('../utils/delivery');
const { normalizePin, validPin, expectedDelivery } = require('../utils/pincode');

/** Can we deliver to this PIN? Combines the admin's PIN registry, the delivery methods that serve it, and COD rules. */
async function checkPincode(rawPin, { subtotal = 0, cod = false } = {}) {
  const pin = normalizePin(rawPin);
  if (!validPin(pin)) return { pincode: pin, valid: false, serviceable: false, reason: 'Enter a valid 6-digit PIN code' };
  const [settings, rawRow, methods] = await Promise.all([getSettings(), Pincode.findOne({ pincode: pin }), DeliveryMethod.listAll()]);
  const registry = settings.pincodeCheckMode === 'registry';
  const row = registry ? rawRow : null; // with the list switched off it is ignored completely — no blocking, no COD rules, no ETA overrides
  const base = { pincode: pin, valid: true, city: row?.city || '', state: row?.state || '', registryMode: registry };
  if (registry && !(row && row.serviceable)) return { ...base, serviceable: false, reason: row ? 'We don’t deliver to this PIN code right now' : 'We don’t deliver to this PIN code yet', methods: [] };
  const options = applicableMethods(methods, { pincode: pin, subtotal, cod });
  if (!options.length) return { ...base, serviceable: false, reason: 'None of our delivery options reach this PIN code', methods: [] };
  const codAvailable = !!settings.codEnabled && (row ? row.codAvailable : true);
  const first = methods.find((m) => m.key === (options.find((o) => o.selectable) || options[0]).key);
  const exp = expectedDelivery(first, row);
  return { ...base, serviceable: true, codAvailable, expected: exp ? { earliest: exp.earliest, latest: exp.latest, text: exp.text } : null, methods: options, note: row?.note || '' };
}
module.exports = { checkPincode };
