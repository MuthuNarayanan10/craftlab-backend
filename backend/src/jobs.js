/** BACKGROUND JOBS — the safety nets. All of them are idempotent, so running on more than one server instance is harmless.
 *  Set DISABLE_JOBS=true to turn them off (e.g. on a second instance). */
const { reconcilePending } = require('./services/reconcile');
const { releaseStaleHolds } = require('./services/maintenance');
const { syncAll } = require('./services/shipmentService');
const { retryFailedNotifications } = require('./services/notifier');
const Integration = require('./models/Integration');
const { logger } = require('./utils/logger');

function every(ms, name, fn, first = 60e3) {
  const run = async () => { try { const r = await fn(); if (r && (r.recovered || r.changed || r.released || r === true)) logger.info('job', { name, result: r }); } catch (e) { logger.error('job_failed', { name, error: e?.error?.description || e.message }); } };
  setTimeout(run, first).unref();
  setInterval(run, ms).unref();
}

function startJobs() {
  if (process.env.DISABLE_JOBS === 'true') { logger.info('jobs_disabled', {}); return; }
  // 1) recover payments whose webhook/callback was missed, THEN free holds on checkouts that never completed
  every(10 * 60e3, 'payments_reconcile', async () => {
    const hasRazorpay = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET;
    const rec = hasRazorpay ? await reconcilePending({ olderThanMin: 5 }) : {};
    const released = await releaseStaleHolds(30);
    return { ...rec, released };
  });
  // 2) pull courier tracking for shipments in flight (if a courier API is enabled)
  every(20 * 60e3, 'courier_sync', async () => (await Integration.countDocuments({ kind: 'courier', enabled: true })) ? syncAll(50) : null, 120e3);
  // 3) retry notifications that failed
  every(15 * 60e3, 'notification_retry', async () => { const n = await retryFailedNotifications(); return n ? { changed: n } : null; }, 180e3);
}
module.exports = { startJobs };
