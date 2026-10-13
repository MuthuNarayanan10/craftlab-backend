/** OPTIONAL: reads the support mailbox over IMAP (e.g. the care@ mailbox on GoDaddy) and files customer replies on their tickets.
 *  Set IMAP_HOST, IMAP_USER, IMAP_PASS (IMAP_PORT defaults to 993). Needs: npm i imapflow mailparser. Does nothing when unset. */
const { ingestReply } = require('./inboundMail');
const { logger } = require('../utils/logger');
const configured = () => !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
async function pollMailbox() {
  if (!configured()) return null;
  let ImapFlow, simpleParser;
  try { ({ ImapFlow } = require('imapflow')); ({ simpleParser } = require('mailparser')); } catch (e) { logger.warn('imap_modules_missing', { hint: 'npm i imapflow mailparser' }); return null; }
  const client = new ImapFlow({ host: process.env.IMAP_HOST, port: Number(process.env.IMAP_PORT || 993), secure: process.env.IMAP_SECURE !== 'false', auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS }, logger: false });
  let added = 0;
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    for await (const msg of client.fetch({ seen: false }, { source: true, envelope: true })) {
      try {
        const mail = await simpleParser(msg.source);
        const from = mail.from?.value?.[0] || {};
        if (String(from.address || '').toLowerCase() === String(process.env.IMAP_USER).toLowerCase()) { await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true }); continue; }
        const r = await ingestReply({ from: from.address, name: from.name, subject: mail.subject, text: mail.text || '', messageId: mail.messageId });
        if (r.added || r.created) added++;
      } catch (e) { logger.warn('imap_message_failed', { error: e.message }); }
      await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
    }
  } finally { lock.release(); await client.logout().catch(() => {}); }
  return added ? { changed: added } : null;
}
module.exports = { pollMailbox, configured };
