# Stage 1 Invitation-Only Beta Runbook

This runbook releases exactly the 25-award Stage 1 cohort. It does not publish
the legacy catalog, accept open signup, or bypass the database release gate.

## 1. Verify the candidate build

Run the complete local stack, then the launch-specific check against the exact
production environment file without printing secret values:

```bash
npm run verify
npm run launch:check -- --env .env.production.local --production
```

All SQL migrations must parse and all migration contract tests must pass. A
clean-database migration execution is still required before production when a
local PostgreSQL/Docker runtime is available.

## 2. Apply Supabase first

Confirm the linked project is the AwardPing production project. Back it up,
inspect the remote migration list, and apply every migration in filename order:

```bash
npx supabase@latest link --project-ref <production-project-ref>
npx supabase@latest db dump --linked --schema public --file <secure-backup-path>
npx supabase@latest migration list --linked
npx supabase@latest db push --linked
npx supabase@latest migration list --linked
```

Do not run the broad legacy catalog seed. The Stage 1 registry migration owns
the exact 25-member cohort, aliases, hard exclusions, publication state, and
release identity.

If the Supabase SQL Editor is used instead of `db push`, run **every** `.sql` file currently present in `supabase/migrations` in filename order. Do not stop at `0007_shared_award_catalog.sql`. The required chain includes `20260716150000_initial_official_document_events.sql`, `20260716152833_source_intake_fact_candidate_idempotency.sql`, `20260716171409_recover_rejected_initial_document_candidates.sql`, `20260716174800_fix_initial_document_publication_evidence_contract.sql`, and `20260716181500_secure_visual_candidate_publication_trigger.sql`, followed by every later Stage 1 migration. Verify the final state with `migration list --linked`.

The ordered chain includes
`20260716161529_r2_baseline_recovery_quarantine.sql`; keep its exact-source,
hash-verified R2 recovery and durable quarantine contract intact.

In Supabase Auth:

- disable public signup;
- set Site URL to `https://awardping.com`;
- allow only the exact production confirmation/invitation redirects plus the
  explicit localhost development redirect;
- set the minimum password length to 12;
- install `supabase/templates/recovery.html` as the hosted **Reset password**
  template so recovery links pass `token_hash` with `type=recovery` through
  `/auth/confirm`; do not use the default fragment-based template for the SSR
  recovery flow;
- keep secret credentials server/worker-only.

Using a direct PostgreSQL administrator session, provision the exact production
release target (app origin, Supabase origin/project, Vercel project/team, and R2
account/bucket), approved producer source hashes, and release signer material in
Supabase Vault. Application/service-role RPC access cannot create or change
that target.

`PUBLIC`, `anon`, and `authenticated` must have no effective Vault access,
whether granted directly, through `PUBLIC`, or through inherited role
membership. Supabase's managed `supabase_admin` role owns the platform-default
`service_role` Vault grants; a project migration cannot revoke those grants and
must not claim otherwise. The enforceable service-key boundary is that `vault`
is not an exposed Data API profile and no unexpected API-callable function may
reference Vault.

The fresh, signed hosted-runtime proof therefore sends the production
`sb_secret_...` key to the exact Vault-profile GET without redirects and must
receive HTTP `406` with PostgREST code `PGRST106`. Any successful access,
redirect, stale/missing proof, browser-role regrant, or new Vault-referencing RPC
forces `HOLD`, records `vault_access_contract_failed`, and changes the signed
gate state hash. Stage 1 secret verification otherwise continues only through
the reviewed recorders and private readers owned by `postgres`, marked
`SECURITY DEFINER`, and fixed to an empty `search_path`. Never expose the
`vault` schema or add a secret-returning RPC to repair a recorder failure.

## 3. Configure hosted and worker environments

Vercel needs the hosted values used by the app and cron routes:

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` containing the production
  `sb_publishable_...` value
- `SUPABASE_SERVICE_ROLE_KEY` containing a server-only `sb_secret_...` value
- `AWARDPING_ADMIN_EMAILS`
- `RESEND_API_KEY`
- `ALERT_FROM_EMAIL`
- `CONTACT_TO_EMAIL`
- `CRON_SECRET`
- `APP_DATA_ENCRYPTION_KEY`
- `APP_DATA_ENCRYPTION_KEY_ID`
- `APP_DATA_LOOKUP_HMAC_KEY`
- `FREE_CHECK_HOURLY_IP_LIMIT`
- R2 identity/credentials when hosted evidence routes require signed objects

`APP_DATA_ENCRYPTION_KEY` is the active key material for new `ap:v2` AES-GCM
ciphertext. `APP_DATA_ENCRYPTION_KEY_ID` is its non-secret identifier, embedded
and authenticated in every ciphertext. `APP_DATA_LOOKUP_HMAC_KEY` is a separate
stable key used only for the existing 64-hex email lookup-hash contract; it must
not equal the encryption or cron secret. Keep prior v2 key material, when needed, in
`APP_DATA_DECRYPTION_KEYRING_JSON` under its original key ID. Never put any of
these variables in a `NEXT_PUBLIC_` variable.

The missing historical `APP_DATA_ENCRYPTION_KEY` must not be guessed or
replaced in place. Migration
`20260717113112_preserve_legacy_personal_data_for_reentry.sql` copies each
affected profile ciphertext byte-for-byte into an append-only archive, records
its SHA-256, and marks the profile for re-entry without clearing either source
column. The settings and onboarding pages explain that limitation and accept a
fresh name and organization. Saving writes new v2 ciphertext and clears the
re-entry marker; it never changes the archive. Account deletion can erase that
user's archive only through the pending privacy-request-bound erasure RPC.

Migration `20260717123000_legacy_contact_ciphertext_quarantine.sql` separately
inventories every subscriber and digest-outbox contact value that is not
`ap:v2`, using only a ciphertext hash in the protected quarantine registry.
Pending/active subscriber rows are disabled and claimable/reactivatable outbox
rows are terminalized. SQL enqueue, claim, and provider authorization all
require the same exact `ap:v2` subscriber/outbox binding. Any active, claimable,
malformed, or unquarantined non-v2 value forces both the digest release and the
signed Stage 1 launch gate to `HOLD`.

Account deletion uses one pending-request-bound database transaction to write
the durable v2 erasure tombstone, scrub subscriber/outbox material, and erase
the profile legacy archive before Auth deletion. Unrecoverable contact material
can be erased by an explicitly request-bound quarantine ID and ciphertext hash;
the plaintext or old lookup hash is not required. A later exact-key recovery
checks tombstones first and always leaves a recovered subscriber unsubscribed,
so a fresh confirmation is required before mail can resume.

Before launch, preview any plaintext backfill without writes:

```bash
npm run privacy:backfill -- --dry-run
```

The command prints only counts and a plan hash. Applying requires an exact
second-run confirmation:

```bash
npm run privacy:backfill -- --apply --confirm <plan-hash>
```

If and only if the exact legacy v1 key is later recovered, place that exact
unchanged material temporarily in the server-only
`APP_DATA_LEGACY_V1_ENCRYPTION_KEY`. Do not pad or transform a short historical
value: the retired v1 writer hashed the configured string before AES use. Then
run the recovery preview and inspect its blocked count:

```bash
npm run privacy:backfill -- --recover-legacy-v1 --dry-run
npm run privacy:backfill -- --recover-legacy-v1 --apply --confirm <plan-hash>
```

Recovery succeeds only when the current v1 column, immutable archive byte
string, and archived SHA-256 all match. It writes a new v2 copy with a
compare-and-set on `updated_at`; it does not overwrite a user's newer entry or
delete the v1 archive. Remove the temporary legacy key after the verified
recovery run. An unavailable or wrong legacy key leaves the user marked for
re-entry and is never treated as readable data.

The same preview inventories subscriber and outbox contact ciphertext across
all deterministic result pages. With the exact old key it authenticates v1
bytes, verifies the old/current lookup binding, derives the new lookup HMAC,
and performs a revision/hash CAS. Without that key it applies only the durable
disabled quarantine action. An outbox artifact is privacy-scrubbed after its
identity is recovered; readable v1 bytes are never copied into a new outbox
row. Apply output reports quarantined, live-lease-held, recovered, and
tombstone-erased outcomes separately.

The variable names above remain for application compatibility; production does
not accept legacy JWT values in them. `npm run launch:check -- --production`
fails if either value is not the corresponding new key type, if a publishable
key is placed in the server variable, or if a secret key is placed in a
`NEXT_PUBLIC_` variable. Development checks warn about legacy values so a local
migration can be staged without weakening the launch gate.

The local worker needs a dedicated Supabase `sb_secret_...` key, Gemini, and R2
credentials. The installer sends the Supabase secret in `apikey` only and
persists it under the compatibility name `SUPABASE_SERVICE_ROLE_KEY` in the
worker's local environment. Fresh installs reject legacy JWTs. An update-only
install that finds a legacy JWT keeps tasks stopped and requests a validated
replacement before switching the worker runtime.

Gemini is used only by `new_page_review` and `changed_page_review`; PostgreSQL fixes
each at $5 per UTC day with atomic reservations. No Tavily, OpenAI discovery,
baseline-completion AI, source-quality AI, or immediate visual-review key is a
launch requirement.

The isolated release-evidence runner additionally needs the HMAC signer secret,
the anonymous Supabase key, R2 credentials, and—only for the explicit rollback
drill—a Vercel token and the exact rollback/restore deployment IDs. Do not put
the HMAC secret in browser code.

The release-evidence runner requires those variables to contain
`sb_publishable_...` and `sb_secret_...` values. It rejects legacy API keys and
uses the same secret-safe transport as the workers.

### Disable legacy Supabase keys without downtime

Do not disable either legacy key until all consumers are running on the new
keys. Perform the cutover in this order:

1. In the production Supabase project, create/reveal the `sb_publishable_...`
   key and separate `sb_secret_...` keys for the hosted backend, isolated
   release runner, and local worker. Do not delete or disable anything yet.
2. Set the publishable key and hosted secret in every Vercel environment that
   can receive production traffic. Redeploy the reviewed commit because
   `NEXT_PUBLIC_` values are frozen into the client bundle at build time.
3. Run the worker installer from that same clean commit with `-UpdateOnly`. If
   its retained key is a legacy JWT, paste the dedicated worker secret when the
   installer stops and requests it. Confirm all eleven tasks validate before
   they resume.
4. Configure the isolated evidence runner with the publishable key and its
   server-only secret. Run a dry-run hosted-runtime measurement and the normal
   app, Auth, cron/admin, worker read/write, and R2 smoke checks.
5. Run `npm run launch:check -- --env <production-env> --production`. It must
   report current publishable and secret key types. Check deployed logs for
   `Invalid JWT`, HTTP 401, or failed Supabase RPC/REST calls.
6. Treat legacy-key shutdown as one atomic change: Supabase's legacy-key
   control enables or disables `anon` and `service_role` together. Disable the
   pair only after every modern-key preflight passes, and keep one tested
   command ready to re-enable the pair immediately if any post-change probe
   fails.
7. Prove the cutover with endpoints that distinguish acceptance from public
   authorization. Send each key in `apikey` to a guaranteed nonexistent Data
   API relation: modern keys must reach PostgREST and return `404/PGRST205`;
   legacy keys must return `401` with the legacy-disabled reason. Do not use
   `/auth/v1/settings` as the legacy-anon revocation proof because that endpoint
   can remain readable. Separately require Auth settings with the modern
   publishable key, a real privileged read with each modern secret, anonymous
   browsing/login, cron/admin, digest, release evidence, worker capture, both
   paid review lanes, reconciliation, quarantine, and page-audit checks.
8. Keep the release gate pending through the required normal 6 PM cohorts and
   soak. Retain only the new keys after logs and acceptance evidence show no
   legacy dependency.

## 4. Deploy in fail-closed order

1. Apply and verify the database migrations.
2. Deploy the reviewed app revision to Vercel.
3. Confirm the production aliases point to that exact revision.
4. Update the installed local worker from the same reviewed revision.
5. Confirm app, worker, matcher, policy, and migration hashes agree.

The public release remains `pending` during these steps. A deploy succeeding is
not permission to expose the cohort.

The local 6 PM visual-capture shards and independently leased downstream lanes
are the monitoring authority. Historical user-level monitor timestamps and errors are not worker health signals.

## 5. Produce acceptance evidence

Use the producer-owned release CLI; it measures the configured production
target itself and cannot sign arbitrary JSON. Record:

- hosted runtime/auth identity (fresh within 1 hour);
- exact R2 recovery verification (fresh within 24 hours);
- non-cohort anonymous leak crawl (fresh within 24 hours);
- rollback and restoration drill (fresh within 7 days);
- database-derived exact crop coverage;
- three normal complete 6 PM three-shard cohorts;
- at least 24 hours of healthy soak evidence.

The newest signed measurement is authoritative. A newer failure or expiry keeps
the gate on HOLD even when an older pass exists.

Each R2 drill and anonymous leak crawl signs only the exact failure count and a
SHA-256 of the ordered failure set; raw response bodies and verbose errors are
not signed. The producer also writes a redacted local operator report under
`reports/stage1-release-evidence/` and prints its deterministic path in both
preview and apply output. That report contains only actionable public paths or
immutable R2 bucket/object identities, HTTP status/outcome, expected and
observed hashes/lengths/content types, and fixed safe repair guidance. It never
receives credentials, authorization/cookie headers, response bodies, signing
secrets, or raw exception messages. The report must carry the same failure
count and failure-set hash as the signed evidence; a successful measurement has
an explicit empty failure set. Before writing, the report independently
recomputes that hash from its normalized ordered rows and refuses a missing,
altered, reordered, or schema-mismatched diagnostic set.

Award-level verification itself is a durable epoch: its manifest check time,
unchanged snapshot capture time, successful reconciliation, passed deterministic
audit, and registry verification time do not expire merely because 24 hours
elapsed. This does not weaken freshness. Every bound source must still be open,
error-free, and successfully checked within 24 hours; exact latest snapshot
keys/hashes, candidate, reconciliation, audit, and fact-ledger identities must
still match; future-dated evidence, a newer failure, changed evidence, or open
quarantine still closes readiness. Separately, an expired signed R2 recovery
drill closes national public visibility while leaving truthful award readiness
intact for reactivation after a new recovery proof and acceptance.

The R2 drill is bound to the current object set, not merely to its signing age.
It reads every retained published-event artifact plus each manifest source's
core immutable capture objects (HTML page and text, or PDF and text). Source
keys must use one exact
`visual-snapshots/sources/<source UUID>/captures/<32-hex generation>/...`
generation with the complete kind-specific slot set; moving `/latest/` keys,
mixed generations, wrong filenames, duplicates, or incomplete sets are rejected.
Text objects are fully downloaded, checked against their recorded raw UTF-8 byte
length, normalized by removing exactly the one stored terminal newline, and
then compared with the semantic `text_hash`. A new published event, changed
manifest binding, malformed source generation, or changed object-set hash
invalidates an otherwise age-current signature until the drill is rerun.

The v4 R2 manifest enumerates every reference-bearing published-event slot:
`full`, `metadata`, `crop`, `main_full`, `thumbnail`, `text`, `layout`, every
`states[].image` and `states[].geometry`, and `crop.source_image_object_key`.
It retains candidate-bound evidence even after suppression, normalizes exact
bucket/key aliases into one physical GET, and separately signs the complete
logical-reference graph. Webpage, PDF, and first-observation sides must have
their complete kind-specific role set; unknown fields, unsafe state IDs,
missing descriptors, inconsistent aliases, or unclassified object-key paths
fail before any R2 request. The evidence records both object and reference
counts, alias counts, and the object/reference set hashes. A successful drill
must GET and verify every distinct physical object exactly once.

Candidate-free `historical_artifact_unrecoverable` rows intentionally contribute
no invented R2 object. Their signed terminal limitation remains visible through
crop coverage and quarantine. Effective publication requires a fresh hosted
runtime, a current v4 R2 artifact bound to that runtime, and a current
database-derived crop artifact bound to the same R2 artifact. Therefore a new
unbound public event, stale crop proof, or missing historical evidence cannot
remain effectively visible merely because the physical R2 object set did not
change.

Initial official PDFs count as covered only when the retained previous-side
first-observation attestation and current PDF satisfy the exact candidate,
acquisition, hash, R2-role, and localization bindings. Ordinary PDFs retain the
candidate-bound `not_applicable_pdf` rule; every other PDF shape fails closed.

Expect a deliberate `HOLD` window after a migration that changes any release
evidence contract. Recover in this order: apply the migration; deploy the exact
reviewed app revision and update the worker from that revision; record a fresh
hosted-runtime proof; run and record the v4 R2 proof; record the database-derived
crop proof bound to that R2 artifact; then rerun the gate/readiness report. Do
not reuse an earlier artifact or reorder these steps to restore visibility.

Snapshots captured before `latest_metadata.text_object_bytes` was introduced
cannot substantiate the text object contract and remain fail-closed. Recapture
or repair those Stage 1 source generations before building their reviewed
manifests; do not waive the missing byte-length evidence.

## 6. Promote through the database gate

Run the read-only readiness report first:

```bash
npm run stage1:readiness:strict
```

Only after all 25 awards, every visible fact/event, budgets, hashes, worker
cohorts, soak, rollback, R2, and leak checks pass may an administrator generate
and consume the release acceptance record. Promotion is atomic and binds the
exact gate-state hash and release epoch. Never update publication-state tables
directly.

## 7. Smoke-test the invitation-only beta

```bash
npm run launch:smoke -- --url https://awardping.com
```

Verify anonymously that only effectively verified Stage 1 awards are
discoverable, non-cohort slugs do not leak, Marshall has no Sherfield source,
and failed localization shows the event-specific full screenshot with the
honest unavailable label. Then verify an owner/admin invitation, watchlist,
office notes/tasks, password recovery from request through password update,
Operator Action Inbox, quarantine, digest outbox, and both paid-lane budget
displays. Use both a real invited email and an unregistered email and confirm
the recovery request page gives the same public response for both.

The 13:00 UTC daily digest job both freezes new digest payloads and immediately
drains the durable outbox. A second Hobby-compatible daily job at 14:00 UTC
retries queued deliveries and records terminal failures for operator action.
The authenticated drain route remains available for a deliberate manual retry;
no digest depends on an in-memory timer.

## Rollback

Suspend the Stage 1 release first so public surfaces and digest claims fail
closed. Roll back the app to the measured deployment, restore the worker to the
matching revision, and verify the database contract/hash state. Do not reverse
data-bearing Supabase migrations without a reviewed forward repair and backup.
