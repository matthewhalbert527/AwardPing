# AwardPing Local PC Worker

## What It Does

- Installs the AwardPing worker under `%LOCALAPPDATA%\AwardPingWorker`.
- Installs Node.js LTS with `winget` if Node is missing.
- Prompts for a dedicated Supabase `sb_secret_...` key, Gemini API key, and the complete
  Cloudflare R2 bucket/account/access-key configuration used to retain immutable
  published evidence.
- Writes those values to `.env.worker.local` on the PC.
- Seals the exact source git commit as `AWARDPING_WORKER_REVISION` and keeps the
  live HTTPS app URL as `NEXT_PUBLIC_APP_URL`, so app/worker promotion checks
  cannot pass with an unknown or stale deployment.
- Installs npm dependencies.
- Runs the optional one-page program-text collection check while all recurring tasks
  are still disabled. A failed smoke test leaves them disabled.
- Creates Windows Scheduled Tasks named `AwardPing Visual Snapshot Worker Shard 1-3`
  that collect the approved required HTML/PDF sources daily as private originals
  and extracted text. Existing task names remain for compatibility; no screenshot,
  crop, image-AI or discovery flags are sent to the new collector.
- Creates eight independent, staggered downstream tasks for new-page review,
  changed-page review, feedback promotion, suppression, reconciliation,
  deterministic page audit, manual quarantine, and nightly reporting. A slow or
  failed lane cannot block the other seven.
- Only **Changed Page Review** can incur an AI charge, under the existing
  **$5/day** lane limit. New Page Review reports deferred discovery; feedback,
  suppression, reconciliation and quarantine report a read-only legacy hold.
  Page audit remains deterministic, and nightly reporting reads text coverage.
- Creates `runtime/program-text-archive` with protected, inheritable private
  permissions for the operator, system/administrators and existing worker task
  principals. It validates the directory before setting
  `AWARDPING_PROGRAM_TEXT_ARCHIVE`; historical snapshot folders stay untouched.
- Keeps the text configuration disabled until the exact app, database and worker
  release is staged and verified. An initial baseline is collection coverage,
  not a program update. Collection failure exits once; wrappers do not retry it.

## Windows Install

Run the installer directly from this repo on the crawler PC:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\installer\windows\Install-AwardPingWorker.ps1" -AcceptInteractiveTaskLogon
```

The installer registers new tasks with the current Windows user's interactive
token. That mode cannot run after the operator signs out. A fresh install must
therefore use `-AcceptInteractiveTaskLogon` only after the operator explicitly
accepts responsibility for keeping that Windows account logged in across the 6
PM scan and downstream windows.

The acceptance is recorded without credentials in
`worker-operational-mode.json`. It is an honest operational limitation, not a
claim of logged-off unattended service. An existing installation whose eleven
tasks all use an approved least-privilege logged-off principal does not require
this acceptance. The installer preserves those existing principals during an
update.

Then:

1. Paste the worker's dedicated Supabase `sb_secret_...` key when prompted.
   Legacy JWT, anon, and publishable keys are rejected.
2. Paste the Gemini API key when prompted.
3. Enter the Cloudflare R2 bucket and paste the Cloudflare R2 account ID, access
   key ID, and secret access key. The installer keeps all eleven permanent tasks
   disabled unless the configuration is complete and resolves to an HTTPS R2
   endpoint.
4. Confirm the installer summary lists eleven permanent Scheduled Tasks: three
   6 PM shards and eight downstream lanes.

The old hosted `awardping-worker-windows.zip` updater has been retired. Do not
copy individual files into the installed `app` folder. That misses root runner
scripts, dependency changes, and Scheduled Task updates.

## Safe Worker Update

Deploy a reviewed revision in this order:

1. Run the repository tests, commit the exact revision being deployed, and push
   that commit to the release branch.
   The installer refuses a dirty git worktree so copied code cannot be labeled
   as an older commit. A distribution without `.git` must carry a packaged
   `.awardping-worker-revision` manifest created from that committed revision.
2. From that clean commit, apply and verify its Supabase migrations.
3. Stage the exact reviewed commit on Vercel, verify its text-only UI and identity,
   and only then promote that same deployment. Follow the current release
   coordination record; do not deploy directly from a dirty development tree.
   Verify the promoted identity endpoint before changing the worker:

   ```powershell
   $ReleaseSha = (git rev-parse HEAD).Trim()
   $ProductionAppUrl = "https://awardping.vercel.app"
   $Identity = Invoke-RestMethod "$ProductionAppUrl/api/monitoring-policy-identity"
   if ($Identity.revision -ne $ReleaseSha) {
     throw "Production does not match the reviewed release commit."
   }
   ```

   Keep the identity response with the release evidence. It names the exact
   full, Batch, suppression, and executable matcher-bundle policy hashes that the
   installed worker must match.
4. From that same still-clean revision, run:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\installer\windows\Install-AwardPingWorker.ps1" -UpdateOnly -AppUrl "https://awardping.vercel.app" -AcceptInteractiveTaskLogon
   ```

   Update mode builds and validates a complete staged app and npm dependency
   tree before it pauses anything. It preserves the existing R2 credentials
   with the rest of `.env.worker.local`, validates that the retained R2
   configuration is still complete, and never prompts for or replaces those
   secrets. It removes obsolete persistent discovery/onboarding, visual-review,
   localization-repair, snapshot-reset, and forced-R2-refresh mode keys without
   printing their former values. Those historical modes are not part of text-only collection. It then pauses only AwardPing tasks and
   worker processes whose command lines target this exact install root, copies
   local environment/report state, and switches complete app directories. A
   workspace catch-up running from this repository is outside that process
   scope and is not stopped. If staging fails, the installed app is untouched;
   a completed switch keeps the prior complete app temporarily as a rollback.

   Updated and newly created tasks are registered disabled until every wrapper,
   action target, runtime script, dependency, and task definition validates.
   Validation rejects missing or extra triggers, a visual shard that is not
   daily at exactly 6 PM, and any lane that is not on its required 15-minute
   cadence and stagger offset. It also rejects a task action with the wrong
   wrapper, shard/lane key, or timeout.
   On success, the installer enforces the canonical triggers (three daily 6 PM
   shards and eight staggered 15-minute lanes) and installs current actions and
   settings while each existing task keeps its principal, enabled state, and
   running state. Legacy tasks are retired only after that task-set commit. On
   failure, newly created tasks are removed and the complete original task XML
   set is restored exactly. Tasks remain disabled if neither the old nor new
   app is complete enough to run. The installer also refuses to overwrite a
   fixed AwardPing task owned by another install root or a custom Task Scheduler
   path, and leaves unrelated Startup-folder launchers untouched.

   The acceptance flag is required only when the installed task set still uses
   interactive logon and no valid operational-mode acceptance has already been
   recorded. It does not change task principals or make them capable of running
   while logged off.
5. Compare repository and installed hashes for the monitoring policies, lane
   wrapper/runner, text configuration and the complete program-text capture,
   storage, OCR, review, monitor, repository, provider and CLI modules. The
   installer requires matching bytes and all dependencies, including `pdf-parse`
   and `cheerio`. The pinned Scrapling Python runtime is retained; the old
   selector manifest does not admit or exclude awards in the new text roster.
   Confirm the same three shard tasks run daily at 6 PM and all eight downstream
   lane tasks retain their 15-minute cadence, offsets, lane keys, locks and timeouts.
6. Inspect the first log for each lane after deployment. Each log must name only
   its own lane and finish with a zero exit code. A failure in one log must not
   prevent the other task logs from advancing. Confirm `AwardPing Page Audit
   Lane` runs the deterministic public-page evaluator and does not submit a
   Gemini request.

The installer protects `.env.worker.local` from inherited ACL entries and
allows access only to the installing operator, `SYSTEM`, local Administrators,
and the exact principals retained by AwardPing's scheduled tasks. Runtime
validation fails closed if an unrelated group or orphaned SID can read or modify
the worker credentials.

## Permanent Worker Work

The permanent worker schedule contains the three 6 PM capture shards and these
eight downstream tasks. There is no monolithic downstream pipeline.

Every 6 PM shard calls `scripts/program-text-worker.mjs --mode=collect --apply=true`
with only environment, limit, domain delay, shard and run-trigger arguments.
The approved required-source roster comes from the reviewed 25-award manifest,
not an old selector. No screenshot, image review, crop or discovery is requested.
A collection failure exits once and does not restart automatically.

| Windows task | Text-only behavior | Direct AI/API cost |
| --- | --- | --- |
| `AwardPing New Page Review Lane` | Reports deferred discovery; preserves the old intake queue. | **$0** |
| `AwardPing Changed Page Review Lane` | Reviews saved program-text comparisons; never auto-retries failed paid reviews. | Existing **$5/day** maximum. |
| `AwardPing Feedback Promotion Lane` | Reports a read-only legacy hold. | **$0** |
| `AwardPing Suppression Lane` | Reports a read-only legacy hold. | **$0** |
| `AwardPing Reconciliation Lane` | Reports a read-only legacy hold. | **$0** |
| `AwardPing Page Audit Lane` | Runs deterministic public-page checks; never submits to Gemini. | **$0** |
| `AwardPing Manual Quarantine Lane` | Reports a read-only legacy hold. | **$0** |
| `AwardPing Nightly Report Lane` | Reports required-source text coverage. | **$0** |

Each lane retains its stagger, Windows execution timeout, local lock and database
lease. A slow or failed lane does not block the other seven. First collection
creates a private baseline only. Public updates require a later complete capture,
an actual approved program-detail change and validated exact text provenance.

Lane logs are retained only under the installed worker's `logs` directory.
Per-run logs expire after 14 days and are also capped at the newest 2,000 files;
orphaned stdout/stderr temporary logs expire after 24 hours and are capped at
64 files. Each per-lane summary rotates at 5 MiB and keeps one previous copy.

Each web capture expands eligible sections, scrolls and suppresses known noise,
waits for the final page state, and then records visible text-node rectangles
immediately before the screenshot. Both the screenshot and the structured
geometry include matching hashes and actual pixel dimensions. Opened accordion
states are captured separately when needed. An expansion-state geometry failure
does not discard an otherwise valid page capture, but it does degrade the 6 PM
report with the affected source and a bounded repair recommendation.

An accepted review is not public until the changed-page review lane has copied
every candidate-referenced artifact to permanent, content-addressed storage, created
real previous/current crops for exact localized wording, and atomically bound
the immutable evidence to the change event. If exact localization fails, the
event keeps its own full screenshot and an honest unavailable status. The
worker report distinguishes verified crop sides, full-image fallbacks, and
evidence upload/publication failures and includes a safe solution for each
failure.

Each intake run writes eligible, loaded, attempted, completed, and deferred
counts for polling, capture, submission, and reconciliation. Terminal request
failures remain stopped until an operator chooses a safe retry. If Gemini Batch
creation cannot be confirmed, the request is failed closed for manual review;
generic Retry and Rerun AI actions stay blocked so the external job cannot be
submitted twice. The Admin Source Intake card shows per-stage progress, claim
conflicts, stale/manual recovery counts, the latest blocker, and the
operator-review queue.

The updater retires `AwardPing Baseline Completion Watchdog`, `AwardPing
Baseline Facts Watchdog`, `AwardPing Overnight Source Quality Pass`, and the
`AwardPing Startup Supervisor` task/Startup-folder launcher, plus any old
standalone source-intake or localization watchdog. It also unregisters the
retired `AwardPing Downstream Queue Pipeline` and removes its wrapper and lock
only after all eight replacement lane tasks validate. The installer also removes
the former baseline-completion, baseline-refresh, source-quality, and standalone
localization-repair launchers. Recovery now runs through immutable R2 evidence,
the normal capture path, quarantine, and the independent downstream lanes.
The corresponding source-tree PowerShell entrypoints fail closed, and the local
command center no longer offers the retired `daily`, `catchup`, `baseline`, or
`cleanup` bundles. Manual source discovery remains available as a bounded,
baseline-only onboarding action; it does not launch those retired workflows.

## Historical Manual Quarantine Registry (held)

This section describes preserved pre-text records only. The current scheduled
quarantine lane does not mutate them. Do not run the old sync/recovery commands
as part of text-only monitoring.

Manual quarantine is durable database state, not a count copied from one
catch-up report. The registry groups a latest critical page audit with its
latest failed reconciliation as one public-page repair case while preserving
both evidence records. Each terminal visual-review candidate remains its own
case. Historical screenshot-localization limitations are imported from the
complete source-ID inventory and remain separate from work that an operator
can repair.

Catch-up and Admin report these four facts independently:

- **Automated work clear**: whether every safe automatic queue is drained.
- **Quarantined work remaining**: unresolved operator cases, counted once per
  case.
- **Historical limitations**: retained screenshots that truthfully cannot gain
  exact historical geometry. This stays unknown until a complete inventory is
  imported; a missing report is never displayed as zero.
- **Terminal failures requiring action**: linked terminal failure records,
  including failed reconciliation and exhausted Batch attempts.

The `AwardPing Manual Quarantine Lane` refreshes database-backed cases with:

```powershell
npm run source:sync-manual-quarantine -- --env .env.worker.local
```

Import historical localization only from the complete retained-snapshot audit:

```powershell
npm run source:sync-manual-quarantine -- --env .env.worker.local --historical-report reports/snapshot-localization-coverage-latest.json
```

The import verifies that the report count exactly matches its unique source
IDs, hashes the report, and fails closed if any source cannot be bound to its
retained previous object keys and hashes. Actions remain in **3. Action
Inbox** as one exact grouped-backlog entry; **5. Manual Quarantine** is the
detailed, paginated repair view. Its totals come from the full registry before
pagination, its default clusters bind domain + evidence failure + policy reason
+ likely repair, and its assignment/start-review controls cannot retry or spend.

## Historical Feedback Promotions (held)

These previous visual-review and promotion procedures are retained as private
operational reference, not current run instructions. Current feedback/suppression/
reconciliation lanes make no legacy-queue mutations.

The `AwardPing Feedback Promotion Lane` makes the broader feedback workflow
automatic after an operator clusters feedback and drafts an inactive rule:

1. Scan the complete paginated change-event history, including events already
   hidden by immediate feedback suppression. A configured safety cap fails the
   shadow report instead of pretending the partial scan was complete.
2. Run every clustered event as a positive regression fixture and every
   operator-confirmed legitimate update ID sealed into the immutable draft as
   a negative fixture. The worker exact-loads only those bound IDs; it never
   chooses a convenient negative by first asking the candidate matcher what it
   already preserves. A missing, duplicate, overlapping, or no-longer-retained
   negative fails closed.
3. Compare the live app with the installed worker using the exact git revision,
   full policy hash, Batch policy hash, suppression policy hash, and normalized
   executable matcher digest. At least one retained worker run must prove the
   same identity.
4. Wait for a later regular 6 PM cohort with exactly three scheduled shards.
   The worker never launches another capture or paid API request for this gate.
   It waits until every exact-run visual-review candidate is published or
   rejected and fails on any candidate failure. A `superseded` candidate
   remains nonterminal for promotion even when its replacement is known; the
   workflow waits for a later clean 6 PM cohort instead of rewriting its raw
   database status. Every shard must also report zero capture failures and zero
   candidate/run observation-ledger failures. Canary events count only when
   their candidate is immutably bound to one of those exact three worker-run
   IDs through the append-only
   `shared_award_visual_review_candidate_run_observations` ledger. This also
   records a duplicate candidate seen in a later run without overwriting its
   original metadata. The three runs' retained observation total must equal
   the ledger bindings; a published candidate without its event binding cannot
   pass as an empty, clean canary.
5. After the behavior-identical rule is globally activated, verify the live
   app and worker again. Then resume a bounded per-cluster retroactive sweep
   from a canary-cycle-specific `monitoring_policy_sweep_state` checkpoint. It
   changes an event only when the candidate matcher and active production
   suppression decision agree, and it advances only after reaching the true
   end of history with zero errors.
6. On the next feedback-promotion lane run after a completed sweep, append a
   successful zero-API-charge `local_worker_runs` identity attestation bound to
   that cluster revision. The admin route deterministically selects the earliest
   exact matching run after the sweep and the database revalidates it before
   Resolve can succeed. This does not start a visual capture, wait for the next
   day, or add another 6 PM canary.
7. If activated identity verification or the sweep fails, or the rule is
   disabled after a partial pass, mark the cluster `rollback_required`. The
   promotion lane waits for the exact inactive app/worker identity, re-evaluates
   every attributable event with the candidate excluded, preserves any other
   valid production suppression, and reverses the rest in bounded audited
   batches. Each activation cycle has separate cursor and request identities.
   Only a zero-attributable count permits the cluster to return to draft.
   The same rollback path applies when an operator disables the rule after the
   sweep: Admin hides Resolve and both workflow views show high-severity
   rollback/deactivation repair.

The ordinary downstream suppression sweep loads every unresolved proposed rule
ID and excludes all of them fail-closed. It therefore cannot activate a draft,
bypass the canary, or obscure which suppressions must be reversed.

Unchanged failed evidence uses a deterministic transition request ID, so a
later lane retry returns the existing audit result instead of creating duplicate
failure rows. Normal waits—such as waiting for the next 6 PM cohort or resuming
an incomplete bounded cursor—do not create failed transitions.

The Supabase key must be a dedicated `sb_secret_...` key from the AwardPing
project's API Keys settings. It is not a legacy JWT `service_role` key, Gemini
API key, Vercel key, anon/publishable key, or Cloudflare token. The installer
checks it against the AwardPing tables using the `apikey` header only; it never
sends an `sb_secret_...` value as bearer authorization.

The installer hides pasted keys while you type. They are still stored in the PC's
local `.env.worker.local` file under the compatibility variable name
`SUPABASE_SERVICE_ROLE_KEY` because the worker needs them to run. Update-only
retains a current `sb_secret_...`; if it finds a legacy JWT or missing key, it
keeps the scheduled tasks stopped and requests a validated replacement in the
staged environment before switching versions.

## Manual Text Collection and Coverage

Only after the reviewed text configuration and matching release have been
explicitly enabled, the compatibility launcher collects required pages:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AwardPingWorker\Run-AwardPingVisualSnapshots.ps1" -All -Limit 50000
```

The old filename is not a visual-capture instruction. It invokes the new
program-text collector, does not call an AI provider, and does not publish a
baseline as a change. Logs remain under
`%LOCALAPPDATA%\AwardPingWorker\logs`.

To read required-source coverage without collection, AI requests or publication:

```powershell
Push-Location "$env:LOCALAPPDATA\AwardPingWorker\app"
node scripts/program-text-worker.mjs --mode=report --env=.env.worker.local
Pop-Location
```

The compatibility `6-SHOW-VISUAL-SNAPSHOT-STATUS.bat` shows this same text
coverage report, the latest collection log and scheduled task results. Complete
coverage counts complete reviewed source sets, not awards with only one page.
An unavailable PDF/OCR extraction or unresolved source remains a gap; it is not
hidden by a successful process exit. Historical screenshots, visual queues and
their evidence are preserved privately and are not rendered by the website or
retrieved by the retired visual API routes.

## Uninstall Scheduled Task

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AwardPingWorker\Uninstall-AwardPingWorker.ps1"
```

That removes the AwardPing Scheduled Tasks. Delete `%LOCALAPPDATA%\AwardPingWorker` if you also
want to remove logs and local env files.
