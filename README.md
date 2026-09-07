# AwardPing

AwardPing is a focused nationally competitive award monitor. Advisors can create a shared office, track awards from a shared source database, manually add exact URLs, rely on the scheduled 6 PM capture scans and independent 15-minute downstream lanes, and receive email alerts or daily digests when meaningful content changes.

## Stack

- Next.js App Router, TypeScript, Tailwind CSS
- Supabase Auth, Postgres, Row Level Security
- Resend email alerts for award page updates
- Tavily + Gemini or OpenAI for award source discovery and summaries
- Local PC worker for source crawling and shared change history

## Local Setup

For UI-only development without starting a database or worker:

```bash
npm ci
npm run dev
```

The app can render without environment variables; data-dependent pages show their unavailable state. Auth, persistence, email, and optional discovery need separately configured services. Do not copy production credentials into a UI-only development environment.

Set `AWARDPING_ADMIN_EMAILS` to a comma-separated list of owner login emails to enable the private `/dashboard/admin` background scan page.

**Fresh database bootstrap remains unresolved.** The frozen migration chain requires a historical homepage-data transition that is not created by ordinary startup. Bare database startup/reset from the normal checkout is not a working setup procedure. The [test-only migration replay](docs/stage1-fixture-migration-smoke.md) passed in an explicitly authorized disposable GitHub environment using a guarded synthetic fixture. That fixture is not production evidence and must never be applied to a live database or placed in `supabase/migrations`.

## Supabase Setup

This is configuration guidance for an already provisioned, separately approved development environment, not a database bootstrap or production upgrade procedure. Do not apply all migration files or repair migration history to make a ledger match. Existing schema/data and recorded migration history must be reviewed together before any database change.

1. Use the approved development project's URL and publishable key in `.env.local`; keep its secret key server-only under the compatibility variable names in `.env.example`.
2. Configure the site URL and auth redirect URLs to include:
   - `http://localhost:3000/auth/confirm`
   - `https://your-domain.com/auth/confirm`
3. Configure the Supabase **Reset password** email template to send the token
   hash through AwardPing's server callback. Copy
   `supabase/templates/recovery.html` into the hosted Auth template; the default
   Supabase template does not establish the server-side recovery session used
   by `/reset-password`.

## Award Discovery Setup

1. Add `TAVILY_API_KEY` and either `GEMINI_API_KEY` or `OPENAI_API_KEY` to `.env.local`.
2. Optional: set `AI_PROVIDER=gemini` to prefer Gemini, or leave `AI_PROVIDER=auto` to use Gemini when present and OpenAI otherwise.
3. Optional: set `GEMINI_DISCOVERY_MODEL`, `GEMINI_SUMMARY_MODEL`, `OPENAI_DISCOVERY_MODEL`, or `OPENAI_SUMMARY_MODEL` to the models you want.
4. Do not run the legacy broad catalog seed for Stage 1. Discovery does not authorize publishing additional awards; follow the [reviewed source and candidate workflow](docs/stage1-reviewed-source-and-candidate-workflow.md).
5. Use `/award-directory` to search the shared award database, then add specific awards to a watchlist after login.

## Shared Offices

Each signup gets a starter workspace and can create a university office such as an Office of Nationally Competitive Awards, Fellowships Office, Honors Advising office, or whatever name the school uses. The creator gets owner/admin permissions so they can edit awards, invite advisors, add tracked award pages, review scheduled-worker results, and manage the watchlist.

Owners and admins can invite teammates by searching existing users by email, sending an email invitation, or creating an invite code/link. Invite links work for existing accounts and for new users after signup. Members can review the shared watchlist, award source pages, change history, and choose whether they receive immediate alerts, a daily digest, both, or no emails.

Set `CRON_SECRET` in production so Vercel can call the digest cron route. The default digest cron runs at 13:00 UTC. Source monitoring is performed by the local 6 PM visual-capture shards and the independently leased downstream lanes, not by a Vercel monitor cron.

## Local PC Visual Worker

For the lowest-cost setup, keep the website on Vercel and run the screenshot/PDF
checker from a local computer. The worker reads shared award sources from
Supabase, captures visual baselines, compares future screenshots and PDFs, and
uses AI only when a visual candidate needs review.

```bash
npm run source:visual-snapshots -- --env .env.worker.local --all=true --limit 50000
```

The legacy local text-change worker has been retired. Three visual-capture
shards run on the crawler PC at 6:00 PM. Eight independently leased downstream
lanes run every 15 minutes for new-page review, changed-page review, feedback
promotion, suppression, reconciliation, deterministic page audit, manual
quarantine, and the nightly report. A slow visual batch cannot block auditing
or reconciliation. Only the two review lanes can create a Gemini charge, and
PostgreSQL atomically caps each one at $5 per UTC day.

Update the Windows worker from a reviewed repository revision with
`Install-AwardPingWorker.ps1 -UpdateOnly`; do not copy individual files into the
installed app. The complete install and update runbook is in
`docs/local-pc-worker-installer.md`.

## Stage 1 Public Launch

Stage 1 is limited to exactly 25 national award cohorts. A website deployment, discovery result, or successful disposable test does not authorize cohort expansion or prove current source freshness.

Start with local verification (`npm run verify`) and the [recorded fixture-assisted replay result](docs/stage1-fixture-migration-smoke.md). Any production database change, worker update, or subsequent website deployment needs a separately reviewed operation with the exact target, current state, approved changes, verification, and recovery plan. Never use a broad catalog seed, blanket migration push, or migration-history repair as a launch shortcut.

The [historical invitation-only beta runbook](docs/private-beta-launch.md) preserves release-gate, auth, evidence, worker, and digest requirements. It is not a current production execution checklist; its historical operation examples require separate review before use. Use `/dashboard/ops` as an owner/admin to inspect worker and source health, downstream lanes, digest runs, and failed deliveries. Do not infer monitoring success from a deploy or test pass.

## Free Service Copy

AwardPing is free. User-facing calls to action should say `Sign up for free`, and billing or pricing routes should continue redirecting into signup or the dashboard.

## Verification

```bash
npm run verify
```

This runs:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

For launch-specific checks:

```bash
npm run launch:check -- --env .env.production.local --production
npm run launch:smoke -- --url https://your-domain.com
```
