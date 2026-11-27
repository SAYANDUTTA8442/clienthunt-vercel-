'use strict';
// npm run check-env : reports which env files were found, where each setting came from and whether it is usable.
// Prints NAMES and verdicts only, never values. Makes no network calls and does not initialise Firebase.
const { loaded } = require('../lib/env');
const { parseServiceAccount, ConfigError } = require('../lib/firebase-config');

const env = process.env, src = (k) => (loaded.sources[k] ? 'from ' + loaded.sources[k] : (k in env ? 'from the process environment' : 'not set'));
let bad = false;
console.log('env files found: ' + (loaded.files.length ? loaded.files.join(', ') : 'none') + (loaded.skipped ? ' (file loading skipped: ' + loaded.skipped + ')' : ''));

if (env.FIRESTORE_EMULATOR_HOST) {
  console.log(env.VERCEL ? 'FAIL FIRESTORE_EMULATOR_HOST is set on Vercel' : 'OK   Firestore EMULATOR mode (FIRESTORE_EMULATOR_HOST, ' + src('FIRESTORE_EMULATOR_HOST') + ')');
  if (env.VERCEL) bad = true;
} else {
  try { const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT); console.log('OK   FIREBASE_SERVICE_ACCOUNT valid, project_id=' + sa.project_id + ' (' + src('FIREBASE_SERVICE_ACCOUNT') + ')'); }
  catch (e) { if (!(e instanceof ConfigError)) throw e; console.log('FAIL ' + e.message); bad = true; }
}

const key = env.FIREBASE_WEB_API_KEY;
if (!key) { console.log('FAIL FIREBASE_WEB_API_KEY not set (admin sign-in will not work)'); bad = true; }
else console.log('OK   FIREBASE_WEB_API_KEY set (' + src('FIREBASE_WEB_API_KEY') + ')' + (key.length < 30 ? '  WARNING: only ' + key.length + ' characters; Firebase Web API keys are normally 39. Is it truncated?' : ''));

const salt = env.RATE_SALT;
if (!salt) console.log('WARN RATE_SALT not set (a weak built-in default is used)');
else if (/change-me/i.test(salt) || salt.length < 16) console.log('WARN RATE_SALT is the placeholder or shorter than 16 characters: set a long random value before launch');
else console.log('OK   RATE_SALT set (' + src('RATE_SALT') + ')');
console.log((env.ALLOWED_ORIGINS ? 'OK   ' : 'info ') + 'ALLOWED_ORIGINS ' + (env.ALLOWED_ORIGINS ? 'set (' + src('ALLOWED_ORIGINS') + ')' : 'empty (only needed when the frontend is on another origin)'));
process.exit(bad ? 1 : 0);
