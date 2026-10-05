/** Courier registry. To add a courier: create <name>.js exporting the same shape as shiprocket.js, then register it here.
 *  Nothing else in the order system needs to change. */
const manual = require('./manual');
const { shiprocketProvider } = require('./shiprocket');

// SHIPROCKET_BASE_URL lets staging / sandbox / tests point at a different API host (defaults to Shiprocket production)
const factories = { manual: () => manual, shiprocket: (opts) => shiprocketProvider(opts || (process.env.SHIPROCKET_BASE_URL ? { baseUrl: process.env.SHIPROCKET_BASE_URL } : undefined)) };
const cache = {};
function getCourier(id, opts) {
  if (!factories[id]) throw new Error(`Unknown courier provider "${id}"`);
  if (opts) return factories[id](opts); // explicit options (tests / custom base URL)
  return cache[id] || (cache[id] = factories[id]());
}
const listCouriers = () => Object.keys(factories).map((id) => { const p = getCourier(id); return { id, label: p.label, supportsApi: p.supportsApi, secrets: p.secrets, config: p.config }; });
module.exports = { getCourier, listCouriers };
