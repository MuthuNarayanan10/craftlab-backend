const admin = require('firebase-admin');

let initialized = false;

/** Lazily initializes the Firebase Admin SDK from a service account JSON
 *  stored as a single-line env var (FIREBASE_SERVICE_ACCOUNT_JSON).
 *  Get this from: Firebase Console → Project Settings → Service Accounts
 *  → Generate New Private Key → paste the entire file contents as one
 *  line into that env var. */
function getFirebaseAdmin() {
  if (!initialized) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set — OTP login cannot verify tokens until this is configured.');
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    initialized = true;
  }
  return admin;
}

/** Verifies a Firebase ID token from the client (issued after successful
 *  phone OTP verification) and returns the decoded token, which includes
 *  `phone_number` in E.164 format (e.g. +919876543210). */
async function verifyFirebaseToken(idToken) {
  const fbAdmin = getFirebaseAdmin();
  return fbAdmin.auth().verifyIdToken(idToken);
}

module.exports = { getFirebaseAdmin, verifyFirebaseToken };
