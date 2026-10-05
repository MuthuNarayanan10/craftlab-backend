const NotificationLog = require('../models/NotificationLog');
const Integration = require('../models/Integration');
const { getSettings } = require('../models/Settings');
const { sendEmail } = require('../utils/email');
const { createNotifier, emailChannel, whatsappCloudChannel } = require('../utils/notifications');
const { logger } = require('../utils/logger');

const logStore = {
  async claim(key, doc) { try { const d = await NotificationLog.create({ key, ...doc }); return { id: d.id, ...d.toObject() }; } catch (e) { if (e.code === 11000) return null; throw e; } },
  async update(id, patch) { const { $inc, ...set } = patch; const u = {}; if (Object.keys(set).length) u.$set = set; if ($inc) u.$inc = $inc; await NotificationLog.findByIdAndUpdate(id, u); },
  async findFailed(limit) { return (await NotificationLog.find({ status: 'failed', attempts: { $lt: 3 } }).sort({ createdAt: 1 }).limit(limit)).map((d) => ({ id: d.id, ...d.toObject() })); },
};

let cache = null;
async function build() {
  if (cache && Date.now() - cache.at < 60e3) return cache.value;
  const settings = await getSettings();
  const wa = await Integration.findOne({ provider: 'whatsapp_cloud', enabled: true });
  let waChannel = { id: 'whatsapp', send: async () => { throw Object.assign(new Error('WhatsApp provider is not configured'), { skipped: true }); } };
  if (wa) { try { const s = wa.getSecrets(); waChannel = whatsappCloudChannel({ phoneNumberId: wa.config.phoneNumberId, accessToken: s.accessToken, templateName: wa.config.templateName, languageCode: wa.config.languageCode || 'en' }); } catch (e) { logger.warn('whatsapp_config_error', { error: e.message }); } }
  const enabled = (c) => c === 'email' ? settings.notifyEmailEnabled : (settings.notifyWhatsappEnabled && !!wa);
  const value = createNotifier({ logStore, channels: { email: emailChannel(sendEmail), whatsapp: waChannel }, enabled });
  cache = { at: Date.now(), value };
  return value;
}
const resetNotifierCache = () => { cache = null; };

/** Fire-and-forget: a notification problem must never affect an order. Failures are logged and retried by the background job. */
function notifyOrder(eventKey, ctx) {
  return build().then((n) => n.notify(eventKey, ctx)).catch((e) => logger.error('notify_failed', { event: eventKey, order: ctx.order?.orderNumber, error: e.message }));
}
async function retryFailedNotifications() { return (await build()).retryFailed(); }

module.exports = { notifyOrder, retryFailedNotifications, resetNotifierCache };
