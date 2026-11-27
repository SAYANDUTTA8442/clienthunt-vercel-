'use strict';
const { db } = require('./firebase');
const U = require('./util');
const V = require('./validation');
const { getConfig } = require('./config');
const RL = require('./ratelimit');
const { audit } = require('./audit');
const T = require('./teams');

const W = 15 * 60;   // window for lookup limits, seconds
const GENERIC_FAIL = 'These details do not match a registered team. Check the Team Code and the email address, then try again.';

/** Per-visitor limits (real client IP from Vercel). Returns a failure object or null. */
async function lookupGate(cfg, ctx, tag) {
  if (await RL.count('lookup:fail:ip:' + ctx.ip) >= cfg.rate_lookup_failures_per_ip) return U.fail('RATE_LIMITED', 'Too many failed attempts. Please wait about 15 minutes and try again.');
  if (!(await RL.hit('lookup:ip:' + ctx.ip, cfg.rate_lookups_per_ip, W))) return U.fail('RATE_LIMITED', 'Too many requests. Please wait a few minutes and try again.');
  return null;
}
const lookupFailed = (ctx) => RL.bump('lookup:fail:ip:' + ctx.ip, W);

/** register.html "Check Registration Status": Team Code + a member's email -> read-only status. */
async function handleStatusCheck(p, ctx) {
  const cfg = await getConfig();
  const code = U.normalizeTeamCode(p && p.team_code), email = U.normalizeEmail(p && p.email);
  if (!V.TEAM_CODE_RE.test(code) || !V.EMAIL_RE.test(email)) return U.fail('VALIDATION_ERROR', 'Enter the Team Code (for example CH-26-AB23) and an email address.');
  const gate = await lookupGate(cfg, ctx, 'status'); if (gate) return gate;

  const reg = await T.getReg(code);
  const member = reg ? reg.members.find((m) => U.emailKey(m.email) === U.emailKey(email)) : null;
  if (!reg || !member) {
    await lookupFailed(ctx);
    await audit('STATUS_CHECK_FAILED', '', code, 'public', 'REJECTED', reg ? 'member_mismatch' : 'team_unknown', { ttlDays: 30 });
    return U.fail('STATUS_NOT_FOUND', GENERIC_FAIL);
  }
  await audit('STATUS_CHECK_OK', reg.registration_id, code, 'member:' + member.member_number, 'OK', '', { ttlDays: 90 });
  return U.ok({ team_code: reg.team_code, team_name: reg.team_name, team_size: reg.team_size, registration_status: reg.registration_status,
    registered_on: String(reg.registration_timestamp).slice(0, 10), note: 'Please save these details.' });
}

const maskPhone = (p) => { p = String(p || ''); return p.length > 4 ? p.slice(0, 2) + '******' + p.slice(-2) : ''; };

/** search-team.html: a Team Code OR any member's email -> team details. Emails are never returned. */
async function handleSearchTeam(p, ctx) {
  const cfg = await getConfig();
  // Either a single `query` (Team Code OR member email) or an explicit `team_code` / `email` field. `query` wins if several are sent.
  const q = U.normalizeSpace(p && (p.query || p.team_code || p.email));
  const asCode = U.normalizeTeamCode(q), byCode = V.TEAM_CODE_RE.test(asCode);
  const asEmail = U.normalizeEmail(q), byEmail = !byCode && V.EMAIL_RE.test(asEmail);
  if (!byCode && !byEmail) return U.fail('VALIDATION_ERROR', 'Enter a Team Code (for example CH-26-AB23) or the email address of any team member.');
  const gate = await lookupGate(cfg, ctx, 'search'); if (gate) return gate;

  let reg = null, matched = 0;
  if (byCode) reg = await T.getReg(asCode);
  else if (cfg.allowed_domains.indexOf(asEmail.slice(asEmail.lastIndexOf('@') + 1)) !== -1) {
    const f = await T.findByEmail(asEmail);
    if (f) { reg = f.reg; matched = f.member.member_number; }
  }
  if (!reg) {
    await lookupFailed(ctx);
    await audit('SEARCH_TEAM_FAILED', '', byCode ? asCode : '', 'public', 'REJECTED', byCode ? 'code_unknown' : 'email_no_match', { ttlDays: 30 });
    return U.fail('STATUS_NOT_FOUND', 'No team found. Check the Team Code or use the exact institutional email you registered with.');
  }

  const show = cfg.search_show_contacts;
  const people = reg.members.slice().sort((a, b) => a.member_number - b.member_number).map((m) => ({
    member_number: m.member_number, role: m.member_number === 1 ? 'Team leader' : 'Member', full_name: m.full_name,
    phone: show ? m.phone : maskPhone(m.phone), courses: m.courses, department: m.department, semester: m.semester }));
  await audit('SEARCH_TEAM_OK', reg.registration_id, reg.team_code, 'public', 'OK', (byCode ? 'by_code' : 'by_email') + '; contacts=' + (show ? '1' : '0'), { ttlDays: 90 });
  return U.ok({ team_code: reg.team_code, team_name: reg.team_name, team_size: reg.team_size, registration_status: reg.registration_status,
    eligibility_status: reg.eligibility_status, registered_on: reg.registration_timestamp, last_updated: reg.last_updated,
    contacts_masked: !show, matched_member_number: matched || null, members: people });
}

/** "Report a problem": a row in `requests` that an organiser answers from the dashboard. */
async function handleReportProblem(p, ctx) {
  if (!p || typeof p !== 'object') return U.fail('BAD_REQUEST', 'The request could not be understood.');
  if (p.hp) { await audit('HONEYPOT_REJECTED', '', '', 'public', 'REJECTED', 'report_problem', { ttlDays: 30 }); return U.fail('REQUEST_REJECTED', 'We could not process this request.'); }

  const errors = {};
  const name = U.normalizeSpace(p.full_name);
  if (!name) errors.full_name = 'Enter your name.';
  else if (!V.PERSON_NAME_RE.test(name)) errors.full_name = 'Use letters, spaces, hyphens, apostrophes or full stops only (2–80 characters).';

  const rawContact = U.normalizeSpace(p.contact), phone = V.normalizePhone(rawContact), mail = U.normalizeEmail(rawContact);
  let contact = '';
  if (phone) contact = phone;
  else if (rawContact.length <= 254 && V.EMAIL_RE.test(mail)) contact = mail;
  else errors.contact = 'Enter a 10-digit mobile number or an email address where the organisers can reach you.';

  const teamCode = U.normalizeTeamCode(p.team_code);
  if (teamCode && !V.TEAM_CODE_RE.test(teamCode)) errors.team_code = 'A Team Code looks like CH-26-AB23. Leave it blank if you do not remember it.';

  const message = U.normalizeSpace(p.message);
  if (message.length < 10) errors.message = 'Please describe the problem (at least 10 characters).';
  else if (message.length > 1000) errors.message = 'Please keep the message under 1,000 characters.';
  if (Object.keys(errors).length) return U.fail('VALIDATION_ERROR', 'Please correct the highlighted fields.', { errors });

  if (!(await RL.hit('req:ip:' + ctx.ip, 5, 3600)) || !(await RL.hit('req:contact:' + (phone || U.emailKey(contact)), 3, 3600)) || !(await RL.hit('req:global', 120, 60))) {
    return U.fail('RATE_LIMITED', 'Too many requests. Please wait a while before sending another.');
  }
  const id = 'REQ-' + U.secureRandom(8), ts = U.nowStamp();
  await db.collection('requests').doc(id).set({ request_id: id, created_at: ts, created_ms: Date.now(), team_code: teamCode, full_name: name, contact, message,
    status: 'OPEN', handled_by: '', resolution_note: '', last_updated: ts });
  await audit('PROBLEM_REPORTED', '', teamCode, 'public', 'OK', 'request=' + id);
  return U.ok({ request_id: id, message: 'Your request has been recorded. The Organising Team will contact you using the details you gave.' });
}

module.exports = { handleStatusCheck, handleSearchTeam, handleReportProblem };
