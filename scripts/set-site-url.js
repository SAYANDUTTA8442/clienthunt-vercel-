'use strict';
/**
 * npm run set-site-url -- https://your-domain.example [--from https://freelanthropy.netlify.app] [--dry]
 * Rewrites the public site origin used in canonical / og:url / og:image links, sitemap.xml and robots.txt.
 * Touches only text files under public/ and only the exact origin string, nothing else.
 */
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const EXTS = new Set(['.html', '.xml', '.txt', '.json', '.webmanifest']);

function origin(v, label) {
  let u; try { u = new URL(v); } catch (_) { throw new Error(label + ' must be a full URL such as https://example.com'); }
  if (u.protocol !== 'https:' || u.origin !== v.replace(/\/+$/, '')) throw new Error(label + ' must be an https origin with no path, e.g. https://example.com');
  return u.origin;
}
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (EXTS.has(path.extname(e.name).toLowerCase())) yield p;
  }
}

/** @returns {{file:string,count:number}[]} */
function run(opts) {
  const root = opts.dir || PUBLIC_DIR, from = origin(opts.from || 'https://freelanthropy.netlify.app', '--from'), to = origin(opts.to, 'the new site URL');
  const changed = [];
  for (const file of walk(root)) {
    const s = fs.readFileSync(file, 'utf8'), count = s.split(from).length - 1;
    if (!count) continue;
    if (!opts.dry) fs.writeFileSync(file, s.split(from).join(to));
    changed.push({ file: path.relative(root, file).split(path.sep).join('/'), count });
  }
  return changed;
}
module.exports = { run, origin };

if (require.main === module) {
  const args = process.argv.slice(2), val = (f) => { const i = args.indexOf(f); return i === -1 ? undefined : args[i + 1]; };
  const to = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--from');
  if (!to) { console.error('Usage: npm run set-site-url -- https://your-domain.example [--from https://old.example] [--dry]'); process.exit(1); }
  try {
    const out = run({ to, from: val('--from'), dry: args.includes('--dry') });
    out.forEach((c) => console.log((args.includes('--dry') ? 'would change ' : 'changed ') + c.file + ' (' + c.count + ')'));
    console.log(out.length ? 'Done.' : 'Nothing to change (the old origin was not found).');
  } catch (e) { console.error(e.message); process.exit(1); }
}
