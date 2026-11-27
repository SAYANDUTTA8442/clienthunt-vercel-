'use strict';
require('./env');                                   // MUST be first: loads .env.local / .env before anything reads process.env
const admin = require('firebase-admin');
const { ConfigError, resolveFirebaseInit } = require('./firebase-config');

if (!admin.apps.length) {
  const init = resolveFirebaseInit(process.env);
  if (init.mode === 'emulator') {
    admin.initializeApp({ projectId: init.projectId });
  } else {
    let credential;
    try { credential = admin.credential.cert(init.serviceAccount); }
    catch (_) { throw new ConfigError('firebase-admin rejected FIREBASE_SERVICE_ACCOUNT (check project_id, client_email and private_key).'); }
    admin.initializeApp({ credential });
  }
}

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

module.exports = { admin, db, auth: admin.auth(), FieldValue: admin.firestore.FieldValue };
