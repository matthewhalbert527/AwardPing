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

The launch check validates required env names, cron config, migrations, job-run observability, pipeline tables, free-service copy, and billing redirects. It does not print secret values.

## 2. Prepare Supabase

Create or select the production Supabase project, then apply every migration in order:

```bash
npx supabase@latest link --project-ref <supabase-project-ref>
npx supabase@latest db dump --linked --schema public --file /tmp/awardping-remote-public-schema.sql
npx supabase@latest db push
npm run seed:shared-awards
```

If the CLI is not authenticated, run `npx supabase@latest login` first. Before `db push`, inspect the dumped schema and confirm the project is empty or already AwardPing-only. Do not push these migrations into a shared or unrelated Supabase database. If SQL editor is used instead, run `supabase/migrations/0001_initial.sql` through `0007_shared_award_catalog.sql` in filename order.

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

Then run the cron smoke only when you are ready to create real `job_runs` rows and perform due monitor/digest work:

```bash
npm run launch:smoke -- --url https://<production-domain> --cron-secret "$CRON_SECRET" --run-cron
```

After the cron smoke, log in as an owner/admin and open `/dashboard/ops`. Confirm the latest check and digest runs are recorded, failed email deliveries are visible, and monitor errors are understandable.

## 6. First Advisor Workflow

Before inviting more users, complete this path with a beta account:

1. Sign up for free and reach `/dashboard`.
2. Confirm the default office exists.
3. Use `/award-directory` to find an award, then add it to the watchlist after login.
4. Open the watchlist and run a manual check.
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
