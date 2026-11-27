'use strict';
const { db } = require('./firebase');
const U = require('./util');

/** [key, value, description]. Stored in Firestore doc config/main as { key: value }. Existing values are never overwritten by seeding. */
const DEFAULT_CONFIG = [
  ['competition_name', 'ClientHunt'],
  ['competition_year', '2026'],
  ['registration_status', 'OPEN'],            // master switch: OPEN, CLOSED or NOT_STARTED. Anything else = CLOSED
  ['registration_opens_at', ''],              // optional, e.g. 2026-11-09 10:00 (IST unless an offset is given)
  ['registration_closes_at', ''],
  ['min_team_size', '1'],
  ['max_team_size', '4'],
  ['approved_email_domains', 'iitp.ac.in'],   // comma-separated. VERIFY BEFORE LAUNCH; empty closes registration
  ['policy_version', '2026-v1'],
  ['organiser_contact_email', 'freelanthropy.iitpatna@gmail.com'],
  ['team_code_prefix', 'CH'],
  ['rate_registrations_per_ip_per_hour', '20'],
  ['rate_registrations_per_email_per_hour', '6'],
  ['rate_registrations_global_per_minute', '300'],
  ['search_team_show_contacts', '0'],         // 1 = show members' phone numbers on the public lookup page. Emails are never shown.
  ['rate_lookups_per_ip_per_15min', '20'],
  ['rate_lookup_failures_per_ip_per_15min', '8'],
  ['submission_closes_at', ''],
  ['eval_max_problem', '25'],                 // PLACEHOLDERS: set the real maxima before marking
  ['eval_max_case', '25'],
  ['eval_max_mail', '25'],
  ['eval_max_quote', '25'],
  ['marking_enabled', '0'],
  ['results_final', '0'],
  ['eval_show_others', '0']
];

let cache = { at: 0, map: null };
const TTL_MS = 10000;   // instances reuse the config for 10s; a dashboard change is visible within that

async function readMap(force) {
  if (!force && cache.map && Date.now() - cache.at < TTL_MS) return cache.map;
  const map = {};
  DEFAULT_CONFIG.forEach((r) => { map[r[0]] = r[1]; });
  const snap = await db.collection('config').doc('main').get();
  if (snap.exists) Object.entries(snap.data()).forEach(([k, v]) => { if (v !== null && v !== undefined) map[k] = String(v).trim(); });
  cache = { at: Date.now(), map };
  return map;
}

async function getConfig(force) {
  const map = await readMap(force);
  const opensMs = U.parseWhen(map.registration_opens_at), closesMs = U.parseWhen(map.registration_closes_at);
  const state = U.registrationState(map.registration_status, opensMs, closesMs, Date.now());
  const submissionCloses = U.parseWhen(map.submission_closes_at);
  return {
    competition_name: map.competition_name,
    competition_year: map.competition_year,
    registration_state: state,
    registration_open: state === 'OPEN',
    opens_at: isNaN(opensMs) ? null : opensMs,
    closes_at: isNaN(closesMs) ? null : closesMs,
    min_team_size: U.toInt(map.min_team_size, 1),
    max_team_size: U.toInt(map.max_team_size, 4),
    allowed_domains: String(map.approved_email_domains).split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
    policy_version: map.policy_version,
    contact_email: map.organiser_contact_email,
    code_prefix: String(map.team_code_prefix || 'CH').toUpperCase(),
    rate_reg_ip_per_hour: U.toInt(map.rate_registrations_per_ip_per_hour, 20),
    rate_reg_email_per_hour: U.toInt(map.rate_registrations_per_email_per_hour, 6),
    rate_reg_global_per_minute: U.toInt(map.rate_registrations_global_per_minute, 300),
    search_show_contacts: String(map.search_team_show_contacts).trim() === '1',
    rate_lookups_per_ip: U.toInt(map.rate_lookups_per_ip_per_15min, 20),
    rate_lookup_failures_per_ip: U.toInt(map.rate_lookup_failures_per_ip_per_15min, 8),
    submission_closes_at: submissionCloses === null || isNaN(submissionCloses) ? null : submissionCloses,
    eval_max: { problem: U.evalMax(map.eval_max_problem), case: U.evalMax(map.eval_max_case), mail: U.evalMax(map.eval_max_mail), quote: U.evalMax(map.eval_max_quote) },
    marking_enabled: String(map.marking_enabled).trim() === '1',
    results_final: String(map.results_final).trim() === '1',
    eval_show_others: String(map.eval_show_others).trim() === '1'
  };
}

async function setConfigValue(key, value) {
  await db.collection('config').doc('main').set({ [key]: String(value) }, { merge: true });
  cache = { at: 0, map: null };
}

module.exports = { DEFAULT_CONFIG, getConfig, setConfigValue };
