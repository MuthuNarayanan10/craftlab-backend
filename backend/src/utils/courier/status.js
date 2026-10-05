/** Maps whatever words a courier uses to our normalised tracking states. */
function normalizeCourierStatus(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/rto|return to origin|returned to origin|undelivered.*return/.test(t)) return 'rto';
  if (/cancel/.test(t)) return 'cancelled';
  if (/out for delivery|ofd/.test(t)) return 'out_for_delivery';
  if (/delivered/.test(t) && !/un-?delivered|not delivered/.test(t)) return 'delivered';
  if (/undelivered|not delivered|delivery attempt|failed|exception|damaged|lost|misrouted|held|hold/.test(t)) return 'exception';
  if (/in transit|in-transit|shipped|dispatched|reached|arrived|departed|forwarded|hub|bagged|sorted/.test(t)) return 'in_transit';
  if (/picked up|pickup done|pick-?up complete|collected/.test(t)) return 'picked_up';
  if (/pickup|pick-up|manifest|awb|awaiting|scheduled|ready to ship|generated/.test(t)) return 'pickup_scheduled';
  return null;
}
module.exports = { normalizeCourierStatus };
