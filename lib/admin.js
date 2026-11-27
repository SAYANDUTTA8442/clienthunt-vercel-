'use strict';
require('./env');                                   // before anything reads process.env (FIREBASE_WEB_API_KEY, Firebase credentials)
/**
 * Admin dashboard API. Identity lives in Firebase Authentication (email + password, scrypt-hashed by Google; this code never
 * stores or hashes a password). Roles live in the `admins` collection:  admins/{ADM-XXXXXX} { uid, email, full_name, role,
 * status, must_change_password, pw_epoch, created_at, created_by, last_login }.
 *
 * Sign-in checks the password with Firebase, then issues OUR OWN opaque session token (stored hashed in `sessions`, 4 hours),
 * so every request can be revoked instantly: every request re-reads the admin row, and a password change / reset / disable
 * deletes the sessions. The dashboard front end keeps working unchanged.
 */
const { db, auth } = require('./firebase');
const U = require('./util');
const V = require('./validation');
const { getConfig, setConfigValue } = require('./config');
const RL = require('./ratelimit');
const { audit } = require('./audit');
const T = require('./teams');

const SESSION_TTL_S = 4 * 60 * 60;
const TOKEN_RE = /^[A-Z2-9]{40}$/;
const ROLES = ['OWNER', 'ADMIN'];
const MIN_PASSWORD_LEN = 12;
const W = 15 * 60;

/* ---------- passwords (verified by Firebase Auth) ---------- */

async function verifyPassword(email, password) {
  const key = process.env.FIREBASE_WEB_API_KEY;
  if (!key) throw new Error('FIREBASE_WEB_API_KEY is not set');
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(key), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: false })
  });
  const j = await r.json().catch(() => ({}));
  return r.ok && !!j.localId ? { ok: true, uid: j.localId } : { ok: false };
}

function passwordProblem(pass, email) {
  if (typeof pass !== 'string' || pass.length < MIN_PASSWORD_LEN) return 'Use a password of at least ' + MIN_PASSWORD_LEN + ' characters.';
  if (pass.length > 200) return 'That password is too long.';
  if (pass.toLowerCase() === String(email || '').toLowerCase()) return 'The password cannot be your email address.';
  if (/^(.)\1+$/.test(pass)) return 'Choose a less repetitive password.';
  return '';
}
const tempPassword = () => U.secureRandom(12);

/* ---------- admin rows ---------- */

const adminDoc = (id) => db.collection('admins').doc(id);
async function adminById(id) { if (!V.ADMIN_ID_RE.test(String(id))) return null; const s = await adminDoc(id).get(); return s.exists ? s.data() : null; }
async function adminByEmail(email) {
  const q = await db.collection('admins').where('email', '==', email).limit(1).get();
  return q.empty ? null : q.docs[0].data();
}
const me = (r) => ({ admin_id: r.admin_id, full_name: r.full_name, role: r.role, must_change_password: !!r.must_change_password });
const listView = (r) => ({ admin_id: r.admin_id, full_name: r.full_name, email: r.email, role: r.role, status: r.status,
  must_change_password: !!r.must_change_password, created_at: r.created_at, created_by: r.created_by, last_login: r.last_login });

async function newAdminId() {
  for (let i = 0; i < 20; i++) { const id = 'ADM-' + U.secureRandom(6); if (!(await adminById(id))) return id; }
  throw new Error('Could not allocate an admin id.');
}

/** Used by scripts/create-owner.js. Creates an OWNER, or resets an existing admin with that email to an active OWNER with a new password. */
async function createOrResetOwner(fullName, email, password) {
  const name = U.normalizeSpace(fullName), mail = U.normalizeEmail(email);
  if (!V.PERSON_NAME_RE.test(name)) throw new Error("Enter the owner's name (letters, spaces, hyphens, apostrophes, full stops).");
  if (!V.EMAIL_RE.test(mail)) throw new Error('Enter a valid email address.');
  const problem = passwordProblem(String(password || ''), mail); if (problem) throw new Error(problem);
  const ts = U.nowStamp(), existing = await adminByEmail(mail);
  if (existing) {
    await auth.updateUser(existing.uid, { password: String(password), disabled: false, displayName: name });
    await adminDoc(existing.admin_id).update({ full_name: name, role: 'OWNER', status: 'ACTIVE', must_change_password: false, pw_epoch: Date.now(), last_updated: ts });
    await dropSessions(existing.admin_id);
    await audit('ADMIN_OWNER_RESET', '', '', 'script', 'OK', 'admin=' + existing.admin_id);
    return { admin_id: existing.admin_id, created: false };
  }
  let user;
  try { user = await auth.getUserByEmail(mail); await auth.updateUser(user.uid, { password: String(password), disabled: false, displayName: name }); }
  catch (e) { if (e.code !== 'auth/user-not-found') throw e; user = await auth.createUser({ email: mail, password: String(password), displayName: name }); }
  const id = await newAdminId();
  await adminDoc(id).set({ admin_id: id, uid: user.uid, email: mail, full_name: name, role: 'OWNER', status: 'ACTIVE', must_change_password: false,
    pw_epoch: Date.now(), created_at: ts, created_by: 'script', last_login: '', last_updated: ts });
  await audit('ADMIN_OWNER_CREATED', '', '', 'script', 'OK', 'admin=' + id);
  return { admin_id: id, created: true };
}

/* ---------- sessions ---------- */

const sessionRef = (token) => db.collection('sessions').doc(U.sha256(token).slice(0, 40));
async function issueSession(adminId, createdMs) {
  const token = U.secureRandom(40);
  await sessionRef(token).set({ admin_id: adminId, created_ms: createdMs || Date.now(), expiresAt: new Date(Date.now() + SESSION_TTL_S * 1000) });
  return token;
}
async function dropSessions(adminId, exceptToken) {
  const q = await db.collection('sessions').where('admin_id', '==', adminId).get();
  const keep = exceptToken ? sessionRef(exceptToken).path : '';
  const batch = db.batch(); let n = 0;
  q.docs.forEach((d) => { if (d.ref.path !== keep) { batch.delete(d.ref); n++; } });
  if (n) await batch.commit();
}

/** Returns { admin: 'ADM-…', me: row, token } or { err }. Re-reads the admin row every time so changes bite immediately. */
async function adminAuth(p, opts) {
  const token = String((p && p.token) || '');
  const expired = { err: U.fail('SESSION_EXPIRED', 'Your session has ended. Please sign in again.') };
  if (!TOKEN_RE.test(token)) return expired;
  const s = await sessionRef(token).get();
  if (!s.exists) return expired;
  const sess = s.data();
  if (sess.expiresAt && sess.expiresAt.toMillis && sess.expiresAt.toMillis() < Date.now()) return expired;
  const row = await adminById(sess.admin_id);
  if (!row || row.status !== 'ACTIVE' || Number(sess.created_ms) < Number(row.pw_epoch || 0)) return expired;
  if (!(await RL.hit('adm:req:' + sess.admin_id, 300, 60))) return { err: U.fail('RATE_LIMITED', 'Too many requests. Please slow down.') };
  if (row.must_change_password && !(opts && opts.allowMustChange)) return { err: U.fail('PASSWORD_CHANGE_REQUIRED', 'Please choose a new password before continuing.') };
  return { admin: row.admin_id, me: row, token };
}
async function ownerAuth(p) {
  const a = await adminAuth(p); if (a.err) return a;
  if (a.me.role !== 'OWNER') return { err: U.fail('FORBIDDEN', 'Only an owner can do this.') };
  return a;
}

/* ---------- login / logout / password ---------- */

async function handleAdminLogin(p, ctx) {
  const email = U.normalizeEmail(p && p.email), pass = String((p && p.password) || '');
  if (!V.EMAIL_RE.test(email) || !pass || pass.length > 200) return U.fail('VALIDATION_ERROR', 'Enter your email and password.');
  const id = U.emailKey(email), failKey = 'adm:fail:' + ctx.ip + ':' + id, ipFailKey = 'adm:fail:ip:' + ctx.ip;

  // Limits are per visitor (IP) and per IP+email, so a stranger can no longer lock the real admins out.
  if (!(await RL.hit('adm:login:ip:' + ctx.ip, 20, W))) return U.fail('RATE_LIMITED', 'Too many attempts. Please wait a few minutes and try again.');
  if ((await RL.count(failKey)) >= 5 || (await RL.count(ipFailKey)) >= 15) {
    await audit('ADMIN_LOGIN_LOCKED', '', '', 'public', 'REJECTED', '', { ttlDays: 30 });
    return U.fail('RATE_LIMITED', 'Too many failed attempts. Please wait about 15 minutes and try again.');
  }
  const snap = await db.collection('admins').limit(1).get();
  if (snap.empty) return U.fail('NOT_CONFIGURED', 'No administrator exists yet. Run "npm run create-owner" first.');

  const v = await verifyPassword(email, pass);
  const row = v.ok ? await adminByEmail(email) : null;
  if (!v.ok || !row || row.status !== 'ACTIVE' || row.uid !== v.uid) {
    await RL.bump(failKey, W); await RL.bump(ipFailKey, W);
    await audit('ADMIN_LOGIN_FAILED', '', '', 'public', 'REJECTED', '', { ttlDays: 30 });
    return U.fail('NOT_AUTHORISED', 'The email or password is not correct.');
  }
  const token = await issueSession(row.admin_id);
  await adminDoc(row.admin_id).update({ last_login: U.nowStamp() });
  await audit('ADMIN_LOGIN_OK', '', '', row.admin_id, 'OK', '');
  return U.ok({ token, expires_in_s: SESSION_TTL_S, me: me(row) });
}

async function handleAdminLogout(p) {
  const token = String((p && p.token) || '');
  if (TOKEN_RE.test(token)) await sessionRef(token).delete();
  return U.ok({ message: 'Signed out.' });
}

async function handleAdminChangePassword(p, ctx) {
  const a = await adminAuth(p, { allowMustChange: true }); if (a.err) return a.err;
  const cur = String((p && p.current_password) || ''), nw = String((p && p.new_password) || '');
  if (!(await RL.hit('adm:chg:' + a.admin, 6, W))) return U.fail('RATE_LIMITED', 'Too many attempts. Please wait a few minutes.');
  const v = await verifyPassword(a.me.email, cur);
  if (!v.ok) {
    await audit('PASSWORD_CHANGE_FAILED', '', '', a.admin, 'REJECTED', '');
    return U.fail('NOT_AUTHORISED', 'Your current password is not correct.', { errors: { current_password: 'Not correct.' } });
  }
  let problem = passwordProblem(nw, a.me.email);
  if (!problem && nw === cur) problem = 'Choose a password different from the current one.';
  if (problem) return U.fail('VALIDATION_ERROR', problem, { errors: { new_password: problem } });

  const now = Date.now();
  await auth.updateUser(a.me.uid, { password: nw });
  await adminDoc(a.admin).update({ must_change_password: false, pw_epoch: now, last_updated: U.nowStamp() });
  await dropSessions(a.admin);
  const token = await issueSession(a.admin, now + 1);
  await audit('PASSWORD_CHANGED', '', '', a.admin, 'OK', '');
  return U.ok({ message: 'Password changed. Other sessions were signed out.', token, me: me(await adminById(a.admin)) });
}

/* ---------- reading ---------- */

async function buildTeams() {
  const snap = await db.collection('registrations').get();
  return snap.docs.map((d) => T.teamView(d.data())).sort((a, b) => (a.registered_on < b.registered_on ? 1 : -1));
}
function reqView(r) {
  return { request_id: r.request_id, created_at: r.created_at, team_code: r.team_code, full_name: r.full_name, contact: r.contact, message: r.message,
    status: r.status, handled_by: r.handled_by, resolution_note: r.resolution_note, last_updated: r.last_updated };
}
function stats(teams) {
  const s = { teams: teams.length, by_status: {}, by_eligibility: {}, participants: 0, by_size: {}, by_course: {} };
  teams.forEach((t) => {
    s.by_status[t.registration_status] = (s.by_status[t.registration_status] || 0) + 1;
    s.by_eligibility[t.eligibility_status] = (s.by_eligibility[t.eligibility_status] || 0) + 1;
    if (t.registration_status === 'CANCELLED') return;
    s.participants += t.team_size;
    s.by_size[t.team_size] = (s.by_size[t.team_size] || 0) + 1;
    t.members.forEach((m) => { const c = m.courses || 'Not given'; s.by_course[c] = (s.by_course[c] || 0) + 1; });
  });
  return s;
}

async function handleAdminData(p) {
  const a = await adminAuth(p); if (a.err) return a.err;
  const [cfg, teams, reqs, admins] = await Promise.all([
    getConfig(true), buildTeams(),
    db.collection('requests').orderBy('created_ms', 'desc').limit(500).get(),
    db.collection('admins').get()
  ]);
  return U.ok({
    me: me(a.me),
    admins_directory: admins.docs.map((d) => ({ admin_id: d.data().admin_id, full_name: d.data().full_name })),
    registration_state: cfg.registration_state, teams, stats: stats(teams),
    requests: reqs.docs.map((d) => reqView(d.data())), requests_available: true,
    courses: V.COURSES, semesters: V.SEMESTERS, generated_at: U.nowStamp()
  });
}

async function handleAdminAudit(p) {
  const a = await adminAuth(p); if (a.err) return a.err;
  const q = await db.collection('auditLog').orderBy('ts_ms', 'desc').limit(150).get();
  return U.ok({ rows: q.docs.map((d) => { const v = d.data(); return { timestamp: v.ts, action: v.action, team_code: v.team_code, actor: v.actor, status: v.status, details: v.details }; }) });
}

/* ---------- writing ---------- */

async function handleAdminTeamUpdate(p) {
  const a = await adminAuth(p); if (a.err) return a.err;
  const code = U.normalizeTeamCode(p.team_code), ch = p.changes;
  if (!V.TEAM_CODE_RE.test(code) || !ch || typeof ch !== 'object' || Array.isArray(ch)) return U.fail('VALIDATION_ERROR', 'The request could not be understood.');
  return T.applyTeamChanges(await getConfig(), code, ch, a.admin, audit);
}

async function handleAdminTeamStatus(p) {
  const a = await adminAuth(p); if (a.err) return a.err;
  const code = U.normalizeTeamCode(p.team_code), reason = U.normalizeSpace(p.reason).slice(0, 200), changes = {}, notes = [];
  if (p.registration_status !== undefined && p.registration_status !== '') {
    const rs = String(p.registration_status).toUpperCase();
    if (['REGISTERED', 'CANCELLED'].indexOf(rs) === -1) return U.fail('VALIDATION_ERROR', 'Registration status must be REGISTERED or CANCELLED.');
    changes.registration_status = rs; notes.push('status=' + rs);
  }
  if (p.eligibility_status !== undefined && p.eligibility_status !== '') {
    const es = String(p.eligibility_status).toUpperCase();
    if (['UNVERIFIED', 'VERIFIED', 'INELIGIBLE'].indexOf(es) === -1) return U.fail('VALIDATION_ERROR', 'Eligibility must be UNVERIFIED, VERIFIED or INELIGIBLE.');
    changes.eligibility_status = es; notes.push('eligibility=' + es);
  }
  if (!V.TEAM_CODE_RE.test(code) || !notes.length) return U.fail('VALIDATION_ERROR', 'The request could not be understood.');
  const out = await T.setTeamStatus(code, changes);
  if (out.success) await audit('ADMIN_STATUS_CHANGED', '', code, a.admin, 'OK', notes.join('; ') + '; reason=' + reason);
  return out;
}

async function handleAdminRequestUpdate(p) {
  const a = await adminAuth(p); if (a.err) return a.err;
  const id = String(p.request_id || ''), status = String(p.status || '').toUpperCase(), note = U.normalizeSpace(p.note).slice(0, 300);
  if (!/^REQ-[A-Z2-9]{8}$/.test(id) || ['OPEN', 'RESOLVED'].indexOf(status) === -1) return U.fail('VALIDATION_ERROR', 'The request could not be understood.');
  const ref = db.collection('requests').doc(id), s = await ref.get();
  if (!s.exists) return U.fail('STATUS_NOT_FOUND', 'No such request.');
  await ref.update({ status, handled_by: a.admin, resolution_note: note, last_updated: U.nowStamp() });
  await audit('REQUEST_' + status, '', '', a.admin, 'OK', 'request=' + id);
  return U.ok({ message: status === 'RESOLVED' ? 'Marked as resolved.' : 'Reopened.', request: reqView((await ref.get()).data()) });
}

async function handleAdminSetRegistration(p) {
  const a = await ownerAuth(p); if (a.err) return a.err;
  const state = String(p.state || '').toUpperCase();
  if (['OPEN', 'CLOSED'].indexOf(state) === -1) return U.fail('VALIDATION_ERROR', 'State must be OPEN or CLOSED.');
  await setConfigValue('registration_status', state);
  await audit('REGISTRATION_' + state, '', '', a.admin, 'OK', 'via dashboard');
  const cfg = await getConfig(true);
  return U.ok({ message: 'Registration switch set to ' + state + '.', registration_state: cfg.registration_state });
}

/* ---------- administrators (OWNER only) ---------- */

async function handleAdminAdminsList(p) {
  const a = await ownerAuth(p); if (a.err) return a.err;
  const q = await db.collection('admins').get();
  return U.ok({ admins: q.docs.map((d) => listView(d.data())) });
}

async function handleAdminAdminCreate(p) {
  const a = await ownerAuth(p); if (a.err) return a.err;
  const errors = {}, name = U.normalizeSpace(p.full_name), mail = U.normalizeEmail(p.email), role = String(p.role || 'ADMIN').toUpperCase();
  if (!V.PERSON_NAME_RE.test(name)) errors.full_name = 'Enter the name (letters, spaces, hyphens, apostrophes, full stops).';
  if (!V.EMAIL_RE.test(mail) || mail.length > 254) errors.email = 'Enter a valid email address.';
  if (ROLES.indexOf(role) === -1) errors.role = 'Choose OWNER or ADMIN.';
  if (Object.keys(errors).length) return U.fail('VALIDATION_ERROR', 'Please correct the highlighted fields.', { errors });
  if (await adminByEmail(mail)) return U.fail('VALIDATION_ERROR', 'An administrator with that email already exists.', { errors: { email: 'Already an administrator.' } });

  const temp = tempPassword(), ts = U.nowStamp();
  let user;
  try { user = await auth.createUser({ email: mail, password: temp, displayName: name }); }
  catch (e) {
    if (e.code === 'auth/email-already-exists') return U.fail('VALIDATION_ERROR', 'That email already has a login. Remove it in the Firebase console first.', { errors: { email: 'Already has a login.' } });
    throw e;
  }
  const id = await newAdminId();
  await adminDoc(id).set({ admin_id: id, uid: user.uid, email: mail, full_name: name, role, status: 'ACTIVE', must_change_password: true,
    pw_epoch: Date.now(), created_at: ts, created_by: a.admin, last_login: '', last_updated: ts });
  await audit('ADMIN_CREATED', '', '', a.admin, 'OK', 'new=' + id + '; role=' + role);
  return U.ok({ message: 'Administrator added. Give them the temporary password now: it will not be shown again.', admin: listView(await adminById(id)), temp_password: temp });
}

async function handleAdminAdminUpdate(p) {
  const a = await ownerAuth(p); if (a.err) return a.err;
  const id = String(p.admin_id || '');
  if (!V.ADMIN_ID_RE.test(id)) return U.fail('VALIDATION_ERROR', 'The request could not be understood.');
  const wantStatus = p.status === undefined || p.status === '' ? '' : String(p.status).toUpperCase();
  const wantRole = p.role === undefined || p.role === '' ? '' : String(p.role).toUpperCase();
  const reset = p.reset_password === true;
  if ((wantStatus && ['ACTIVE', 'DISABLED'].indexOf(wantStatus) === -1) || (wantRole && ROLES.indexOf(wantRole) === -1) || (!wantStatus && !wantRole && !reset)) {
    return U.fail('VALIDATION_ERROR', 'The request could not be understood.');
  }
  if (id === a.admin) return U.fail('FORBIDDEN', 'You cannot change your own role or status, or reset your own password here. Use "Change password" instead.');

  // Inside a transaction, so two owners acting at the same moment can never leave the system with no active owner.
  const res = await db.runTransaction(async (tx) => {
    const s = await tx.get(adminDoc(id));
    if (!s.exists) return { fail: U.fail('STATUS_NOT_FOUND', 'No such administrator.') };
    const row = s.data(), owners = await tx.get(db.collection('admins').where('role', '==', 'OWNER').where('status', '==', 'ACTIVE'));
    const changes = { last_updated: U.nowStamp() }, notes = []; let temp = '';
    if (wantStatus && wantStatus !== row.status) { changes.status = wantStatus; notes.push('status=' + wantStatus); }
    if (wantRole && wantRole !== row.role) { changes.role = wantRole; notes.push('role=' + wantRole); }
    if (reset) { temp = tempPassword(); changes.must_change_password = true; changes.pw_epoch = Date.now(); notes.push('password_reset'); }
    if (!notes.length) return { row, none: true };
    const stillOwner = (changes.role || row.role) === 'OWNER' && (changes.status || row.status) === 'ACTIVE';
    if (row.role === 'OWNER' && row.status === 'ACTIVE' && !stillOwner && owners.size <= 1) return { fail: U.fail('FORBIDDEN', 'There must always be at least one active owner.') };
    tx.update(adminDoc(id), changes);
    return { row, changes, notes, temp };
  });
  if (res.fail) return res.fail;
  if (res.none) return U.ok({ message: 'Nothing to change.', admin: listView(res.row) });

  const authUpd = {};
  if (res.changes.status) authUpd.disabled = res.changes.status === 'DISABLED';
  if (res.temp) authUpd.password = res.temp;
  if (Object.keys(authUpd).length) await auth.updateUser(res.row.uid, authUpd);
  if (res.changes.status === 'DISABLED' || res.temp) await dropSessions(id);
  await audit('ADMIN_UPDATED', '', '', a.admin, 'OK', 'target=' + id + '; ' + res.notes.join('; '));
  const out = { message: 'Updated.', admin: listView(await adminById(id)) };
  if (res.temp) { out.temp_password = res.temp; out.message = 'Password reset. Give them the temporary password now: it will not be shown again. They are signed out everywhere.'; }
  return U.ok(out);
}

module.exports = { adminAuth, ownerAuth, createOrResetOwner, passwordProblem, handleAdminLogin, handleAdminLogout, handleAdminChangePassword, handleAdminData,
  handleAdminAudit, handleAdminTeamUpdate, handleAdminTeamStatus, handleAdminRequestUpdate, handleAdminSetRegistration,
  handleAdminAdminsList, handleAdminAdminCreate, handleAdminAdminUpdate };
