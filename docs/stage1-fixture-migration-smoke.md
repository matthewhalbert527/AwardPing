# Test-only Stage 1 migration replay

This helper is an explicit, fixture-assisted test of frozen migrations. It is **not a production bootstrap or migration repair**. It does not fabricate human-reviewed award evidence or change the live site's 25-award release.

## Why a fixture is necessary

The historical migration chain creates exact identity v2. The frozen August 31 v3 migration intentionally requires three previously reviewed homepage changes: Truman `/apply`, Hertz without its trailing slash, and Soros without `www`. Those data changes happened outside migration history. The migration correctly refuses the old v2 hash.

Consequently, bare `supabase db start` or full `supabase db reset` still fails from the ordinary checkout. Passing this wrapper must never be presented as proof that bare reset works. A seed file cannot satisfy a guard that fails earlier during migration startup.

The wrapper supplies a clearly synthetic prerequisite only in a brand-new disposable database. The fixture belongs under `supabase/tests/fixtures`, never `supabase/migrations`. No historical SQL file, migration version, production guard, or existing CI workflow is changed.

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

## Validation status

The implementation has **not executed against PostgreSQL**. Offline tests cover planning, immutable file inventories, argument/environment boundaries, exact ledger verification, mocked command order, partial failures, and cleanup. Fixture contract/parser tests are not a database integration test.

Current review status: both runner and corrected fixture passed independent static review. The combined focused suite passes **53 offline tests** (45 runner tests and 8 fixture contract/parser tests); focused lint is clean. The fixture preserves the required historical seed records and acquires the shared release lock plus table locks before its guards. Exact original payload provenance comes from executing the byte-verified frozen prefix and its full-payload postconditions, followed by the fixture's key/value and unchanged-row checks; the fixture alone is not an arbitrary-database validator.

Runtime validation in an authorized disposable Linux environment is still required before wiring this helper into CI. In particular, a successful v3 transition may expose further assumptions in later frozen migrations; the wrapper must report those failures rather than bypassing them. This helper proves no live award fact, source freshness, monitoring success, or production release readiness.
