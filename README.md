# AwardPing

AwardPing is a focused nationally competitive award monitor. Advisors can create a shared office, track awards from a shared source database, manually add exact URLs, use hourly scheduled checks, and receive email alerts or daily digests when meaningful content changes.

## Stack

- Next.js App Router, TypeScript, Tailwind CSS
- Supabase Auth, Postgres, Row Level Security
- Resend email alerts for award page updates
- Tavily + Gemini or OpenAI for award source discovery and summaries
- Local PC worker for source crawling and shared change history

## Local Setup

```bash
cp .env.example .env.local
npx supabase start
npm install
npm run dev
```

The app can render without environment variables, but auth, persistence, email, and AI discovery require Supabase, Resend, Tavily, and either Gemini or OpenAI keys.

Set `AWARDPING_ADMIN_EMAILS` to a comma-separated list of owner login emails to enable the private `/dashboard/admin` background scan page.

For local development, `npx supabase start` applies the migrations and prints the local Project URL plus publishable/secret keys. Put those local values in `.env.local`, then restart `npm run dev`.

## Supabase Setup

1. Create a Supabase project.
2. Run the SQL files in `supabase/migrations` in order through the SQL editor or Supabase CLI.
3. Add the Supabase URL, anon key, and service role key to `.env.local`.
4. Configure the site URL and auth redirect URLs to include:
   - `http://localhost:3000/auth/confirm`
   - `https://your-domain.com/auth/confirm`

## Award Discovery Setup

1. Add `TAVILY_API_KEY` and either `GEMINI_API_KEY` or `OPENAI_API_KEY` to `.env.local`.
2. Optional: set `AI_PROVIDER=gemini` to prefer Gemini, or leave `AI_PROVIDER=auto` to use Gemini when present and OpenAI otherwise.
3. Optional: set `GEMINI_DISCOVERY_MODEL`, `GEMINI_SUMMARY_MODEL`, `OPENAI_DISCOVERY_MODEL`, or `OPENAI_SUMMARY_MODEL` to the models you want.
4. Seed the shared award catalog with `npm run seed:shared-awards`.
5. Use `/award-directory` to search the shared award database, then add specific awards to a watchlist after login.

## Shared Offices

Each signup gets a starter workspace and can create a university office such as an Office of Nationally Competitive Awards, Fellowships Office, Honors Advising office, or whatever name the school uses. The creator gets owner/admin permissions so they can edit awards, invite advisors, add tracked award pages, run manual checks, and manage the watchlist.

Owners and admins can invite teammates by searching existing users by email, sending an email invitation, or creating an invite code/link. Invite links work for existing accounts and for new users after signup. Members can review the shared watchlist, award source pages, change history, and choose whether they receive immediate alerts, a daily digest, both, or no emails.

Set `CRON_SECRET` in production so Vercel can call the monitor and digest cron routes. The default digest cron runs at 13:00 UTC.

## Local PC Visual Worker

For the lowest-cost setup, keep the website on Vercel and run the screenshot/PDF
checker from a local computer. The worker reads shared award sources from
Supabase, captures visual baselines, compares future screenshots and PDFs, and
uses AI only when a visual candidate needs review.

```bash
npm run source:visual-snapshots -- --env .env.worker.local --all=true --limit 50000
```

The legacy local text-change worker has been retired. Daily checking should use
`Run-AwardPingVisualSnapshots.ps1`, which is scheduled on the crawler PC for
6:00 PM.

The Windows worker now lives on the crawler PC directly. Make code changes in
this repo, copy the changed worker files into `%LOCALAPPDATA%\AwardPingWorker\app`
when needed, then deploy Vercel and push Git. The old hosted worker zip updater
has been retired.

## Private Beta Launch

Before inviting real advisors:

1. Run `npm run verify`.
2. Apply every migration in `supabase/migrations`, including `0008_shared_award_history.sql`.
3. Set hosted Supabase auth URLs to your production domain plus `http://localhost:3000/auth/confirm`.
4. Configure Vercel environment variables for Supabase, Resend, Tavily, Gemini or OpenAI, `CRON_SECRET`, and `NEXT_PUBLIC_APP_URL`.
5. Verify Resend sender/domain status before relying on invite, alert, or digest email.
6. Run `npm run launch:check -- --env .env.production.local --production`.
7. Run `npm run launch:smoke -- --url https://your-domain.com`.
8. Run `npm run seed:shared-awards` against production.
9. Run `npm run source:visual-snapshots -- --env .env.worker.local --all=true --limit 50000` from the local crawler computer.
10. Use `/dashboard/ops` as an owner/admin to confirm cron runs, monitor errors, and failed deliveries after launch.

The full launch runbook is in `docs/private-beta-launch.md`.

## Free Service Copy

AwardPing is free during the private beta. User-facing calls to action should say `Sign up for free`, and billing or pricing routes should continue redirecting into signup or the dashboard.

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
