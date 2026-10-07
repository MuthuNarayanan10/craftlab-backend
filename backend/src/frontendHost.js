/** One-container hosting: the API also serves the storefront and admin (SERVE_FRONTEND=true — set by the Docker setup).
 *  - /js/config.js is rewritten on the fly: the API is the SAME origin (/api), and the PUBLIC Firebase web config comes from
 *    environment variables at RUN time (so there is no build step and nothing to bake into the image).
 *  - Everything else is plain static files from the frontend folder. */
const express = require('express');
const fs = require('fs');
const path = require('path');

const FIREBASE_KEYS = { apiKey: 'FIREBASE_API_KEY', authDomain: 'FIREBASE_AUTH_DOMAIN', projectId: 'FIREBASE_PROJECT_ID', storageBucket: 'FIREBASE_STORAGE_BUCKET', messagingSenderId: 'FIREBASE_MESSAGING_SENDER_ID', appId: 'FIREBASE_APP_ID' };

/** Pure: turns the shipped config.js into the one this deployment needs. */
function renderConfig(source, env = process.env) {
  let out = source.replace(/const API_BASE = [^;]*;/, "const API_BASE = location.origin + '/api';");
  const fb = {}; for (const [k, v] of Object.entries(FIREBASE_KEYS)) if (env[v]) fb[k] = env[v];
  if (Object.keys(fb).length) out = out.replace(/const FIREBASE_CONFIG = \{[\s\S]*?\};/, 'const FIREBASE_CONFIG = ' + JSON.stringify(fb) + ';');
  if (env.WHATSAPP_NUMBER) out = out.replace(/const WHATSAPP_NUMBER = '[^']*';/, `const WHATSAPP_NUMBER = ${JSON.stringify(String(env.WHATSAPP_NUMBER).replace(/\D/g, ''))};`);
  return out;
}

function mountFrontend(app, dir = process.env.FRONTEND_DIR || path.join(__dirname, '../../frontend')) {
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error(`SERVE_FRONTEND is on but ${dir} has no index.html`);
  const configPath = path.join(dir, 'js/config.js'); let cached = null;
  app.get('/js/config.js', (req, res) => { cached = cached || renderConfig(fs.readFileSync(configPath, 'utf8')); res.type('application/javascript').set('Cache-Control', 'no-cache').send(cached); });
  app.use(express.static(dir, { index: 'index.html', etag: true, setHeaders: (res, file) => {
    if (/\.html$/.test(file)) res.set('Cache-Control', 'no-cache');                         // pages: always check for a new version
    else if (/\.(png|jpe?g|webp|svg|ico|woff2?)$/.test(file)) res.set('Cache-Control', 'public, max-age=604800');
    else res.set('Cache-Control', 'public, max-age=300');
  } }));
}
module.exports = { mountFrontend, renderConfig };
