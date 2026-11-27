# ClientHunt registration (Vercel + Firebase)
The Freelanthropy site and the ClientHunt backend in ONE Vercel project: static pages in `public/`, the API at `/api`, data in Firestore.
Registration, team lookup, problem reports, an admin dashboard and Round 1 evaluation for the ClientHunt competition.
See **DEPLOY.md** for setup, data migration and the list of changes from the Google Apps Script version.

```
api/index.js      single endpoint, same JSON {action} contract as before
lib/              config, validation, registration (transaction), teams, public lookups, admin, eval, rate limit, audit
public/           the whole site (index, clienthunt, register, search-team, sponsor, collaborate, admin dashboard, hidden evaluation page, assets)
vercel.json       routes (old Netlify redirects), security headers, function settings
scripts/          seed-config, create-owner, import-from-sheets, check-env, set-site-url
test/             node --test (in-memory Firestore fake)
```
