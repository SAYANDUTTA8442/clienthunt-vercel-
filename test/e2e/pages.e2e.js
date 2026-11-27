'use strict';
// Browser-level test of the MERGED site: the real pages run in jsdom, and their fetch() is wired straight into api/index.js
// (Firestore model, Firebase Auth REST stubbed). Needs jsdom, which is not a project dependency:  npm i --no-save jsdom@24  &&  npm run test:e2e
const path = require('path');
const BE = path.resolve(__dirname, '..', '..'), FE = path.join(BE, 'public');
process.env.CLIENTHUNT_SKIP_ENV_FILES = '1';
process.env.ALLOWED_ORIGINS = '';                                               // merged deployment: same origin, no CORS setting needed
const H = require(BE + '/test/helpers');                                      // injects the Firestore model + patches Firebase Auth REST
const handler = require(BE + '/api/index.js');
const A = require(BE + '/lib/admin');
const { handleRegister } = require(BE + '/lib/registration');
const { setConfigValue, getConfig } = require(BE + '/lib/config');
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (e) { console.error('jsdom is not installed. Run: npm i --no-save jsdom@24'); process.exit(2); }
const fs = require('fs'), assert = require('assert');
const bad = (m) => { throw new Error(m); };

const PAGE_ORIGIN = 'https://clienthunt-vercel-sigma.vercel.app', API_ORIGIN = PAGE_ORIGIN;   // ONE origin serves pages and API
const seen = { hosts: new Set(), contentTypes: new Set(), calls: [] };
let ipCounter = 0;

function makeFetch(ip) {
  return async (url, opts) => {
    opts = opts || {}; const u = new URL(url, PAGE_ORIGIN);
    seen.hosts.add(u.origin);
    if (u.origin !== API_ORIGIN || u.pathname !== '/api') throw new TypeError('Failed to fetch (page called ' + u.origin + u.pathname + ')');
    const headers = { 'x-forwarded-for': ip };   // same-origin requests carry no Origin header
    for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    if (opts.method === 'POST') seen.contentTypes.add(String(headers['content-type'] || '').split(';')[0]);
    let status, body; const out = {};
    const res = { setHeader: (k, v) => { out[k.toLowerCase()] = v; }, status(c) { status = c; return this; }, send(b) { body = b; }, end() {} };
    await handler({ method: opts.method || 'GET', headers, query: Object.fromEntries(u.searchParams), body: opts.body, socket: {} }, res);
    if (PAGE_ORIGIN !== API_ORIGIN && out['access-control-allow-origin'] !== PAGE_ORIGIN) throw new TypeError('Failed to fetch (CORS: no Access-Control-Allow-Origin for ' + PAGE_ORIGIN + ')');
    try { seen.calls.push((opts.body ? JSON.parse(opts.body).action : 'GET ' + u.search)); } catch (e) {}
    return { ok: status === 200, status, text: async () => body, json: async () => JSON.parse(body) };
  };
}

async function open(file, pathname) {
  const html = fs.readFileSync(FE + '/' + file, 'utf8');
  const ip = '7.7.' + (++ipCounter) + '.1';
  const dom = new JSDOM(html, { url: PAGE_ORIGIN + pathname, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = makeFetch(ip); w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }));
      w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
      w.confirm = () => true; w.alert = () => {};
      w.addEventListener('error', (e) => { dom._errors.push(e.message); });
    } });
  dom._errors = []; return dom;
}
const wait = async (fn, what, ms) => { const t = Date.now(); for (;;) { let v; try { v = fn(); } catch (e) { v = false; } if (v) return v; if (Date.now() - t > (ms || 4000)) throw new Error('timeout waiting for: ' + what); await new Promise((r) => setTimeout(r, 15)); } };
const $ = (d, id) => d.window.document.getElementById(id);
const fire = (d, el, type) => el.dispatchEvent(new d.window.Event(type, { bubbles: true, cancelable: true }));
const setv = (d, el, v) => { el.value = v; fire(d, el, 'input'); fire(d, el, 'change'); };
const results = []; const ok = (name) => { results.push(name); console.log('  PASS  ' + name); };

(async () => {
  // ---------- backend fixtures ----------
  H.fake.reset(); await getConfig(true);
  await A.createOrResetOwner('Org One', 'org1@iitp.ac.in', 'a very long password');
  await A.createOrResetOwner('Org Two', 'org2@iitp.ac.in', 'another long password');
  const two = H.fake.docs('admins').find((a) => a.data.email === 'org2@iitp.ac.in'); H.fake.put('admins/' + two.id, Object.assign({}, two.data, { must_change_password: true }));
  await setConfigValue('marking_enabled', '1');
  const team = await handleRegister(H.payload(3, 2), H.ctx('5.5.5.5')); assert.ok(team.success); const CODE = team.team_code;

  for (const f of ['clienthunt-register.html', 'search-team.html', 'admin/dashboard.html', 'super/ultra/admin/evaluation/pre/submission/index.html']) fs.readFileSync(FE + '/' + f, 'utf8').includes('API_URL: "/api"') || bad(f + ' is not on the same-origin API');
  console.log('\n[1] Registration page: config fetch from the new API (GET ?action=config) (same origin)');
  let d = await open('clienthunt-register.html', '/clienthunt/register');
  await wait(() => !$(d, 'cfgBanner') || $(d, 'cfgBanner').hidden, 'config loaded, no "cannot load" banner');
  await wait(() => seen.calls.some((c) => /GET \?action=config/.test(c)), 'config request seen');
  assert.ok(!$(d, 'apiBanner') || $(d, 'apiBanner').hidden, 'backend-address banner hidden'); ok('register page loads registration state from the Vercel API');
  assert.ok(!d.window.document.getElementById('adminEdit') && !/adminEdit|admin_update/.test(d.window.document.documentElement.outerHTML), 'legacy admin edit removed'); ok('legacy email-only admin edit is gone from the public page');

  console.log('[2] Registration page: status check (Team Code + email)');
  setv(d, $(d, 'stCode'), CODE.toLowerCase()); setv(d, $(d, 'stEmail'), 'STU30_2301CS030@IITP.AC.IN');
  fire(d, $(d, 'statusForm'), 'submit');
  await wait(() => !$(d, 'statusResult').hidden && $(d, 'srCode').textContent === CODE, 'status result');
  assert.strictEqual($(d, 'srName').textContent, 'Team d'); ok('status check returns the team');
  setv(d, $(d, 'stEmail'), 'wrong_2301cs999@iitp.ac.in'); $(d, 'statusResult').hidden = true; fire(d, $(d, 'statusForm'), 'submit');
  await wait(() => !$(d, 'statusBanner').hidden && /do not match/i.test($(d, 'statusBanner').textContent), 'generic not-found banner'); ok('wrong details show the generic error, nothing leaked');

  console.log('[3] Search-team page: by Team Code and by email');
  d = await open('search-team.html', '/clienthunt/search-team');
  setv(d, $(d, 'q'), CODE); fire(d, $(d, 'form'), 'submit');
  await wait(() => !$(d, 'result').hidden && $(d, 'rCode').textContent === CODE, 'result by code');
  assert.ok(/\*{6}/.test($(d, 'rMembers').textContent) || !/9876543\d{3}/.test($(d, 'rMembers').textContent)); ok('search by Team Code renders, phones masked');
  d = await open('search-team.html', '/clienthunt/search-team');
  setv(d, $(d, 'q'), 'Stu31_2301cs031@iitp.ac.in'); fire(d, $(d, 'form'), 'submit');
  await wait(() => !$(d, 'result').hidden && $(d, 'rCode').textContent === CODE, 'result by email'); ok('search by member email renders');
  assert.ok(!/@iitp/.test($(d, 'result').textContent), 'no emails shown'); ok('emails never shown');
  setv(d, $(d, 'rpName'), 'Test Person'); setv(d, $(d, 'rpContact'), '9876501234'); setv(d, $(d, 'rpMsg'), 'This is a test problem report.');
  fire(d, $(d, 'reportForm'), 'submit');
  await wait(() => H.fake.docs('requests').length === 1, 'problem report stored'); ok('report-a-problem is stored in Firestore');

  console.log('[4] Admin dashboard: sign in with the Vercel API');
  d = await open('admin/dashboard.html', '/admin/dashboard.html');
  const lf = $(d, 'loginForm'); const inputs = lf.querySelectorAll('input');
  setv(d, inputs[0], 'org1@iitp.ac.in'); setv(d, inputs[1], 'a very long password'); fire(d, lf, 'submit');
  await wait(() => !$(d, 'app').hidden, 'dashboard visible', 6000);
  await wait(() => d.window.document.body.textContent.includes(CODE), 'team listed in dashboard'); ok('dashboard sign-in and data load work');

  console.log('[5] Evaluation page: email + password sign-in (replaces the old email-only login)');
  d = await open('super/ultra/admin/evaluation/pre/submission/index.html', '/super/ultra/admin/evaluation/pre/submission');
  assert.ok($(d, 'siPass') && $(d, 'siPass').type === 'password'); ok('password field present');
  fire(d, $(d, 'signinForm'), 'submit');
  assert.ok(!$(d, 'siEmail-err').hidden && !$(d, 'siPass-err').hidden); ok('empty form is validated client-side');
  setv(d, $(d, 'siEmail'), 'org1@iitp.ac.in'); setv(d, $(d, 'siPass'), 'WRONG password here'); fire(d, $(d, 'signinForm'), 'submit');
  await wait(() => !$(d, 'siBanner').hidden && /not correct/i.test($(d, 'siBanner').textContent), 'wrong-password banner');
  assert.ok($(d, 'dash').hidden && $(d, 'siPass').value === ''); ok('wrong password is rejected and the field is cleared');
  setv(d, $(d, 'siEmail'), 'org1@iitp.ac.in'); setv(d, $(d, 'siPass'), 'a very long password'); fire(d, $(d, 'signinForm'), 'submit');
  await wait(() => !$(d, 'dash').hidden && /Signed in as ADM-/.test($(d, 'who').textContent), 'dashboard shown', 6000);
  await wait(() => $(d, 'list').textContent.includes(CODE), 'team code listed'); ok('sign-in works and teams are listed by Team Code');
  assert.ok(!/@/.test($(d, 'list').textContent), 'blind: no emails on the page'); ok('blind evaluation: no emails or names shown');
  assert.ok(![...Array(d.window.sessionStorage.length).keys()].length && d.window.localStorage.length === 0); ok('nothing written to browser storage');

  const head = d.window.document.querySelector('.team-head'); head.click();
  await wait(() => $(d, 'tb-' + CODE), 'team panel opens');
  setv(d, $(d, 'at-' + CODE), '2026-11-27T10:00'); setv(d, $(d, 'ref-' + CODE), 'inbox/ClientHunt'); fire(d, $(d, 'at-' + CODE).form, 'submit');
  await wait(() => /Email ·/.test($(d, 'list').textContent) && H.fake.docs('submissions').length === 1, 'receipt saved'); ok('log email receipt (eval_log_receipt with session token)');
  if (!$(d, 'tb-' + CODE)) d.window.document.querySelector('.team-head').click();
  await wait(() => $(d, 'mk-' + CODE + '-problem'), 'marks form');
  for (const k of ['problem', 'case', 'mail', 'quote']) setv(d, $(d, 'mk-' + CODE + '-' + k), '10');
  fire(d, $(d, 'mk-' + CODE + '-problem').form, 'submit');
  await wait(() => /My total 40 \/ 100/.test($(d, 'list').textContent) && H.fake.docs('evaluations').length === 1, 'marks saved'); ok('save marks (eval_save_marks) and total shown');
  const ev = H.fake.docs('evaluations')[0].data; assert.ok(/^ADM-/.test(ev.admin_id) && ev.total === 40); ok('marks are stored against the admin ID');

  const sessionsBefore = H.fake.docs('sessions').length;
  console.log('[6] Evaluation page: session expiry');
  H.fake.docs('sessions').forEach((s) => H.fake.store.delete('sessions/' + s.id));
  $(d, 'refreshBtn').click();
  await wait(() => !$(d, 'signinCard').hidden && $(d, 'dash').hidden && /session has ended/i.test($(d, 'siBanner').textContent), 'returned to sign-in'); ok('expired session returns to sign-in with a clear message');

  console.log('[7] Evaluation page: sign out revokes the session on the server');
  setv(d, $(d, 'siEmail'), 'org1@iitp.ac.in'); setv(d, $(d, 'siPass'), 'a very long password'); fire(d, $(d, 'signinForm'), 'submit');
  await wait(() => !$(d, 'dash').hidden, 'signed in again', 6000);
  const n1 = H.fake.docs('sessions').length; $(d, 'signoutBtn').click();
  await wait(() => H.fake.docs('sessions').length === n1 - 1, 'session deleted on server'); ok('sign-out deletes the server session');

  console.log('[8] Evaluation page: admin who must change password');
  d = await open('super/ultra/admin/evaluation/pre/submission/index.html', '/super/ultra/admin/evaluation/pre/submission');
  setv(d, $(d, 'siEmail'), 'org2@iitp.ac.in'); setv(d, $(d, 'siPass'), 'another long password'); fire(d, $(d, 'signinForm'), 'submit');
  await wait(() => !$(d, 'siBanner').hidden && /new password first/i.test($(d, 'siBanner').textContent), 'must-change message');
  assert.ok($(d, 'dash').hidden); ok('must-change-password admin gets clear instructions, no access');
  await wait(() => H.fake.docs('sessions').every((s) => s.data.admin_id !== two.id), 'that session revoked'); ok('and the session created for the attempt is revoked');

  console.log('\n[9] Cross-cutting');
  assert.deepStrictEqual([...seen.hosts], [API_ORIGIN]); ok('every request went to the same origin only, path /api (no Apps Script, no CORS needed)');
  assert.deepStrictEqual([...seen.contentTypes], ['text/plain']); ok('all POSTs are text/plain, so browsers send no CORS preflight');
  console.log('\nALL ' + results.length + ' CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e); process.exit(1); });
