# ClientHunt registration (Vercel + Firebase)
Registration, team lookup, problem reports and an admin dashboard for the ClientHunt competition.
See **DEPLOY.md** for setup, data migration and the list of changes from the Google Apps Script version.

```
api/index.js      single endpoint, same JSON {action} contract as before
lib/              config, validation, registration (transaction), teams, public lookups, admin, eval, rate limit, audit
public/           register.html, search-team.html, admin/dashboard.html
scripts/          seed-config, create-owner, import-from-sheets
test/             node --test (in-memory Firestore fake)
```
