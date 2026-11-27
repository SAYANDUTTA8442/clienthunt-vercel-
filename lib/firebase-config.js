'use strict';
/** Pure configuration parsing for lib/firebase.js. Error messages never contain any part of a secret value. */

class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; this.code = 'CLIENTHUNT_CONFIG'; }
}

const REQUIRED_FIELDS = ['project_id', 'client_email', 'private_key'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const NOT_JSON = 'FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON (or Base64-encoded JSON). In a .env file the JSON must be on ONE line: ' +
  'wrap it in single quotes, or use the Base64 form (base64 -w0 service-account.json).';

/** Raw JSON or Base64-encoded JSON -> service-account object with real newlines in private_key. */
function parseServiceAccount(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new ConfigError('FIREBASE_SERVICE_ACCOUNT is not set. Put it in .env.local or .env (see .env.example) or export it in the environment.');
  }
  let text = String(raw).trim();
  if (text[0] !== '{') {
    if (!/^[A-Za-z0-9+/_=\-\s]+$/.test(text)) throw new ConfigError(NOT_JSON);
    text = Buffer.from(text, 'base64').toString('utf8').trim();
  }
  let sa;
  try { sa = JSON.parse(text); } catch (_) { throw new ConfigError(NOT_JSON); }      // never forward e.message: it can quote the input
  if (!isObj(sa)) throw new ConfigError(NOT_JSON);

  const missing = REQUIRED_FIELDS.filter((k) => typeof sa[k] !== 'string' || !sa[k].trim());
  if (missing.length) throw new ConfigError('FIREBASE_SERVICE_ACCOUNT is missing required field(s): ' + missing.join(', ') + '.');

  sa.private_key = sa.private_key.replace(/\\n/g, '\n');                               // escaped \n -> real newlines
  if (!/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]+-----END (?:[A-Z]+ )?PRIVATE KEY-----/.test(sa.private_key)) {
    throw new ConfigError('FIREBASE_SERVICE_ACCOUNT.private_key is not a complete PEM private key (truncated or mis-pasted?).');
  }
  return sa;
}

/** Decides how Firebase Admin is initialised. Throws ConfigError; returns { mode:'emulator', projectId } | { mode:'credential', serviceAccount }. */
function resolveFirebaseInit(env) {
  if (env.FIRESTORE_EMULATOR_HOST) {
    // Local emulator tests only. Refuse on Vercel so production can never silently point at an emulator.
    if (env.VERCEL) throw new ConfigError('FIRESTORE_EMULATOR_HOST must not be set on Vercel');
    return { mode: 'emulator', projectId: env.GCLOUD_PROJECT || 'demo-clienthunt' };
  }
  return { mode: 'credential', serviceAccount: parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT) };
}

module.exports = { ConfigError, parseServiceAccount, resolveFirebaseInit, REQUIRED_FIELDS };
