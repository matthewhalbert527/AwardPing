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
- keep secret credentials server/worker-only.

Using a direct PostgreSQL administrator session, provision the exact production
release target (app origin, Supabase origin/project, Vercel project/team, and R2
account/bucket), approved producer source hashes, and release signer material in
Supabase Vault. Application/service-role RPC access cannot create or change
that target.

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
- `FREE_CHECK_HOURLY_IP_LIMIT`
- R2 identity/credentials when hosted evidence routes require signed objects

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
6. Disable only the legacy `anon` key in Supabase. Repeat anonymous browsing,
   login/invitation confirmation, and the hosted Auth-settings probe. Re-enable
   that key immediately if any consumer fails, then repair the consumer.
7. Disable only the legacy `service_role` key. Repeat cron/admin, digest,
   release-evidence dry-run, worker capture, both review lanes, reconciliation,
   quarantine, and page-audit probes. Re-enable it immediately if any path
   fails.
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

- hosted runtime/auth identity (fresh within 2 hours);
- exact R2 recovery verification (fresh within 24 hours);
- non-cohort anonymous leak crawl (fresh within 24 hours);
- rollback and restoration drill (fresh within 7 days);
- database-derived exact crop coverage;
- three normal complete 6 PM three-shard cohorts;
- at least 24 hours of healthy soak evidence.

The newest signed measurement is authoritative. A newer failure or expiry keeps
the gate on HOLD even when an older pass exists.

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
office notes/tasks, Operator Action Inbox, quarantine, digest outbox, and both
paid-lane budget displays.

## Rollback

Suspend the Stage 1 release first so public surfaces and digest claims fail
closed. Roll back the app to the measured deployment, restore the worker to the
matching revision, and verify the database contract/hash state. Do not reverse
data-bearing Supabase migrations without a reviewed forward repair and backup.
