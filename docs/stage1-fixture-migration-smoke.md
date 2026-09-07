# Test-only Stage 1 migration replay

This helper is an explicit, fixture-assisted test of frozen migrations. It is **not a production bootstrap or migration repair**. It does not fabricate human-reviewed award evidence or change the live site's 25-award release.

## Why a fixture is necessary

The historical migration chain creates exact identity v2. The frozen August 31 v3 migration intentionally requires three previously reviewed homepage changes: Truman `/apply`, Hertz without its trailing slash, and Soros without `www`. Those data changes happened outside migration history. The migration correctly refuses the old v2 hash.

Consequently, bare `supabase db start` or full `supabase db reset` still fails from the ordinary checkout. Passing this wrapper must never be presented as proof that bare reset works. A seed file cannot satisfy a guard that fails earlier during migration startup.

The wrapper supplies a clearly synthetic prerequisite only in a brand-new disposable database. The fixture belongs under `supabase/tests/fixtures`, never `supabase/migrations`. No historical SQL file, migration version, production guard, or existing bare-chain CI workflow is changed.

## Safe default and execution boundary

```sh
node scripts/run-stage1-fixture-migration-smoke.mjs --plan
```

No flag also means plan. This reads an allowlisted input inventory and prints paths, byte counts, and SHA-256 hashes. It does not spawn commands, create temporary files, start Docker, or connect to a database. `--help` does not even load project files.

Execution is intentionally limited to an explicitly authorized **Linux** test environment with the already-installed Supabase CLI **2.109.1**, `psql`, and a local Docker socket. Docker may download images; this is not an offline command. There is no `npx`, package installation, linked-project option, connection URL option, or automatic CI dispatch.

Only after approval to start and destroy a disposable local database:

```sh
node scripts/run-stage1-fixture-migration-smoke.mjs --execute-disposable-local
```

Windows supports the plan and mocked contract tests, not database execution. Production deployment approval is not blanket approval for this operation.

## What the execution path checks

1. Inventory every regular migration file and reject duplicate versions, symlinks, an unexpected v3 predecessor, or changed source bytes.
2. Allocate a unique temporary project identity and unused high local ports. Generate a minimal PostgreSQL 17 configuration with seed execution disabled. Copy only exact prefix SQL, the fixture, and the six existing SQL smokes. Do not copy `.env`, Supabase link metadata, Docker contexts, or project secrets.
3. Start/reset only the prefix through `20260830223000`; assert its exact migration ledger. The suffix must be absent from this copied workdir even during `db start`.
4. Run the guarded fixture with local-only `psql`, startup files disabled, explicit database/user, a test application-name marker, and error-stop behavior. The marker is an additional check, **not proof of authorization or isolation by itself**. The fixture must reject unexpected reviewed/evidence-bearing state while recognizing and snapshot-preserving exact historical evidence deliberately seeded by frozen migrations (including the NDSEG quarantine record). An empty-table assumption is not sufficient. It changes only the three exact canonical homepage pairs in registry and shared award rows.
5. Require exactly the fixture's committed success status and v3 hash from quiet, unaligned `psql` output; reject missing, wrong, or extra rows. Restore the byte-identical suffix, verify hashes, apply pending local migrations, and check the complete ledger. Run all six existing SQL smokes and recheck the ledger and copied/source inventories. No synthetic fixture migration version is permitted.
6. After any attempted start, stop only the unique test project with `--no-backup`. Remove only the verified owned temporary directory. If stop fails, report and preserve its path/config for recovery; never stop all projects or touch the ordinary checkout's database. Cleanup failure cannot turn a failed run into success.

The child environment excludes inherited database/cloud credentials, Docker contexts, Node startup hooks, and remote connection settings. Docker is pinned to the local Unix socket. PostgreSQL connects only to literal `127.0.0.1` on the allocated port, using the disposable database's standard local password.

The CLI's `SUPABASE_HOME` is a new owned temporary directory; telemetry is disabled with `DO_NOT_TRACK=1`. Stage names go to stderr, separately from the successful JSON receipt. Failed commands include only a bounded, terminal-control-stripped diagnostic tail with workflow-command sentinels broken and every line prefixed. The runner does not log inherited environment, arguments, or configuration.

## Explicitly authorized GitHub validation

The separate `.github/workflows/stage1-fixture-migration-smoke.yml` workflow leaves the existing bare-chain workflow unchanged. It runs only on relevant pushes to `claude/overnight-supervised-20260903` whose **HEAD commit message** contains `[fixture-replay]`. Adding that marker is an explicit opt-in to start and destroy a disposable GitHub-runner database. Its read-only-permission jobs run the offline contracts first, then install pinned Supabase CLI 2.109.1 and use the guarded runner. No production secrets or linked project are used.

An optional manual `fixture_replay` boolean defaults to false. Manual dispatch will only become available if this workflow is later integrated into the default branch; this change does not do that. Branch-push opt-in is the current invocation path, so ordinary pushes without the marker do not execute databases.

## Validation status

The fixture-assisted replay **passed against disposable PostgreSQL 17** in [GitHub run 34077529149](https://github.com/matthewhalbert527/AwardPing/actions/runs/34077529149) at source commit `2801bf347aa7c8e2a8537933db9c0f8d8abf701f`, completed September 6, 2026 at 9:51 PM Central (September 7 at 02:51 UTC). The run passed the exact prefix ledger, guarded fixture receipt, byte-identical suffix, full 132-migration ledger, all six existing SQL smokes, final source/copy hashes, and owned database/directory cleanup. Its final receipt reports `fixture-assisted-replay-passed`, `migrationCount: 132`, `productionEvidence: false`, and `bareResetFixed: false`.

Offline tests cover planning, immutable file inventories, argument/environment boundaries, exact ledger verification, mocked command order, partial failures, and cleanup. Fixture contract/parser tests are not a database integration test; the separate GitHub runtime result supplies that evidence for this exact fixture-assisted path.

Current review status: both runner and corrected fixture passed independent static review. The combined focused suite passes **61 offline tests** (49 runner tests, 8 fixture contract/parser tests, and 4 CI workflow contracts); focused lint is clean. The fixture preserves the required historical seed records and acquires the shared release lock plus table locks before its guards. Exact original payload provenance comes from executing the byte-verified frozen prefix and its full-payload postconditions, followed by the fixture's key/value and unchanged-row checks; the fixture alone is not an arbitrary-database validator.

The first owner-authorized disposable GitHub validation passed without changing frozen migrations or production guards. Future runs must still report any later migration assumptions rather than bypassing them. The bare-chain failure remains unresolved; this helper proves no live award fact, source freshness, monitoring success, or production release readiness. The live website remains at `111c077922de4f85e8ecb7e3792da1faea8b8af4`, with no production database or worker changes from this validation.
