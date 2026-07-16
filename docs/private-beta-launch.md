# Private Beta Launch Runbook

Use this checklist to move AwardPing from a local build to a hosted private beta. The service is free during this phase, so signup CTAs should say "Sign up for free" and billing/pricing surfaces should stay redirected.

## 1. Verify The Build

Run the full local verification suite before touching production:

```bash
npm run verify
```

Then check launch-specific wiring against the env file you intend to use:

```bash
npm run launch:check -- --env .env.production.local --production
```

The launch check validates required env names, digest cron config, migrations, job-run observability, pipeline tables, free-service copy, and billing redirects. It does not print secret values. Source monitoring itself runs on the local 6 PM visual-capture shards and independently leased downstream lanes.

## 2. Prepare Supabase

Create or select the production Supabase project, then apply every migration in order:

```bash
npx supabase@latest link --project-ref <supabase-project-ref>
npx supabase@latest db dump --linked --schema public --file /tmp/awardping-remote-public-schema.sql
npx supabase@latest db push --linked
npx supabase@latest migration list --linked
npm run seed:shared-awards
```

If the CLI is not authenticated, run `npx supabase@latest login` first. Before `db push`, inspect the dumped schema and confirm the project is empty or already AwardPing-only. Do not push these migrations into a shared or unrelated Supabase database. Confirm `migration list --linked` shows every local migration on the remote side and no local-only rows remain.

If SQL Editor is used instead, run **every** `.sql` file currently present in `supabase/migrations` in filename order. Do not stop at `0007_shared_award_catalog.sql`; the required sequence includes `20260716150000_initial_official_document_events.sql`, which adds immutable first-observation provenance and publication support for newly discovered official documents, followed by `20260716152833_source_intake_fact_candidate_idempotency.sql`, which makes retained-result fact replay duplicate-safe, `20260716161529_r2_baseline_recovery_quarantine.sql`, which atomically protects a source and creates a source-keyed operator case when authoritative R2 recovery fails, and `20260716171409_recover_rejected_initial_document_candidates.sql`, which safely reopens only zero-charge first-document candidates rejected by the corrected applicant-signal guard.

Before updating the installed worker, confirm the last migration is present remotely. The R2 service-role RPCs keep a recovery failure in `review_later` and in Manual Quarantine until the worker verifies and restores the exact immutable R2 generation. Generic quarantine refreshes cannot close that case, and the recovery itself creates no API charge. Broad scans continue to exclude the protected source; use only the worker's exact-source recovery invocation to retry it. Exact recovery resolves the R2 case, but it reopens and clears source failure fields only if the R2 workflow still owns the exact `review_later` status, owner, and note; any later unrelated review is preserved. The rejected first-document recovery is also service-role-only and zero-charge: it requires the exact rejected candidate, acquisition, signature, candidate evidence signature, unassigned quarantine evidence hash, and corrected failure reason. It does not alter immutable evidence or resolve quarantine; normal atomic event publication must succeed before the quarantine closes.

In Supabase Auth, set:

- Site URL: `https://<production-domain>`
- Redirect URLs: `https://<production-domain>/auth/confirm`
- Local redirect for development: `http://localhost:3000/auth/confirm`

## 3. Configure Vercel

Link the repo to the intended Vercel project:

```bash
npx vercel@latest login
npx vercel@latest link
```

Set these production environment variables in Vercel:

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- `ALERT_FROM_EMAIL`
- `CONTACT_TO_EMAIL`
- `CRON_SECRET`
- `TAVILY_API_KEY`
- `AI_PROVIDER`
- `GEMINI_API_KEY`
- `GEMINI_DISCOVERY_MODEL`
- `GEMINI_SUMMARY_MODEL`
- `OPENAI_API_KEY`
- `OPENAI_DISCOVERY_MODEL`
- `OPENAI_SUMMARY_MODEL`
- `DISCOVERY_DAILY_USER_LIMIT`
- `DISCOVERY_DAILY_IP_LIMIT`
- `DISCOVERY_DAILY_GLOBAL_LIMIT`

Use a verified Resend sender for `ALERT_FROM_EMAIL`. Use a long random value for `CRON_SECRET`; do not reuse a local value.

Keep the discovery limits conservative for the private beta. Each award search currently performs four basic Tavily searches plus one Gemini or OpenAI classification call, so discovery is the main variable cost surface.

## 4. Deploy

Deploy production:

```bash
npx vercel@latest --prod
```

If Vercel generated a new URL, update `NEXT_PUBLIC_APP_URL` to the final production URL and redeploy.

## 5. Smoke Test

Run a non-mutating route smoke test:

```bash
npm run launch:smoke -- --url https://<production-domain>
```

Then run the cron smoke only when you are ready to create a real digest `job_runs` row and perform due digest delivery work:

```bash
npm run launch:smoke -- --url https://<production-domain> --cron-secret "$CRON_SECRET" --run-cron
```

After the cron smoke, log in as an owner/admin and open `/dashboard/ops`. Confirm the local worker and downstream lanes are healthy, shared-source failures are understandable, the latest digest run is recorded, and failed email deliveries are visible. Historical user-level monitor timestamps and errors are not worker health signals.

## 6. First Advisor Workflow

Before inviting more users, complete this path with a beta account:

1. Sign up for free and reach `/dashboard`.
2. Confirm the default office exists.
3. Use `/award-directory` to find an award, then add it to the watchlist after login.
4. Open the watchlist and confirm its tracked sources are assigned to the scheduled visual worker; the retired manual text check is intentionally unavailable.
5. Move the saved award through the pipeline.
6. Add one note and one task.
7. Send and accept one office invite.
8. Confirm emails send through Resend or are intentionally skipped in local-only testing.

## Rollback

If the deployment fails before users enter data, roll back the Vercel deployment:

```bash
npx vercel@latest rollback
```

Do not roll back Supabase schema once beta users have written data unless a migration is confirmed destructive and a backup has been taken.
