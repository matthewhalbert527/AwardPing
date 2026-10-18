# Pinned Windows Scrapling runtime

`installer/windows/Install-AwardPingScraplingRuntime.ps1` prepares an isolated Python environment. The helper alone does **not** install an application release, change scheduled tasks or environment files, select a live worker runtime, install a browser, or run captures. The main worker installer has a separate explicit opt-in described below; implementing that interface does not mean production has been activated.

Run it from a reviewed release, supplying an existing dedicated worker directory and a real base Python 3.10+ executable (major version 3). The `SourceRoot` contains `scripts/scrapling/requirements.txt`; pass the release's `runner-files` directory if that is where the payload lives.

```powershell
$runtime = & 'C:\reviewed-release\installer\windows\Install-AwardPingScraplingRuntime.ps1' `
  -InstallRoot 'C:\Users\example\AppData\Local\AwardPingWorker' `
  -SourceRoot 'C:\reviewed-release' `
  -PythonExecutable 'C:\Python312\python.exe'
$runtime
```

Omitting `PythonExecutable` checks real `python.exe`/`python3.exe` executables on PATH. Windows Store aliases and other reparse points are rejected; Python is never installed automatically. There are no interactive prompts. A supplied virtual environment cannot be used as the base interpreter.

The result object contains absolute `PythonExecutable`, `RuntimeRoot` and `ReceiptPath`, plus `RequirementsSha256`, `PythonSha256`, `ReceiptSha256` and `Reused`. The caller must retain/verify this receipt and independently complete the reviewed release's activation and rollback steps. Do not copy a dirty checkout into the installed worker.

## Installation and reuse

- The runtime is `InstallRoot\runtime\scrapling-<full SHA-256 of exact requirements bytes>`. Old hash directories are retained for rollback.
- Only exact package pins are accepted. Packages are installed from PyPI as wheels with `--no-deps`; all transitive packages must therefore be explicitly pinned. `pip check` and exact installed-version verification must both pass. Unexpected packages other than pip/setuptools/wheel bootstrap tools are rejected.
- New installs and reuse also import the actual Scrapling fetcher/native dependencies in a bounded 30-second, no-request smoke check. Windows can reject native DLLs under deeply nested paths even when package/version checks pass. Use a short dedicated installation root; do not change global path/security settings or overwrite a failed runtime to mask this error. An actual long-path staging attempt exposed this failure before activation.
- Python/pip configuration variables are stripped from child processes, pip is noninteractive/isolated, and `PIP_CONFIG_FILE=NUL` disables configuration files. Subprocess output is not copied to errors because it may contain sensitive information. [pip configuration documentation](https://pip.pypa.io/en/stable/topics/configuration/).
- The receipt records hashes of retained runtime files, package versions, base Python and its Windows Python DLLs. Reuse checks the file inventory **before executing the runtime**, then repeats dependency/version checks. Generated `__pycache__/*.pyc`/`*.pyo` files are excluded because normal Python execution may create them; Python source, native modules, package metadata and configuration are included.
- This is not a portable Python distribution: the base Python installation must remain available. Its standard library is an external dependency, not fully sealed by this receipt. Version pins are not wheel-content supply-chain hashes. The receipt detects accidental changes; it is not an authentication boundary against someone who can modify both files and receipt.
- Absolute local paths are required; drive roots, broad profile/system directories, UNC/device paths, traversal, alternate streams, and reparse points are rejected. Concurrent installs of the same hash are refused using a create-only lock. No runtime is deleted or overwritten. The installer removes only the exact lock it successfully created.
- An incomplete runtime, changed file, stale lock, unavailable wheel, unsupported interpreter or failed subprocess stops installation. Existing/partial files are preserved for inspection. There is no automatic retry, deletion or repair. Any cleanup is a separate explicit operator decision; do not erase old runtimes needed for rollback.

## Offline safety tests

```powershell
node node_modules/vitest/vitest.mjs run scripts/scrapling-runtime-installer.test.mjs --maxWorkers=1
```

Tests use static inspection, temporary directories, local no-network subprocess fixtures and a mocked package installation. They never install packages or touch a live worker. A real reviewed install is a separate prerequisite to production cutover, not established by these tests.

## Explicit main-installer integration

From the same clean, reviewed worker release used by the normal installer, pass all three opt-in arguments. The manifest must contain approved real source UUIDs and exact official URLs; a research proposal or pilot fallback ID is not an approved source. Independently review and record its raw-file SHA-256 before invoking the installer.

```powershell
# Example interface only; the main installer changes the worker and scheduled tasks.
& 'C:\reviewed-release\installer\windows\Install-AwardPingWorker.ps1' `
  -UpdateOnly `
  -EnableScrapling `
  -ScraplingManifestPath 'C:\reviewed-release\config\approved-scrapling-sources.json' `
  -ScraplingManifestSha256 '<reviewed lowercase SHA-256>' `
  -ScraplingPythonExecutable 'C:\Python312\python.exe'
```

Retain the existing app-URL and operational-logon arguments required by the normal installer. `ScraplingPythonExecutable` is optional only when supported base-Python discovery or verified runtime reuse suffices. There is no new prompt. Without `EnableScrapling`, a legacy installation does not install Python or change collector configuration. If an existing environment already selects Scrapling, an update must explicitly supply the reviewed manifest/hash again; silently inheriting an unverified selection is refused before staging or task changes.

Update mode prepares the pinned runtime and validates the manifest in the staged app before pausing tasks. The existing clean-source check still applies. It creates two app-local files, refusing overwrites: `.awardping-scrapling-manifest.json` (exact reviewed bytes) and `.awardping-scrapling-runtime.json` (schema `awardping.scrapling-installation.v1`). The binding records manifest hash/count, requirements hash, durable Python/runtime paths and runtime receipt path/hash. Only the staged environment receives the two collector keys, pointing to the final app manifest and durable Python executable.

Before scheduled tasks can resume, installer verification checks the exact app-local manifest, pinned requirements, receipt binding, complete retained runtime reuse and actual native imports. Every new candidate validates its HTML/Scrapling code-file import closure against the reviewed release, even with collection disabled; this includes `visible-document.js`, not just Python files. Legacy rollback uses the existing `RequireManagedRuntime=false` mode and does not demand new files from an older restored release. An invalid or partial enabled binding still fails closed. The runtime remains under `InstallRoot\runtime`; switching or rolling back complete app directories does not delete it. A failed update restores the previous complete app/environment through the existing installer rollback path, including its prior manifest/binding, while retaining any newly prepared runtime for inspection.

This integration does **not** approve sources, modify baselines, verify provider billing, run profile migration or establish document coverage. Before activation, finish those prerequisites and test profile-compatible rollback; reverting code alone must not compare legacy and Scrapling baselines as an award change. Keep durable runtimes and receipts needed by both revisions. Read-only worker-startup verification is implemented in `scripts/lib/scrapling-runtime-binding.mjs` using the same binding schema; it verifies manifest, requirements, receipt and runtime/base-file hashes without invoking Python or installing anything. It is a separate defense, not a substitute for installer import checks or proof that production is activated.

```powershell
node node_modules/vitest/vitest.mjs run scripts/scrapling-main-installer.test.mjs scripts/scrapling-runtime-installer.test.mjs --maxWorkers=1
```
