'use strict';
// npm run create-owner -- "Your Name" you@iitp.ac.in "a long password"
// Creates the first OWNER. Running it again for the same email resets that owner's password (recovery if every owner is locked out).
const { createOrResetOwner } = require('./_boot')('../lib/admin');   // loads .env.local / .env first

const [name, email, password] = process.argv.slice(2);
if (!name || !email || !password) { console.error('Usage: npm run create-owner -- "Name" email@domain "password (12+ chars)"'); process.exit(1); }
createOrResetOwner(name, email, password)
  .then((r) => { console.log((r.created ? 'Owner created: ' : 'Owner reset: ') + r.admin_id); process.exit(0); })
  .catch((e) => { console.error('Failed: ' + e.message); process.exit(1); });
