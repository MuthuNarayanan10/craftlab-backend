const { getNextSequence } = require('../models/Counter');

/** Indian financial year (April–March) label for a date, by India time. FY2026 = the year that starts on 1 April 2026. */
function financialYear(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 3600e3);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(); // 0 = Jan
  return m >= 3 ? y : y - 1;
}

/** Order numbers look like FY2026CL001 — one counter per financial year, so the number restarts at 001 every 1 April.
 *  (Past 999 it simply grows: FY2026CL1000.) Atomic counter: two simultaneous checkouts can never share a number. */
async function generateOrderNumber(date = new Date()) {
  const fy = financialYear(date);
  const seq = await getNextSequence(`orderNumber-FY${fy}`, 0);
  return `FY${fy}CL${String(seq).padStart(3, '0')}`;
}
module.exports = generateOrderNumber;
module.exports.financialYear = financialYear;
