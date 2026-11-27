'use strict';
/**
 * Firestore EMULATOR integration tests for registration idempotency (M1.1).
 * These exercise REAL Firestore transaction isolation, contention aborts and SDK retries.
 *   npm run test:emulator
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const S = require('./support');
const I = require('../../lib/idempotency');
const { handleRegister } = require('../../lib/registration');
const { getConfig, setConfigValue } = require('../../lib/config');

const N = 4;   // concurrent callers. Kept at 4 because the shared rate-limit counter doc is itself transaction-hot (see DEPLOY notes)
const ctx = (i) => ({ ip: '10.1.0.' + i });
const only = (list, action) => list.filter((a) => a.data.action === action);
const snapshot = async () => ({ regs: await S.docs('registrations'), emails: await S.docs('memberEmails'), replays: await S.docs('replays'), audit: await S.docs('auditLog') });

beforeEach(async () => { await S.clearDatabase(); await getConfig(true); });
after(async () => { await S.clearDatabase(); });

test('emulator A: simultaneous identical registrations create exactly one team', async () => {
  const probe = S.instrumentTransactions();
  try {
    const id = 'emu-identical-0123456789';
    const rs = await Promise.all(Array.from({ length: N }, (_, i) => handleRegister(S.payload(1, 3, id), ctx(i + 1))));
    assert.ok(rs.every((r) => r.success), JSON.stringify(rs));
    assert.strictEqual(new Set(rs.map((r) => r.team_code)).size, 1, 'all callers see the same Team Code');
    assert.strictEqual(rs.filter((r) => !r.replayed).length, 1, 'exactly one caller created it');
    const s = await snapshot();
    assert.strictEqual(s.regs.length, 1); assert.strictEqual(s.emails.length, 3); assert.strictEqual(s.replays.length, 1);
    assert.strictEqual(s.replays[0].data.result.team_code, s.regs[0].id);
    assert.strictEqual(only(s.audit, 'REGISTRATION_CREATED').length, 1);
    console.log('# registration transaction callbacks:', probe.counts.registrationCallbacks, 'for', N, 'requests (more than the requests that reached the transaction = Firestore retried)');
  } finally { probe.restore(); }
});

test('emulator B: simultaneous different payloads with one request id commit at most one', async () => {
  const id = 'emu-different-0123456789';
  const rs = await Promise.all([1, 2, 3].map((n) => handleRegister(S.payload(n, 2, id), ctx(n))));
  assert.strictEqual(rs.filter((r) => r.success).length, 1, JSON.stringify(rs));
  assert.ok(rs.filter((r) => !r.success).every((r) => r.error_code === 'IDEMPOTENCY_KEY_REUSED'), JSON.stringify(rs));
  const s = await snapshot();
  assert.strictEqual(s.regs.length, 1); assert.strictEqual(s.emails.length, 2); assert.strictEqual(s.replays.length, 1);
  assert.strictEqual(s.replays[0].data.result.team_code, s.regs[0].id, 'the replay record belongs to the committed team');
});

test('emulator C: distinct request ids racing for the same members: one wins, no orphan indexes', async () => {
  const a = S.payload(1, 2, 'emu-race-a-0123456789'), b = S.payload(2, 2, 'emu-race-b-0123456789'), c = S.payload(3, 2, 'emu-race-c-0123456789');
  b.members[0] = a.members[0]; c.leader = a.leader;
  const rs = await Promise.all([handleRegister(a, ctx(1)), handleRegister(b, ctx(2)), handleRegister(c, ctx(3))]);
  assert.strictEqual(rs.filter((r) => r.success).length, 1, JSON.stringify(rs));
  assert.ok(rs.filter((r) => !r.success).every((r) => r.error_code === 'DUPLICATE_MEMBER'), JSON.stringify(rs));
  const s = await snapshot();
  assert.strictEqual(s.regs.length, 1); assert.strictEqual(s.emails.length, 2); assert.strictEqual(s.replays.length, 1);
  assert.ok(s.emails.every((e) => e.data.team_code === s.regs[0].id));
});

test('emulator C2: the same team under different request ids converges on one registration', async () => {
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => handleRegister(S.payload(1, 2, 'emu-same-team-' + i + '-0123456789'), ctx(i + 1))));
  assert.strictEqual(rs.filter((r) => r.success).length, 1, JSON.stringify(rs));
  assert.ok(rs.filter((r) => !r.success).every((r) => r.error_code === 'ALREADY_REGISTERED'), JSON.stringify(rs));
  const s = await snapshot(); assert.strictEqual(s.regs.length, 1); assert.strictEqual(s.emails.length, 2); assert.strictEqual(s.replays.length, 1);
});

test('emulator E: lost response is recoverable; no extra team, indexes or audit event', async () => {
  const id = 'emu-lost-0123456789abc';
  await handleRegister(S.payload(1, 3, id), ctx(1));                       // the client never sees this result
  const retry = await handleRegister(S.payload(1, 3, id), ctx(2));
  const s = await snapshot();
  assert.strictEqual(retry.replayed, true); assert.strictEqual(retry.team_code, s.regs[0].id);
  assert.strictEqual(s.regs.length, 1); assert.strictEqual(s.emails.length, 3); assert.strictEqual(only(s.audit, 'REGISTRATION_CREATED').length, 1);
});

test('emulator F: replay still works after registration closes', async () => {
  const id = 'emu-closed-0123456789ab';
  const r1 = await handleRegister(S.payload(1, 2, id), ctx(1));
  await setConfigValue('registration_status', 'CLOSED');
  const r2 = await handleRegister(S.payload(1, 2, id), ctx(2));
  assert.strictEqual(r2.replayed, true); assert.strictEqual(r2.team_code, r1.team_code); assert.strictEqual((await S.docs('registrations')).length, 1);
  assert.strictEqual((await handleRegister(S.payload(2, 1, 'emu-closed-other-0123456'), ctx(3))).error_code, 'REGISTRATION_CLOSED');
});

test('emulator G: replay record is a real Firestore Timestamp; an expired one that still exists is replaced transactionally', async () => {
  const id = 'emu-expiry-0123456789a';
  await handleRegister(S.payload(1, 1, id), ctx(1));
  const [rep] = await S.docs('replays');
  assert.ok(typeof rep.data.expiresAt.toMillis === 'function', 'expiresAt is stored as a Timestamp');
  const ttl = rep.data.expiresAt.toMillis() - Date.now(); assert.ok(ttl > 5.9 * 3600e3 && ttl <= 6 * 3600e3);
  await S.putDoc('replays', rep.id, Object.assign({}, rep.data, { expiresAt: S.timestamp(Date.now() - 1000) }));      // TTL has NOT deleted it yet
  const r2 = await handleRegister(S.payload(2, 1, id), ctx(2));                                                        // new payload, same id, after expiry
  assert.ok(r2.success && !r2.replayed, JSON.stringify(r2));
  const reps = await S.docs('replays'); assert.strictEqual(reps.length, 1); assert.strictEqual(reps[0].data.result.team_code, r2.team_code);
  assert.strictEqual((await S.docs('registrations')).length, 2);
});

test('emulator H: legacy replay record is proven, replayed and backfilled; a mismatching payload is rejected untouched', async () => {
  const id = 'emu-legacy-0123456789a';
  const r1 = await handleRegister(S.payload(1, 2, id), ctx(1));
  const [rep] = await S.docs('replays');
  const legacy = { result: rep.data.result, expiresAt: rep.data.expiresAt };
  await S.db.collection('replays').doc(rep.id).set(legacy);                                                            // overwrite: drops the new fields
  assert.strictEqual((await handleRegister(S.payload(2, 2, id), ctx(2))).error_code, 'IDEMPOTENCY_KEY_REUSED');
  assert.deepStrictEqual((await S.docs('replays'))[0].data.payload_hash, undefined, 'mismatch must not backfill');
  const ok = await handleRegister(S.payload(1, 2, id), ctx(3));
  assert.strictEqual(ok.replayed, true); assert.strictEqual(ok.team_code, r1.team_code);
  const after = (await S.docs('replays'))[0].data;
  assert.strictEqual(after.schema_version, 1); assert.match(after.payload_hash, /^[0-9a-f]{64}$/);
  assert.strictEqual(after.expiresAt.toMillis(), legacy.expiresAt.toMillis());
  assert.strictEqual((await S.docs('registrations')).length, 1);
});

test('emulator I: corrupt replay record fails closed and is never overwritten', async () => {
  const id = 'emu-corrupt-0123456789';
  await handleRegister(S.payload(1, 1, id), ctx(1));
  const [rep] = await S.docs('replays');
  const bad = Object.assign({}, rep.data, { result: { success: true, registration_id: 'x' } });
  await S.putDoc('replays', rep.id, bad);
  const r = await handleRegister(S.payload(1, 1, id), ctx(2));
  assert.strictEqual(r.error_code, 'IDEMPOTENCY_RECORD_UNVERIFIABLE');
  assert.deepStrictEqual((await S.docs('replays'))[0].data.result, bad.result);
  assert.strictEqual((await S.docs('registrations')).length, 1);
});

test('emulator: replay document ids are hashes, never the raw request id', async () => {
  const id = 'emu-docid-0123456789ab';
  await handleRegister(S.payload(1, 1, id), ctx(1));
  const reps = await S.docs('replays');
  assert.strictEqual(reps.length, 1); assert.strictEqual(reps[0].id, I.replayDocId(id)); assert.ok(!reps[0].id.includes(id));
});
