# R2 Visual Snapshots

AwardPing stores immutable visual capture objects in Cloudflare R2 in two
separate retention planes.

The source-baseline plane keeps the two active generations for each shared
source in the database pointer row:

- `latest` is the current baseline or newest promoted meaningful update.
- `previous` is the promoted capture that was `latest` before that.

Objects are written under capture-specific keys such as
`visual-snapshots/sources/<source-id>/captures/<capture-hash>/page.jpg` or
`.../approved/<approval-hash>/page.jpg`. The worker uploads every required object
first, atomically advances the database pointer with an `updated_at` compare-and-set,
and only then deletes objects that fell out of the two-generation history. A lost
compare-and-set deletes only the losing upload's objects that are not referenced by
the winning pointer. It never overwrites an object that another worker is serving.

The published-event plane is permanent. Before an accepted visual review can
create a public update, the downstream worker copies every image, PDF,
metadata file, text file, and structured geometry file referenced by that exact
review candidate into content-addressed keys under:

```text
visual-snapshots/published/<candidate-id>/<previous|current>/<role>/<sha256>.<extension>
```

At queue time, every artifact reference records its exact byte SHA-256 and byte
length. A path-free previous/current artifact-manifest digest is part of both
the evidence signature and candidate signature. Publication recomputes the
manifest and preflights every local file before the first permanent upload, so
a same-size replacement, stale path, missing state hash, or geometry/image
binding mismatch cannot be published. If an archive was moved, the signed
archive-relative path may resolve under the explicitly supplied archive root;
the exact hash and byte-length checks still apply.

For web pages, it also creates real JPEG previous/current crops from the exact
changed text rectangles. Added wording is localized against the current image;
removed wording is localized against the previous image. If the exact text was
found only after an accordion was opened, that opened-state screenshot supplies
the event image and crop. A crop is marked verified only when the exact wording
rectangle overlaps the crop and the geometry is hash- and dimension-bound to
the screenshot. Otherwise the event retains and serves its own full screenshot
with an explicit unavailable reason. It never substitutes a fuzzy crop or the
source's newer moving pointer.

The worker HEAD-verifies byte length and SHA-256 metadata for every permanent
object, then atomically inserts the change event and immutable evidence row.
Failure at any point leaves the candidate retryable and does not publish a
partial update. Repeated attempts reuse the same content-addressed keys. The
database rejects updates or deletion of published evidence and requires the
event's candidate, source, award, hashes, captures, geometry, localization, and
crop identities to agree.

Normal scheduled scans write to the source-baseline plane only when a source is
first baselined, manually refreshed, or promoted as a meaningful update.
Unchanged captures, AI-rejected changes, and low-confidence candidates do not
advance that pointer. Accepted candidates are copied to the permanent event
plane before publication. The per-source publication lease and local baseline
mutex serialize the local baseline, R2 pointer, event evidence, and
reconciliation side effects across the 6 PM capture scan and the independent
changed-page review lane.

Retention cleanup may remove objects that fall out of the moving two-generation
source history. It categorically excludes `visual-snapshots/published/`; every
object referenced by a published update must remain available for that update.

The bucket should stay private. AwardPing reads from it by generating short-lived
signed URLs from the server.

## Automatic Local Cache Recovery

R2 is authoritative when a retained local baseline points to missing evidence.
Before the 6 PM comparison fails, the worker checks the R2 `latest` and
`previous` generations for one exact match to the baseline's source, award,
kind, capture timestamp, image/PDF hash, and text hash. It does not choose a
newer pointer or a fuzzy substitute.

Every referenced key must be under the source's immutable capture/approved
prefix. The worker HEADs and downloads the complete required generation,
verifies object metadata/length, recomputes the core SHA-256 hashes, validates
the downloaded source metadata and layout/image binding, and rewrites only the
machine-local file paths. Downloads go to a sibling staging directory. Only
after every artifact passes does one atomic rename publish the restored cache
and one atomic JSON write repoint the baseline. Any missing object, key escape,
hash mismatch, identity mismatch, partial download, or concurrent baseline
change leaves the last-known-good baseline untouched and is reported as a
refused or failed recovery.

Recovery is enabled whenever complete R2 snapshot sync is enabled; it creates
no Gemini/API-review charge. Admin workflow **6. Evidence Recovery** reports
attempts, exact restores, refusals, and operational failures from the scheduled
workers. It separates restores with verified text-node/accordion geometry from
legacy evidence-only restores, so a recovered screenshot is never mistaken for
recovered localization data.

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

## Published Event Coverage

Measure the immutable event evidence itself, including an R2 HEAD check for
each required artifact. This report counts verified event crop sides, honest
full-image fallbacks, and unrecoverable historical events separately; it does
not treat the existence of source layout metadata as successful localization.

```powershell
npm run source:visual-evidence-coverage -- --env .env.worker.local
```

## Historical Event Backfill

Historical repair is dry-run by default. It accepts only an existing direct
candidate foreign key, an exact unique candidate signature, or an exact reverse
event ID recorded on one candidate, and then cross-checks award, source, and
previous/current visual hashes. It never guesses from timestamps or the current
source pointer. Legacy geometry cannot create a verified crop; surviving full
event artifacts are retained with an honest unavailable status. Ambiguous
linkage, missing archives, manifest failures, and total artifact loss remain
retryable by default; they do not create an immutable evidence row. Apply mode
continues recovering independent later events but keeps its contiguous
checkpoint before the first unresolved gap, so a rerun revisits every pending
event and idempotently skips evidence already recovered.

```powershell
npm run source:backfill-visual-event-evidence -- --env .env.worker.local
npm run source:backfill-visual-event-evidence -- --env .env.worker.local --apply=true
```

Only confirmed terminal loss may be recorded as
`historical_artifact_unrecoverable`. After reviewing the dry-run report, an
operator can supply a JSON confirmations file:

```json
[
  {
    "event_id": "00000000-0000-0000-0000-000000000000",
    "resolution_reason_code": "historical_artifacts_unrecoverable",
    "reason": "Both candidate-bound retained sides were confirmed destroyed.",
    "actor": "operator@example.com",
    "confirmed_at": "2026-07-15T19:00:00.000Z"
  }
]
```

```powershell
npm run source:backfill-visual-event-evidence -- --env .env.worker.local --apply=true --terminal-loss-confirmations .\reviewed-terminal-loss.json
```

The current reason code must exactly match the reviewed confirmation. A stale
or mismatched confirmation is rejected and remains in the repair report.
