'use strict';
// Unit tests against the in-memory MODEL (test/fake-firebase.js). Concurrency here is a model check only;
// the authoritative concurrency tests are test/emulator/idempotency.emulator.test.js (npm run test:emulator).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const I = require('../lib/idempotency');
const U = require('../lib/util');
const { handleRegister } = require('../lib/registration');
const { getConfig, setConfigValue } = require('../lib/config');
const fake = H.fake;

const ID = 'req-0123456789abcdef';
const req = (n, size, id, extra) => H.payload(n, size, Object.assign({ client_request_id: id || ID }, extra || {}));
const ctx = (i) => H.ctx('10.0.0.' + (i || 1));
const regs = () => fake.docs('registrations');
const emails = () => fake.docs('memberEmails');
const replays = () => fake.docs('replays');
const created = () => fake.docs('auditLog').filter((a) => a.data.action === 'REGISTRATION_CREATED');
const rlTotal = () => fake.docs('rateLimits').reduce((t, d) => t + d.data.count, 0);
const replayPath = (id) => 'replays/' + I.replayDocId(id || ID);

beforeEach(async () => { fake.reset(); await getConfig(true); });

/* ---------- canonical hashing ---------- */

test('hash: deterministic, normalised, order-sensitive, excludes transport fields', () => {
  const base = req(1, 3), h = (p) => I.payloadHash(I.canonicalRegistration(p));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  assert.match(h(base), /^[0-9a-f]{64}$/);
  assert.strictEqual(h(base), h(clone(base)));

  const email = clone(base); email.leader.email = email.leader.email.toUpperCase();                       // email casing
  assert.strictEqual(h(email), h(base));
  const ws = clone(base); ws.team_name = '  ' + base.team_name.replace(' ', '   ') + ' '; ws.members[0].full_name = ' ' + base.members[0].full_name + '\t';   // whitespace
  assert.strictEqual(h(ws), h(base));
  for (const spelling of ['+91 98765 43210', '91-9876543210', '09876543210', '98765-43210']) {             // phone spellings
    const a = clone(base), b = clone(base); a.leader.phone = '9876543210'; b.leader.phone = spelling;
    assert.strictEqual(h(a), h(b), spelling);
  }
  const sized = clone(base); sized.team_size = String(base.team_size);                                      // "3" vs 3
  assert.strictEqual(h(sized), h(base));

  const swapped = clone(base); swapped.members.reverse();                                                   // member order matters
  assert.notStrictEqual(h(swapped), h(base));
  const decl = clone(base); decl.declarations.rules_acceptance = false;                                     // each declaration matters
  assert.notStrictEqual(h(decl), h(base));
  const name = clone(base); name.team_name += 'x';
  assert.notStrictEqual(h(name), h(base));

  const noise = clone(base); noise.client_request_id = 'zzzzzzzzzzzzzzzzzzzz'; noise.action = 'other'; noise.hp = ''; noise.extra = { a: 1 };
  assert.strictEqual(h(noise), h(base));                                                                    // excluded fields
});

test('hash: independent of mutable configuration', async () => {
  const p = req(1, 2), before = I.payloadHash(I.canonicalRegistration(p));
  await setConfigValue('registration_status', 'CLOSED'); await setConfigValue('max_team_size', '2'); await setConfigValue('approved_email_domains', 'example.org');
  assert.strictEqual(I.payloadHash(I.canonicalRegistration(p)), before);
});

/* ---------- request id validation ---------- */

test('request id: missing and malformed are rejected, nothing is written, raw id is never a document id', async () => {
  for (const bad of [undefined, null, '', 'short', 'has spaces in it 1234567', 'x'.repeat(65), 12345678901234567890, { a: 1 }, 'ünïcode-ünïcode-ünïcode']) {
    const p = req(1, 1); if (bad === undefined) delete p.client_request_id; else p.client_request_id = bad;
    const r = await handleRegister(p, ctx());
    assert.strictEqual(r.error_code, 'INVALID_REQUEST_ID', String(bad));
    assert.ok(!JSON.stringify(r).match(/firestore|replays|stack/i));
  }
  assert.strictEqual(regs().length + emails().length + replays().length, 0);
  assert.strictEqual(rlTotal(), 0, 'rejected before rate limiting');
  assert.ok((await handleRegister(req(1, 1), ctx())).success);
  assert.ok(replays().every((d) => d.id !== ID && !d.id.includes(ID)));
});

/* ---------- replay semantics ---------- */

test('A: identical sequential retry returns the original result, one registration', async () => {
  const r1 = await handleRegister(req(1, 3), ctx()), r2 = await handleRegister(req(1, 3), ctx(2));
  assert.ok(r1.success && !('replayed' in r1));
  assert.strictEqual(r2.replayed, true);
  assert.strictEqual(r2.team_code, r1.team_code); assert.strictEqual(r2.registration_id, r1.registration_id);
  assert.strictEqual(regs().length, 1); assert.strictEqual(emails().length, 3); assert.strictEqual(replays().length, 1);

  const d = replays()[0].data;   // schema
  assert.strictEqual(d.schema_version, 1); assert.match(d.payload_hash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(d.result, r1); assert.ok(!('replayed' in d.result));
  assert.ok(typeof d.created_at === 'string' && d.created_at);
  assert.ok(typeof d.expiresAt.toMillis === 'function', 'expiresAt is a Timestamp');
  const ttl = d.expiresAt.toMillis() - Date.now(); assert.ok(ttl > 5.9 * 3600e3 && ttl <= 6 * 3600e3);
  assert.ok(!JSON.stringify(d).includes('Student'), 'payload itself is not stored');
});

test('A: semantically identical retry (email case, phone spelling) is a replay', async () => {
  const r1 = await handleRegister(req(1, 2), ctx());
  const p = req(1, 2); p.leader.email = p.leader.email.toUpperCase(); p.leader.phone = '+91 ' + p.leader.phone; p.team_name = ' ' + p.team_name + '  ';
  const r2 = await handleRegister(p, ctx());
  assert.strictEqual(r2.replayed, true); assert.strictEqual(r2.team_code, r1.team_code); assert.strictEqual(regs().length, 1);
});

test('B: same request id, different payload is rejected and changes nothing', async () => {
  const r1 = await handleRegister(req(1, 2), ctx());
  const snapReplay = JSON.stringify(replays()), snapRegs = JSON.stringify(regs());
  const r2 = await handleRegister(req(2, 2), ctx(2));
  assert.strictEqual(r2.error_code, 'IDEMPOTENCY_KEY_REUSED'); assert.ok(!r2.team_code);
  assert.strictEqual(JSON.stringify(replays()), snapReplay); assert.strictEqual(JSON.stringify(regs()), snapRegs);
  assert.strictEqual(regs().length, 1); assert.strictEqual(emails().length, 2);
  assert.strictEqual((await handleRegister(req(1, 2), ctx())).team_code, r1.team_code, 'original still replays');
});

test('F: registration closed after commit still returns the original result; a new request is refused', async () => {
  const r1 = await handleRegister(req(1, 2), ctx());
  await setConfigValue('registration_status', 'CLOSED');
  const rl = rlTotal(), r2 = await handleRegister(req(1, 2), ctx(2));
  assert.strictEqual(r2.replayed, true); assert.strictEqual(r2.team_code, r1.team_code); assert.strictEqual(r2.registration_id, r1.registration_id);
  assert.strictEqual(rlTotal(), rl, 'a replay consumes no rate-limit attempt');
  assert.strictEqual(regs().length, 1);
  assert.strictEqual((await handleRegister(req(3, 1, 'req-other-0123456789'), ctx(3))).error_code, 'REGISTRATION_CLOSED');
  assert.strictEqual((await handleRegister(req(2, 2), ctx(4))).error_code, 'IDEMPOTENCY_KEY_REUSED', 'different payload, same id, closed: still a conflict');
});

test('E: commit succeeded but the response was lost: identical retry recovers it, no second audit event, no extra indexes', async () => {
  await handleRegister(req(1, 3), ctx());                        // response discarded: the client never saw it
  const retry = await handleRegister(req(1, 3), ctx(2));
  assert.strictEqual(retry.replayed, true);
  assert.strictEqual(retry.team_code, regs()[0].id);
  assert.strictEqual(regs().length, 1); assert.strictEqual(emails().length, 3);
  assert.strictEqual(created().length, 1);
});

/* ---------- expiry (TTL deletion is asynchronous) ---------- */

test('expiry: an expired record that still exists is not a replay; identical payload falls through to normal duplicate handling', async () => {
  const r1 = await handleRegister(req(1, 2), ctx());
  const doc = replays()[0].data; fake.put(replayPath(), Object.assign({}, doc, { expiresAt: new Date(Date.now() - 1000) }));
  const r2 = await handleRegister(req(1, 2), ctx(2));
  assert.strictEqual(r2.error_code, 'ALREADY_REGISTERED'); assert.ok(!r2.replayed);
  assert.strictEqual(regs().length, 1); assert.strictEqual(r1.success, true);
});

test('expiry: an expired record is replaced transactionally by a new request using the same id', async () => {
  await handleRegister(req(1, 1), ctx());
  const old = replays()[0].data; fake.put(replayPath(), Object.assign({}, old, { expiresAt: new Date(Date.now() - 1) }));
  const r2 = await handleRegister(req(2, 1), ctx(2));
  assert.ok(r2.success && !r2.replayed); assert.strictEqual(regs().length, 2);
  const nd = replays()[0].data;
  assert.notStrictEqual(nd.payload_hash, old.payload_hash); assert.strictEqual(nd.result.team_code, r2.team_code);
  assert.ok(nd.expiresAt.toMillis() > Date.now());
  assert.strictEqual((await handleRegister(req(2, 1), ctx(3))).replayed, true);
});

test('expiry: Timestamp, Date and {_seconds} shapes are all understood; garbage is corrupt', () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(I.expiresMs(new fake.Timestamp(now)), now);
  assert.strictEqual(I.expiresMs(new Date(now)), now);
  assert.strictEqual(I.expiresMs({ _seconds: now / 1000, _nanoseconds: 0 }), now);
  assert.ok(isNaN(I.expiresMs(undefined))); assert.ok(isNaN(I.expiresMs('soon')));
});

/* ---------- legacy records: { result, expiresAt } with no payload_hash ---------- */

async function makeLegacy() {
  const r1 = await handleRegister(req(1, 2), ctx());
  fake.put(replayPath(), { result: r1, expiresAt: new Date(Date.now() + 3600e3) });          // downgrade to the old shape
  return r1;
}

test('legacy: identical payload is proven against the stored registration, replayed and backfilled', async () => {
  const r1 = await makeLegacy(), before = replays()[0].data;
  const r2 = await handleRegister(req(1, 2), ctx(2));
  assert.strictEqual(r2.replayed, true); assert.strictEqual(r2.team_code, r1.team_code); assert.strictEqual(regs().length, 1);
  const after = replays()[0].data;
  assert.strictEqual(after.schema_version, 1); assert.match(after.payload_hash, /^[0-9a-f]{64}$/);
  assert.strictEqual(after.expiresAt.toMillis(), before.expiresAt.toMillis(), 'expiry is not extended');
  assert.deepStrictEqual(after.result, r1);
});

test('legacy: works while registration is closed', async () => {
  const r1 = await makeLegacy(); await setConfigValue('registration_status', 'CLOSED');
  assert.strictEqual((await handleRegister(req(1, 2), ctx(2))).team_code, r1.team_code);
});

test('legacy: a different payload is rejected and the record is not overwritten', async () => {
  await makeLegacy(); const snap = JSON.stringify(replays());
  const r = await handleRegister(req(2, 2), ctx(2));
  assert.strictEqual(r.error_code, 'IDEMPOTENCY_KEY_REUSED'); assert.strictEqual(JSON.stringify(replays()), snap); assert.strictEqual(regs().length, 1);
});

test('legacy: unverifiable (registration missing / unusable result) fails closed, nothing overwritten, nothing created', async () => {
  const r1 = await makeLegacy(); fake.store.delete('registrations/' + r1.team_code);
  let snap = JSON.stringify(replays());
  assert.strictEqual((await handleRegister(req(1, 2), ctx(2))).error_code, 'IDEMPOTENCY_RECORD_UNVERIFIABLE');
  assert.strictEqual(JSON.stringify(replays()), snap); assert.strictEqual(regs().length, 0);

  fake.put(replayPath(), { result: { success: true }, expiresAt: new Date(Date.now() + 3600e3) });
  snap = JSON.stringify(replays());
  assert.strictEqual((await handleRegister(req(1, 2), ctx(3))).error_code, 'IDEMPOTENCY_RECORD_UNVERIFIABLE');
  assert.strictEqual(JSON.stringify(replays()), snap);
});

/* ---------- corruption ---------- */

test('corruption: missing result fields, bad hash, unknown schema, missing expiresAt all fail closed without overwriting', async () => {
  const r1 = await handleRegister(req(1, 1), ctx()), good = replays()[0].data;
  const cases = {
    'missing team_code': Object.assign({}, good, { result: { success: true, registration_id: r1.registration_id, registration_status: 'REGISTERED', message: 'x' } }),
    'replayed flag stored': Object.assign({}, good, { result: Object.assign({}, r1, { replayed: true }) }),
    'result not an object': Object.assign({}, good, { result: 'oops' }),
    'bad hash': Object.assign({}, good, { payload_hash: 'nothex' }),
    'unknown schema': Object.assign({}, good, { schema_version: 99 }),
    'no expiresAt': (() => { const c = Object.assign({}, good); delete c.expiresAt; return c; })()
  };
  for (const [name, doc] of Object.entries(cases)) {
    fake.put(replayPath(), doc); const snap = JSON.stringify(replays());
    const r = await handleRegister(req(1, 1), ctx(2));
    assert.strictEqual(r.error_code, 'IDEMPOTENCY_RECORD_UNVERIFIABLE', name);
    assert.ok(!r.success && !r.replayed, name);
    assert.strictEqual(JSON.stringify(replays()), snap, name);
    assert.strictEqual(regs().length, 1, name);
  }
});

/* ---------- concurrency: MODEL only (optimistic transactions with retries) ---------- */

test('C (model): concurrent identical requests create exactly one registration', async () => {
  const rs = await Promise.all([1, 2, 3, 4].map((i) => handleRegister(req(1, 3), ctx(i))));
  assert.ok(rs.every((r) => r.success), JSON.stringify(rs));
  assert.strictEqual(new Set(rs.map((r) => r.team_code)).size, 1);
  assert.strictEqual(regs().length, 1); assert.strictEqual(emails().length, 3); assert.strictEqual(replays().length, 1);
  assert.strictEqual(rs.filter((r) => !r.replayed).length, 1, 'exactly one request created it');
  assert.strictEqual(created().length, 1);
  assert.ok(fake.stats.txConflicts > 0, 'the model really forced at least one transaction retry');
});

test('D (model): concurrent different payloads with one request id commit at most one', async () => {
  const rs = await Promise.all([1, 2, 3, 4].map((i) => handleRegister(req(i, 2), ctx(i))));
  assert.strictEqual(rs.filter((r) => r.success).length, 1, JSON.stringify(rs));
  assert.ok(rs.filter((r) => !r.success).every((r) => r.error_code === 'IDEMPOTENCY_KEY_REUSED'));
  assert.strictEqual(regs().length, 1); assert.strictEqual(emails().length, 2); assert.strictEqual(replays().length, 1);
  assert.strictEqual(replays()[0].data.result.team_code, regs()[0].id);
});

test('concurrent distinct request ids sharing a member: one team wins, no orphan email indexes', async () => {
  const a = req(1, 2, 'req-aaaaaaaaaaaaaaaa'), b = req(2, 2, 'req-bbbbbbbbbbbbbbbb'); b.members[0] = a.members[0];
  const rs = await Promise.all([handleRegister(a, ctx(1)), handleRegister(b, ctx(2))]);
  assert.strictEqual(rs.filter((r) => r.success).length, 1, JSON.stringify(rs));
  assert.ok(rs.some((r) => r.error_code === 'DUPLICATE_MEMBER'));
  assert.strictEqual(regs().length, 1); assert.strictEqual(emails().length, 2); assert.strictEqual(replays().length, 1);
});

test('model sanity: the fake enforces reads-before-writes and aborts on a stale read', async () => {
  const d = fake.db.collection('x').doc('a');
  await assert.rejects(fake.db.runTransaction(async (tx) => { tx.set(d, { a: 1 }); await tx.get(d); }), /reads to be executed before/);
  let runs = 0;
  await fake.db.runTransaction(async (tx) => { runs++; await tx.get(d); if (runs === 1) fake.put('x/a', { a: 2 }); tx.set(d, { a: 3 }); });
  assert.strictEqual(runs, 2);
});
