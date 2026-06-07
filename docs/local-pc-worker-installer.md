# AwardPing Local PC Worker Installer

Use this package on the Windows PC that will crawl award pages.

## What It Does

- Installs the AwardPing worker under `%LOCALAPPDATA%\AwardPingWorker`.
- Installs Node.js LTS with `winget` if Node is missing.
- Prompts for the Supabase `service_role` key and Gemini API key.
- Writes those values to `.env.worker.local` on the PC.
- Installs npm dependencies.
- Runs a one-page test.
- Can immediately run the full initial source expansion crawl that searches for
  official subpages across awards.
- Optionally creates a Windows Scheduled Task named `AwardPing Local Source Worker`
  that runs every 60 minutes.

## Windows Install

1. Copy `awardping-worker-windows.zip` to the PC.
2. Extract the zip.
3. Double-click `1-INSTALL-AND-RUN-DEEP-CRAWL.bat`.
4. Paste the Supabase legacy JWT `service_role` key or the newer `sb_secret_...`
   key when prompted.
5. Paste the Gemini API key when prompted.
6. Accept the hourly Scheduled Task when prompted.

For a setup without immediately starting the full crawl, double-click:

```text
2-INSTALL-ONLY.bat
```

The normal first-run choice is `1-INSTALL-AND-RUN-DEEP-CRAWL.bat`. It installs
the worker, then starts the source expansion crawl after the one-page validation.
The `runner-files` folder is just the internal app package used by the installer.

The Supabase key must be an elevated AwardPing project key from Supabase Project
Settings -> API. Use either the legacy JWT `service_role` key or a newer
`sb_secret_...` secret key. It is not the Gemini API key, Vercel key,
anon/publishable key, or Cloudflare token. The installer checks this key before
installing dependencies.

The installer hides pasted keys while you type. They are still stored in the PC's
local `.env.worker.local` file because the worker needs them to run.

## Manual Run

After install, double-click this from the extracted package or from
`%LOCALAPPDATA%\AwardPingWorker` to expand all awards:

```text
3-RUN-DEEP-CRAWL-AGAIN.bat
```

That is equivalent to:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AwardPingWorker\Run-AwardPingWorker.ps1" -DeepCrawl -Limit 20000 -MaxSubpages 24 -CrawlDepth 2
```

To run the scheduled-style hourly check immediately, double-click:

```text
4-RUN-HOURLY-CHECK-NOW.bat
```

Or run this in PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AwardPingWorker\Run-AwardPingWorker.ps1" -Limit 1
```

To do a targeted deep crawl for one award, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AwardPingWorker\Run-AwardPingWorker.ps1" -Award "Udall" -DeepCrawl -Limit 75 -MaxSubpages 24 -CrawlDepth 2
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
