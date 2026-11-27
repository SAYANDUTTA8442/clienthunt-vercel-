'use strict';
/**
 * Central environment loading. Every module that reads process.env (directly or through lib/firebase.js) requires this first,
 * so no entry point depends on the order of its own imports.
 *
 * Precedence, highest first:
 *   1. variables already in process.env (shell exports, CI, Vercel-injected values): NEVER overwritten
 *   2. .env.local   (local overrides)
 *   3. .env         (fallback)
 *
 * Files are resolved from the PROJECT ROOT (the parent of lib/), never from process.cwd(), so scripts work from any directory.
 * Files are parsed (dotenv.parse) and merged here instead of calling dotenv.config() twice, because dotenv's "override:false"
 * means first-writer-wins: loading .env first would make .env beat .env.local. We read .env.local first and let .env only fill gaps.
 *
 * On a deployed Vercel runtime (VERCEL set and VERCEL_ENV != 'development') files are not read at all.
 * Nothing here ever prints or returns a value, only variable names.
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FILES = ['.env.local', '.env'];                  // highest precedence first

const isDeployed = (env) => !!env.VERCEL && env.VERCEL_ENV !== 'development';
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Parsed variables, or null when the file is simply absent. Errors never include file contents. */
function readEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
    throw new Error('Could not read ' + path.basename(file) + ' (' + e.code + ').');
  }
  return dotenv.parse(text.replace(/^\uFEFF/, ''));
}

/**
 * @param {{rootDir?:string, env?:object}} [opts]  both injectable for tests
 * @returns {{skipped:string|null, files:string[], applied:string[], sources:Object<string,string>}}  names only
 */
function loadEnv(opts) {
  opts = opts || {};
  const rootDir = opts.rootDir || PROJECT_ROOT, env = opts.env || process.env;
  const result = { skipped: null, files: [], applied: [], sources: {} };
  if (env.CLIENTHUNT_SKIP_ENV_FILES === '1') { result.skipped = 'disabled'; return result; }   // used by the test suites
  if (isDeployed(env)) { result.skipped = 'deployed'; return result; }

  for (const name of FILES) {
    const vars = readEnvFile(path.join(rootDir, name));
    if (!vars) continue;
    result.files.push(name);
    for (const key of Object.keys(vars)) {
      if (has(env, key)) continue;                                  // process.env, or .env.local, already decided this key
      env[key] = vars[key];
      result.applied.push(key); result.sources[key] = name;
    }
  }
  return result;
}

const loaded = loadEnv();       // runs once per process (Node caches the module)

module.exports = { loadEnv, readEnvFile, isDeployed, PROJECT_ROOT, FILES, loaded };
