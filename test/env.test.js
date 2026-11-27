'use strict';
// Environment loading + Firebase configuration tests. No real credentials anywhere: every key is generated at run time.
const H = require('./helpers');            // sets CLIENTHUNT_SKIP_ENV_FILES=1 for THIS process and injects the Firestore model
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const E = require('../lib/env');
const C = require('../lib/firebase-config');

const ROOT = path.resolve(__dirname, '..');
const tmpDirs = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-env-')); tmpDirs.push(d); return d; };
after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));   // retries: Windows can hold handles briefly

const KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const sa = (project) => ({ type: 'service_account', project_id: project || 'test-project', private_key_id: 'not-a-real-id', private_key: KEY, client_email: 'svc@' + (project || 'test-project') + '.iam.gserviceaccount.com' });
const oneLine = (o) => JSON.stringify(o);                                   // private_key newlines become literal \n
const asEnvLine = (o) => "FIREBASE_SERVICE_ACCOUNT='" + oneLine(o) + "'";   // single quotes: dotenv keeps \n literal

function load(files, env) {
  const dir = mkdir(); for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
  const e = Object.assign({}, env); return { env: e, result: E.loadEnv({ rootDir: dir, env: e }), dir };
}

/* ---------------- precedence ---------------- */

test('only .env exists: variables load', () => { const { env } = load({ '.env': 'A=from-env\nB=2' }); assert.deepStrictEqual([env.A, env.B], ['from-env', '2']); });
test('only .env.local exists: variables load', () => { const { env } = load({ '.env.local': 'A=from-local' }); assert.strictEqual(env.A, 'from-local'); });
test('both files: .env.local takes precedence over .env', () => { const { env, result } = load({ '.env': 'A=env', '.env.local': 'A=local' }); assert.strictEqual(env.A, 'local'); assert.strictEqual(result.sources.A, '.env.local'); });
test('variable only in .env: fallback works while .env.local exists', () => { const { env, result } = load({ '.env': 'ONLY_ENV=x', '.env.local': 'OTHER=y' }); assert.strictEqual(env.ONLY_ENV, 'x'); assert.strictEqual(result.sources.ONLY_ENV, '.env'); });
test('variable only in .env.local: local override works', () => { const { env } = load({ '.env': 'OTHER=x', '.env.local': 'ONLY_LOCAL=y' }); assert.strictEqual(env.ONLY_LOCAL, 'y'); });
test('process variable beats .env', () => { const { env } = load({ '.env': 'A=env' }, { A: 'process' }); assert.strictEqual(env.A, 'process'); });
test('process variable beats .env.local', () => { const { env, result } = load({ '.env.local': 'A=local', '.env': 'A=env' }, { A: 'process' }); assert.strictEqual(env.A, 'process'); assert.ok(!result.applied.includes('A')); });
test('an empty process variable still counts as set and is not overwritten (dotenv semantics)', () => { const { env } = load({ '.env': 'A=env' }, { A: '' }); assert.strictEqual(env.A, ''); });
test('missing files: no crash, nothing applied', () => { const { result } = load({}); assert.deepStrictEqual(result, { skipped: null, files: [], applied: [], sources: {} }); });
test('a directory named .env is ignored; BOM and comments are handled', () => {
  const dir = mkdir(); fs.mkdirSync(path.join(dir, '.env')); fs.writeFileSync(path.join(dir, '.env.local'), '\uFEFF# comment\nA=1 # trailing\n');
  const env = {}; E.loadEnv({ rootDir: dir, env }); assert.strictEqual(env.A, '1');
});
test('files are read from rootDir, never from process.cwd()', () => {
  const dir = mkdir(); fs.writeFileSync(path.join(dir, '.env'), 'ROOTED=yes');
  const other = mkdir(); fs.writeFileSync(path.join(other, '.env'), 'ROOTED=wrong');
  const old = process.cwd(); process.chdir(other);
  try { const env = {}; E.loadEnv({ rootDir: dir, env }); assert.strictEqual(env.ROOTED, 'yes'); } finally { process.chdir(old); }
});
test('loading twice is harmless (idempotent)', () => { const { env, dir } = load({ '.env': 'A=1' }); const r2 = E.loadEnv({ rootDir: dir, env }); assert.deepStrictEqual(r2.applied, []); assert.strictEqual(env.A, '1'); });
test('the test switch disables file loading', () => { const dir = mkdir(); fs.writeFileSync(path.join(dir, '.env'), 'A=1'); const env = { CLIENTHUNT_SKIP_ENV_FILES: '1' }; assert.strictEqual(E.loadEnv({ rootDir: dir, env }).skipped, 'disabled'); assert.ok(!('A' in env)); });

/* ---------------- Vercel ---------------- */

test('Vercel (production/preview): local files are not read, injected values stay authoritative', () => {
  for (const vercelEnv of ['production', 'preview', undefined]) {
    const { env, result } = load({ '.env.local': 'A=local\nEXTRA=x', '.env': 'A=env' }, { VERCEL: '1', VERCEL_ENV: vercelEnv, A: 'injected' });
    assert.strictEqual(env.A, 'injected'); assert.ok(!('EXTRA' in env)); assert.strictEqual(result.skipped, 'deployed');
  }
});
test('`vercel dev` (VERCEL_ENV=development) still loads local files, without overriding injected values', () => {
  const { env } = load({ '.env.local': 'A=local\nB=b' }, { VERCEL: '1', VERCEL_ENV: 'development', A: 'injected' });
  assert.strictEqual(env.A, 'injected'); assert.strictEqual(env.B, 'b');
});

/* ---------------- credentials parsing ---------------- */

test('missing credentials: clear configuration error', () => {
  for (const v of [undefined, '', '   ']) assert.throws(() => C.parseServiceAccount(v), (e) => e instanceof C.ConfigError && /FIREBASE_SERVICE_ACCOUNT is not set/.test(e.message) && e.code === 'CLIENTHUNT_CONFIG');
});
test('raw JSON credentials parse', () => { const p = C.parseServiceAccount(oneLine(sa('raw-proj'))); assert.strictEqual(p.project_id, 'raw-proj'); assert.match(p.private_key, /^-----BEGIN PRIVATE KEY-----\n/); });
test('Base64 credentials parse', () => { const p = C.parseServiceAccount(Buffer.from(oneLine(sa('b64-proj'))).toString('base64')); assert.strictEqual(p.project_id, 'b64-proj'); assert.ok(p.private_key.includes('\n')); });
test('Base64 of pretty-printed JSON (as produced by base64 -w0 on the downloaded file) parses', () => { assert.strictEqual(C.parseServiceAccount(Buffer.from(JSON.stringify(sa('pp'), null, 2)).toString('base64')).project_id, 'pp'); });
test('escaped private-key newlines are normalised to real newlines', () => {
  const raw = oneLine(sa()).replace(/\\n/g, '\\n'), p = C.parseServiceAccount(raw);
  assert.ok(!p.private_key.includes('\\n')); assert.ok(p.private_key.split('\n').length > 5);
  const doubleEscaped = JSON.stringify(Object.assign(sa(), { private_key: KEY.replace(/\n/g, '\\n') }));   // literal backslash-n inside the JSON string value
  assert.ok(!C.parseServiceAccount(doubleEscaped).private_key.includes('\\n'));
});
test('the normalised key is accepted by firebase-admin (generated key, offline)', () => {
  const admin = require('firebase-admin'); assert.ok(admin.credential.cert(C.parseServiceAccount(oneLine(sa()))));
});
test('invalid / incomplete credentials fail with a specific message that never contains the input', () => {
  const secret = 'SUPERSECRET123';
  const bad = ['{"project_id":"' + secret, secret + secret, Buffer.from('not json ' + secret).toString('base64'), '[]',
    oneLine({ project_id: 'p', client_email: 'e@x', private_key: 'x' + secret }),
    oneLine({ project_id: 'p', client_email: 'e@x', private_key: '-----BEGIN PRIVATE KEY-----\n' + secret + '\n' }),   // truncated, no END
    oneLine({ client_email: 'e@x', private_key: KEY + secret })];
  for (const raw of bad) {
    let msg = ''; try { C.parseServiceAccount(raw); assert.fail('should throw'); } catch (e) { assert.ok(e instanceof C.ConfigError, e.message); msg = e.message; }
    assert.ok(!msg.includes(secret), 'message leaked input: ' + msg);
  }
  assert.match((() => { try { C.parseServiceAccount(oneLine({ client_email: 'e', private_key: KEY })); } catch (e) { return e.message; } })(), /missing required field\(s\): project_id/);
});
test('JSON that dotenv double-quote expansion has broken gives the one-line hint, not a stack trace', () => {
  const dir = mkdir(); fs.writeFileSync(path.join(dir, '.env'), 'FIREBASE_SERVICE_ACCOUNT="' + oneLine(sa()).replace(/"/g, '\\"') + '"\n');
  const env = {}; E.loadEnv({ rootDir: dir, env });
  assert.throws(() => C.parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT), /ONE line/);
});
test('a pretty-printed multi-line JSON value (unquoted) is detected, not silently half-read', () => {
  const dir = mkdir(); fs.writeFileSync(path.join(dir, '.env'), 'FIREBASE_SERVICE_ACCOUNT=' + JSON.stringify(sa(), null, 2) + '\n');
  const env = {}; E.loadEnv({ rootDir: dir, env });
  assert.throws(() => C.parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT), /ONE line/);
});

/* ---------------- emulator / Vercel ---------------- */

test('local emulator: existing behaviour preserved (no credentials needed, default and custom project id)', () => {
  assert.deepStrictEqual(C.resolveFirebaseInit({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), { mode: 'emulator', projectId: 'demo-clienthunt' });
  assert.strictEqual(C.resolveFirebaseInit({ FIRESTORE_EMULATOR_HOST: 'h:1', GCLOUD_PROJECT: 'demo-x' }).projectId, 'demo-x');
});
test('Vercel + emulator host: initialisation is rejected', () => {
  assert.throws(() => C.resolveFirebaseInit({ FIRESTORE_EMULATOR_HOST: 'h:1', VERCEL: '1' }), /must not be set on Vercel/);
});
test('without an emulator host the credential path is used', () => {
  const r = C.resolveFirebaseInit({ FIREBASE_SERVICE_ACCOUNT: oneLine(sa('p1')) }); assert.strictEqual(r.mode, 'credential'); assert.strictEqual(r.serviceAccount.project_id, 'p1');
});

/* ---------------- results never carry values ---------------- */

test('loadEnv results contain variable names only, never values', () => {
  const { result } = load({ '.env': 'TOKEN=SUPERSECRET123', '.env.local': 'OTHER=SUPERSECRET456' });
  const text = JSON.stringify(result); assert.ok(!text.includes('SUPERSECRET')); assert.ok(text.includes('TOKEN'));
});

/* ---------------- end to end in a copy of the project (separate processes, other cwd) ---------------- */

// Temporary projects get lib/, scripts/ and package.json only. Their dependencies (dotenv, firebase-admin, csv-parse) are found through
// NODE_PATH, so no symlink / junction / copied node_modules is needed (symlinks need admin rights or Developer Mode on Windows).
function project(files) {
  const root = mkdir();
  for (const d of ['lib', 'scripts']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  for (const [n, c] of Object.entries(files || {})) fs.writeFileSync(path.join(root, n), c);
  return root;
}

// Child environment starts EMPTY (no inherited secrets, never the real .env). Only what Node needs to start is passed through, and none of it is secret:
//   PATH, HOME, NODE_PATH (this project's node_modules + any NODE_PATH already set, joined with the platform delimiter),
//   and the Windows system variables Node and OpenSSL need to start reliably.
const NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
const OS_ESSENTIALS = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
function childEnv(extra) {
  const base = { PATH: process.env.PATH, HOME: os.tmpdir(), NODE_PATH };
  for (const k of OS_ESSENTIALS) if (process.env[k] !== undefined) base[k] = process.env[k];
  return Object.assign(base, extra || {});
}
const run = (root, args, extraEnv) => spawnSync(process.execPath, args.map((a) => (a.startsWith('scripts/') || a.startsWith('lib/') ? path.join(root, a) : a)),
  { cwd: os.tmpdir(), encoding: 'utf8', timeout: 30000, env: childEnv(extraEnv) });   // other cwd on purpose
const WEB = 'FIREBASE_WEB_API_KEY=AIza' + 'x'.repeat(35);
const SALT = 'RATE_SALT=' + 'r'.repeat(32);

test('smoke: temporary projects need no symlink or copied node_modules; dependencies resolve through NODE_PATH', () => {
  const root = project({});
  assert.ok(!fs.existsSync(path.join(root, 'node_modules')), 'temporary project must not contain node_modules');
  const r = run(root, ['-e', "console.log(require.resolve('dotenv'))"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(path.resolve(r.stdout.trim()).startsWith(path.join(ROOT, 'node_modules')), 'resolved outside this project: ' + r.stdout);
  assert.ok(NODE_PATH.split(path.delimiter).includes(path.join(ROOT, 'node_modules')));
  assert.ok(!('CLIENTHUNT_SKIP_ENV_FILES' in childEnv()) && !('FIREBASE_SERVICE_ACCOUNT' in childEnv()), 'child env must start clean');
});
test('smoke: only .env works (check-env, run from another directory)', () => {
  const r = run(project({ '.env': [asEnvLine(sa('proj-env')), WEB, SALT].join('\n') }), ['scripts/check-env.js']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /project_id=proj-env \(from \.env\)/); assert.match(r.stdout, /env files found: \.env\b/);
});
test('smoke: only .env.local works', () => {
  const r = run(project({ '.env.local': [asEnvLine(sa('proj-local')), WEB, SALT].join('\n') }), ['scripts/check-env.js']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /project_id=proj-local \(from \.env\.local\)/);
});
test('smoke: both present, .env.local wins and .env fills the gaps', () => {
  const r = run(project({ '.env': [asEnvLine(sa('proj-env')), WEB, SALT].join('\n'), '.env.local': asEnvLine(sa('proj-local')) }), ['scripts/check-env.js']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /project_id=proj-local \(from \.env\.local\)/); assert.match(r.stdout, /FIREBASE_WEB_API_KEY set \(from \.env\)/);
});
test('smoke: process environment beats both files', () => {
  const r = run(project({ '.env': asEnvLine(sa('proj-env')) + '\n' + WEB, '.env.local': asEnvLine(sa('proj-local')) }), ['scripts/check-env.js'], { FIREBASE_SERVICE_ACCOUNT: oneLine(sa('proj-process')) });
  assert.match(r.stdout, /project_id=proj-process \(from the process environment\)/);
});
test('smoke: check-env never prints secret values', () => {
  const r = run(project({ '.env': [asEnvLine(sa('proj-env')), WEB, SALT].join('\n') }), ['scripts/check-env.js']);
  const all = r.stdout + r.stderr;
  assert.ok(!all.includes('PRIVATE KEY') && !all.includes(KEY.split('\n')[1]) && !all.includes('r'.repeat(32)) && !all.includes('x'.repeat(35)));
});
test('smoke: lib/firebase initialises from .env alone and keeps its export contract', () => {
  const root = project({ '.env': asEnvLine(sa('proj-env')) });
  const r = run(root, ['-e', "const f=require(" + JSON.stringify(path.join(root, 'lib/firebase')) + ");console.log(Object.keys(f).sort().join(','))"]);
  assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual(r.stdout.trim(), 'FieldValue,admin,auth,db');
});
test('smoke: lib/admin (imported first by create-owner) sees .env credentials: usage message, no config error', () => {
  const r = run(project({ '.env': asEnvLine(sa('proj-env')) }), ['scripts/create-owner.js']);
  assert.strictEqual(r.status, 1); assert.match(r.stderr, /Usage: npm run create-owner/); assert.ok(!/Configuration error|not set/.test(r.stderr), r.stderr);
});
test('smoke: no credentials anywhere -> one readable configuration error from every script, exit 1', () => {
  const root = project({});
  for (const s of ['scripts/create-owner.js', 'scripts/seed-config.js']) {
    const r = run(root, [s]); assert.strictEqual(r.status, 1, s);
    assert.match(r.stderr, /Configuration error: FIREBASE_SERVICE_ACCOUNT is not set/); assert.ok(!/at .*\.js:\d+/.test(r.stderr), 'no stack trace: ' + r.stderr);
  }
  const c = run(root, ['scripts/check-env.js']); assert.strictEqual(c.status, 1); assert.match(c.stdout, /FAIL FIREBASE_SERVICE_ACCOUNT is not set/);
});
test('smoke: broken credentials in .env -> specific error that does not echo the value', () => {
  const r = run(project({ '.env': 'FIREBASE_SERVICE_ACCOUNT={"project_id":"SUPERSECRET123"\n}' }), ['scripts/seed-config.js']);
  assert.strictEqual(r.status, 1); assert.match(r.stderr, /ONE line/); assert.ok(!(r.stdout + r.stderr).includes('SUPERSECRET123'));
});
test('smoke: Vercel runtime ignores local files; Vercel + emulator host is rejected', () => {
  const root = project({ '.env.local': asEnvLine(sa('proj-local')) });
  const a = run(root, ['scripts/check-env.js'], { VERCEL: '1', VERCEL_ENV: 'production' });
  assert.strictEqual(a.status, 1); assert.match(a.stdout, /file loading skipped: deployed/); assert.match(a.stdout, /FIREBASE_SERVICE_ACCOUNT is not set/);
  const b = run(root, ['scripts/check-env.js'], { VERCEL: '1', VERCEL_ENV: 'production', FIREBASE_SERVICE_ACCOUNT: oneLine(sa('proj-injected')) });
  assert.match(b.stdout, /project_id=proj-injected \(from the process environment\)/);
  const c = run(root, ['-e', "require(" + JSON.stringify(path.join(root, 'lib/firebase')) + ")"], { VERCEL: '1', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
  assert.notStrictEqual(c.status, 0); assert.match(c.stderr, /must not be set on Vercel/);
});
test('smoke: local emulator mode still initialises without credentials', () => {
  const root = project({});
  const r = run(root, ['-e', "console.log(Object.keys(require(" + JSON.stringify(path.join(root, 'lib/firebase')) + ")).sort().join(','))"], { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
  assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual(r.stdout.trim(), 'FieldValue,admin,auth,db');
});

/* ---------------- script semantics unchanged ---------------- */

test('seed-config: adds missing settings, never overwrites existing ones (run in-process against the Firestore model)', async () => {
  H.fake.reset(); H.fake.put('config/main', { competition_name: 'Custom Name', registration_status: 'CLOSED' });
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try {
    require('../scripts/seed-config.js');
    for (let i = 0; i < 100 && !(H.fake.docs('config')[0] && H.fake.docs('config')[0].data.min_team_size); i++) await new Promise((r) => setTimeout(r, 20));
  } finally { console.log = orig; }
  const cfg = H.fake.docs('config')[0].data;
  assert.strictEqual(cfg.competition_name, 'Custom Name'); assert.strictEqual(cfg.registration_status, 'CLOSED');
  assert.strictEqual(cfg.min_team_size, '1'); assert.strictEqual(cfg.search_team_show_contacts, '0');
  assert.ok(logs.some((l) => /Added:/.test(l)) && !logs.some((l) => /Custom Name/.test(l) && /Added/.test(l)));
});

/* ---------------- repository hygiene ---------------- */

test('.gitignore protects env files and service-account files; .env.example stays a safe template', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const l of ['.env', '.env.*', '!.env.example', 'service-account*.json']) assert.ok(lines.includes(l), 'missing ' + l);
  const ex = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.ok(!/BEGIN PRIVATE KEY-----(\\n|\n)[A-Za-z0-9+/]{30,}/.test(ex), 'example contains key material');
  assert.ok(!/AIza[0-9A-Za-z_\-]{20,}/.test(ex), 'example contains an API key');
  assert.match(ex, /FIREBASE_SERVICE_ACCOUNT=/);
});
test('every file that reads process.env loads lib/env first (static audit)', () => {
  const files = ['api/index.js', 'lib/admin.js', 'lib/firebase.js', 'lib/ratelimit.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8'), firstRequire = src.match(/require\(['"]([^'"]+)['"]\)/)[1];
    assert.match(firstRequire, /(^|\/)env$/, f + ' first require is ' + firstRequire);
  }
  for (const f of ['scripts/seed-config.js', 'scripts/create-owner.js', 'scripts/import-from-sheets.js', 'scripts/check-env.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const boot = src.search(/require\(['"](\.\/_boot|\.\.\/lib\/env)['"]\)/), firstLib = src.search(/require\(['"]\.\.\/lib\/(?!env)/);
    assert.ok(boot !== -1, f + ' never loads the env bootstrap');
    assert.ok(firstLib === -1 || boot < firstLib, f + ' imports an application module before loading the environment');
  }
});
