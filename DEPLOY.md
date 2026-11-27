# ClientHunt on Vercel + Firebase

Serverless Node.js (`api/index.js`) on Vercel, Firestore for data, Firebase Authentication for admin logins.
The three pages in `public/` are unchanged apart from `API_URL`, which is now `/api`.

## 1. Firebase (once)
1. Create a project. **Build > Firestore Database**: create it in `asia-south1` (Mumbai), production mode.
2. **Build > Authentication > Sign-in method**: enable **Email/Password** (admin passwords are verified through it).
3. **Project settings > Service accounts > Generate new private key.** Keep the JSON secret.
4. **Project settings > General**: copy the **Web API key**.
5. Deploy the lock-down rules (browsers get no direct database access, everything goes through the API):
   `npx firebase-tools deploy --only firestore:rules`
6. Turn on TTL so counters, sessions and noisy audit rows clean themselves up:
   ```
   gcloud firestore fields ttls update expiresAt --collection-group=rateLimits --enable-ttl
   gcloud firestore fields ttls update expiresAt --collection-group=sessions   --enable-ttl
   gcloud firestore fields ttls update expiresAt --collection-group=replays    --enable-ttl
   gcloud firestore fields ttls update expiresAt --collection-group=auditLog   --enable-ttl
   ```
   (`auditLog` rows only carry `expiresAt` for noisy public events; the real audit trail is kept.)

## 2. Local setup
```
npm install
cp .env.example .env.local   # fill it in (single-quoted one-line JSON, or Base64). .env also works as a fallback
npm run check-env            # verifies the values are usable; prints names only
npm test                  # business-logic tests, no Firebase needed
```
```
npm run seed              # writes the default settings into Firestore (never overwrites existing ones)
npm run create-owner -- "Your Name" you@iitp.ac.in "a long password"   # first OWNER; re-run to reset a password
```
**Check `approved_email_domains` and `registration_status` in Firestore doc `config/main` before launch.**

## 3. Vercel
1. Import the repo (or `npx vercel`). Framework preset: *Other*. No build command, output directory `public`.
2. Project > Settings > Environment Variables: `FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_WEB_API_KEY`, `RATE_SALT` (all environments).
3. Deploy. Pages: `/register`, `/search-team`, `/admin/dashboard`. API: `/api`.
4. If you keep the pages on another host (Netlify), set `API_URL` in each page to `https://<project>.vercel.app/api`
   and set `ALLOWED_ORIGINS=https://your-site.netlify.app` on Vercel. Hosting everything on Vercel needs neither.

## 4. Moving the existing data
1. Close registration in the old system. In the old sheet export `Registrations`, `TeamMembers` (and `Requests`) as CSV into `./exports/`.
2. `npm run import` (dry run) then `npm run import -- --apply`. Team Codes are preserved; cancelled teams don't claim emails.
3. Admins are **not** migrated (password hashes can't move): create each with `create-owner`, or sign in and use the Administrators tab.
4. Open registration on the new site, retire the Apps Script deployment.

## Settings (Firestore doc `config/main`, edit in the console)
Same keys as the old Configuration sheet, minus the legacy admin ones. Notable: `registration_status` (also toggled from the dashboard),
`registration_opens_at` / `registration_closes_at`, `search_team_show_contacts` (**default is now 0**), `marking_enabled`, `results_final`, `eval_max_*`.
Changes show up within ~10 seconds.

## What changed from the Apps Script version
| Area | Before | Now |
|---|---|---|
| Duplicate members | global script lock + PENDING/rollback/reconcile | one Firestore transaction; `memberEmails` index makes duplicates impossible |
| Rate limiting | shared CacheService buckets, no IP | per-IP atomic counters; one visitor can't use up everyone's quota |
| Admin lockout | any stranger could lock admins out | failures counted per IP (+ email), never globally |
| Admin passwords | home-made salted SHA-256 x300 | Firebase Authentication (Google-managed hashing); we store none |
| Legacy email-only admin (`admin_master_emails`, `admin_update`, admin `status_check`) | anyone knowing an admin email could mark or edit | removed. Eval/marking now needs the dashboard sign-in token |
| Marker identity | position in an email list | the admin's `ADM-` id |
| Public lookup | phones shown by default | masked by default; failed lookups limited per IP |
| Audit log | every rejected request appended forever | noisy public events expire (TTL), real events kept |
| Owners | race could leave zero owners | change runs in a transaction that keeps >= 1 active owner |
| Consent | declarations validated, not stored | policy version + accepted-at saved on each team |

## Not carried over
- `adminBuildResultsSheet` and `adminCreateEvaluatorSpreadsheet` (they created Google Sheets). Marks live in `evaluations`; export with the
  Firestore console or ask for a small `npm run results` script.
- The `EvaluationMapping` tab (nothing read it). The `registration_id` / `evaluation_reference` split is gone; `registration_id` is kept only as an internal field.

## Data model
`registrations/{TEAM_CODE}` (members embedded) · `memberEmails/{sha256(emailKey)}` · `requests` · `submissions/{TEAM_CODE}` · `evaluations/{TEAM_CODE_ADM-id}` ·
`admins/{ADM-id}` · `sessions` · `auditLog` · `config/main` · `rateLimits` · `replays`.

## Registration idempotency (M1.1)
See `docs/REGISTRATION-IDEMPOTENCY.md`. Every registration request must carry a valid `client_request_id`. Keep the TTL policy on `replays.expiresAt`
enabled (section 1.6), though correctness no longer depends on it. Tests: `npm test`; real-emulator concurrency tests: `npm run test:emulator`.

## Environment variables (all scripts, tests and the API)
`lib/env.js` is the single loader; `lib/firebase.js`, `lib/admin.js`, `lib/ratelimit.js`, `api/index.js` and every script load it before anything reads `process.env`.
Files are read from the project root (any working directory works). **Precedence: process environment > `.env.local` > `.env`**; an existing variable is never overwritten.
On Vercel (production/preview) files are not read: only the variables set in the Vercel dashboard are used. `vercel dev` does read local files.
Run `npm run check-env` to see which files were found and where each setting came from (names only, never values).
If the Firebase value is not on one line it is reported as such. Use single quotes or Base64; the loader never prints the value.
