'use strict';
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L lookalikes

const ok = (data) => Object.assign({ success: true }, data || {});
const fail = (code, message, extra) => Object.assign({ success: false, error_code: code, message }, extra || {});

/** "2026-11-09T10:00:00+05:30": the same stamp format the Sheets version wrote. */
function istStamp(ms) {
  const d = new Date((ms === undefined ? Date.now() : ms) + 5.5 * 3600 * 1000);
  return d.toISOString().slice(0, 19) + '+05:30';
}
const nowStamp = () => istStamp();

function normalizeSpace(v) {
  if (v === null || v === undefined) return '';
  return String(v).normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}
const normalizeEmail = (v) => normalizeSpace(v).toLowerCase();
const normalizeTeamCode = (v) => normalizeSpace(v).toUpperCase();

/** Comparison key: lower-case, and "+tag" aliases fold onto the base mailbox. */
function emailKey(email) {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  return e.slice(0, at).split('+')[0] + e.slice(at);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Unbiased random string; crypto.randomInt does the rejection sampling. */
function secureRandom(length, alphabet) {
  alphabet = alphabet || CODE_ALPHABET;
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet.charAt(crypto.randomInt(alphabet.length));
  return out;
}

/** Constant-time string compare. */
function sameString(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Parses 2026-11-09 10:00 / 2026-11-09T10:00:30 / with Z or +05:30. No zone = IST. null = blank, NaN = unreadable. */
function parseWhen(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) return NaN;
  let tz = '+05:30';
  if (m[7]) tz = /^z$/i.test(m[7]) ? 'Z' : (m[7].length === 5 ? m[7].slice(0, 3) + ':' + m[7].slice(3) : m[7]);
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${tz}`);
}

/** NOT_STARTED | OPEN | CLOSED. Fails closed on a typo or an unreadable date. */
function registrationState(manual, opensMs, closesMs, nowMs) {
  manual = String(manual || '').trim().toUpperCase();
  if (manual === 'NOT_STARTED') return 'NOT_STARTED';
  if (manual !== 'OPEN') return 'CLOSED';
  if (opensMs !== null && (isNaN(opensMs) || nowMs < opensMs)) return 'NOT_STARTED';
  if (closesMs !== null && (isNaN(closesMs) || nowMs >= closesMs)) return 'CLOSED';
  return 'OPEN';
}

const evalMax = (v) => { const n = parseFloat(v); return isFinite(n) && n > 0 && n <= 1000 ? round2(n) : 0; };
const toInt = (v, fallback) => { const n = parseInt(v, 10); return isNaN(n) ? fallback : n; };

const safeErr = (e) => String((e && e.message) || e || 'error').slice(0, 200);

module.exports = { CODE_ALPHABET, ok, fail, istStamp, nowStamp, normalizeSpace, normalizeEmail, normalizeTeamCode, emailKey,
  sha256, secureRandom, sameString, round2, parseWhen, registrationState, evalMax, toInt, safeErr };
