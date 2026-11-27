# Registration idempotency (M1.1)

## API contract (POST /api, `action: "register"`)

`client_request_id` is **required** and must match `^[A-Za-z0-9\-]{16,64}$`. The frontend already sends it (a fresh UUID whenever the form payload changes).

| Situation | Response |
|---|---|
| New valid registration | `{ success:true, registration_id, team_code, registration_status:"REGISTERED", message }` |
| Same id + same payload (any time within 6 h, even if registration has since closed) | the original result above plus `replayed:true` |
| Same id + different payload | `{ success:false, error_code:"IDEMPOTENCY_KEY_REUSED", message }` |
| `client_request_id` missing or malformed | `{ success:false, error_code:"INVALID_REQUEST_ID", message }` |
| Stored replay record unreadable / unverifiable | `{ success:false, error_code:"IDEMPOTENCY_RECORD_UNVERIFIABLE", message }` (fails closed, record untouched) |
| Everything else | unchanged (`VALIDATION_ERROR`, `DUPLICATE_MEMBER`, `ALREADY_REGISTERED`, `REGISTRATION_CLOSED`, `RATE_LIMITED`, `INTERNAL_ERROR`, ...) |

"Same payload" means the same canonical payload: team name, team size, leader, members (order matters) and the four declarations, after the
same normalisation validation uses (whitespace, e-mail case, phone spelling). `client_request_id`, `action`, `hp`, IP, timestamps and
Configuration are excluded, so the hash never changes when settings change. Only the SHA-256 is stored, never the payload.

Failed attempts (validation errors, duplicates, closed) create **no** replay record, so correcting a form and resubmitting with the same id is still possible.

## Replay document `replays/{sha256(client_request_id)[0:40]}`
`schema_version` (1) · `payload_hash` · `result` (original success result, never containing `replayed`) · `created_at` · `expiresAt` (Firestore Timestamp, now + 6 h; the TTL field).
Enable the Firestore TTL policy on `replays.expiresAt` (see DEPLOY.md). TTL deletion is asynchronous, so the code checks `expiresAt` itself: an expired record that still exists is treated as absent and is replaced inside the registration transaction.

## The original race condition
The previous flow was: (1) read `replays/{id}` **outside** any transaction, (2) run the registration transaction, (3) write `replays/{id}` **after** it committed. Consequences:
1. **Commit then lost response/crash before step 3:** the team exists but no replay record does. The retry reached the duplicate check and got `ALREADY_REGISTERED`: the team's code was never returned and could not be recovered through the retry path.
2. **Concurrent identical requests:** both read "no replay" in step 1. One committed; the other lost the email-index race and answered `ALREADY_REGISTERED` instead of the original result.
3. **No payload check:** a different payload reusing a cached id received the first team's result (a wrong confirmation, and another team's code).
4. **A failure in step 3 after the commit** surfaced as `INTERNAL_ERROR` although the registration had succeeded.
5. **Closed-registration check ran first**, so a committed request could not be replayed after closing.
6. **Expiry was never inspected** (relied on TTL), and an invalid id silently turned idempotency off.

## New design (lib/registration.js, lib/idempotency.js)
1. Reject missing/malformed `client_request_id` (before rate limiting).
2. Canonical payload hash (config-independent).
3. Non-transactional preflight read of the replay document, an **optimisation only**: replay/conflict answers cost no rate-limit attempt and work when registration is closed.
4. Open/closed, domains, validation, rate limits (existing keys and windows), then one Firestore transaction:
   - **reads**: `replays/{id}` → (legacy proof read of its registration) → `registrations/{code}` → configuration → every `memberEmails/{hash}`
   - decision: replay / conflict / corrupt are answered from the authoritative read; otherwise duplicate checks
   - **writes** (only after all reads): `registrations/{code}`, `memberEmails` per member, `replays/{id}`: all or nothing
5. Two requests with one id cannot both commit: both read the replay doc (absent), Firestore aborts the later commit, the SDK re-runs the callback, and the re-run reads the winner's replay record, returning a replay (same payload) or `IDEMPOTENCY_KEY_REUSED` (different payload).
6. The transaction callback has no side effects (no audit, no rate limit) because it may run several times. `REGISTRATION_CREATED` is written after the commit, and only by the call that created the team.

Legacy `{ result, expiresAt }` records are never returned blindly: the registration named in `result` is read, its payload is rebuilt canonically and its hash must equal the incoming hash; only then is `payload_hash` backfilled (in a transaction, without extending expiry). A mismatch is `IDEMPOTENCY_KEY_REUSED`; anything unverifiable fails closed.

## Running the tests
```
npm test                    # unit tests (in-memory MODEL of Firestore)  : test/core.test.js, test/idempotency.test.js
npm run test:emulator       # REAL Firestore emulator (needs Java; downloads the emulator jar once): test/emulator/idempotency.emulator.test.js
CH_TEST_FAKE=1 node --test test/emulator/idempotency.emulator.test.js   # same test code against the model, to debug the tests themselves
```
`test/fake-firebase.js` is a model (versioned documents, optimistic transactions that abort and re-run, reads-before-writes enforcement, Timestamps).
It is **not** Firestore; only the emulator suite counts as evidence of concurrent correctness.

## Known limitations
- The configuration read inside the transaction is a fresh read, not part of the transaction: closing registration at the same instant a registration commits can still let that one through.
- If the process dies between the commit and the `REGISTRATION_CREATED` audit write, that audit row is lost (a replay never re-emits it).
- Rate-limit counters (`reg:global` etc.) are transactions on hot documents; very large simultaneous bursts can exhaust the SDK's retries and return `INTERNAL_ERROR` (pre-existing, out of scope).
- A corrupt replay record blocks its own request id until `expiresAt` passes (or an operator deletes it if `expiresAt` is missing).
- After an admin edits a team, a legacy (pre-upgrade) replay record for that team can no longer be proven and returns `IDEMPOTENCY_KEY_REUSED`; legacy records disappear within 6 h of deployment.
- After the 6 h window an identical retry returns `ALREADY_REGISTERED` (the team exists) rather than the original code; use "Check Registration Status".
