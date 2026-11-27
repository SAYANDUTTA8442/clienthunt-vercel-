'use strict';
const { db } = require('./firebase');
const U = require('./util');
const V = require('./validation');
const { getConfig } = require('./config');
const RL = require('./ratelimit');
const { audit } = require('./audit');
const T = require('./teams');
const I = require('./idempotency');

function gate(cfg) {
  if (cfg.registration_state === 'NOT_STARTED') return U.fail('REGISTRATION_NOT_STARTED', 'Registration has not started yet.');
  if (!cfg.registration_open) return U.fail('REGISTRATION_CLOSED', 'Registration is currently closed.');
  return null;
}

const INTERNAL = () => U.fail('INTERNAL_ERROR', 'We could not complete your registration. No registration was recorded, so it is safe to try again.');
const CONFLICT = () => U.fail('IDEMPOTENCY_KEY_REUSED', 'This request identifier was already used for a different registration. Reload the form and submit again.');
const UNVERIFIABLE = () => U.fail('IDEMPOTENCY_RECORD_UNVERIFIABLE', 'We could not safely confirm an earlier submission with this identifier. Please contact the Organising Team before trying again.');

/** Maps a non-'none' resolveReplay outcome to an API response. Never exposes Firestore details. */
function replayResponse(res) {
  if (res.kind === 'replay' || res.kind === 'backfill') return Object.assign({}, res.result, { replayed: true });
  if (res.kind === 'conflict') return CONFLICT();
  return UNVERIFIABLE();
}

/**
 * Registration is ONE Firestore transaction. Inside it, in this order:
 *   reads : replays/{id} -> (legacy proof read) -> registrations/{code} -> memberEmails/{hash} x members
 *   writes: registrations/{code}, memberEmails x members, replays/{id}      (all or nothing)
 * so a committed registration ALWAYS has its replay record, and two requests sharing a request id can never both commit:
 * Firestore aborts the loser, the SDK re-runs the callback, and the re-run reads the winner's replay document.
 * The callback is side-effect free (no audit, no rate limit) because Firestore may run it several times.
 */
async function handleRegister(p, ctx) {
  if (!p || typeof p !== 'object') return U.fail('BAD_REQUEST', 'The request could not be understood.');

  if (p.hp) {   // honeypot: independent of configuration
    await audit('HONEYPOT_REJECTED', '', '', 'public', 'REJECTED', '', { ttlDays: 30 });
    return U.fail('REQUEST_REJECTED', 'We could not process this request.');
  }

  const idProblem = I.requestIdProblem(p.client_request_id);
  if (idProblem) {
    return U.fail('INVALID_REQUEST_ID', idProblem === 'missing' ? 'The request is missing its identifier. Reload the page and try again.'
      : 'The request identifier is not valid. Reload the page and try again.');
  }
  const requestId = String(p.client_request_id);
  const hash = I.payloadHash(I.canonicalRegistration(p));
  const replayRef = I.replayRef(requestId);

  // Preflight (optimisation only; the transaction below is authoritative). Runs BEFORE the open/closed check so an already
  // committed identical request is still answered after registration closes, and before rate limiting so it costs no attempt.
  const pre = await I.resolveReplay((ref) => ref.get(), await replayRef.get(), hash, Date.now());
  if (pre.kind === 'replay' || pre.kind === 'conflict') return replayResponse(pre);
  if (pre.kind === 'corrupt') { await audit('IDEMPOTENCY_RECORD_INVALID', '', '', 'system', 'ERROR', 'reason=' + pre.reason, { ttlDays: 60 }); return replayResponse(pre); }
  if (pre.kind === 'backfill') {      // legacy record proven against its registration: backfill payload_hash transactionally, then answer
    try {
      const out = await db.runTransaction(async (tx) => {
        const res = await I.resolveReplay((ref) => tx.get(ref), await tx.get(replayRef), hash, Date.now());
        if (res.kind === 'backfill') tx.update(replayRef, res.update);
        return res;
      });
      if (out.kind !== 'none') return replayResponse(out);
    } catch (err) {
      await audit('SYSTEM_ERROR', '', '', 'system', 'ERROR', U.safeErr(err));
      return INTERNAL();
    }
  }

  let cfg = await getConfig();
  const g0 = gate(cfg); if (g0) return g0;
  if (!cfg.allowed_domains.length) {
    await audit('CONFIG_ERROR', '', '', 'system', 'ERROR', 'approved_email_domains is empty');
    return U.fail('NOT_CONFIGURED', 'Registration is not available right now. Please contact the Organising Team.');
  }

  const v = V.validateRegistration(p, cfg);
  if (!v.ok) return U.fail('VALIDATION_ERROR', 'Please correct the highlighted fields.', { errors: v.errors });
  const c = v.clean;

  if (!(await RL.hit('reg:global', cfg.rate_reg_global_per_minute, 60)) ||
      !(await RL.hit('reg:ip:' + ctx.ip, cfg.rate_reg_ip_per_hour, 3600)) ||
      !(await RL.hit('reg:email:' + U.emailKey(c.leader.email), cfg.rate_reg_email_per_hour, 3600))) {
    return U.fail('RATE_LIMITED', 'Too many attempts. Please wait a few minutes and try again.');
  }

  const people = [c.leader].concat(c.members).map((m, i) => ({ member_number: i + 1, full_name: m.full_name, email: m.email, phone: m.phone,
    courses: m.courses, department: m.department, semester: m.semester }));
  const yy = String(cfg.competition_year).slice(-2);

  let result = null;
  for (let attempt = 0; attempt < 6 && !result; attempt++) {
    const teamCode = cfg.code_prefix + '-' + yy + '-' + U.secureRandom(4);
    try {
      result = await db.runTransaction(async (tx) => {
        const nowMs = Date.now();

        // 1-5. authoritative replay check, BEFORE anything that depends on mutable configuration
        const replaySnap = await tx.get(replayRef);
        const res = await I.resolveReplay((ref) => tx.get(ref), replaySnap, hash, nowMs);
        if (res.kind === 'replay') return { out: replayResponse(res) };
        if (res.kind === 'conflict') return { out: replayResponse(res), tag: 'IDEMPOTENCY_CONFLICT' };
        if (res.kind === 'corrupt') return { out: replayResponse(res), tag: 'IDEMPOTENCY_RECORD_INVALID', reason: res.reason };
        if (res.kind === 'backfill') { tx.update(replayRef, res.update); return { out: replayResponse(res) }; }   // reads are all done

        // 6-8. team code, configuration, member emails, duplicates (reads only)
        const codeSnap = await tx.get(T.regRef(teamCode));
        if (codeSnap.exists) return { retry: true };

        const cfgNow = await getConfig(true);                       // organisers may have closed registration meanwhile
        const g1 = gate(cfgNow); if (g1) return { out: g1 };

        const refs = people.map((m) => T.emailRef(m.email));
        const snaps = await Promise.all(refs.map((r) => tx.get(r)));
        const owned = snaps.map((s) => (s.exists ? s.data().team_code : ''));
        const conflicts = owned.map((o, i) => (o ? i : -1)).filter((i) => i !== -1);

        if (conflicts.length) {
          const first = owned[conflicts[0]];
          if (conflicts.length === people.length && owned.every((o) => o === first)) {
            const existing = await tx.get(T.regRef(first));
            if (existing.exists && existing.data().team_size === people.length) {
              return { out: U.fail('ALREADY_REGISTERED', 'A registration with exactly this team already exists. Use “Check Registration Status” to retrieve your Team Code. You do not need to register again.'), tag: 'ALREADY_REGISTERED' };
            }
          }
          const errors = {};
          conflicts.forEach((i) => { errors[i === 0 ? 'leader.email' : 'members.' + (i - 1) + '.email'] = 'This email address is already associated with another team.'; });
          return { out: U.fail('DUPLICATE_MEMBER', 'This email address is already associated with another team.', { errors }), tag: 'DUPLICATE_REJECTED' };
        }

        // 9-13. all reads done: build the result and write registration + email indexes + replay record together
        const ts = U.istStamp(nowMs), registrationId = 'REG-' + U.secureRandom(10);
        const out = U.ok({ registration_id: registrationId, team_code: teamCode, registration_status: 'REGISTERED', message: 'Team registration completed successfully.' });
        tx.create(T.regRef(teamCode), {
          registration_id: registrationId, team_code: teamCode, team_name: c.team_name, team_size: people.length,
          registration_status: 'REGISTERED', eligibility_status: 'UNVERIFIED',
          registration_timestamp: ts, last_updated: ts, members: people,
          declarations: { accepted: true, policy_version: cfgNow.policy_version, accepted_at: ts }
        });
        refs.forEach((r, i) => tx.create(r, { team_code: teamCode, member_number: i + 1 }));
        const doc = I.buildReplayDoc(hash, out, nowMs);
        if (replaySnap.exists) tx.set(replayRef, doc);               // replaces an EXPIRED record that TTL has not deleted yet
        else tx.create(replayRef, doc);
        return { out, created: { registrationId, teamCode } };
      });
    } catch (err) {
      await audit('SYSTEM_ERROR', '', '', 'system', 'ERROR', U.safeErr(err));
      return INTERNAL();
    }
    if (result.retry) result = null;
  }
  if (!result) return INTERNAL();

  // Audit only AFTER the commit, and only for a registration this call actually created (a replay never reaches `created`).
  if (result.created) await audit('REGISTRATION_CREATED', result.created.registrationId, result.created.teamCode, 'public', 'OK', 'size=' + people.length + '; policy=' + cfg.policy_version);
  else if (result.tag === 'IDEMPOTENCY_RECORD_INVALID') await audit(result.tag, '', '', 'system', 'ERROR', 'reason=' + result.reason, { ttlDays: 60 });
  else if (result.tag) await audit(result.tag, '', '', 'public', 'REJECTED', '', { ttlDays: 30 });

  return result.out;
}

module.exports = { handleRegister, gate };
