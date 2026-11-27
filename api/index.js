'use strict';
require('../lib/env');                               // before anything reads process.env (ALLOWED_ORIGINS, Firebase credentials)
/**
 * Single endpoint, same JSON action contract the Apps Script web app had, so the three HTML pages only needed their API_URL changed.
 *   GET  /api?action=config
 *   POST /api   { "action": "register" | "status_check" | "search_team" | "report_problem" | "admin_*" | "eval_*", ... }
 * Body may be text/plain (what the pages send) or application/json. Failures are { success:false, error_code, message }.
 */
const U = require('../lib/util');
const { getConfig } = require('../lib/config');
const { audit } = require('../lib/audit');
const { handleRegister } = require('../lib/registration');
const P = require('../lib/public');
const A = require('../lib/admin');
const E = require('../lib/eval');

const MAX_BODY = 20000;

const ROUTES = {
  register: handleRegister,
  status_check: P.handleStatusCheck,
  search_team: P.handleSearchTeam,
  report_problem: P.handleReportProblem,
  admin_login: A.handleAdminLogin,
  admin_logout: A.handleAdminLogout,
  admin_change_password: A.handleAdminChangePassword,
  admin_admins_list: A.handleAdminAdminsList,
  admin_admin_create: A.handleAdminAdminCreate,
  admin_admin_update: A.handleAdminAdminUpdate,
  admin_data: A.handleAdminData,
  admin_team_update: A.handleAdminTeamUpdate,
  admin_team_status: A.handleAdminTeamStatus,
  admin_request_update: A.handleAdminRequestUpdate,
  admin_set_registration: A.handleAdminSetRegistration,
  admin_audit: A.handleAdminAudit,
  eval_list: E.handleEvalList,
  eval_log_receipt: E.handleEvalReceipt,
  eval_save_marks: E.handleEvalMarks
};

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function cors(req, res) {
  const allowed = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.indexOf(origin) !== -1) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function readBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return JSON.stringify(req.body);
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY * 2) break; chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

const send = (res, obj) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.status(200).send(JSON.stringify(obj)); };

async function internalError(err) {
  console.error('unhandled:', err);
  await audit('SYSTEM_ERROR', '', '', 'system', 'ERROR', U.safeErr(err), { ttlDays: 60 });
  return U.fail('INTERNAL_ERROR', 'Something went wrong on our side. Please try again in a few minutes.');
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') {
      const action = (req.query && req.query.action) || 'config';
      if (action !== 'config') return send(res, U.fail('UNKNOWN_ACTION', 'Unknown action.'));
      const cfg = await getConfig();
      return send(res, U.ok({
        competition_name: cfg.competition_name, registration_state: cfg.registration_state, registration_open: cfg.registration_open,
        opens_at: cfg.opens_at, closes_at: cfg.closes_at, server_time: Date.now(),
        min_team_size: cfg.min_team_size, max_team_size: cfg.max_team_size, allowed_email_domains: cfg.allowed_domains, policy_version: cfg.policy_version
      }));
    }
    if (req.method !== 'POST') return send(res, U.fail('BAD_REQUEST', 'The request could not be understood.'));

    const raw = await readBody(req);
    if (!raw || raw.length > MAX_BODY) return send(res, U.fail('BAD_REQUEST', 'The request could not be understood.'));
    let body; try { body = JSON.parse(raw); } catch (e) { return send(res, U.fail('BAD_REQUEST', 'The request could not be understood.')); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, U.fail('BAD_REQUEST', 'The request could not be understood.'));

    const fn = Object.prototype.hasOwnProperty.call(ROUTES, body.action) ? ROUTES[body.action] : null;
    if (!fn) return send(res, U.fail('UNKNOWN_ACTION', 'Unknown action.'));
    return send(res, await fn(body, { ip: clientIp(req) }));
  } catch (err) {
    return send(res, await internalError(err));
  }
};
