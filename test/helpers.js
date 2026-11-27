'use strict';
process.env.CLIENTHUNT_SKIP_ENV_FILES = '1';   // unit/emulator tests never read real .env files
const path = require('path');
const fake = require('./fake-firebase');
const key = require.resolve('../lib/firebase');
require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
process.env.RATE_SALT = 'test'; process.env.FIREBASE_WEB_API_KEY = 'test';
// password check against the fake auth instead of Google's REST endpoint
global.fetch = async (url, opts) => {
  const b = JSON.parse(opts.body), u = [...fake.users.values()].find((x) => x.email === b.email && x.password === b.password && !x.disabled);
  return { ok: !!u, json: async () => (u ? { localId: u.uid } : { error: { message: 'INVALID_LOGIN_CREDENTIALS' } }) };
};
const letters = (n) => { let s = ''; do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
const person = (n, extra) => Object.assign({ full_name: 'Student ' + letters(n), email: 'stu' + n + '_2301cs0' + n + '@iitp.ac.in', phone: '98765432' + (10 + n),
  courses: 'B.Tech', department: 'Computer Science', semester: '3rd Semester' }, extra || {});
const payload = (n, size, extra) => Object.assign({ action: 'register', client_request_id: require('crypto').randomUUID(), team_name: 'Team ' + letters(n), team_size: size,
  leader: person(n * 10), members: Array.from({ length: size - 1 }, (_, i) => person(n * 10 + i + 1)),
  declarations: { eligibility: true, participation_consent: true, information_accuracy: true, rules_acceptance: true } }, extra || {});
module.exports = { fake, person, payload, ctx: (ip) => ({ ip: ip || '1.1.1.1' }) };
