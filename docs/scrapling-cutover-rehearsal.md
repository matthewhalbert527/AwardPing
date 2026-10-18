# Offline Scrapling cutover rehearsal

This is a local regression check, not a production migration command. It does not
load worker credentials, contact websites, call an AI provider, alter scheduled
tasks, or read or write the production database or object store.

Run from the shared development folder:

```powershell
node node_modules/vitest/vitest.mjs run scripts/scrapling-cutover-rehearsal.test.mjs
```

## What is exercised

The test extracts and executes the **current worker's actual** source dispatch,
baseline writer, storage error handling, required-persistence guard, baseline restoration, and Scrapling
comparison orchestration in an isolated context. This avoids importing the worker
CLI, whose startup initializes live services. The production source-manifest and
profile-transition guards and atomic file writer are used directly.

Each fixture has its own temporary archive. Tests verify:

- Neither migration nor rollback can compare incompatible extraction profiles.
- Explicit baseline-only migration and rollback do not queue a public change or
  invoke AI review. The old capture and its bytes remain intact.
- A successful persistence acknowledgment precedes recording baseline success.
- Failed or disabled authoritative persistence restores the complete prior local
  baseline, including its original profile, facts, and evidence references.
- A failed first baseline leaves no baseline pointer but retains acquired evidence.
- Older observations cannot overwrite a newer baseline.
- A changed approved URL or award identity is rejected before collection, and a
  newly held source is not collected.
- Acquisition or retention failure does not replace the previous baseline.
- The next same-profile unchanged result neither rotates the baseline nor queues
  a change.

## What is deliberately simulated

Network collection, artifact projection, database review-state/health callbacks,
object-store persistence acknowledgments, and the unchanged-comparison result
are explicit test doubles. Screenshot fixture bytes are not real images. This
suite tests orchestration and local restoration, **not** image validation, remote
transaction atomicity, extraction accuracy, AI judgment, the per-source process
lock, or the installed release. Unexpected candidate/publication paths fail the
test instead of calling a remote service.

The actual baseline-fact extraction function is also exercised with extraction
disabled; an attempted provider availability check would fail the test.

Use the companion capture, artifact-binding, baseline-promotion, runtime-binding,
HTML comparison, accuracy, and installer suites for their respective boundaries.
The offline readiness report accounts for saved capture evidence; it cannot prove
that sources are still approved or reachable today.

## Remaining release gates

1. Review and build the isolated release against the installed worker base. Do not
   install the dirty shared development tree or assume its HEAD is live.
2. Verify the existing Gemini service actually completes a bounded review after
   billing recovery. A successful model-list request is not sufficient.
3. Refresh the exact approved-source manifest and confirm source identities and
   current review states. The retained 74-source proposal is not fresh authority.
4. Rehearse the exact release and real persistence/rollback boundaries in an
   isolated environment; keep the installer quiesce/backup protocol intact.
5. Only then perform a controlled baseline-only cutover, verify authoritative
   persistence and health, and resume ordinary comparison. Preserve legacy and
   Scrapling evidence. A rollback also needs a compatible baseline-only capture;
   disabling Scrapling alone is not a safe comparison rollback.

No step in this document activates Scrapling automatically. NSF failures,
PDF/image-text gaps, screenshot alignment limitations, manual holds, and untested
AI behavior remain visible release limitations rather than successful coverage.

## Read-only staged-installation preflight

`scripts/check-scrapling-cutover.mjs` provides a bounded operator check around the
existing runtime-binding and exact-source manifest validators. Supply explicit
absolute paths to an already staged, installer-shaped app and durable runtime:

```powershell
node scripts/check-scrapling-cutover.mjs `
  --app-dir 'C:\reviewed-worker\app' `
  --manifest 'C:\reviewed-worker\app\.awardping-scrapling-manifest.json' `
  --python 'C:\reviewed-worker\runtime\scrapling-<requirements-sha256>\Scripts\python.exe'
```

This command does not create the staging installation, load an environment file,
execute Python, contact websites/providers/databases, change baselines or modify
tasks. It validates the selected manifest format and hash-bound runtime files and
prints JSON. Missing, changed, malformed or unbound files fail; no fallback is
selected. Declaring all 25 award IDs does not imply all 25 have selected sources.

Exit 0 means **local binding verification only**. The output always retains
`production_ready: false` and `activation_authorized: false`, with the independent
live approval, real AI accuracy, coverage, exact-release, persistence/rollback and
scheduled-run checks still required. This is a snapshot integrity diagnostic, not
proof of native imports, current source approval or future unchanged files. The
offline rehearsal above and the installer remain separate; do not run the real
worker as a substitute for this check.
