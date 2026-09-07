import { createHash, randomInt, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

export const PREFIX_VERSION = "20260830223000";
export const V3_MIGRATION = "20260831210000_canonical_identity_v3_truman_apply.sql";
export const FIXTURE_PATH = "supabase/tests/fixtures/stage1_identity_v3_prerequisite.sql";
export const FIXTURE_SUCCESS_ROW = "stage1_identity_v3_prerequisite_ok|71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9";
export const SMOKE_PATHS = Object.freeze([
  "stage1_r2_reference_graph_smoke.sql",
  "stage1_expansion_without_main_layout_smoke.sql",
  "stage1_expansion_capture_coverage_smoke.sql",
  "stage1_source_activation_finalizations_getter_smoke.sql",
  "stage1_evidence_schema_upgrade_failure_quarantine_smoke.sql",
  "stage1_activation_release_lock_order_smoke.sql",
].map((name) => `supabase/tests/${name}`));
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMP_PREFIX = "awardping-fixture-replay-";
export const USAGE = `Usage: node scripts/run-stage1-fixture-migration-smoke.mjs [--plan | --help | --execute-disposable-local]

Default / --plan: read-only inventory; no processes, temporary files, or database.
--execute-disposable-local: explicitly start/reset/delete a NEW local test database.
Execution currently targets Linux CI with installed Supabase CLI 2.109.1, psql,
and a local Docker socket. It may download Docker images. No automatic installs.

TEST-ONLY staged replay: frozen migrations plus an explicit synthetic prerequisite.
This does NOT fix bare db start/reset or prove production review/content accuracy.
No workflow is changed or dispatched by this script.
`;

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readRegular(root, path) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith(`..${sep}`) || rel === "..") throw new Error("File escapes the source root.");
  // Check every path component so a symlinked parent cannot smuggle in secrets.
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink refused: ${path}`);
  }
  if (!lstatSync(absolute).isFile()) throw new Error(`Not a regular file: ${path}`);
  const bytes = readFileSync(absolute);
  return { path, size: bytes.length, sha256: hash(bytes), bytes };
}

export function loadReplayInputs(root = DEFAULT_ROOT) {
  root = realpathSync(root);
  const directory = join(root, "supabase/migrations");
  if (lstatSync(join(root, "supabase")).isSymbolicLink() || lstatSync(directory).isSymbolicLink()) {
    throw new Error("Symlinked migration directory refused.");
  }
  const names = readdirSync(directory).sort();
  if (!names.length || names.some((name) => !/^(?:\d{4}|\d{14})_[a-zA-Z0-9_-]+\.sql$/.test(name))) {
    throw new Error("Migration directory must contain only versioned SQL files.");
  }
  const versions = names.map((name) => name.split("_", 1)[0]);
  if (new Set(versions).size !== versions.length) throw new Error("Duplicate migration version.");
  const split = names.indexOf(V3_MIGRATION);
  if (split < 1 || versions[split - 1] !== PREFIX_VERSION) throw new Error("Unexpected v3 migration predecessor/order.");
  const migrations = names.map((name) => ({
    ...readRegular(root, `supabase/migrations/${name}`), name, version: name.split("_", 1)[0],
  }));
  const config = readRegular(root, "supabase/config.toml");
  if (!/^major_version\s*=\s*17\s*$/m.test(config.bytes.toString("utf8"))) {
    throw new Error("This test runner requires the checked-in PostgreSQL 17 config.");
  }
  return {
    root, split, migrations, config,
    fixture: readRegular(root, FIXTURE_PATH),
    smokes: SMOKE_PATHS.map((path) => readRegular(root, path)),
  };
}

function inventory(inputs) {
  return [inputs.config, ...inputs.migrations, inputs.fixture, ...inputs.smokes]
    .map(({ path, size, sha256 }) => ({ path, size, sha256 }));
}

export function replayPlan(inputs) {
  return {
    status: "planned-not-executed", prerequisite: "TEST-ONLY synthetic v2-to-v3 homepages",
    limitation: "Bare db start/reset remains non-reproducible; this is not production review evidence.",
    migrationCount: inputs.migrations.length, prefixThrough: PREFIX_VERSION,
    suffixFrom: V3_MIGRATION, inventory: inventory(inputs),
    stages: ["copy allowlisted prefix to a unique temporary project", "start/reset prefix without seeds",
      "assert prefix ledger", "apply guarded test fixture", "restore byte-identical suffix",
      "apply remaining migrations", "assert complete ledger", "run existing SQL smokes",
      "stop only temporary project and remove only its directory"],
  };
}

export function assertExactLedger(output, migrations) {
  let rows;
  try { rows = JSON.parse(String(output).trim()); } catch { throw new Error("Invalid migration ledger JSON."); }
  if (JSON.stringify(rows) !== JSON.stringify(migrations.map(({ version }) => version))) {
    throw new Error("Migration ledger differs from exact frozen migration versions/order.");
  }
}

export function assertFixtureReceipt(output) {
  if (typeof output !== "string" || output.trim() !== FIXTURE_SUCCESS_ROW) {
    throw new Error("Fixture did not return exactly the committed success status and v3 hash.");
  }
}

// Probe only when explicitly executing. Hold both ports together while checking;
// Docker binding is authoritative after release (a race fails the start step).
export async function chooseLocalPorts() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = randomInt(55000, 62000);
    const servers = [];
    try {
      for (const candidate of [port, port + 1]) {
        const server = createServer();
        servers.push(server);
        await new Promise((done, reject) => {
          server.once("error", reject);
          server.listen({ host: "127.0.0.1", port: candidate, exclusive: true }, done);
        });
      }
      return [port, port + 1];
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    } finally {
      await Promise.all(servers.filter((server) => server.listening)
        .map((server) => new Promise((done) => server.close(done))));
    }
  }
  throw new Error("Cannot allocate unused local replay ports.");
}

export function localEnvironment(inherited, temporaryRoot, projectId) {
  // Never inherit PG*, cloud credentials, Docker contexts, NODE_OPTIONS, or
  // Supabase tokens/links. No dotenv files are copied or loaded.
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR"]) {
    if (typeof inherited[key] === "string") env[key] = inherited[key];
  }
  return {
    ...env, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONFIG: join(temporaryRoot, "docker"),
    XDG_CONFIG_HOME: join(temporaryRoot, "config"), XDG_DATA_HOME: join(temporaryRoot, "data"),
    SUPABASE_HOME: join(temporaryRoot, "supabase-home"), DO_NOT_TRACK: "1",
    PGPASSWORD: "postgres", PGSSLMODE: "disable", PGCONNECT_TIMEOUT: "5", PGAPPNAME: projectId,
    PGPASSFILE: join(temporaryRoot, "empty-pgpass"), PGSERVICEFILE: join(temporaryRoot, "empty-pgservice"),
  };
}

export function failureTail(stderr, stdout) {
  const clean = (value) => stripVTControlCharacters(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "").trim();
  const diagnostic = clean(stderr) || clean(stdout);
  if (!diagnostic) return "";
  // Break both workflow-command sentinels: legacy ##[ is recognized anywhere,
  // so a line prefix alone is insufficient. Never print args/env/config.
  const inert = diagnostic.slice(-4000).replace(/:{2,}/g, (colons) => colons.split("").join(" "))
    .replaceAll("##[", "## [");
  return `\n${inert.split("\n").map((line) => `[replay diagnostic] ${line}`).join("\n")}`;
}

function temporaryConfig(projectId, port, shadowPort) {
  return `project_id = "${projectId}"\n[api]\nenabled = false\n[db]\nport = ${port}\nshadow_port = ${shadowPort}\nmajor_version = 17\nhealth_timeout = "2m"\n[db.migrations]\nenabled = true\nschema_paths = []\n[db.seed]\nenabled = false\nsql_paths = []\n`;
}

function assertOwnedDirectory(directory, parent) {
  if (dirname(directory) !== parent || !basename(directory).startsWith(TEMP_PREFIX)
    || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) {
    throw new Error("Refusing cleanup of a directory not owned by this replay.");
  }
}

function writeCopy(root, file) {
  if (isAbsolute(file.path) || /^[a-z]:/i.test(file.path) || file.path.split(/[\\/]/).includes("..")) {
    throw new Error("Copied file path must stay inside the disposable workdir.");
  }
  const destination = resolve(root, file.path);
  const within = relative(root, destination);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error("Copied file path escapes disposable workdir.");
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, file.bytes, { flag: "wx" });
}

function assertCopies(root, files) {
  const actualNames = readdirSync(join(root, "supabase/migrations")).sort();
  const expectedNames = files.filter(({ name }) => name).map(({ name }) => name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error("Copied migration inventory drifted.");
  for (const file of files) {
    if (readRegular(root, file.path).sha256 !== file.sha256) throw new Error(`Copied file drifted: ${file.path}`);
  }
}

export async function executeReplay({
  consent = false, inputs = loadReplayInputs(), platform = process.platform,
  tempRoot = tmpdir(), inheritedEnv = process.env, runProcess = spawnSync,
  choosePorts = chooseLocalPorts, uuid = randomUUID, stdout = process.stdout, stderr = process.stderr,
} = {}) {
  if (consent !== true) throw new Error("Explicit disposable-local execution consent is required.");
  if (platform !== "linux") throw new Error("Database execution is restricted to Linux CI; --plan works on any platform.");
  const id = uuid().replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid unique replay identity.");
  const projectId = `${TEMP_PREFIX}${id}`;
  const ports = await choosePorts();
  if (ports.length !== 2 || ports.some((port) => !Number.isInteger(port) || port < 55000 || port > 62000)
    || ports[0] === ports[1]) throw new Error("Unsafe local replay ports.");
  const parent = realpathSync(tempRoot);
  const directory = mkdtempSync(join(parent, TEMP_PREFIX));
  assertOwnedDirectory(directory, parent);
  const env = localEnvironment(inheritedEnv, directory, projectId);
  let startAttempted = false;
  let failure;
  let stopped = false;
  const prefix = inputs.migrations.slice(0, inputs.split);
  const files = [...inputs.migrations, inputs.fixture, ...inputs.smokes];
  function command(executable, args, label) {
    stderr.write(`[replay] ${label}\n`);
    const result = runProcess(executable, args, {
      cwd: directory, env, shell: false, windowsHide: true,
      encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${label} failed (${result.error?.code ?? result.signal ?? result.status}).${failureTail(result.stderr, result.stdout)}`);
    }
    return result.stdout ?? "";
  }
  const supabase = (args, label) => command("supabase", [...args, "--workdir", directory], label);
  const psql = (args, label) => command("psql", ["--no-psqlrc", "--no-password", "--host=127.0.0.1",
    `--port=${ports[0]}`, "--username=postgres", "--dbname=postgres", "--set=ON_ERROR_STOP=1", ...args], label);
  const ledger = (expected) => assertExactLedger(psql(["--tuples-only", "--no-align", "--command",
    "select coalesce(json_agg(version order by version), '[]'::json) from supabase_migrations.schema_migrations;"],
  "Read migration ledger"), expected);
  try {
    mkdirSync(join(directory, "supabase"));
    mkdirSync(join(directory, "docker"));
    mkdirSync(join(directory, "config"));
    mkdirSync(join(directory, "data"));
    mkdirSync(join(directory, "supabase-home"));
    writeFileSync(join(directory, "empty-pgpass"), "", { flag: "wx", mode: 0o600 });
    writeFileSync(join(directory, "empty-pgservice"), "", { flag: "wx", mode: 0o600 });
    writeFileSync(join(directory, "supabase/config.toml"), temporaryConfig(projectId, ...ports), { flag: "wx" });
    for (const file of [...prefix, inputs.fixture, ...inputs.smokes]) writeCopy(directory, file);
    assertCopies(directory, [...prefix, inputs.fixture, ...inputs.smokes]);
    if (JSON.stringify(inventory(loadReplayInputs(inputs.root))) !== JSON.stringify(inventory(inputs))) {
      throw new Error("Source files changed after planning.");
    }
    if (supabase(["--version"], "Supabase version").trim() !== "2.109.1") throw new Error("Supabase CLI must be exactly 2.109.1.");
    command("psql", ["--version"], "PostgreSQL client preflight");
    startAttempted = true;
    supabase(["db", "start"], "Start disposable database");
    supabase(["db", "reset", "--local", "--version", PREFIX_VERSION, "--no-seed", "--yes"], "Reset prefix");
    ledger(prefix);
    assertFixtureReceipt(psql(["--quiet", "--tuples-only", "--no-align", "--field-separator=|",
      "--file", join(directory, inputs.fixture.path)], "Guarded test-only fixture"));
    for (const file of inputs.migrations.slice(inputs.split)) writeCopy(directory, file);
    assertCopies(directory, files);
    supabase(["migration", "up", "--local"], "Apply frozen suffix");
    ledger(inputs.migrations);
    for (const smoke of inputs.smokes) psql(["--file", join(directory, smoke.path)], `Smoke ${basename(smoke.path)}`);
    ledger(inputs.migrations);
    assertCopies(directory, files);
  } catch (error) {
    failure = error;
  } finally {
    if (startAttempted) {
      try {
        supabase(["stop", "--project-id", projectId, "--no-backup"], "Stop disposable database");
        stopped = true;
      } catch (error) {
        failure = new Error(`${failure ? `${failure.message} ` : ""}${error.message} Preserved recovery workdir: ${directory}`);
      }
    }
    try {
      if (JSON.stringify(inventory(loadReplayInputs(inputs.root))) !== JSON.stringify(inventory(inputs))) {
        throw new Error("Source files drifted during replay; result is not valid.");
      }
    } catch (error) {
      failure = new Error(`${failure ? `${failure.message} ` : ""}${error.message}`);
    }
    if (!startAttempted || stopped) {
      try {
        assertOwnedDirectory(directory, parent);
        rmSync(directory, { recursive: true, force: false });
      } catch (error) {
        failure = new Error(`${failure ? `${failure.message} ` : ""}Cleanup refused/failed: ${error.message}`);
      }
    }
  }
  if (failure) throw failure;
  const result = { status: "fixture-assisted-replay-passed", migrationCount: inputs.migrations.length,
    productionEvidence: false, bareResetFixed: false, projectId };
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function runReplayCli({ argv = process.argv.slice(2), load = loadReplayInputs,
  execute = executeReplay, stdout = process.stdout } = {}) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    stdout.write(USAGE);
    return { status: "help" };
  }
  if (argv.length > 1 || (argv.length === 1 && !["--plan", "--execute-disposable-local"].includes(argv[0]))) {
    throw new Error(`Unknown or duplicated arguments.\n${USAGE}`);
  }
  const inputs = load();
  if (argv[0] === "--execute-disposable-local") return execute({ consent: true, inputs, stdout });
  const result = replayPlan(inputs);
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runReplayCli().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
