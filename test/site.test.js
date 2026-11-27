'use strict';
// The merged site: routing, links, same-origin API, hidden admin page, security headers, domain helper.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os');

const ROOT = path.resolve(__dirname, '..'), PUB = path.join(ROOT, 'public');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const read = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');
const exists = (p) => { try { return fs.statSync(path.join(PUB, p)).isFile(); } catch (_) { return false; } };
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }
const htmlFiles = [...walk(PUB)].filter((f) => f.endsWith('.html')).map((f) => path.relative(PUB, f).split(path.sep).join('/'));

/** Minimal model of Vercel resolution for this config: redirects, then a real file, then rewrites. Returns { type, target } or null. */
function resolve(url) {
  const p = url.split('#')[0].split('?')[0];
  const red = vercel.redirects.find((r) => r.source === p); if (red) return { type: 'redirect', target: red.destination };
  if (p.startsWith('/api')) return { type: 'function', target: p };
  const file = p === '/' ? 'index.html' : p.replace(/^\//, '');
  if (exists(file)) return { type: 'file', target: file };
  const rw = vercel.rewrites.find((r) => r.source === p); if (rw) return exists(rw.destination.replace(/^\//, '')) ? { type: 'rewrite', target: rw.destination } : null;
  return null;
}

test('every rewrite and redirect target exists (known gap: /join has no join.html yet)', () => {
  const missing = vercel.rewrites.filter((r) => !exists(r.destination.replace(/^\//, ''))).map((r) => r.source);
  assert.deepStrictEqual([...new Set(missing)].sort(), ['/join', '/join/']);
  for (const r of vercel.redirects) assert.ok(resolve(r.destination), 'redirect target does not resolve: ' + r.destination);
});

test('all internal links and assets used by the pages resolve (except the known /join gap)', () => {
  const bad = new Set();
  for (const f of htmlFiles) {
    const src = read(f);
    for (const m of src.matchAll(/(?:href|src|action)="(\/[^"]*)"/g)) { const u = m[1]; if (u.startsWith('//')) continue; if (!resolve(u)) bad.add(u + '  (in ' + f + ')'); }
  }
  const unexpected = [...bad].filter((b) => !b.startsWith('/join '));
  assert.deepStrictEqual(unexpected, []);
});

test('pretty URLs from the old Netlify rules all resolve', () => {
  const expect = { '/': 'index.html', '/clienthunt': '/clienthunt.html', '/clienthunt/': '/clienthunt.html', '/clienthunt/register': '/clienthunt-register.html',
    '/clienthunt/register/': '/clienthunt-register.html', '/clienthunt/search-team': '/search-team.html', '/clienthunt/rulebook': '/assets/rulebook.pdf',
    '/collaborate': '/collaborate.html', '/sponsor/': '/sponsor.html', '/admin/dashboard': '/admin/dashboard.html',
    '/super/ultra/admin/evaluation/pre/submission': '/super/ultra/admin/evaluation/pre/submission/index.html' };
  for (const [u, t] of Object.entries(expect)) { const r = resolve(u); assert.ok(r, u); assert.strictEqual(r.target, t, u); }
  assert.strictEqual(resolve('/index.html').type, 'redirect');
  assert.strictEqual(resolve('/register').target, '/clienthunt/register');
});

test('unknown URLs fall through to the custom 404 page', () => { assert.ok(exists('404.html')); assert.strictEqual(resolve('/no-such-page'), null); });

test('the four ClientHunt pages call the same-origin API; no Apps Script left in them', () => {
  const pages = ['clienthunt-register.html', 'search-team.html', 'admin/dashboard.html', 'super/ultra/admin/evaluation/pre/submission/index.html'];
  for (const f of pages) {
    const s = read(f);
    assert.match(s, /API_URL: "\/api"/, f + ' config');
    assert.ok(!/script\.google\.com|vercel\.app/.test(s), f + ' still references Apps Script or an absolute API host');
  }
  for (const f of ['sponsor.html', 'collaborate.html']) assert.ok(/script\.google\.com/.test(read(f)), f + ' is expected to keep its own Apps Script (not part of ClientHunt)');
  assert.ok(!exists('api') && !fs.existsSync(path.join(PUB, 'api')), 'public/ must not shadow the /api function');
});

test('legacy email-only admin code is gone from every page', () => {
  for (const f of htmlFiles) assert.ok(!/(?<![A-Za-z_])admin_update|buildAdminEdit|id="adminEdit"|email: S\.email/.test(read(f)), f);
});

test('the evaluation page lives only at its hidden path, is noindex, and is not publicly guessable', () => {
  const hidden = 'super/ultra/admin/evaluation/pre/submission/index.html';
  assert.ok(exists(hidden)); assert.ok(!exists('pre-submission-evaluation.html'));
  assert.match(read(hidden), /noindex, nofollow/); assert.match(read('admin/dashboard.html'), /noindex, nofollow/);
  const hdr = (src) => vercel.headers.find((h) => h.source === src);
  for (const s of ['/admin/(.*)', '/super/(.*)']) assert.ok(hdr(s).headers.some((h) => h.key === 'X-Robots-Tag' && /noindex/.test(h.value)), s);
  assert.ok(!/super\/ultra|pre-submission/.test(read('robots.txt') + read('sitemap.xml') + read('index.html') + read('clienthunt.html')), 'hidden path must not be linked or listed');
});

test('CSP covers everything the pages load and allows nothing risky', () => {
  const csp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  const dir = Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));
  assert.ok(!/unsafe-eval/.test(csp) && !dir['script-src'].some((v) => v === '*' || /^https?:/.test(v)), 'scripts: self + inline only');
  assert.deepStrictEqual(dir['frame-ancestors'], ["'none'"]); assert.deepStrictEqual(dir['base-uri'], ["'none'"]);
  for (const f of htmlFiles) {
    const s = read(f);
    assert.ok(!/<script[^>]+src="https?:/i.test(s), f + ' loads an external script, which the CSP blocks');
    assert.ok(!/<iframe/i.test(s), f + ' embeds a frame');
    assert.ok(!/<img[^>]+src="https?:/i.test(s), f + ' loads an external image, which the CSP blocks');
    for (const m of s.matchAll(/<link[^>]+href="(https:\/\/[^"/]+)/g)) {
      if (/rel="(canonical|alternate|preconnect|dns-prefetch)"/.test(m[0])) continue;
      assert.ok(dir['style-src'].includes(m[1]) || dir['font-src'].includes(m[1]), f + ': ' + m[1] + ' not allowed by CSP');
    }
    for (const m of s.matchAll(/fetch\(\s*([A-Za-z_]+)/g)) assert.ok(['API_URL', 'SCRIPT_URL'].includes(m[1]), f + ' fetch target ' + m[1]);
  }
  assert.ok(dir['connect-src'].includes("'self'") && dir['connect-src'].includes('https://script.google.com') && dir['connect-src'].includes('https://script.googleusercontent.com'), 'sponsor/collaborate forms need the Apps Script hosts');
});

test('scripts and pages contain no credentials or env files', () => {
  assert.ok(![...walk(PUB)].some((f) => /(^|\/)\.env|service-account/i.test(f)));
  for (const f of htmlFiles) assert.ok(!/BEGIN PRIVATE KEY|FIREBASE_SERVICE_ACCOUNT|AIza[0-9A-Za-z_-]{30,}/.test(read(f)), f);
});

test('set-site-url rewrites only the exact origin, validates input, supports a dry run', () => {
  const { run, origin } = require('../scripts/set-site-url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-site-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.html'), '<link rel="canonical" href="https://freelanthropy.netlify.app/x"><a href="https://freelanthropy.netlify.app.evil.com">');
    fs.writeFileSync(path.join(dir, 'sub', 'sitemap.xml'), '<loc>https://freelanthropy.netlify.app/</loc>');
    fs.writeFileSync(path.join(dir, 'keep.png'), 'https://freelanthropy.netlify.app');
    const dry = run({ dir, to: 'https://example.org', dry: true });
    assert.strictEqual(dry.length, 2); assert.ok(fs.readFileSync(path.join(dir, 'a.html'), 'utf8').includes('freelanthropy.netlify.app'), 'dry run writes nothing');
    run({ dir, to: 'https://example.org/' });
    assert.ok(fs.readFileSync(path.join(dir, 'a.html'), 'utf8').includes('https://example.org/x'));
    assert.ok(fs.readFileSync(path.join(dir, 'sub', 'sitemap.xml'), 'utf8').includes('<loc>https://example.org/</loc>'));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'keep.png'), 'utf8'), 'https://freelanthropy.netlify.app', 'non-text files untouched');
    for (const bad of ['http://example.org', 'example.org', 'https://example.org/path', 'javascript:alert(1)']) assert.throws(() => origin(bad, 'x'), /must/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
