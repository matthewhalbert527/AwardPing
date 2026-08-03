# Stage 1 reviewed-reconciliation and manifest workflow

`npm run stage1:manifest-draft` is the post-commit proof step for an explicit
Stage 1 human-review root. It performs stable, exact-count `SELECT` queries,
writes one local JSON draft, and has no apply, provider, capture, candidate
creation, or R2-object-read mode.

Source onboarding and immutable candidate creation happen first and have their
own confirmations. See
[`stage1-reviewed-source-and-candidate-workflow.md`](stage1-reviewed-source-and-candidate-workflow.md).

## Required order

1. Review or import exact fact candidates separately. Candidate creation is
   not part of reconciliation or manifest generation. A Stage 1 candidate must
   have an exact field/item value, source ID, quote and location, and a
   `stage1_immutable_evidence` metadata marker produced only after an exact
   local-text substring check against the immutable capture text hash and key.
   Legacy candidates carrying a generic quote are not usable.
2. Create one `awardping.stage1.human-review-root.v1` document for one exact
   cohort. The root contains only human choices: canonical award, public facts,
   field composition, per-candidate immutable evidence, all eight role/source
   choices, and the review attestation. It contains no reconciliation or page
   audit IDs.
3. Run `npm run stage1:reconcile-reviewed -- --selection=<root.json>` without
   apply. Review its independent confirmation. A separately authorized apply
   commits that same canonical root hash, updates only the explicit candidates,
   and produces the deterministic audit. Re-run separately for each cohort.
4. After the reviewed reconciliation succeeds, run:

   ```powershell
   npm run stage1:manifest-draft -- --mapping=review-bundles/stage1-human-review-root.json
   ```

   The generator discovers the latest succeeded reviewed reconciliation and
   deterministic audit. Both must persist the exact canonical root schema and
   SHA-256. Supplying generated record IDs cannot steer this lookup.
5. Review the manifest draft, then pass it to `npm run stage1:promote` without
   `--apply` for the separate publication preview and confirmation.

## Human-review root rules

The root must identify one exact Stage 1 cohort or all exact national 25. Each
cohort has all eight roles: `identity_home`, `eligibility`,
`application_materials`, `dates_cycle`, `funding`, `faq`,
`selection_interviews`, and `current_documents`. `identity_home` binds exactly
the configured canonical homepage. Other sources may be reviewed official
program, public-authority, or contractor hosts, but the root must record the
exact host classification and official linking evidence. No fuzzy host
inference is performed.

Every candidate is attributed to exactly one reviewed Stage 1 role. Its
existing `source_role` remains the intake relevance (`primary` or
`supporting`); reconciliation records the distinct reviewed Stage 1 role in
signed evidence and never overwrites intake provenance.

Every nonempty public fact has one field choice with one composition method:

- `direct_exact`: exactly one candidate value must deep-equal the complete
  reviewed public value.
- `ordered_array_items`: the public value must be an array and candidate IDs
  remain in signed item order; candidate value at index N must exactly equal
  public item N.

Each candidate ID has a 1:1 `candidate_evidence` entry containing its exact
source, quote, location, immutable text SHA-256, and immutable text object key.
Those hash/key values must equal the reviewed source snapshot's
`snapshot.hashes.text_hash` and `snapshot.object_keys.text`. The candidate row
must match the reviewed quote/location and contain this exact metadata marker:

```json
{
  "schema_version": "awardping.stage1.candidate-immutable-evidence.v1",
  "source_id": "<source UUID>",
  "capture_text_sha256": "<lowercase SHA-256>",
  "capture_text_object_key": "visual-snapshots/sources/<source UUID>/captures/<32 hex>/text.txt",
  "evidence_quote_sha256": "<SHA-256 of exact stored quote UTF-8 bytes>",
  "verification_method": "exact_local_text_substring"
}
```

A role marked `not_published` still retains at least one reviewed official
source and an honest rationale, but has zero candidate IDs. Present or combined
roles require explicit candidates. The candidate-contributor source IDs are
kept separate from all reviewed monitoring sources, so a monitor-only source
does not enter reconciliation provenance.

## Immutable capture rules

Snapshot keys must use one lowercase immutable generation:
`visual-snapshots/sources/<source UUID>/captures/<32 hex>/`. Mutable
`/latest/` and `/approved/` aliases, mixed sources or generations, unknown
slots, and wrong filenames are rejected. Webpages require `page`, `thumb`,
`text`, and `meta`; PDFs require exactly `pdf`, `text`, and `meta`. Capture
hashes and byte metadata must match the database plus supplied R2/local
verification. Capture and verification timestamps are durable and may be
older; the live source check and human review must be within 24 hours.

The machine-readable root contract is
`docs/stage1-manifest-draft-mapping.schema.json`. The Marshall-shaped example
in `docs/stage1-manifest-draft-mapping.example.json` uses placeholders and is
not a production selection.
