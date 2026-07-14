# AwardPing Local PC Worker

## What It Does

- Installs the AwardPing worker under `%LOCALAPPDATA%\AwardPingWorker`.
- Installs Node.js LTS with `winget` if Node is missing.
- Prompts for the Supabase `service_role` key and Gemini API key.
- Writes those values to `.env.worker.local` on the PC.
- Installs npm dependencies.
- Runs a one-page visual snapshot test.
- Creates Windows Scheduled Tasks named `AwardPing Visual Snapshot Worker Shard 1-3`
  that run the screenshot/PDF checker daily.

## Windows Install

Run the installer directly from this repo on the crawler PC:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\installer\windows\Install-AwardPingWorker.ps1"
```

Then:

1. Paste the Supabase legacy JWT `service_role` key or the newer `sb_secret_...`
   key when prompted.
2. Paste the Gemini API key when prompted.
3. Accept the Scheduled Task when prompted.

The old hosted `awardping-worker-windows.zip` updater has been retired. Do not
copy individual files into the installed `app` folder. That misses root runner
scripts, dependency changes, and Scheduled Task updates.

## Safe Worker Update

Deploy a reviewed revision in this order:

1. Apply and verify its Supabase migrations.
2. Run the repository tests and commit the exact revision being deployed.
3. From that revision, run:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\installer\windows\Install-AwardPingWorker.ps1" -UpdateOnly
   ```

   Update mode builds and validates a complete staged app and npm dependency
   tree before it pauses anything. It then pauses only AwardPing tasks and
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
   fixed AwardPing task or Startup-folder launcher owned by another install
   root or a custom Task Scheduler path.
4. Compare repository and installed hashes for both policy JSON files and the
   policy, suppression, visual-review, capture, and baseline worker scripts.
   Confirm the three visual shard tasks still run daily at 6 PM and the
   downstream task runs hourly with `SuppressionSweepLimit` in its action.
5. Inspect the first downstream log after deployment. It must show, in order,
   `visual-review-batch`, `change-event-suppression-sweep`,
   `award-reconciliation`, and `page-audit-batch`, with a zero final exit code.

## Baseline Completion Watchdog

While backfilling missing visual baselines, install the watchdog from this repo:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\installer\windows\Watch-AwardPingBaselineCompletion.ps1" -InstallRoot "$env:LOCALAPPDATA\AwardPingWorker" -Install
```

That creates a Windows Scheduled Task named
`AwardPing Baseline Completion Watchdog`. It checks every five minutes and
restarts `Run-AwardPingVisualSnapshots.ps1 -CompleteMissingBaselines` if the
baseline-completion worker stopped before actionable missing baselines reached
zero.

## Baseline Page-Info Watchdog

While backfilling Gemini page information from saved screenshots/PDFs, install
the page-info watchdog from this repo:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\installer\windows\Watch-AwardPingBaselineFacts.ps1" -InstallRoot "$env:LOCALAPPDATA\AwardPingWorker" -Install
```

That creates a Windows Scheduled Task named
`AwardPing Baseline Facts Watchdog`. It checks every five minutes and restarts
`Run-AwardPingBaselineFacts.ps1` if the Gemini page-info extraction stopped
before all local baselines have facts. It skips pages already extracted. If the
daily Gemini API cost cap is reached, it pauses for the rest of the day instead
of immediately restarting and spending past the cap.

The Supabase key must be an elevated AwardPing project key from Supabase Project
Settings -> API. Use either the legacy JWT `service_role` key or a newer
`sb_secret_...` secret key. It is not the Gemini API key, Vercel key,
anon/publishable key, or Cloudflare token. The installer checks this key before
installing dependencies.

The installer hides pasted keys while you type. They are still stored in the PC's
local `.env.worker.local` file because the worker needs them to run.

## Nightly Source Quality Pass

To run the cleanup/accuracy pass every night beside the normal 6 PM visual
snapshot runner, install the separate scheduled task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\installer\windows\Install-AwardPingOvernightSourceQuality.ps1"
```

That creates a Windows Scheduled Task named
`AwardPing Overnight Source Quality Pass`. By default it runs daily at 6 PM local
time for up to 10 hours, applies the source cleanup, short-title cleanup, missing
homepage cleanup, and aggregate award fact refresh, and writes logs under
`%LOCALAPPDATA%\AwardPingWorker\logs`.

To run it manually after installation, double-click:

```text
9-RUN-OVERNIGHT-SOURCE-QUALITY-NOW.bat
```

Useful install options:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\installer\windows\Install-AwardPingOvernightSourceQuality.ps1" -At "6pm" -Hours 10 -MaxAwards 90 -MinOpenSources 75
```

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

## Uninstall Scheduled Task

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AwardPingWorker\Uninstall-AwardPingWorker.ps1"
```

That removes the Scheduled Task. Delete `%LOCALAPPDATA%\AwardPingWorker` if you also
want to remove logs and local env files.
