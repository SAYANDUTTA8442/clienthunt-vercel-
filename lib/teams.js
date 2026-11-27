'use strict';
/**
 * Data model (Firestore):
 *   registrations/{TEAM_CODE}   one document per team, members embedded (max 4) so a team is always read/written atomically
 *   memberEmails/{sha256(emailKey)}   { team_code, member_number }: exists ONLY for members of non-cancelled teams.
 *                                     Creating it inside the registration transaction is what makes duplicate members impossible,
 *                                     even under a launch-day rush (the Sheets version needed a global script lock for this).
 */
const { db } = require('./firebase');
const U = require('./util');
const V = require('./validation');

const regRef = (code) => db.collection('registrations').doc(code);
const emailRef = (email) => db.collection('memberEmails').doc(U.sha256(U.emailKey(email)));
const isActive = (reg) => reg.registration_status !== 'CANCELLED';

function memberView(m) {
  return { member_number: m.member_number, full_name: m.full_name, email: m.email, phone: m.phone, courses: m.courses, department: m.department, semester: m.semester };
}
function teamView(reg) {
  return {
    team_code: reg.team_code, team_name: reg.team_name, team_size: reg.team_size,
    registration_status: reg.registration_status, eligibility_status: reg.eligibility_status,
    registered_on: reg.registration_timestamp, last_updated: reg.last_updated,
    members: reg.members.slice().sort((a, b) => a.member_number - b.member_number).map(memberView)
  };
}

async function getReg(code) {
  const s = await regRef(code).get();
  return s.exists ? s.data() : null;
}

/** Email -> { reg, member } for an active team, or null. */
async function findByEmail(email) {
  const s = await emailRef(email).get();
  if (!s.exists) return null;
  const reg = await getReg(s.data().team_code);
  if (!reg || !isActive(reg)) return null;
  const member = reg.members.find((m) => U.emailKey(m.email) === U.emailKey(email));
  return member ? { reg, member } : null;
}

const MEMBER_FIELDS = ['full_name', 'email', 'phone', 'courses', 'department', 'semester'];

/** Validates one member field the same way registration does. Returns { error } or { value }. */
function checkField(cfg, field, raw) {
  const v = U.normalizeSpace(raw);
  let e = '';
  switch (field) {
    case 'full_name': e = V.validatePersonName(v); return e ? { error: e } : { value: v };
    case 'email': { const em = U.normalizeEmail(v); e = V.validateEmailAgainstConfig(em, cfg); return e ? { error: e } : { value: em }; }
    case 'phone': { const ph = V.normalizePhone(v); return ph ? { value: ph } : { error: 'Enter a valid 10-digit Indian mobile number.' }; }
    case 'courses': e = V.validateCourse(v); return e ? { error: e } : { value: v };
    case 'department': e = V.validateDepartment(v); return e ? { error: e } : { value: v };
    case 'semester': e = V.validateSemester(v); return e ? { error: e } : { value: v };
  }
  return { error: 'Unknown field.' };
}

/**
 * Admin edit of a team. Validates every changed value first and writes nothing if any is invalid.
 * Email changes move the memberEmails index entry atomically and refuse addresses that belong to another active team.
 * `ch` = { team_name?, members?: [{ member_number, full_name?, email?, phone?, courses?, department?, semester? }] }
 */
async function applyTeamChanges(cfg, teamCode, ch, actor, audit) {
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(regRef(teamCode));
    if (!snap.exists) return { fail: U.fail('STATUS_NOT_FOUND', 'No team with that code.') };
    const reg = snap.data(), members = reg.members.map((m) => Object.assign({}, m));
    const errors = {}, changedFields = [], emailMoves = [];
    let teamName = reg.team_name;

    if (typeof ch.team_name === 'string' && U.normalizeSpace(ch.team_name) !== reg.team_name) {
      const v = U.normalizeSpace(ch.team_name), e = V.validateTeamName(v);
      if (e) errors.team_name = e; else { teamName = v; changedFields.push('team_name'); }
    }

    (Array.isArray(ch.members) ? ch.members.slice(0, 4) : []).forEach((m, i) => {
      if (!m || typeof m !== 'object') return;
      const cur = members.find((x) => x.member_number === Number(m.member_number));
      if (!cur) return;
      MEMBER_FIELDS.forEach((f) => {
        if (typeof m[f] !== 'string') return;
        const r = checkField(cfg, f, m[f]);
        if (r.error) { errors['members.' + i + '.' + f] = r.error; return; }
        const same = f === 'email' ? U.emailKey(r.value) === U.emailKey(cur.email) : r.value === cur[f];
        if (same) return;
        if (f === 'email') emailMoves.push({ cur, newEmail: r.value, errKey: 'members.' + i + '.email', oldRef: emailRef(cur.email) });
        cur[f] = r.value;
        changedFields.push((cur.member_number === 1 ? 'leader_' : 'member_' + cur.member_number + '_') + f);
      });
    });

    if (!changedFields.length && !Object.keys(errors).length) return { reg, message: 'No changes to save.' };

    // Reads must precede writes in a transaction: check every new address.
    if (isActive(reg)) {
      const mine = {}; members.forEach((x) => { mine[U.emailKey(x.email)] = (mine[U.emailKey(x.email)] || 0) + 1; });
      for (const mv of emailMoves) {
        if (errors[mv.errKey]) continue;
        if (mine[U.emailKey(mv.newEmail)] > 1) { errors[mv.errKey] = 'That email address is already used in this team.'; continue; }
        mv.newRef = emailRef(mv.newEmail);
        mv.newSnap = await tx.get(mv.newRef);
        if (mv.newSnap.exists && mv.newSnap.data().team_code !== teamCode) errors[mv.errKey] = 'That email address already belongs to a registered member.';
      }
    }
    if (Object.keys(errors).length) return { fail: U.fail('VALIDATION_ERROR', 'Please correct the highlighted fields. Nothing was saved.', { errors }) };

    const now = U.nowStamp();
    const upd = { team_name: teamName, members, last_updated: now };
    tx.update(regRef(teamCode), upd);
    if (isActive(reg)) emailMoves.forEach((mv) => {
      if (mv.oldRef.path !== mv.newRef.path) tx.delete(mv.oldRef);
      tx.set(mv.newRef, { team_code: teamCode, member_number: mv.cur.member_number });
    });
    return { reg: Object.assign({}, reg, upd), changedFields, message: 'Saved ' + changedFields.length + ' change' + (changedFields.length === 1 ? '' : 's') + '.' };
  });

  if (outcome.fail) return outcome.fail;
  (outcome.changedFields || []).forEach((f) => audit('ADMIN_EDIT', '', teamCode, actor, 'OK', 'field=' + f));
  return U.ok({ message: outcome.message, team: teamView(outcome.reg) });
}

/** Cancel / restore / eligibility. Cancelling frees the members' emails; restoring re-claims them and refuses clashes. */
async function setTeamStatus(teamCode, changes) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(regRef(teamCode));
    if (!snap.exists) return U.fail('STATUS_NOT_FOUND', 'No team with that code.');
    const reg = snap.data(), upd = { last_updated: U.nowStamp() };
    const goingCancelled = changes.registration_status === 'CANCELLED' && isActive(reg);
    const goingActive = changes.registration_status === 'REGISTERED' && !isActive(reg);

    if (goingActive) {
      const refs = reg.members.map((m) => emailRef(m.email));
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));
      const clash = snaps.findIndex((s) => s.exists && s.data().team_code !== teamCode);
      if (clash !== -1) return U.fail('DUPLICATE_MEMBER', 'This team cannot be restored: member ' + reg.members[clash].member_number + ' is already in another active team.');
      reg.members.forEach((m, i) => tx.set(refs[i], { team_code: teamCode, member_number: m.member_number }));
    }
    if (goingCancelled) reg.members.forEach((m) => tx.delete(emailRef(m.email)));

    if (changes.registration_status) upd.registration_status = changes.registration_status;
    if (changes.eligibility_status) upd.eligibility_status = changes.eligibility_status;
    tx.update(regRef(teamCode), upd);
    return U.ok({ message: 'Team updated.', team: teamView(Object.assign({}, reg, upd)) });
  });
}

module.exports = { regRef, emailRef, isActive, teamView, memberView, getReg, findByEmail, applyTeamChanges, setTeamStatus };
