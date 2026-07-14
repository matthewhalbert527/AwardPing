# Award Monitoring Policy

AwardPing's global monitoring policy lives in:

`config/award-monitoring-policy.json`

Conversation-derived user decisions live in:

`config/award-decision-memory.json`

Use this file as the first stop for stipulations that decide what should become a public update, what should be filtered as noise, and what source-quality cleanup should treat as low-value or bad source shape.

## How It Is Used

- App-side change classification and public rendering use `src/lib/award-monitoring-policy.ts`.
- Node runners use `scripts/lib/award-monitoring-policy.mjs`.
- Visual snapshot AI prompts include policy prompt lines by scope, including the queued `visual_review_batch` used by the 6 PM capture scan.
- Baseline facts prompts include decision memory for source relevance, short source titles, important-date context, award conditions, and source-quality decisions.
- Change interpretation prompts include decision memory for duplicate updates, expansion/lazy-load noise, wrong screenshot localization, and false added/removed text.
- The overnight source-quality pass records the active policy version in each report.
- Both loaders expose the same deterministic full-bundle `awardMonitoringPolicyIdentity` (`id`, bundle `version`, content `hash`, policy version, and decision-memory version) for audit metadata.
- Batch candidates created by the 6 PM capture scan and the hourly cleanup sweep use the separate `visualReviewBatchPolicyIdentity`. Its hash includes only active Batch rules, aliases, blocking/persistence behavior, Batch prompts, and active Batch decision memory. Baseline-only prompts, examples, labels, and other audit metadata therefore do not invalidate otherwise identical visual-review work.
- Both loaders validate batch coverage at load time. An active alert-blocking rule without a prompt or `visual_review_batch` scope fails fast instead of silently disappearing from queued review.
- Every active policy rule may declare legacy or model-emitted `aliases`. App and worker paths canonicalize those aliases to the stable rule `id` before deciding or recording a suppression.

## Operational Feedback Loop

1. An admin chooses **Not an update** on an event. The event is suppressed immediately, and the requested global/source/award scope is captured in an append-only `monitoring_feedback` row. The original feedback is immutable.
2. If the behavior is already covered by an active rule, the feedback records `already_active`. Otherwise it remains `pending_review`; it does not silently change global behavior.
3. Review the evidence and promote only a deterministic, reusable pattern. Add or refine the config rule, its known aliases, its Batch prompt, and regression fixtures. Do not turn an award-specific example into a global suppression without repeatable evidence.
4. Run the app and worker policy parity tests, classifier/suppression fixtures, visual Batch fixtures, and the relevant migration tests.
5. Deploy the application and worker from the same reviewed policy/config revision. The 6 PM capture shards then consume the same effective Batch identity and canonical rules as the app when they compare evidence and enqueue review candidates.
6. After that revision is deployed, use **Mark implemented**. This appends a `monitoring_feedback_promotions` record tied to the implemented stable rule; it does not rewrite the original feedback record.

This review gate keeps a one-off correction from becoming an accidental global rule while ensuring approved patterns are absorbed by the UI, 6 PM capture workers, queued Batch review, publication guard, and hourly retroactive suppression sweep.

## Worker State and Policy Changes

- A candidate rejected by the latest policy is written to `shared_award_visual_rejection_ledger`, keyed by source, evidence signature, and effective policy hash. The capture worker can absorb the same rejected comparison on a later run without replacing the public/local/R2 last-known-good baseline. Changed evidence or a changed effective policy receives a new review opportunity.
- When a submitted result returns under an older effective policy, the worker rebuilds its prompt, rekeys it to the current effective identity, clears the stale Batch state, and returns it to `pending`. Because polling precedes submission in the hourly worker, the refreshed candidate can be submitted in the same run. Pending candidates are also persisted with the current signature and prompt before submission; a conflicting current-policy candidate supersedes the stale row.
- Batch submission claims record a unique `batch_display_name` (including a claim-token fragment) before the Gemini create request. A timeout, 5xx response, malformed successful response, or crash after that request is intentionally failed closed with `manual_recovery_required_possible_external_batch_created`; it is never auto-resubmitted because the first paid job may exist. Operators should locate the Gemini job by `batch_display_name`, then reconcile its name/result or explicitly clear the claim only after confirming no job was created.
- An approved candidate is not final `published` until its enclosing full capture is the current local baseline and, when enabled, the current R2 baseline. Expandable-section siblings use the full hashes in their shared `meta.json`, never the section hash. Transient promotion failures remain `succeeded` with the completed Batch response and are retried without another paid submission; rejected-only captures never advance the baseline.
- Completed Batch results acquire an atomic per-candidate, database-unique per-source publication claim before rejection-ledger, baseline, change-event, or reconciliation side effects. Concurrent pollers lose the compare-and-set and do no publication work; an abandoned claim becomes recoverable after the configured stale interval. Windows workers also hold an OS-owned per-source mutex across local/R2 side effects, which the operating system releases after a crash. R2 promotion uploads to deterministic immutable capture keys and advances its pointer with an `updated_at` compare-and-set only after every object is durable; a losing writer removes only uploads that the winning pointer does not reference. Partial uploads and failed pointer writes therefore remain safe to retry.
- `cleanup-change-event-noise.mjs` runs in the hourly downstream pipeline after visual Batch publication and scans unsuppressed history in ascending `(detected_at, id)` order. Its service-role-only `monitoring_policy_sweep_state` cursor makes bounded hourly runs continue where the prior run stopped, so old rows cannot be starved by newer events. A changed effective policy hash or deterministic matcher version resets the cursor and intentionally rechecks the full history. The retro sweep evaluates immutable event evidence and current global policy, but does not permanently suppress a historical event merely because its source is now missing, `review_later`, or differently classified; those mutable lifecycle gates remain part of live publication/rendering instead.
- Both worker-state tables are service-role-only. The rejection ledger is comparison memory, not a public baseline or an approval record.

## Adding A Stipulation

1. Add a named entry to `policy_flags` or `source_quality_stipulations`.
2. Give update filters a stable `id`, for example `relative_age_timestamp_churn`.
3. Set `alert_blocking: true` when the flag should prevent public updates.
4. Set `persistent: true` when stored change details with that flag should keep being filtered later.
5. Every active `alert_blocking` flag must have a `prompt` and include `visual_review_batch` in `prompt_scopes`. Add any other prompt scopes that need the same rule.
6. Add every established legacy/model spelling to `aliases`; do not create two canonical rules for the same behavior.
7. Wire deterministic helper logic only when text or metadata can reject it without AI.
8. Increment the policy version so new scan and candidate metadata identifies the changed bundle.
9. Add or update tests in `src/lib/award-monitoring-policy.test.ts`, `scripts/lib/award-monitoring-policy.test.mjs`, and the relevant classifier test.

## Adding User Decision Memory

Use `config/award-decision-memory.json` when a user correction should guide future AI decisions across awards, especially:

- a source page or PDF should be treated as unrelated or review_later,
- a detected change is not meaningful and should be rejected globally,
- a field belongs somewhere else, such as materials versus award conditions,
- a source title should be shorter or less repetitive,
- a one-off example reveals a repeatable pattern.

Each entry should include a stable `id`, `decision_type`, `applies_to`, `prompt_scopes`, and a short `prompt`. Keep examples brief and use them to illustrate patterns, not to create award-only exceptions unless the entry is explicitly award-specific.

Decision-memory entries used by update-review scopes (`change_details_ai`, visual snapshot review, or an update/screenshot-localization decision type) must also include `visual_review_batch`. Increment the decision-memory version whenever those decisions change.

## Current Example

`relative_age_timestamp_churn` covers news/listing recency labels such as `8 days ago` becoming `9 days ago`. That is not an applicant-facing award change and should not produce an update for any award.
