# Stage 1 reviewed source and candidate workflow

This is the operator path for turning the explicit human review of the exact
national 25 into monitored source requests and immutable fact candidates. It
does not publish award facts. Source onboarding and candidate import each use
their own preview, exact confirmation, atomic apply, and separate receipt.

## Safety boundaries

- The cohort is exactly 25 awards and eight required source roles per award:
  200 award-role slots in total.
- A preview makes no production writes and no paid API calls.
- A confirmed source enqueue makes no paid API calls and does not start page
  processing. Later review of a genuinely new page runs in the separate
  `new_page_review` lane, whose account-wide daily cap is $5.
- Every new source request is `historical_import` plus `baseline_only`. It may
  establish evidence for the reviewed Stage 1 cohort, but it cannot notify the
  public as though historical wording were a newly observed change.
- A confirmed candidate import makes no paid API calls. It inserts only pending
  reviewed fact candidates and their private idempotency ledger. It does not
  change sources, releases, reconciliation, publication state, or legacy
  candidate rows.
- Neither command automatically accepts a ranked candidate, reconciles public
  facts, or promotes the cohort.

## 1. Build and review the source-onboarding plan

The source plan consumes the current Stage 1 readiness report and all three
explicit human-review reports. With the standard report names, run:

```powershell
npm run stage1:source-plan
```

To supply different retained reports, use:

```powershell
npm run stage1:source-plan -- `
  --readiness=reports/stage1-cohort-readiness-current.json `
  --review-1=reports/stage1-awards-1-8-official-role-review-2026-07-17.json `
  --review-2=reports/stage1-official-source-review-09-16-20260717.json `
  --review-3=reports/stage1-official-source-review-17-25-20260717.json `
  --output=reports/stage1-reviewed-source-onboarding-plan.json
```

The command must report 25 awards, 200 accounted award-role slots, zero role
gaps, zero writes, and zero paid calls. Review every proposed URL, exact award
ID, source-role link, authority classification, and the complete (not capped)
summary. Existing source rows are evidence only and remain read-only. A URL may
be collapsed across several roles for the same award, but is never deduplicated
across different awards.

Two identity cases are intentionally distinct:

- Hertz has a reviewed canonical identity migration from
  `https://www.hertzfoundation.org/the-fellowship/` to
  `https://www.hertzfoundation.org/hertz-fellowship/`. This is a separate
  identity migration, not a side effect of source onboarding.
- NDSEG remains canonically rooted at `https://ndseg.org/`. Its official
  `https://ndseg.org/apply-link` delegates the current application to the
  SysPlus contractor host, which is classified as `official_contractor_host`.
  The contractor source does not replace the canonical NDSEG identity.

If the plan is correct and still within its 24-hour review window, copy the
exact `Plan SHA-256` printed by the preview and run:

```powershell
npm run stage1:source-plan -- `
  --apply `
  --confirm=<exact-preview-plan-sha256> `
  --apply-result=reports/stage1-reviewed-source-onboarding-apply-result.json
```

The atomic apply inserts only missing deterministic `source_page_requests`.
It fails closed if the live registry, canonical award identity, reviewed
inputs, request seed data, or confirmation hash has changed. Keep the preview
and the separate enqueue receipt together. Enqueue is still free; later page
processing is a different operation governed by the $5/day new-page lane.

## 2. Review immutable capture text and prepare candidate bundles

Wait for each required source to have a verified immutable capture. Human
review must use the retained capture text, not a mutable `latest` alias and not
a paraphrase. For each proposed fact item, retain:

- the exact canonical award and source UUIDs;
- the immutable capture text object key and lowercase SHA-256;
- the exact UTF-8 quote and its start/end offsets in that capture text;
- the exact fact field, item value, source role, and review timestamp; and
- the explicit reviewer attestation required by the bundle schema.

The import loader reads only regular files below the configured capture
archive, rejects symlink or junction redirection, recomputes the text bytes and
hash, and verifies the exact quote range. A generic quote, fuzzy match, mutable
object key, wrong source generation, stale review, or mismatched official
identity fails closed before any candidate write.

## 3. Preview and confirm the reviewed candidate import

Preview the explicit-human bundle:

```powershell
npm run stage1:import-reviewed -- `
  --bundle=review-bundles/stage1-reviewed-candidates.json `
  --output=reports/stage1-candidate-import-preview.json
```

Review the candidate IDs, exact values, quote ranges, capture hashes and keys,
canonical award binding, and the printed confirmation phrase. The phrase has
this form and must be copied exactly from the current preview:

```text
CONFIRM STAGE1 CANDIDATE IMPORT <bundle-sha256>
```

Then run the atomic import with a separate, new receipt path:

```powershell
npm run stage1:import-reviewed -- `
  --bundle=review-bundles/stage1-reviewed-candidates.json `
  --output=reports/stage1-candidate-import-preview.json `
  --apply `
  --confirm="CONFIRM STAGE1 CANDIDATE IMPORT <bundle-sha256>" `
  --apply-result=reports/stage1-candidate-import-apply-result.json
```

The apply receipt is write-once, separate from the preview, and contains the
bundle/confirmation hashes, deterministic candidate IDs, inserted/idempotent
counts, timestamp, and zero-side-effect attestation. It intentionally contains
no reviewer identity, source quote, environment secret, or service credential.
An exact replay is allowed after downstream candidate lifecycle changes while
the review and live identity fences remain valid. Every retry re-reads the
immutable local file; the ledger retains the complete first verification proof
and compares every stable binding field while allowing only that new local
verification timestamp to differ. The importer never reverts downstream
lifecycle changes.

## 4. Reconcile and publish separately

Candidate import is not approval. After the exact candidates and all eight
source roles have been human-reviewed, follow the separate workflow in
[`stage1-manifest-draft.md`](stage1-manifest-draft.md): create the signed human
review root, preview and confirm reviewed reconciliation, generate the manifest
draft, and separately preview any Stage 1 promotion. The NDSEG application-cycle
dates remain
`not_published` in durable manual quarantine until its two current official
contractor pages agree or explicit retained program-owner evidence resolves the
conflict.

No command in this guide authorizes a production apply merely because a
preview succeeded. The operator must inspect the complete artifact and provide
the exact current confirmation for each apply.
