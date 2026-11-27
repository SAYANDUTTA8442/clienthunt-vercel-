'use strict';
/**
 * Round 1 receipts and marking. ADMIN ONLY, and now behind the same token sign-in as the dashboard (the Sheets version
 * accepted just an email address on the admin list). Blind by design: no names or emails are ever returned. Each admin
 * scores independently and sees only their own marks unless config eval_show_others = 1.
 *
 *   eval_list         { token }
 *   eval_log_receipt  { token, team_code, received_at, reference, note }
 *   eval_save_marks   { token, team_code, marks:{problem,case,mail,quote}, comment }   (needs marking_enabled = 1)
 */
const { db } = require('./firebase');
const U = require('./util');
const V = require('./validation');
const { getConfig } = require('./config');
const { audit } = require('./audit');
const { adminAuth } = require('./admin');
const T = require('./teams');

const CRITERIA = [
  { key: 'problem', label: 'Business Problem Analysis & Solution Development' },
  { key: 'case', label: 'Case Study' },
  { key: 'mail', label: 'Professional Mail Writing' },
  { key: 'quote', label: 'Project Quotation' }
];

const configView = (cfg) => ({
  criteria: CRITERIA.map((c) => ({ key: c.key, label: c.label, max: cfg.eval_max[c.key] })),
  marking_enabled: cfg.marking_enabled, results_final: cfg.results_final, show_others: cfg.eval_show_others,
  submission_closes_at: cfg.submission_closes_at, server_time: Date.now()
});
const marksView = (e) => ({ admin_id: e.admin_id, marks: e.marks, total: e.total, comment: e.comment, updated: e.last_updated });

async function views(cfg, adminId, onlyCode) {
  const regs = (await db.collection('registrations').get()).docs.map((d) => d.data()).filter(T.isActive).filter((r) => !onlyCode || r.team_code === onlyCode);
  const subs = {}, evs = {};
  (await db.collection('submissions').get()).docs.forEach((d) => { subs[d.data().team_code] = d.data(); });
  (await db.collection('evaluations').get()).docs.forEach((d) => { const v = d.data(); (evs[v.team_code] = evs[v.team_code] || []).push(v); });
  regs.sort((a, b) => (a.team_code < b.team_code ? -1 : 1));
  return regs.map((r) => {
    const s = subs[r.team_code], list = evs[r.team_code] || [], mine = list.find((e) => e.admin_id === adminId);
    const v = { team_code: r.team_code, team_size: r.team_size,
      received: s ? { received_at: s.received_at, late: s.late, reference: s.reference, note: s.note, logged_by: s.logged_by } : null,
      mine: mine ? marksView(mine) : null, scored_by: list.length };
    if (cfg.eval_show_others) {
      v.all = list.map(marksView).sort((a, b) => (a.admin_id < b.admin_id ? -1 : 1));
      v.average = list.length ? U.round2(list.reduce((t, e) => t + e.total, 0) / list.length) : null;
    }
    return v;
  });
}

async function handleEvalList(p) {
  const a = await adminAuth(p); if (a.err) return a.err;
  const cfg = await getConfig(), teams = await views(cfg, a.admin);
  await audit('EVAL_LIST_VIEWED', '', '', a.admin, 'OK', 'teams=' + teams.length, { ttlDays: 90 });
  return U.ok({ admin_id: a.admin, config: configView(cfg), teams });
}

async function handleEvalReceipt(p) {
  const a = await adminAuth(p); if (a.err) return a.err;
  const cfg = await getConfig();
  if (cfg.results_final) return U.fail('RESULTS_FINAL', 'Results are final, so receipts can no longer be changed.');
  const code = U.normalizeTeamCode(p.team_code), ref = U.normalizeSpace(p.reference), note = U.normalizeSpace(p.note), at = U.parseWhen(p.received_at);
  const errors = {};
  if (!V.TEAM_CODE_RE.test(code)) errors.team_code = 'Enter a valid Team Code, for example CH-26-AB23.';
  if (at === null || isNaN(at)) errors.received_at = 'Enter the date and time the email was received.';
  else if (at > Date.now() + 5 * 60000) errors.received_at = 'That time is in the future.';
  if (ref.length > 300) errors.reference = 'Keep this under 300 characters.';
  if (note.length > 300) errors.note = 'Keep this under 300 characters.';
  if (Object.keys(errors).length) return U.fail('VALIDATION_ERROR', 'Please correct the highlighted fields.', { errors });

  const reg = await T.getReg(code);
  if (!reg || !T.isActive(reg)) return U.fail('TEAM_NOT_FOUND', 'No active team has that Team Code.');
  const closes = cfg.submission_closes_at, subRef = db.collection('submissions').doc(code), existing = (await subRef.get()).exists, now = U.nowStamp();
  await subRef.set({ receipt_id: code, team_code: code, received_at: U.istStamp(at), late: closes === null ? '' : (at > closes ? 'YES' : 'NO'),
    reference: ref, note, logged_by: a.admin, last_updated: now, created_at: existing ? undefined : now }, { merge: true });
  await audit(existing ? 'EVAL_RECEIPT_UPDATED' : 'EVAL_RECEIPT_LOGGED', reg.registration_id, code, a.admin, 'OK', '');
  return U.ok({ message: existing ? 'Receipt updated.' : 'Receipt logged.', team: (await views(cfg, a.admin, code))[0] });
}

async function handleEvalMarks(p) {
  const a = await adminAuth(p); if (a.err) return a.err;
  const cfg = await getConfig();
  if (cfg.results_final) return U.fail('RESULTS_FINAL', 'Results are final, so marks can no longer be changed.');
  if (!cfg.marking_enabled) return U.fail('MARKING_DISABLED', 'Marking is switched off right now. Set marking_enabled to 1 in the config document.');
  const code = U.normalizeTeamCode(p.team_code), marks = (p.marks && typeof p.marks === 'object') ? p.marks : {}, comment = U.normalizeSpace(p.comment);
  const vals = {}, errors = {};
  if (!V.TEAM_CODE_RE.test(code)) errors.team_code = 'Enter a valid Team Code.';
  CRITERIA.forEach((c) => {
    const max = cfg.eval_max[c.key], raw = marks[c.key];
    const n = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) ? Number(raw) : NaN;
    if (!max) errors['marks.' + c.key] = 'The maximum for this criterion is not set in the config.';
    else if (!isFinite(n)) errors['marks.' + c.key] = 'Enter a mark.';
    else if (n < 0 || n > max) errors['marks.' + c.key] = 'Enter a number from 0 to ' + max + '.';
    else if (U.round2(n) !== n) errors['marks.' + c.key] = 'Use at most 2 decimal places.';
    else vals[c.key] = n;
  });
  if (comment.length > 500) errors.comment = 'Keep comments under 500 characters.';
  if (Object.keys(errors).length) return U.fail('VALIDATION_ERROR', 'Please correct the highlighted fields. Nothing was saved.', { errors });

  const reg = await T.getReg(code);
  if (!reg || !T.isActive(reg)) return U.fail('TEAM_NOT_FOUND', 'No active team has that Team Code.');
  const ref = db.collection('evaluations').doc(code + '_' + a.admin), curSnap = await ref.get(), cur = curSnap.exists ? curSnap.data() : null;
  const changed = CRITERIA.filter((c) => !cur || cur.marks[c.key] !== vals[c.key]).map((c) => c.key);
  if (cur && cur.comment !== comment) changed.push('comment');
  if (cur && !changed.length) return U.ok({ message: 'No changes to save.', team: (await views(cfg, a.admin, code))[0] });

  const now = U.nowStamp();
  await ref.set({ evaluation_id: ref.id, team_code: code, admin_id: a.admin, marks: vals, max: cfg.eval_max, total: U.round2(vals.problem + vals.case + vals.mail + vals.quote),
    comment, created_at: cur ? cur.created_at : now, last_updated: now });
  await audit(cur ? 'EVAL_MARKS_UPDATED' : 'EVAL_MARKS_SAVED', reg.registration_id, code, a.admin, 'OK', 'fields=' + changed.join(','));
  return U.ok({ message: 'Marks saved.', team: (await views(cfg, a.admin, code))[0] });
}

module.exports = { handleEvalList, handleEvalReceipt, handleEvalMarks };
