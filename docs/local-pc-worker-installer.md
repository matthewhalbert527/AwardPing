# AwardPing Local PC Worker

## What It Does

- Installs the AwardPing worker under `%LOCALAPPDATA%\AwardPingWorker`.
- Installs Node.js LTS with `winget` if Node is missing.
- Prompts for the Supabase `service_role` key and Gemini API key.
- Writes those values to `.env.worker.local` on the PC.
- Installs npm dependencies.
- Runs a one-page visual snapshot test.
- Creates a Windows Scheduled Task named `AwardPing Visual Snapshot Worker`
  that runs the screenshot/PDF checker daily.

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

The old hosted `awardping-worker-windows.zip` updater has been retired. Update
the worker by editing this repo and copying changed worker files into
`%LOCALAPPDATA%\AwardPingWorker\app` on this PC.

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

## Uninstall Scheduled Task

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AwardPingWorker\Uninstall-AwardPingWorker.ps1"
```

That removes the Scheduled Task. Delete `%LOCALAPPDATA%\AwardPingWorker` if you also
want to remove logs and local env files.
