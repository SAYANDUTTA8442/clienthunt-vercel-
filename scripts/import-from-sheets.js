'use strict';
/**
 * One-time import of the existing Google Sheets data.
 *   1. In the old spreadsheet, File > Download > CSV for the tabs: Registrations, TeamMembers (required), Requests (optional).
 *   2. Put them in ./exports/ as Registrations.csv, TeamMembers.csv, Requests.csv
 *   3. npm run import            (dry run: prints what it would do)
 *      npm run import -- --apply (writes to Firestore)
 * Team Codes are kept, so teams that already hold a code keep working. Cancelled teams are imported without claiming their emails.
 * PENDING rows (failed writes) are skipped. Re-running is safe: existing teams are left alone.
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const boot = require('./_boot');                   // loads .env.local / .env before any Firebase import
const { db } = boot('../lib/firebase');
const U = require('../lib/util');
const T = boot('../lib/teams');

const dir = path.join(__dirname, '..', 'exports'), apply = process.argv.includes('--apply');
const read = (f, required) => {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) { if (required) throw new Error('Missing ' + p); return []; }
  return parse(fs.readFileSync(p, 'utf8'), { columns: true, skip_empty_lines: true, bom: true, trim: true });
};

(async () => {
  const regs = read('Registrations.csv', true), mems = read('TeamMembers.csv', true), reqs = read('Requests.csv', false);
  const byReg = {}; mems.forEach((m) => { (byReg[m.registration_id] = byReg[m.registration_id] || []).push(m); });
  const stats = { teams: 0, skipped_pending: 0, skipped_existing: 0, skipped_bad: 0, cancelled: 0, requests: 0 };

  for (const r of regs) {
    if (r.registration_status === 'PENDING') { stats.skipped_pending++; continue; }
    const list = (byReg[r.registration_id] || []).sort((a, b) => Number(a.member_number) - Number(b.member_number));
    if (!list.length || list.length !== Number(r.team_size)) { console.warn('SKIP (member count mismatch):', r.team_code); stats.skipped_bad++; continue; }
    const ref = T.regRef(r.team_code);
    if ((await ref.get()).exists) { stats.skipped_existing++; continue; }
    const members = list.map((m, i) => ({ member_number: i + 1, full_name: m.full_name, email: U.normalizeEmail(m.institutional_email), phone: m.phone,
      courses: m.courses || '', department: m.department || '', semester: m.semester || '' }));
    const active = r.registration_status !== 'CANCELLED'; if (!active) stats.cancelled++;
    stats.teams++;
    if (!apply) continue;
    const batch = db.batch();
    batch.set(ref, { registration_id: r.registration_id, team_code: r.team_code, team_name: r.team_name, team_size: members.length,
      registration_status: r.registration_status, eligibility_status: r.eligibility_status || 'UNVERIFIED',
      registration_timestamp: r.registration_timestamp, last_updated: r.last_updated || r.registration_timestamp, members,
      declarations: { accepted: true, policy_version: 'imported', accepted_at: r.registration_timestamp } });
    if (active) members.forEach((m) => batch.set(T.emailRef(m.email), { team_code: r.team_code, member_number: m.member_number }));
    await batch.commit();
  }
  for (const q of reqs) {
    stats.requests++;
    if (apply) await db.collection('requests').doc(q.request_id).set({ request_id: q.request_id, created_at: q.created_at, created_ms: Date.parse(q.created_at) || Date.now(),
      team_code: q.team_code, full_name: q.full_name, contact: q.contact, message: q.message, status: q.status || 'OPEN', handled_by: '', resolution_note: q.resolution_note || '', last_updated: q.last_updated || q.created_at }, { merge: true });
  }
  console.log((apply ? 'IMPORTED ' : 'DRY RUN (nothing written). Would import ') + JSON.stringify(stats));
  if (!apply) console.log('Run again with --apply to write.');
})().catch((e) => { console.error(e); process.exit(1); });
