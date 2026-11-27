'use strict';
/**
 * Registration idempotency helpers (M1.1). Pure functions plus one reader-agnostic resolver.
 *
 * replays/{sha256(client_request_id)[0:40]}  ->  {
 *   schema_version: 1,
 *   payload_hash:   sha256 of the canonical registration payload (never the payload itself),
 *   result:         the original successful API result (no `replayed` flag),
 *   created_at:     IST stamp,
 *   expiresAt:      Firestore Timestamp, now + 6h   (TTL field; TTL deletion is asynchronous, so readers check it themselves)
 * }
 */
const { db } = require('./firebase');
const U = require('./util');
const V = require('./validation');
const T = require('./teams');

const SCHEMA_VERSION = 1;
const RETENTION_MS = 6 * 60 * 60 * 1000;
const HASH_PREFIX = 'clienthunt/registration-payload/v1\n';
const HASH_RE = /^[0-9a-f]{64}$/;
const DECLARATION_KEYS = ['eligibility', 'participation_consent', 'information_accuracy', 'rules_acceptance'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** '' when usable, otherwise 'missing' | 'malformed'. */
function requestIdProblem(raw) {
  if (raw === undefined || raw === null || raw === '') return 'missing';
  return typeof raw === 'string' && V.REQUEST_ID_RE.test(raw) ? '' : 'malformed';
}
/** The raw request id is never a document id: same SHA-256 scheme as before. */
const replayDocId = (requestId) => U.sha256(requestId).slice(0, 40);
const replayRef = (requestId) => db.collection('replays').doc(replayDocId(requestId));

/* ---------- canonical payload ---------- */

function canonPerson(src) {
  src = isObj(src) ? src : {};
  const rawPhone = U.normalizeSpace(src.phone), phone = V.normalizePhone(src.phone);
  return {
    full_name: U.normalizeSpace(src.full_name),
    email: U.normalizeEmail(src.email),
    phone: phone || (rawPhone ? 'invalid:' + rawPhone : ''),      // equivalent valid phone spellings collapse to 10 digits
    courses: U.normalizeSpace(src.courses),
    department: U.normalizeSpace(src.department),
    semester: U.normalizeSpace(src.semester)
  };
}

/**
 * Canonical form of a submitted registration. Deliberately independent of Configuration (open/closed, team-size limits,
 * allowed domains) so a committed request stays identifiable after settings change. Member order is preserved.
 * Excludes client_request_id, action, hp, IP, timestamps and generated codes.
 */
function canonicalRegistration(p) {
  p = isObj(p) ? p : {};
  let size = typeof p.team_size === 'number' ? p.team_size : parseInt(p.team_size, 10);
  if (!isFinite(size)) size = null;
  const D = isObj(p.declarations) ? p.declarations : {};
  return {
    team_name: U.normalizeSpace(p.team_name),
    team_size: size,
    leader: canonPerson(p.leader),
    members: Array.isArray(p.members) ? p.members.map(canonPerson) : null,
    declarations: {
      eligibility: D.eligibility === true, participation_consent: D.participation_consent === true,
      information_accuracy: D.information_accuracy === true, rules_acceptance: D.rules_acceptance === true
    }
  };
}
const payloadHash = (canon) => U.sha256(HASH_PREFIX + JSON.stringify(canon));

/** Canonical form rebuilt from a STORED registration (used to prove a legacy replay record). Null if it cannot be rebuilt. */
function canonicalFromStored(reg) {
  if (!reg || !Array.isArray(reg.members) || !reg.members.length || !reg.declarations || reg.declarations.accepted !== true) return null;
  const list = reg.members.slice().sort((a, b) => a.member_number - b.member_number);
  return canonicalRegistration({
    team_name: reg.team_name, team_size: reg.team_size, leader: list[0], members: list.slice(1),
    declarations: { eligibility: true, participation_consent: true, information_accuracy: true, rules_acceptance: true }   // all four were required to register
  });
}

/* ---------- replay documents ---------- */

/** Milliseconds for a Firestore Timestamp, Date, number or {_seconds}; NaN when unusable. */
function expiresMs(v) {
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (v && typeof v._seconds === 'number') return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
  return NaN;
}

function resultUsable(r) {
  return isObj(r) && r.success === true && !('replayed' in r) &&
    ['registration_id', 'team_code', 'registration_status', 'message'].every((k) => typeof r[k] === 'string' && r[k]);
}

function buildReplayDoc(hash, result, nowMs) {
  return { schema_version: SCHEMA_VERSION, payload_hash: hash, result, created_at: U.istStamp(nowMs), expiresAt: new Date(nowMs + RETENTION_MS) };
}

/**
 * Decides what an existing replay document means for an incoming request with `hash`.
 * `read(ref)` is tx.get(ref) inside a transaction or ref.get() outside one, so the same logic serves the preflight and the
 * authoritative check. It only READS, so it is safe inside a transaction before any write.
 *   { kind:'none' }                 absent, or expired (whether or not TTL has deleted it yet): safe to create / replace
 *   { kind:'replay', result }       same payload: return the original result
 *   { kind:'backfill', result, update }  legacy record PROVEN against its registration; caller writes `update` transactionally
 *   { kind:'conflict' }             same request id, different payload
 *   { kind:'corrupt', reason }      unreadable or unverifiable record: fail closed, never overwrite
 */
async function resolveReplay(read, snap, hash, nowMs) {
  if (!snap.exists) return { kind: 'none' };
  const d = snap.data() || {};
  const exp = expiresMs(d.expiresAt);
  if (!isFinite(exp)) return { kind: 'corrupt', reason: 'expiresAt' };
  if (exp <= nowMs) return { kind: 'none' };

  if (d.schema_version === undefined && d.payload_hash === undefined) {                 // legacy: { result, expiresAt }
    if (!resultUsable(d.result)) return { kind: 'corrupt', reason: 'legacy_result' };
    const regSnap = await read(T.regRef(d.result.team_code));
    const reg = regSnap.exists ? regSnap.data() : null;
    if (!reg || reg.registration_id !== d.result.registration_id) return { kind: 'corrupt', reason: 'legacy_registration_missing' };
    const stored = canonicalFromStored(reg);
    if (!stored) return { kind: 'corrupt', reason: 'legacy_unverifiable' };
    if (payloadHash(stored) !== hash) return { kind: 'conflict' };
    return { kind: 'backfill', result: d.result, update: { schema_version: SCHEMA_VERSION, payload_hash: hash, created_at: String(reg.registration_timestamp || '') } };
  }
  if (d.schema_version !== SCHEMA_VERSION || typeof d.payload_hash !== 'string' || !HASH_RE.test(d.payload_hash)) return { kind: 'corrupt', reason: 'schema' };
  if (d.payload_hash !== hash) return { kind: 'conflict' };
  if (!resultUsable(d.result)) return { kind: 'corrupt', reason: 'result' };
  return { kind: 'replay', result: d.result };
}

module.exports = { SCHEMA_VERSION, RETENTION_MS, DECLARATION_KEYS, requestIdProblem, replayDocId, replayRef, canonicalRegistration, canonicalFromStored,
  payloadHash, expiresMs, resultUsable, buildReplayDoc, resolveReplay };
