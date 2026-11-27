'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const U = require('../lib/util');
const V = require('../lib/validation');
const { handleRegister } = require('../lib/registration');
const P = require('../lib/public');
const A = require('../lib/admin');
const T = require('../lib/teams');
const { getConfig } = require('../lib/config');

test('util: dates, config state, email keys', () => {
  assert.strictEqual(U.parseWhen(''), null);
  assert.ok(isNaN(U.parseWhen('tomorrow')));
  assert.strictEqual(U.parseWhen('2026-11-09 10:00'), Date.parse('2026-11-09T04:30:00Z'));
  assert.strictEqual(U.registrationState('OPEN', null, null, 1), 'OPEN');
  assert.strictEqual(U.registrationState('open ', NaN, null, 1), 'NOT_STARTED');
  assert.strictEqual(U.registrationState('maybe', null, null, 1), 'CLOSED');
  assert.strictEqual(U.registrationState('OPEN', null, 5, 5), 'CLOSED');
  assert.strictEqual(U.emailKey('A.B+x@IITP.ac.in'), 'a.b@iitp.ac.in');
  assert.match(U.istStamp(Date.parse('2026-11-09T04:30:00Z')), /^2026-11-09T10:00:00\+05:30$/);
  assert.match(U.secureRandom(4), /^[A-HJ-NP-Z2-9]{4}$/);
});

test('validation: phone, email domain, duplicates, declarations', async () => {
  assert.strictEqual(V.normalizePhone('+91 98765 43210'), '9876543210');
  assert.strictEqual(V.normalizePhone('1234567890'), '');
  const cfg = await getConfig();
  const bad = V.validateRegistration(H.payload(1, 2, { leader: H.person(5, { email: 'x@gmail.com' }), declarations: {} }), cfg);
  assert.ok(!bad.ok && bad.errors['leader.email'] && bad.errors.declarations);
  const dup = H.payload(2, 2); dup.members[0].email = dup.leader.email.replace('@', '+tag@');
  assert.ok(V.validateRegistration(dup, cfg).errors['members.0.email']);
});

test('registration: success, duplicate, retry-identical, replay, closed', async () => {
  const r1 = await handleRegister(H.payload(1, 3, { client_request_id: 'req-aaaaaaaaaaaaaaaa' }), H.ctx('2.2.2.2'));
  assert.ok(r1.success, JSON.stringify(r1)); assert.match(r1.team_code, /^CH-26-[A-Z0-9]{4}$/);
  const replay = await handleRegister(H.payload(1, 3, { client_request_id: 'req-aaaaaaaaaaaaaaaa' }), H.ctx('2.2.2.2'));
  assert.strictEqual(replay.team_code, r1.team_code); assert.ok(replay.replayed);
  const again = await handleRegister(H.payload(1, 3), H.ctx('2.2.2.3'));
  assert.strictEqual(again.error_code, 'ALREADY_REGISTERED');
  const clash = H.payload(4, 2); clash.members[0] = H.person(11);   // member of team 1
  const c = await handleRegister(clash, H.ctx('2.2.2.4'));
  assert.strictEqual(c.error_code, 'DUPLICATE_MEMBER'); assert.ok(c.errors['members.0.email']);
  await require('../lib/config').setConfigValue('registration_status', 'CLOSED');
  assert.strictEqual((await handleRegister(H.payload(7, 1), H.ctx())).error_code, 'REGISTRATION_CLOSED');
  await require('../lib/config').setConfigValue('registration_status', 'OPEN');
});

test('lookups: status check, search masks phones, failures rate-limit per IP only', async () => {
  const reg = await handleRegister(H.payload(3, 2), H.ctx('3.3.3.3'));
  const ok = await P.handleStatusCheck({ team_code: reg.team_code, email: 'stu30_2301cs030@iitp.ac.in' }, H.ctx('4.4.4.4'));
  assert.ok(ok.success && ok.team_name === 'Team d', JSON.stringify(ok));
  const s = await P.handleSearchTeam({ query: reg.team_code }, H.ctx('4.4.4.5'));
  assert.ok(s.success && s.contacts_masked && /\*{6}/.test(s.members[0].phone) && !JSON.stringify(s).includes('@iitp'));
  for (let i = 0; i < 8; i++) await P.handleSearchTeam({ query: 'CH-26-ZZZZ' }, H.ctx('5.5.5.5'));
  assert.strictEqual((await P.handleSearchTeam({ query: reg.team_code }, H.ctx('5.5.5.5'))).error_code, 'RATE_LIMITED');
  assert.ok((await P.handleSearchTeam({ query: reg.team_code }, H.ctx('6.6.6.6'))).success, 'another visitor is not locked out');
});

test('admin: owner, login, edit, cancel/restore, lockout is per-IP', async () => {
  await A.createOrResetOwner('Org One', 'org1@iitp.ac.in', 'a very long password');
  const bad = await A.handleAdminLogin({ email: 'org1@iitp.ac.in', password: 'wrong-password-123' }, H.ctx('7.7.7.7'));
  assert.strictEqual(bad.error_code, 'NOT_AUTHORISED');
  const login = await A.handleAdminLogin({ email: 'org1@iitp.ac.in', password: 'a very long password' }, H.ctx('8.8.8.8'));
  assert.ok(login.success && login.token);
  for (let i = 0; i < 6; i++) await A.handleAdminLogin({ email: 'org1@iitp.ac.in', password: 'nope-nope-nope' + i }, H.ctx('7.7.7.7'));
  assert.ok((await A.handleAdminLogin({ email: 'org1@iitp.ac.in', password: 'a very long password' }, H.ctx('8.8.8.9'))).success, 'attacker cannot lock the real admin out');

  const data = await A.handleAdminData({ token: login.token });
  assert.ok(data.success && data.teams.length >= 2);
  const t = data.teams.find((x) => x.members.length === 2);
  const upd = await A.handleAdminTeamUpdate({ token: login.token, team_code: t.team_code, changes: { team_name: 'Renamed Team', members: [{ member_number: 2, phone: '9000000001', email: 'new.person@iitp.ac.in' }] } });
  assert.ok(upd.success, JSON.stringify(upd));
  const taken = await A.handleAdminTeamUpdate({ token: login.token, team_code: t.team_code, changes: { members: [{ member_number: 2, email: 'stu10_2301cs010@iitp.ac.in' }] } });
  assert.strictEqual(taken.error_code, 'VALIDATION_ERROR');
  assert.ok((await A.handleAdminTeamStatus({ token: login.token, team_code: t.team_code, registration_status: 'CANCELLED', reason: 'test' })).success);
  assert.ok((await handleRegister(H.payload(12, 1, { leader: H.person(0, { email: 'new.person@iitp.ac.in' }) }), H.ctx('1.2.3.4'))).success, 'cancelled members can register again');
  const restore = await A.handleAdminTeamStatus({ token: login.token, team_code: t.team_code, registration_status: 'REGISTERED', reason: 'test' });
  assert.strictEqual(restore.error_code, 'DUPLICATE_MEMBER');
});

test('admin: create admin, temp password forces change, disable ends sessions, last owner protected', async () => {
  const owner = await A.handleAdminLogin({ email: 'org1@iitp.ac.in', password: 'a very long password' }, H.ctx('10.0.0.1'));
  const made = await A.handleAdminAdminCreate({ token: owner.token, full_name: 'Org Two', email: 'org2@iitp.ac.in', role: 'ADMIN' });
  assert.ok(made.success && made.temp_password);
  const l2 = await A.handleAdminLogin({ email: 'org2@iitp.ac.in', password: made.temp_password }, H.ctx('10.0.0.2'));
  assert.ok(l2.success && l2.me.must_change_password);
  assert.strictEqual((await A.handleAdminData({ token: l2.token })).error_code, 'PASSWORD_CHANGE_REQUIRED');
  const ch = await A.handleAdminChangePassword({ token: l2.token, current_password: made.temp_password, new_password: 'my own long password' }, H.ctx('10.0.0.2'));
  assert.ok(ch.success);
  assert.ok((await A.handleAdminData({ token: ch.token })).success);
  assert.strictEqual((await A.handleAdminData({ token: l2.token })).error_code, 'SESSION_EXPIRED', 'old session ended');
  assert.strictEqual((await A.handleAdminAdminsList({ token: ch.token })).error_code, 'FORBIDDEN');
  assert.ok((await A.handleAdminAdminUpdate({ token: owner.token, admin_id: made.admin.admin_id, status: 'DISABLED' })).success);
  assert.strictEqual((await A.handleAdminData({ token: ch.token })).error_code, 'SESSION_EXPIRED');
  assert.strictEqual((await A.handleAdminAdminUpdate({ token: owner.token, admin_id: owner.me.admin_id, status: 'DISABLED' })).error_code, 'FORBIDDEN');
});
