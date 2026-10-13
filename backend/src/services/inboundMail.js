/** Replies that customers send to our support mailbox become messages on their ticket (and a new ticket if a known customer writes in fresh).
 *  Fed by (a) the Brevo inbound-parsing webhook or (b) the optional IMAP poller — both call ingestReply(). */
const SupportTicket = require('../models/SupportTicket');
const Customer = require('../models/Customer');
const { getNextSequence } = require('../models/Counter');
const { createNotification } = require('../models/Notification');
const { logger } = require('../utils/logger');

const REF_RE = /TKT-\d+/i;
/** Drop quoted history ("On … wrote:", "> …", "-----Original Message-----") so the ticket shows only the new text. */
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n'); const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^\s*(On .{5,200} wrote:|-{2,}\s*Original Message\s*-{2,}|From:\s.+|Sent from my .+)\s*$/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}

async function ingestReply({ from, name, subject, text, messageId }) {
  const email = String(from || '').trim().toLowerCase();
  const body = stripQuoted(text);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || body.length < 2) return { ignored: 'empty_or_invalid' };
  if (/^(mailer-daemon|postmaster|no-?reply)@/.test(email)) return { ignored: 'automated' };
  const ref = (String(subject || '').match(REF_RE) || [])[0];
  let t = ref ? await SupportTicket.findOne({ ticketNumber: ref.toUpperCase() }).select('+seenMessageIds') : null;
  if (t && messageId && (t.seenMessageIds || []).includes(messageId)) return { duplicate: true, ticket: t.ticketNumber };
  if (t && t.email && t.email !== email) t = null; // only the ticket's own customer may add to it
  if (!t) {
    const known = await Customer.findOne({ email }).select('_id name').lean();
    const prior = await SupportTicket.findOne({ email }).select('_id name').lean();
    if (!known && !prior) { logger.info('inbound_mail_ignored', { reason: 'unknown_sender' }); return { ignored: 'unknown_sender' }; }
    const subj = String(subject || '(no subject)').replace(/^(re|fwd?):\s*/gi, '').trim().slice(0, 140) || '(no subject)';
    t = await SupportTicket.create({ ticketNumber: `TKT-${await getNextSequence('ticket')}`, customerId: known ? known._id : null, name: (known?.name || prior?.name || name || email.split('@')[0]).slice(0, 80), email, subject: subj, queryType: 'Other', status: 'New', messages: [{ from: 'customer', text: body, by: name || email, via: 'email' }], seenMessageIds: messageId ? [messageId] : [] });
    await createNotification('support_request', `New support email ${t.ticketNumber} from ${email}: ${subj}`, { ticketNumber: t.ticketNumber });
    return { created: true, ticket: t.ticketNumber };
  }
  t.messages.push({ from: 'customer', text: body, by: t.name, via: 'email' });
  t.lastCustomerMessageAt = new Date();
  if (['WaitingCustomer', 'Resolved', 'Closed', 'New'].includes(t.status)) t.status = t.status === 'New' ? 'New' : 'Open';
  if (messageId) t.seenMessageIds = [...(t.seenMessageIds || []), messageId].slice(-50);
  await t.save();
  await createNotification('support_request', `Customer replied by email on ${t.ticketNumber}`, { ticketNumber: t.ticketNumber });
  return { added: true, ticket: t.ticketNumber };
}
module.exports = { ingestReply, stripQuoted };
