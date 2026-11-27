'use strict';
require('./env');
const { db } = require('./firebase');
const U = require('./util');

/**
 * Atomic counters in Firestore (doc per key, fixed window). Unlike CacheService in Apps Script these are transactional,
 * and Vercel gives us the real client IP, so limits can be per visitor instead of one shared global bucket.
 * Enable a Firestore TTL policy on rateLimits.expiresAt (see DEPLOY.md) so old counters clean themselves up.
 */
const ref = (key) => db.collection('rateLimits').doc(U.sha256((process.env.RATE_SALT || 'ch') + '|' + key).slice(0, 40));

/** Counts one hit. Returns true if it is within `max` for the window, false if the limit is already reached. */
async function hit(key, max, windowSec) {
  const r = ref(key);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(r), now = Date.now();
    let d = s.exists ? s.data() : null;
    if (!d || d.resetAt <= now) d = { count: 0, resetAt: now + windowSec * 1000 };
    if (d.count >= max) return false;
    tx.set(r, { count: d.count + 1, resetAt: d.resetAt, expiresAt: new Date(d.resetAt + 3600 * 1000) });
    return true;
  });
}

/** Current count without incrementing. */
async function count(key) {
  const s = await ref(key).get();
  return s.exists && s.data().resetAt > Date.now() ? s.data().count : 0;
}

/** Increments unconditionally (used for failed attempts). */
async function bump(key, windowSec) {
  const r = ref(key);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(r), now = Date.now();
    let d = s.exists ? s.data() : null;
    if (!d || d.resetAt <= now) d = { count: 0, resetAt: now + windowSec * 1000 };
    tx.set(r, { count: d.count + 1, resetAt: d.resetAt, expiresAt: new Date(d.resetAt + 3600 * 1000) });
  });
}

module.exports = { hit, count, bump };
