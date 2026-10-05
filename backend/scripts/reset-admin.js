/** RESET (or create) an admin password. Passwords are stored as one-way hashes — they can never be looked up, only replaced.
 *    ADMIN_EMAIL=you@thecraftlab.co.in NEW_PASSWORD='a long new passphrase 2026' npm run reset-admin
 *  Run it in Render → your service → Shell (it uses the server's own database settings). Add CREATE=1 to create the account if it doesn't exist (and ROLE=STAFF for a limited account that can run orders but not change settings, refund, or see the audit log).
 *  With no ADMIN_EMAIL it just lists the admin accounts (emails + roles — never passwords). */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/db');
const Admin = require('../src/models/Admin');
const { audit } = require('../src/models/AuditLog');
const { checkPasswordStrength } = require('../src/utils/password');

(async () => {
  await connectDB();
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  if (!email) {
    const all = await Admin.find().select('email role active lockUntil');
    console.log(all.length ? 'Admin accounts:' : 'No admin accounts exist yet — run with ADMIN_EMAIL, NEW_PASSWORD and CREATE=1.');
    all.forEach((a) => console.log(`  • ${a.email}  (${a.role})${a.active ? '' : '  [DISABLED]'}${a.lockUntil && a.lockUntil > new Date() ? '  [LOCKED until ' + a.lockUntil.toISOString() + ']' : ''}`));
    return;
  }
  const pw = process.env.NEW_PASSWORD || '';
  const problem = checkPasswordStrength(pw, email);
  if (problem) { console.error('❌ ' + problem); process.exitCode = 1; return; }
  let admin = await Admin.findOne({ email });
  if (!admin) {
    if (process.env.CREATE !== '1') { console.error(`❌ No admin with email ${email}. Check the spelling (run without ADMIN_EMAIL to list), or add CREATE=1 to create it.`); process.exitCode = 1; return; }
    const role = (process.env.ROLE || 'ADMIN').toUpperCase();
    if (!['ADMIN', 'STAFF'].includes(role)) { console.error('❌ ROLE must be ADMIN (owner) or STAFF (day-to-day orders only).'); process.exitCode = 1; return; }
    admin = new Admin({ name: role === 'STAFF' ? 'Staff' : 'Store Owner', email, role });
  }
  await admin.setPassword(pw);
  admin.active = true; admin.failedLogins = 0; admin.lockUntil = null;
  await admin.save();
  await audit({ action: 'admin.password_reset', actor: 'server-shell', entity: 'admin', entityId: admin.id, summary: `Password reset for ${email} from the server shell` });
  console.log(`✅ Password set for ${email} (${admin.role}). Account unlocked. Log in at /admin/login.html.`);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => mongoose.disconnect());
