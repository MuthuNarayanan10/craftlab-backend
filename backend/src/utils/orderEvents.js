/** Appends an entry to an order's timeline (caller saves the order). `stage` links an event to a journey stage. */
function pushEvent(order, { label, stage, actor = 'system', note = '', location = '', public: isPublic = true, type = '', at }) {
  if (!Array.isArray(order.events)) order.events = [];
  order.events.push({ at: at || new Date(), label, stage: stage || '', actor, note, location, public: isPublic, type });
  return order;
}
module.exports = { pushEvent };
