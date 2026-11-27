'use strict';
const { db } = require('./firebase');
const U = require('./util');

/**
 * Appends an audit row. Never pass personal data in `details`.
 * opts.ttlDays: noisy public events (failed lookups, honeypot hits) expire on their own so an attacker cannot bloat the log.
 */
async function audit(action, registrationId, teamCode, actor, status, details, opts) {
  try {
    const ms = Date.now();
    const doc = { ts: U.istStamp(ms), ts_ms: ms, action, registration_id: registrationId || '', team_code: teamCode || '',
      actor: actor || 'system', status: status || '', details: String(details || '').slice(0, 500) };
    if (opts && opts.ttlDays) doc.expiresAt = new Date(ms + opts.ttlDays * 86400000);
    await db.collection('auditLog').add(doc);
  } catch (e) {
    console.error('audit failed: ' + U.safeErr(e));
  }
}

module.exports = { audit };
