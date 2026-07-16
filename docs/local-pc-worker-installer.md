# AwardPing Local PC Worker

## What It Does

- Installs the AwardPing worker under `%LOCALAPPDATA%\AwardPingWorker`.
- Installs Node.js LTS with `winget` if Node is missing.
- Prompts for the Supabase `service_role` key, Gemini API key, and the complete
  Cloudflare R2 bucket/account/access-key configuration used to retain immutable
  published evidence.
- Writes those values to `.env.worker.local` on the PC.
- Seals the exact source git commit as `AWARDPING_WORKER_REVISION` and keeps the
  live HTTPS app URL as `NEXT_PUBLIC_APP_URL`, so app/worker promotion checks
  cannot pass with an unknown or stale deployment.
- Installs npm dependencies.
- Runs a one-page visual snapshot test.
- Creates Windows Scheduled Tasks named `AwardPing Visual Snapshot Worker Shard 1-3`
  that run the screenshot/PDF checker daily.
- Creates `AwardPing Downstream Queue Pipeline` for hourly report finalization,
  source intake, review, verified feedback promotion, immutable event-evidence
  publication, suppression, reconciliation, and page audits.

## Windows Install

Run the installer directly from this repo on the crawler PC:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\installer\windows\Install-AwardPingWorker.ps1"
```

Then:

1. Paste the Supabase legacy JWT `service_role` key or the newer `sb_secret_...`
   key when prompted.
2. Paste the Gemini API key when prompted.
3. Enter the Cloudflare R2 bucket and paste the Cloudflare R2 account ID, access
   key ID, and secret access key. The installer keeps the four permanent tasks
   disabled unless the configuration is complete and resolves to an HTTPS R2
   endpoint.
4. Accept the four permanent Scheduled Tasks when prompted.

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
3. Deploy the same commit to Vercel and verify the live identity endpoint before
   changing the worker:

   ```powershell
   $ReleaseSha = (git rev-parse HEAD).Trim()
   $ProductionAppUrl = "https://awardping.vercel.app"
   npx --yes vercel@56.2.1 --prod --yes
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
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\installer\windows\Install-AwardPingWorker.ps1" -UpdateOnly -AppUrl "https://awardping.vercel.app"
   ```

   Update mode builds and validates a complete staged app and npm dependency
   tree before it pauses anything. It preserves the existing R2 credentials
   with the rest of `.env.worker.local`, validates that the retained R2
   configuration is still complete, and never prompts for or replaces those
   secrets. It then pauses only AwardPing tasks and
   worker processes whose command lines target this exact install root, copies
   local environment/report state, and switches complete app directories. A
   workspace catch-up running from this repository is outside that process
   scope and is not stopped. If staging fails, the installed app is untouched;
   a completed switch keeps the prior complete app temporarily as a rollback.

   Updated and newly created tasks are registered disabled until every wrapper,
   action target, runtime script, dependency, and task definition validates.
   On success, current task actions and settings are installed while each
   existing task keeps its prior schedule, principal, enabled state, and
   running state. Legacy tasks are retired only after that task-set commit. On
   failure, newly created tasks are removed and the complete original task XML
   set is restored exactly. Tasks remain disabled if neither the old nor new
   app is complete enough to run. The installer also refuses to overwrite a
   fixed AwardPing task owned by another install root or a custom Task Scheduler
   path, and leaves unrelated Startup-folder launchers untouched.
5. Compare repository and installed hashes for both policy JSON files and the
   policy, suppression, visual-review, capture, immutable-evidence,
   evidence-coverage/backfill, and baseline worker scripts. Confirm the staged
   dependency validation includes the native `sharp` crop package.
   Confirm the three visual shard tasks still run daily at 6 PM and the
   downstream task runs hourly with `SuppressionSweepLimit` in its action.
6. Inspect the first downstream log after deployment. It must show the
   independent `visual-nightly-report` finalizer first, followed by bounded
   `source-intake`, `visual-review-batch`, `verified-feedback-promotions`,
   `change-event-suppression-sweep`,
   `award-reconciliation`, and `page-audit-batch`, with a zero final exit code.
   The final line includes `promotion_exit`, so a failed verification cannot be
   hidden by later successful queue work.

## Permanent and Catch-up Work

The permanent worker schedule contains only the three 6 PM capture shards and
the hourly downstream pipeline. The hourly pipeline first finalizes the due
capture report, processes up to 25 queued source-intake requests, and polls
at most five existing AI batches within a ten-minute budget before review,
verified feedback promotion, suppression, reconciliation, and page-audit work.
Promotion runs after visual review so the exact 6 PM candidates are terminal
before their canary is judged. Failed intake requests wait
for an operator-selected retry instead of cycling forever. This keeps new award
and source submissions moving continuously without turning one-time build work
into another permanent watchdog.

Each web capture expands eligible sections, scrolls and suppresses known noise,
waits for the final page state, and then records visible text-node rectangles
immediately before the screenshot. Both the screenshot and the structured
geometry include matching hashes and actual pixel dimensions. Opened accordion
states are captured separately when needed. An expansion-state geometry failure
does not discard an otherwise valid page capture, but it does degrade the 6 PM
report with the affected source and a bounded repair recommendation.

An accepted review is not public until the hourly worker has copied every
candidate-referenced artifact to permanent, content-addressed storage, created
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
standalone source-intake or localization watchdog. Baseline, source quality,
and localization repair scripts remain targeted catch-up tools only;
run them deliberately for a bounded repair rather than reinstalling a recurring
task.

## Verified Feedback Promotions

The hourly worker makes the broader feedback workflow automatic after an
operator clusters feedback and drafts an inactive rule:

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
6. On the next normal hourly downstream run after a completed sweep, append a
   successful zero-API-charge `local_worker_runs` identity attestation bound to
   that cluster revision. The admin route deterministically selects the earliest
   exact matching run after the sweep and the database revalidates it before
   Resolve can succeed. This does not start a visual capture, wait for the next
   day, or add another 6 PM canary.
7. If activated identity verification or the sweep fails, or the rule is
   disabled after a partial pass, mark the cluster `rollback_required`. The
   hourly worker waits for the exact inactive app/worker identity, re-evaluates
   every attributable event with the candidate excluded, preserves any other
   valid production suppression, and reverses the rest in bounded audited
   batches. Each activation cycle has separate cursor and request identities.
   Only a zero-attributable count permits the cluster to return to draft.
   The same rollback path applies when an operator disables the rule after the
   sweep: Admin hides Resolve and both workflow views show high-severity hourly
   rollback/deactivation repair.

The ordinary downstream suppression sweep loads every unresolved proposed rule
ID and excludes all of them fail-closed. It therefore cannot activate a draft,
bypass the canary, or obscure which suppressions must be reversed.

Unchanged failed evidence uses a deterministic transition request ID, so an
hourly retry returns the existing audit result instead of creating duplicate
failure rows. Normal waits—such as waiting for the next 6 PM cohort or resuming
an incomplete bounded cursor—do not create failed transitions.

The Supabase key must be an elevated AwardPing project key from Supabase Project
Settings -> API. Use either the legacy JWT `service_role` key or a newer
`sb_secret_...` secret key. It is not the Gemini API key, Vercel key,
anon/publishable key, or Cloudflare token. The installer checks this key before
installing dependencies.

The installer hides pasted keys while you type. They are still stored in the PC's
local `.env.worker.local` file because the worker needs them to run.

## Manual Run

To run the visual screenshot/PDF checker immediately, double-click:

```text
3-RUN-VISUAL-SNAPSHOT-CHECK-NOW.bat
```

Or run this in PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AwardPingWorker\Run-AwardPingVisualSnapshots.ps1" -All -Limit 50000
```

Logs are written to:

```text
%LOCALAPPDATA%\AwardPingWorker\logs
```

## 6 PM Capture Reports

The three scheduled visual shards share one Chicago monitoring date and report
independently. A process can exit successfully while individual pages fail, so
the report keeps execution status separate from operational health:

- `healthy`: all three shards reported and no failure was recorded.
- `degraded`: all three shards reported, but one or more source or downstream
  failures need attention.
- `failed`: a shard stopped or was blocked.
- `incomplete`: the scan window ended without all three shard reports.

Each shard writes an atomic start record, refreshes its heartbeat while it is
active, and finishes with `run_health`, grouped failures, and a `repair_plan`.
A stale heartbeat is reported separately from a shard that never launched.
After every scheduled shard finishes, the worker atomically rebuilds:

```text
%LOCALAPPDATA%\AwardPingWorker\app\reports\visual-nightly-report-YYYY-MM-DD.json
%LOCALAPPDATA%\AwardPingWorker\app\reports\visual-nightly-report-latest.json
```

The final report keeps only the newest attempt for each shard, so a retry does
not double-count the scan. It lists a safe recovery for every failure class and
never recommends changing a baseline simply to make an error disappear.
The hourly downstream task runs the same locked finalizer before its queue work,
so a common-cause launch failure still produces a three-shards-missing report
after the 6 PM launch grace period. Rebuilds read only the due monitoring window,
not the full report history.

To read the latest local report and the three Scheduled Task results, run
`6-SHOW-VISUAL-SNAPSHOT-STATUS.bat`. To rebuild or print a report directly from
the installed app:

```powershell
Push-Location "$env:LOCALAPPDATA\AwardPingWorker\app"
npm run source:visual-nightly-report
Pop-Location
```

The Admin dashboard shows the same operational view from
`local_worker_runs.metadata`: three shard rows, captured-page and failure
totals, failure groups, and the corresponding guarded repair instructions.

To audit published evidence itself rather than source-pointer layout metadata:

```powershell
Push-Location "$env:LOCALAPPDATA\AwardPingWorker\app"
npm run source:visual-evidence-coverage -- --env .env.worker.local
Pop-Location
```

Historical evidence recovery is an operator-only, dry-run-by-default command;
it is not another scheduled worker:

```powershell
npm run source:backfill-visual-event-evidence -- --env .env.worker.local
npm run source:backfill-visual-event-evidence -- --env .env.worker.local --apply=true
```

Repairable linkage or archive gaps never become immutable “unrecoverable” rows
automatically. Apply mode reports all pending event IDs, continues recovering
independent later events, and leaves its contiguous checkpoint before the first
gap. Recording terminal loss requires an event-specific reviewed JSON file with
the current reason code, reason, actor, and confirmation timestamp, passed with
`--terminal-loss-confirmations <path>`.

## Uninstall Scheduled Task

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AwardPingWorker\Uninstall-AwardPingWorker.ps1"
```

That removes the AwardPing Scheduled Tasks. Delete `%LOCALAPPDATA%\AwardPingWorker` if you also
want to remove logs and local env files.
