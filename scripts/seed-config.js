'use strict';
// npm run seed : writes any MISSING settings into Firestore doc config/main. Existing values are never overwritten.

const boot = require('./_boot');                   // loads .env.local / .env before any Firebase import
const { db } = boot('../lib/firebase');
const { DEFAULT_CONFIG } = boot('../lib/config');

(async () => {
  const ref = db.collection('config').doc('main'), snap = await ref.get(), have = snap.exists ? snap.data() : {};
  const add = {};
  DEFAULT_CONFIG.forEach(([k, v]) => { if (!(k in have)) add[k] = v; });
  if (Object.keys(add).length) await ref.set(add, { merge: true });
  console.log(Object.keys(add).length ? 'Added: ' + Object.keys(add).join(', ') : 'Config already complete.');
  console.log('CHECK before launch: approved_email_domains =', (have.approved_email_domains || add.approved_email_domains), '| registration_status =', (have.registration_status || add.registration_status));
})().catch((e) => { console.error(e); process.exit(1); });
