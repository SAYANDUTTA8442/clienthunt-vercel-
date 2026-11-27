'use strict';
process.env.CLIENTHUNT_SKIP_ENV_FILES = '1';   // unit/emulator tests never read real .env files
/**
 * Test support for the Firestore EMULATOR suite.
 *   Real run : npm run test:emulator        (firebase emulators:exec sets FIRESTORE_EMULATOR_HOST; needs Java and network access to download the emulator once)
 *   Smoke run: CH_TEST_FAKE=1 node --test test/emulator/idempotency.emulator.test.js
 *              runs the SAME test code against the in-memory model to catch bugs in the tests themselves. It proves nothing about Firestore.
 */
const crypto = require('crypto');
const USE_FAKE = process.env.CH_TEST_FAKE === '1';

let fake = null;
if (USE_FAKE) {
  fake = require('../fake-firebase');
  const key = require.resolve('../../lib/firebase');
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
} else if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is not set. Run "npm run test:emulator" (it starts the emulator), not this file directly.');
}
process.env.RATE_SALT = 'emulator-test';

const { db } = require('../../lib/firebase');
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-clienthunt';

async function clearDatabase() {
  if (USE_FAKE) { fake.reset(); return; }
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const r = await fetch('http://' + host + '/emulator/v1/projects/' + PROJECT + '/databases/(default)/documents', { method: 'DELETE' });
  if (!r.ok) throw new Error('could not clear the emulator database: HTTP ' + r.status);
}

const letters = (n) => { let s = ''; do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
const person = (n) => ({ full_name: 'Student ' + letters(n), email: 'stu' + n + '_2301cs0' + n + '@iitp.ac.in', phone: '98765432' + (10 + (n % 80)),
  courses: 'B.Tech', department: 'Computer Science', semester: '3rd Semester' });
const payload = (n, size, id) => ({ action: 'register', client_request_id: id || crypto.randomUUID(), team_name: 'Team ' + letters(n), team_size: size,
  leader: person(n * 10), members: Array.from({ length: size - 1 }, (_, i) => person(n * 10 + i + 1)),
  declarations: { eligibility: true, participation_consent: true, information_accuracy: true, rules_acceptance: true } });

async function docs(col) { const s = await db.collection(col).get(); return s.docs.map((d) => ({ id: d.id, data: d.data() })); }
async function putDoc(col, id, data) { await db.collection(col).doc(id).set(data); }
function timestamp(ms) { return USE_FAKE ? new Date(ms) : require('firebase-admin').firestore.Timestamp.fromMillis(ms); }

/** Counts executions of the REGISTRATION transaction callback (the one that reads replays/…); >1 per request means Firestore retried it. */
function instrumentTransactions() {
  const orig = db.runTransaction.bind(db), c = { registrationCallbacks: 0, allCallbacks: 0 };
  db.runTransaction = (fn, opts) => orig(async (tx) => {
    c.allCallbacks++; let seen = false;
    const wrap = { get: (r, ...a) => { if (!seen && r.path && r.path.startsWith('replays/')) { seen = true; c.registrationCallbacks++; } return tx.get(r, ...a); },
      set: (...a) => tx.set(...a), update: (...a) => tx.update(...a), create: (...a) => tx.create(...a), delete: (...a) => tx.delete(...a) };
    return fn(wrap);
  }, opts);
  return { counts: c, restore() { db.runTransaction = orig; } };
}

module.exports = { USE_FAKE, PROJECT, db, clearDatabase, payload, person, docs, putDoc, timestamp, instrumentTransactions };
