'use strict';
const { normalizeSpace, normalizeEmail, emailKey } = require('./util');

const COURSES = ['B.Tech', 'BS', 'BS-MS Dual Degree', 'B.Sc.', 'BBA', 'M.Tech', 'M.Sc.', 'MBA', 'PhD', 'Other'];
const SEMESTERS = ['1st Semester', '2nd Semester', '3rd Semester', '4th Semester', '5th Semester',
  '6th Semester', '7th Semester', '8th Semester', '9th Semester', '10th Semester'];

const TEAM_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} .,&'’()\-_!:#]{1,59}$/u;
const PERSON_NAME_RE = /^\p{L}[\p{L}\p{M}.'’\- ]{1,79}$/u;
const EMAIL_RE = /^[a-z0-9][a-z0-9._%+\-]*@[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?)+$/;
const PHONE_RE = /^[6-9][0-9]{9}$/;
const TEAM_CODE_RE = /^[A-Z]{2,4}-[0-9]{2}-[A-Z0-9]{4}$/;
const DEPARTMENT_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} .,&'’()\-\/]{1,99}$/u;
const REQUEST_ID_RE = /^[A-Za-z0-9\-]{16,64}$/;
const ADMIN_ID_RE = /^ADM-[A-Z2-9]{6}$/;

/** Accepts 9876543210, +91 98765 43210, 91-9876543210, 09876543210. Returns 10 digits or ''. */
function normalizePhone(v) {
  let s = normalizeSpace(v).replace(/[\s\-().]/g, '');
  if (/^\+91/.test(s)) s = s.slice(3);
  else if (/^91[0-9]{10}$/.test(s)) s = s.slice(2);
  else if (/^0[0-9]{10}$/.test(s)) s = s.slice(1);
  return PHONE_RE.test(s) ? s : '';
}

function validateEmailAgainstConfig(email, cfg) {
  if (email.length > 254 || !EMAIL_RE.test(email)) return 'Enter a valid email address.';
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (cfg.allowed_domains.indexOf(domain) === -1) {
    return 'Use your IIT Patna institutional email address (@' + cfg.allowed_domains.join(' or @') + ').';
  }
  return '';
}

function validatePersonName(name) {
  if (!name) return 'Enter the full name.';
  if (!PERSON_NAME_RE.test(name)) return 'Use letters, spaces, hyphens, apostrophes or full stops only (2–80 characters).';
  return '';
}
const validateChoice = (v, list, msg) => (list.indexOf(v) === -1 ? msg : '');
const validateCourse = (v) => validateChoice(v, COURSES, 'Select a course.');
const validateSemester = (v) => validateChoice(v, SEMESTERS, 'Select a semester.');
function validateDepartment(v) {
  if (!v) return 'Enter the department.';
  if (!DEPARTMENT_RE.test(v)) return 'Enter a valid department name (2–100 characters).';
  return '';
}
function validateTeamName(v) {
  if (!v) return 'Enter your team name.';
  if (!TEAM_NAME_RE.test(v)) return 'Use 2–60 characters, starting with a letter or number. Letters, numbers, spaces and . , & \' ( ) - _ ! : # are allowed.';
  return '';
}

const DECLARATIONS = ['eligibility', 'participation_consent', 'information_accuracy', 'rules_acceptance'];

/** Returns { ok, errors, clean }. `errors` is keyed by field path (team_name, leader.email, members.0.full_name, declarations...). */
function validateRegistration(p, cfg) {
  const errors = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, errors: { _form: 'Invalid request.' }, clean: null };
  const clean = { leader: {}, members: [] };

  clean.team_name = normalizeSpace(p.team_name);
  const tn = validateTeamName(clean.team_name); if (tn) errors.team_name = tn;

  let size = typeof p.team_size === 'number' ? p.team_size : parseInt(p.team_size, 10);
  if (!isFinite(size) || Math.floor(size) !== size || size < cfg.min_team_size || size > cfg.max_team_size) {
    errors.team_size = 'Choose a team size between ' + cfg.min_team_size + ' and ' + cfg.max_team_size + '.';
    size = null;
  }
  clean.team_size = size;

  const person = (src) => ({
    full_name: normalizeSpace(src.full_name), email: normalizeEmail(src.email), phone: normalizePhone(src.phone),
    courses: normalizeSpace(src.courses), department: normalizeSpace(src.department), semester: normalizeSpace(src.semester)
  });
  const check = (rec, path) => {
    let e;
    if ((e = validatePersonName(rec.full_name))) errors[path + '.full_name'] = e;
    if ((e = validateEmailAgainstConfig(rec.email, cfg))) errors[path + '.email'] = e;
    if (!rec.phone) errors[path + '.phone'] = 'Enter a valid 10-digit Indian mobile number.';
    if ((e = validateCourse(rec.courses))) errors[path + '.courses'] = e;
    if ((e = validateDepartment(rec.department))) errors[path + '.department'] = e;
    if ((e = validateSemester(rec.semester))) errors[path + '.semester'] = e;
  };

  const L = (p.leader && typeof p.leader === 'object') ? p.leader : {};
  clean.leader = person(L);
  check(clean.leader, 'leader');

  const members = Array.isArray(p.members) ? p.members : null;
  if (size !== null) {
    const expected = size - 1;
    if (!members || members.length !== expected) {
      errors.members = 'This team size needs exactly ' + expected + ' additional member' + (expected === 1 ? '' : 's') + '.';
    } else {
      members.forEach((m, i) => {
        const rec = person((m && typeof m === 'object') ? m : {});
        clean.members.push(rec);
        check(rec, 'members.' + i);
      });
    }
  }

  // Duplicate emails inside the same request (alias-aware)
  const seen = {};
  if (!errors['leader.email']) seen[emailKey(clean.leader.email)] = 'leader.email';
  clean.members.forEach((m, i) => {
    const f = 'members.' + i + '.email';
    if (errors[f]) return;
    const k = emailKey(m.email);
    if (seen[k]) {
      errors[f] = seen[k] === 'leader.email'
        ? 'This is the team leader’s email address. Each member needs their own.'
        : 'This email address is used more than once in your team.';
    } else seen[k] = f;
  });

  const D = (p.declarations && typeof p.declarations === 'object') ? p.declarations : {};
  if (DECLARATIONS.some((k) => D[k] !== true)) errors.declarations = 'Please accept all four declarations to submit.';

  return { ok: Object.keys(errors).length === 0, errors, clean };
}

module.exports = { COURSES, SEMESTERS, DECLARATIONS, TEAM_NAME_RE, PERSON_NAME_RE, EMAIL_RE, PHONE_RE, TEAM_CODE_RE, REQUEST_ID_RE, ADMIN_ID_RE,
  normalizePhone, validateEmailAgainstConfig, validatePersonName, validateCourse, validateSemester, validateDepartment, validateTeamName,
  validateRegistration };
