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
- Historical source-quality reports retain the active policy version, but no source-quality or baseline-completion worker is part of the permanent schedule.
- Both loaders expose the same deterministic full-bundle `awardMonitoringPolicyIdentity` (`id`, bundle `version`, content `hash`, policy version, and decision-memory version) for audit metadata.
- Batch candidates created by the 6 PM capture scan and decisions applied by the independent suppression lane use the separate `visualReviewBatchPolicyIdentity`. Its hash includes only active Batch rules, aliases, blocking/persistence behavior, Batch prompts, and active Batch decision memory. Baseline-only prompts, examples, labels, and other audit metadata therefore do not invalidate otherwise identical visual-review work.
- Both loaders validate batch coverage at load time. An active alert-blocking rule without a prompt or `visual_review_batch` scope fails fast instead of silently disappearing from queued review.
- Every active policy rule may declare legacy or model-emitted `aliases`. App and worker paths canonicalize those aliases to the stable rule `id` before deciding or recording a suppression.

## First Observation of a New Official Document

AwardPing may surface a newly discovered PDF for an existing award even when
the PDF has not changed since AwardPing first saw it. This is a **first
observation**, not a before-and-after website change.

The live workflow is:

1. The shared worker discovers a new PDF on an official source for an existing
   award.
2. The **New page review** lane performs the one paid review. It must confirm
   that the PDF is official, applicant-facing, materially relevant, and current,
   upcoming, or evergreen. The review and exact PDF hash are sealed together.
3. An accepted review creates an immutable source-acquisition record. The first
   capture saves the baseline and creates a deterministic, zero-charge
   first-observation candidate from that sealed review and the same PDF hash.
4. Downstream publication may create a **New official document / new cycle
   guidance** event. Its evidence shows the exact wording AwardPing first
   observed and the retained current PDF. It does not invent a previous version.

The public wording must say when **AwardPing first observed** the document. It
must not claim or imply when the publisher posted, released, or changed it. If
the review, acquisition record, exact quote, hash, or retained evidence does not
match, publication fails closed.

Bulk historical onboarding, creation of a new award, imports, repair runs, and
legacy records remain **baseline-only**. They may establish monitoring evidence
but do not create first-observation alerts. Reprocessing one of those records
cannot silently convert it into a live-discovery alert.

If a post-seed PDF matches an older request, AwardPing does not hide the new
link or automatically start a second paid review. It places one item in Manual
Quarantine with the prior request and charge evidence. The safe operator choices
are: replay and bind the exact retained live result for **$0** when it is
eligible, or explicitly approve **one new-page review** after inspecting the
history. The second choice closes only the exact blocking request, preserves its
original status and provenance in quarantine evidence, and remains subject to
the $5 New page review daily budget.

The shared source capture worker, including the scheduled 6 PM shards, is the
authoritative monitoring path. The old per-user `check-monitors` route is
retired; it does not check current shared sources, and its historical counters
must not be treated as current scan results.

## Operational Feedback Loop

Choosing **Not an update** still suppresses that one event immediately. Broader behavior never changes from that click alone. The immutable feedback then enters this verified promotion workflow:

1. **Triaged** — submitting **Not an update** both hides that event and opens a triaged case. The submitter remains in the immutable report evidence, but is not mislabeled as the workflow owner; ownership stays with the functional **Policy review** queue until explicit assignment exists.
2. **Similar feedback clustered** — pending feedback is grouped by a normalized evidence-pattern signature, domain template, and reason. Exact per-occurrence evidence remains immutable, while the cluster shows its recurrence count and source count.
3. **Rule drafted** — an implemented deterministic candidate is selected from policy configuration, where it must remain inactive, persistent, alert-blocking, and available to Batch prompts after activation. Its behavior definition and executable matcher digest are sealed to one draft hash; the operator-written safety boundary is retained alongside it. The operator must also bind at least one exact, retained, known-real update ID that this rule must keep visible. Those IDs are normalized, ordered, unique, immutable, and cannot overlap the clustered false updates. A draft is not permission to suppress globally.
4. **Historical shadow test** — the exact sealed candidate is evaluated against complete retained history without changing any public state. The test includes the already-suppressed feedback events that revealed the pattern and cannot pass if the scan was capped or incomplete.
5. **Regression tests pass** — positive fixtures prove every clustered false update is caught. Negative fixtures load the exact known-real update IDs chosen independently by the operator; the proposed matcher is never allowed to select its own easy negative example. Missing, duplicate, no-longer-legitimate, or over-broad results fail closed and are named in the report.
6. **App and worker hashes match** — the app and worker attest the same concrete code revision plus the full monitoring, visual Batch, change-event suppression, and executable matcher-bundle hashes. The worker computes the matcher-bundle hash from the normalized app and worker suppression, alias-policy, source-quality, report-verification, and promotion-runner sources installed with it; an unavailable, stale, incomplete, or merely similar revision cannot pass.
7. **6 PM canary** — the first complete scheduled three-shard capture cohort after the hash attestation evaluates the still-inactive deterministic candidate against fresh evidence. Manual, catch-up, partial, earlier, mixed-date, capture-failed, or candidate-ledger-incomplete runs cannot satisfy this gate, and the workflow does not launch an extra paid API run.
8. **Retroactive sweep** — only after the canary passes is the candidate changed to active and deployed. The runner rechecks the immutable behavior and matcher hashes, requires a second exact app/worker revision and four-hash attestation for the activated policy, then applies the rule through a bounded, resumable per-cluster sweep whose state and request identity are unique to that accepted canary cycle. After the sweep completes, Resolve stays locked until the next normal feedback-promotion lane run records a successful, zero-API-charge durable attestation with the exact current app/worker revision plus full, Batch, suppression, and matcher hashes. This is an identity check, not another capture or a hidden next-day 6 PM requirement.
9. **Resolved** — the database revalidates that immutable post-sweep worker run and its exact hashes before the feedback cluster is linked to the verified active rule through append-only promotion records. The original feedback and every gate artifact remain immutable audit evidence.

The supported promotion path cannot advance while the candidate is active early, while a legitimate collision exists, or while any evidence gate is incomplete. The admin view shows every legitimate update the proposed rule would also suppress, and that count must be zero. Workflow transitions are sequential and audited; an operator cannot skip directly from a draft to resolved.

If another matching correction arrives before the canary, it joins the same open cluster, increments the evidence revision, and invalidates any draft or later verification artifacts. The visible workflow returns to **Similar feedback clustered**, retains the earlier artifacts as audit history, and requires a fresh draft and complete verification against the enlarged evidence set. A stale browser or worker request cannot advance the new revision.

If matching feedback arrives after the canary is accepted, the database does **not** silently clear the audit while a rule may be live. It preserves the proposed rule and every immutable artifact, marks activation `blocked_late_evidence`, stops the targeted sweep atomically, and raises a high-severity Action Inbox item. If the rule is live, the operator restores and deploys the exact inactive app/worker revision. The next no-charge feedback-promotion lane check verifies five matching identities and a later durable worker run, reverses every partial historical suppression attributable only to that candidate while preserving explicit feedback and other still-valid policy suppressions, and returns the enlarged cluster to **Similar feedback clustered** only after the rollback audit passes. The general policy sweep excludes every unresolved promotion rule, so it cannot bypass the bounded promotion sweep or its rollback provenance.

This gate keeps a one-off correction from becoming an accidental global rule while ensuring approved patterns are absorbed by the UI, 6 PM capture workers, queued Batch review, publication guard, and retroactive suppression sweep.

### Promotion Failure Responses

- **The shadow test catches legitimate updates:** keep the candidate inactive, add those exact event IDs to the known-real fixture set, narrow the configured candidate, and use **Revise the draft rule**. The restart preserves the rejected report and returns to the draft checkpoint.
- **Regression fixtures fail:** repair the matcher, prompt, or named immutable fixture and use **Revise the draft rule** when the draft itself must change. Ordinary unchanged evidence continues its bounded no-charge feedback-promotion lane retry.
- **App and worker hashes differ:** deploy the same reviewed revision to both surfaces, then record a new attestation. Never waive the mismatch.
- **The 6 PM canary fails or is incomplete:** keep global activation blocked, repair the reported shard or rule failure, and wait for a new scheduled cohort.
- **The rule is activated early:** return it to inactive candidate state, redeploy matching app and worker revisions, and rerun every invalidated pre-activation gate.
- **The retroactive sweep fails after activation:** stop further mutation and mark the activation `rollback_required`. Restore the exact inactive app/worker revision; the feedback-promotion lane then reverses or safely re-attributes every candidate-attributable suppression before returning the cluster to draft for full revalidation. The failed sweep cursor and audit stay retained, and the cluster cannot be resolved.
- **The rule becomes inactive after the sweep:** never offer or accept Resolve. The Action Inbox and promotion board show a high-severity blocked deactivation state while the normal zero-charge feedback-promotion lane records the inactive deployment, marks rollback, reverses candidate-attributable suppression, and returns the cluster to draft.
- **New evidence arrives after canary:** block activation and historical mutation immediately. Restore the exact inactive deployment if the rule is live; let the next feedback-promotion lane identity check and bounded suppression-reversal audit return the enlarged cluster to draft.

## Manual Quarantine Accounting

A drained automatic queue does not mean every problem is resolved. The
service-role-only `manual_quarantine_registry` stores durable operator cases,
and `manual_quarantine_registry_events` preserves every opening, evidence
revision, reopening, and status change. The registry uses these rules:

- The latest unresolved error/critical page audit and the latest failed
  reconciliation for one award share one public-page case. Both source records
  remain in its evidence and failure counts, so the UI neither hides the
  reconciliation nor presents one repair as two unrelated cases.
- Missing-response recovery stays automatic only because it reuses the existing
  Gemini Batch and creates no new charge. Every failure that would require a
  new paid new-page or changed-page submission becomes an operator case
  immediately. A site admin must inspect the exact failed candidate and record
  a one-use, version-bound approval; ambiguous provider creation is never
  eligible for a generic resubmission.
- Historical screenshot localization enters the registry only from a complete,
  timestamped, SHA-256-bound source-ID inventory. Until that inventory is
  imported, historical limitations are unknown rather than zero.
- A newer safe audit/reconciliation state or a visual candidate leaving its
  terminal failed state resolves the current case but does not erase its
  append-only registry history.

`manual_quarantine_registry_state` reports **Automated work clear**,
**Quarantined work remaining**, **Historical limitations**, and **Terminal
failures requiring action** independently. Quarantined work counts operator
cases; terminal failures count every linked terminal failure record. The
independent manual-quarantine lane refreshes database-backed cases without a
paid API request. Its lease, timeout, retry clock, and oldest-item target are
independent from every other lane.

The operator backlog reads those cases through a service-role-only exact-count
contract. The default repair group is the full tuple of normalized source
domain, evidence-failure code, policy identity and reason, and likely repair;
single-dimension domain, evidence, policy, and repair views are optional
rollups. Counts are computed before pagination and cross-checked against the
durable registry state, so a 25-row page or a capped legacy query is never
presented as the total. Every pagination link carries the registry sync
timestamp, the transactional operator-backlog revision, and the first page's
fixed age clock. It fails closed if registry membership, assignment, review
status, source/award display data, or the requested snapshot identity changes
mid-review, so offset pages cannot silently skip or duplicate work.

Individual operator assignment is stored separately from functional ownership
so a registry refresh cannot erase it. Saved filters, grouping, sort, and page
size are scoped to the authenticated admin. Bulk controls are deliberately
limited to evidence-bound assignment, clearing one's own assignment, and
starting review. They are transactional, idempotent, append-only audited, and
cannot retry, resolve, delete, or create an API charge.

## Admin Workflows

- **3. Action Inbox** is the single operator entry point. Each ordinary item shows severity and public impact, the failure reason, age, functional owner, what retries automatically, whether that retry creates an API charge, the recommended safe action, retained evidence, and the exact policy identity/version/hash. Manual Quarantine appears once here as an exact total plus grouped-backlog link instead of hundreds of flat duplicate cards. A post-sweep inactive rule is high severity and blocked, with feedback-promotion lane rollback/deactivation repair—not a protected or resolvable state.
- **4. Verified Promotions** is the plain-language nine-step promotion board. Each cluster appears once with recurrence, affected source count, evidence signature/domain template/reason, legitimate collisions, known-real fixtures, current activation state, gate reports, failure details, safe fixes, and only the operator controls legal at that state. At step 8, it explains that the next normal zero-charge feedback-promotion lane attestation unlocks Resolve; it never implies another 6 PM scan is needed.

- **5. Manual Quarantine** is the detailed operator backlog behind that single inbox entry. It keeps the four completion facts and historical limitations visible, then shows exact totals, paginated repair groups, paginated cases, age, functional and individual ownership, saved views, and only the no-charge bulk actions that are safe for the selected evidence revision. It labels award-homepage domain fallbacks honestly and never treats the length of a capped result page as the total.
- **6. Evidence Recovery** reports R2-to-local cache recovery. The worker may restore only the exact immutable generation whose source ID, capture time, kind, hashes, metadata, and required objects match the retained baseline. It stages and verifies the complete generation before an atomic pointer change. A mismatch is refused and the last-known-good baseline remains untouched. If authoritative R2 evidence exists but exact local recovery fails, one source-keyed, high-severity Manual Quarantine case is opened with protected public impact and no retry charge; the source moves to `review_later`. Generic registry refreshes cannot clear it. Broad scans keep excluding that source, while an explicit exact-source recovery invocation may retry the same immutable R2 generation without an API charge. A successful exact-generation rehydration resolves the R2 case. It clears the R2 source failure state and reopens the source only while the R2 workflow still owns the exact review status, owner, and note; if another workflow has taken ownership, that source state remains untouched and excluded as appropriate.
- **7. Lanes & Spending** shows each downstream lane separately: lease, timeout, oldest-item SLA, retry time, backlog, and last failure. It also shows the two account-wide paid budgets—**New page review** and **Changed page review**—with effective cap, reserved, spent, remaining, UTC reset time, and database policy source.

## Paid Review and Independent Lanes

Only two permanent workflows may create a Gemini charge:

1. **New page review** extracts information from newly added source pages.
2. **Changed page review** determines what actually changed on a previously monitored page.

Each lane has an immutable database-policy cap of **$5 per UTC day**. Before a
provider create request, the worker obtains an atomic account-wide reservation
in integer micro-dollars. A definite pre-create failure releases it. An
ambiguous create outcome remains reserved and is sent to operator recovery so
the worker cannot accidentally pay twice. Provider polling, applying a stored
result, promotion, suppression, reconciliation, deterministic page audit,
quarantine sync, and nightly reporting are all zero-charge work.

The old serial hourly pipeline is retired. New-page review, changed-page
review, feedback promotion, suppression, reconciliation, deterministic page
audit, manual quarantine, and nightly reporting each have an independent
database lease, Windows task, timeout, retry state, and oldest-item SLA. A slow
or failed visual review can no longer starve reconciliation or auditing.

## Worker State and Policy Changes

- A candidate rejected by the latest policy is written to `shared_award_visual_rejection_ledger`, keyed by source, evidence signature, and effective policy hash. The capture worker can absorb the same rejected comparison on a later run without replacing the public/local/R2 last-known-good baseline. Changed evidence or a changed effective policy receives a new review opportunity.
- When a submitted result returns under an older effective policy, the worker rebuilds its prompt, rekeys it to the current effective identity, clears the stale Batch state, and returns it to `pending`. Because polling precedes submission in each changed-page review lane run, the refreshed candidate can be submitted in the same run. Pending candidates are also persisted with the current signature and prompt before submission; a conflicting current-policy candidate supersedes the stale row.
- Batch submission claims record a unique `batch_display_name` (including a claim-token fragment) before the Gemini create request. A timeout, 5xx response, malformed successful response, or crash after that request is intentionally failed closed with `manual_recovery_required_possible_external_batch_created`; it is never auto-resubmitted because the first paid job may exist. Operators should locate the Gemini job by `batch_display_name`, then reconcile its name/result or explicitly clear the claim only after confirming no job was created.
- An approved candidate is not final `published` until its enclosing full capture is the current local baseline and, when enabled, the current R2 baseline. Expandable-section siblings use the full hashes in their shared `meta.json`, never the section hash. Transient promotion failures remain `succeeded` with the completed Batch response and are retried without another paid submission; rejected-only captures never advance the baseline.
- Every visual-review candidate observed by a scheduled shard is linked to that exact durable worker run through the append-only `shared_award_visual_review_candidate_run_observations` table. Reused candidate rows can therefore be proven against each canary shard without overwriting their earlier run history.
- Completed Batch results acquire an atomic per-candidate, database-unique per-source publication claim before rejection-ledger, baseline, change-event, or reconciliation side effects. Concurrent pollers lose the compare-and-set and do no publication work; an abandoned claim becomes recoverable after the configured stale interval. Windows workers also hold an OS-owned per-source mutex across local/R2 side effects, which the operating system releases after a crash. R2 promotion uploads to deterministic immutable capture keys and advances its pointer with an `updated_at` compare-and-set only after every object is durable; a losing writer removes only uploads that the winning pointer does not reference. Partial uploads and failed pointer writes therefore remain safe to retry.
- `cleanup-change-event-noise.mjs` runs in its own no-charge suppression lane and scans unsuppressed history in ascending `(detected_at, id)` order. Its service-role-only `monitoring_policy_sweep_state` cursor makes bounded runs continue where the prior run stopped, so old rows cannot be starved by newer events. A changed effective policy hash or deterministic matcher version resets the cursor and intentionally rechecks the full history. The retro sweep evaluates immutable event evidence and current global policy, but does not permanently suppress a historical event merely because its source is now missing, `review_later`, or differently classified; those mutable lifecycle gates remain part of live publication/rendering instead.
- `sync-manual-quarantine-registry.mjs` runs in its own no-charge lane. Its lane-level result is reported independently, so a stale quarantine sync cannot make reconciliation, auditing, or paid review appear unhealthy.
- Worker state, rejection-ledger, and manual-quarantine tables are service-role-only. The rejection ledger is comparison memory, not a public baseline or an approval record.

## Adding A Stipulation

1. Add a named entry to `policy_flags` or `source_quality_stipulations`. A rule entering verified promotion starts with `active: false` and `promotion_test_mode: "deterministic"`.
2. Give update filters a stable `id`, for example `relative_age_timestamp_churn`.
3. Set `alert_blocking: true` when the flag should prevent public updates.
4. Set `persistent: true` for a promotable rule; the verified workflow rejects candidates that cannot keep filtering stored change details.
5. Every active `alert_blocking` flag must have a `prompt` and include `visual_review_batch` in `prompt_scopes`. Add any other prompt scopes that need the same rule.
6. Add every established legacy/model spelling to `aliases`; do not create two canonical rules for the same behavior.
7. Wire the deterministic matcher before drafting the candidate. AI-only or free-form rule IDs cannot enter this workflow because their behavior cannot be replayed safely in shadow and canary stages. Recompute `promotion_matcher.hash` with `scripts/lib/monitoring-promotion-matcher-bundle.mjs`. The canonical bundle covers both app and worker implementations of the suppression matcher, promotion sweep/cursor semantics, policy-alias resolver, source-quality resolver and its baseline/URL-policy dependencies, plus the report verifier, promotion runner, and shared scheduled-nightly eligibility contract. A change to any one of those sources changes the digest, so old shadow/regression artifacts cannot be reused. Parity tests fail when the installed executable bundle and sealed policy digest differ.
8. Increment the policy version so new scan and candidate metadata identifies the changed bundle.
9. Add or update tests in `src/lib/award-monitoring-policy.test.ts`, `scripts/lib/award-monitoring-policy.test.mjs`, and the relevant classifier test.
10. In **4. Verified Promotions**, bind at least one retained operator-confirmed real update ID near the candidate boundary before saving the immutable draft.
11. After the verified 6 PM canary passes, change only `active` to `true`, deploy the same commit to the app and worker, and let the activated hash check plus bounded retroactive sweep finish. Wait for the next normal zero-charge feedback-promotion lane identity attestation before resolving the cluster; no extra 6 PM scan is required. The general sweep will exclude this unresolved rule until resolution.

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
