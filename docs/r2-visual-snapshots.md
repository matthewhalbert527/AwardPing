# R2 Visual Snapshots

AwardPing stores immutable visual capture objects in Cloudflare R2 and keeps the
two active generations for each shared source in the database pointer row:

- `latest` is the current baseline or newest promoted meaningful update.
- `previous` is the promoted capture that was `latest` before that.

Objects are written under capture-specific keys such as
`visual-snapshots/sources/<source-id>/captures/<capture-hash>/page.jpg` or
`.../approved/<approval-hash>/page.jpg`. The worker uploads every required object
first, atomically advances the database pointer with an `updated_at` compare-and-set,
and only then deletes objects that fell out of the two-generation history. A lost
compare-and-set deletes only the losing upload's objects that are not referenced by
the winning pointer. It never overwrites an object that another worker is serving.

Normal scheduled scans upload to R2 only when a source is first baselined,
manually baseline-refreshed, or promoted as a meaningful update. Unchanged
captures, AI-rejected changes, low-confidence review items, and transient
review-only captures stay out of R2. The per-source publication lease and local
baseline mutex serialize the local baseline, R2 pointer, event, and reconciliation
side effects across the 6 PM scan and hourly completed-result recovery.

The bucket should stay private. AwardPing reads from it by generating short-lived
signed URLs from the server.

## Bucket

Default bucket name:

```text
awardping-snapshots
```

Create it with Wrangler after Cloudflare login:

```powershell
npx wrangler login
npx wrangler r2 bucket create awardping-snapshots
```

## R2 API Token

Create an R2 token in Cloudflare with Object Read & Write access scoped to the
`awardping-snapshots` bucket. Record:

- Account ID
- Access Key ID
- Secret Access Key

## Environment

Local worker `.env.worker.local`:

```dotenv
AWARDPING_R2_SNAPSHOT_SYNC=true
R2_BUCKET=awardping-snapshots
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
```

Vercel needs the same R2 values, except the worker-only
`AWARDPING_R2_SNAPSHOT_SYNC` is optional there.

## Backfill Existing Baselines

After the current baseline scrape finishes and R2 credentials are present, upload
the existing local baselines as R2 `latest`:

```powershell
npm run source:visual-snapshots -- --env .env.worker.local --all=true --limit 50000 --r2-backfill-baselines=true --r2-backfill-concurrency=12
```

The backfill uses a first-upload fast path by default. It skips sources whose
database pointer already has `latest` objects, uploads capture-specific immutable
files concurrently, and advances an empty pointer without manufacturing a
`previous` generation.

The next normal 6 PM scan rotates the exact old `latest` object keys, hashes, and
metadata into `previous` in the pointer row only when it promotes a meaningful
update. Completed Gemini results are retained on the candidate row, so a local,
R2, event, or reconciliation failure retries from that stored result without
another model call.
