/** Which orders does this customer account own? Orders placed while logged in, PLUS earlier guest orders —
 *  but guest orders are matched only through a contact the customer has actually VERIFIED (OTP), never one they merely typed. */
function ownedOrdersFilter(c) {
  const or = [{ customerId: c.id }];
  if (c.phoneVerified && c.phone) or.push({ 'customer.phone': c.phone, customerId: null });
  if (c.emailVerified && c.email) or.push({ 'customer.email': c.email, customerId: null });
  return { $or: or };
}
module.exports = { ownedOrdersFilter };
