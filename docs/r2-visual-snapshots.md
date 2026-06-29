# R2 Visual Snapshots

AwardPing can store the two newest visual captures for each shared source page in
Cloudflare R2:

- `latest` is the current baseline or newest promoted meaningful update.
- `previous` is the promoted capture that was `latest` before that.

Normal daily scans do not upload every successful scrape. They upload to R2 only
when a source is first baselined, manually baseline-refreshed, or promoted as a
meaningful update. Unchanged captures, AI-rejected changes, low-confidence review
items, and transient review-only captures stay out of R2.

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

The backfill uses a first-upload fast path by default. It skips sources that
already have R2 `latest` objects, uploads files concurrently, and does not rotate
or check `previous` objects. A benchmark on this PC uploaded 73 baselines in
13.3 seconds at concurrency 12.

Then the next normal 2 AM scan will rotate those objects to `previous` and upload
the new capture as `latest` only for sources where the worker promotes a
meaningful update.
