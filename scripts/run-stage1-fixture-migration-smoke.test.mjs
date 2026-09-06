import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertExactLedger, executeReplay, FIXTURE_PATH, FIXTURE_SUCCESS_ROW, loadReplayInputs, localEnvironment,
  PREFIX_VERSION, replayPlan, runReplayCli, SMOKE_PATHS, USAGE, V3_MIGRATION } from "./run-stage1-fixture-migration-smoke.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith("awardping-replay-test-")
      || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new Error("Unsafe test cleanup.");
    rmSync(root, { recursive: true, force: false });
  }
});

function harness({ failAt, afterCommand, mutateLedger, version = "2.109.1", fixtureReceipt = `${FIXTURE_SUCCESS_ROW}\n` } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "awardping-replay-test-"));
  roots.push(root);
  const source = join(root, "source");
  const tempRoot = join(root, "temporary-runs");
  mkdirSync(tempRoot);
  function write(path, data) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), data);
  }
  write("supabase/config.toml", 'project_id = "REAL-PROJECT-DO-NOT-USE"\n[db]\nmajor_version = 17\n');
  write("supabase/migrations/20260701000000_initial.sql", "select 'raw bytes';\r\n");
  write(`supabase/migrations/${PREFIX_VERSION}_prefix.sql`, "select 2;\n");
  write(`supabase/migrations/${V3_MIGRATION}`, "begin;\nselect 3;\ncommit;\n");
  write("supabase/migrations/20260901000000_suffix.sql", "select 4;\n");
  write(FIXTURE_PATH, "begin;\nselect 'test-only';\ncommit;\n");
  for (const path of SMOKE_PATHS) write(path, "begin;\nselect 5;\nrollback;\n");
  // Deliberately never copied/read by the runner.
  write(".env.local", "SECRET_SENTINEL=never-copy\n");
  write("supabase/.temp/project-ref", "remote-project-do-not-copy");
  const inputs = loadReplayInputs(source);
  const calls = [];
  let suffixApplied = false;
  const runProcess = vi.fn((executable, args, options) => {
    let label;
    if (args[0] === "--version") label = `${executable}-version`;
    else if (executable === "supabase") label = args.slice(0, 2).join(" ");
    else if (args.includes("--command")) label = "ledger";
    else label = basename(args.at(-1));
    const call = { executable, args, options, label,
      migrationNames: readdirSync(join(options.cwd, "supabase/migrations")),
      config: readFileSync(join(options.cwd, "supabase/config.toml"), "utf8"),
    };
    calls.push(call);
    if (label === "migration up") suffixApplied = true;
    let stdout = "";
    if (label === "supabase-version") stdout = `${version}\n`;
    if (label === "psql-version") stdout = "psql (PostgreSQL) 17.6\n";
    if (label === "stage1_identity_v3_prerequisite.sql") stdout = fixtureReceipt;
    if (label === "ledger") {
      const rows = inputs.migrations.slice(0, suffixApplied ? undefined : inputs.split).map((file) => file.version);
      stdout = JSON.stringify(mutateLedger ? mutateLedger(rows, suffixApplied) : rows);
    }
    afterCommand?.(call, { source, inputs, write });
    if (failAt === label || (Array.isArray(failAt) && failAt.includes(label))) {
      return { status: 1, stdout: "", stderr: "simulated failure" };
    }
    return { status: 0, stdout, stderr: "" };
  });
  const options = {
    consent: true, inputs, platform: "linux", tempRoot, runProcess,
    choosePorts: vi.fn(async () => [58001, 58002]),
    uuid: () => "01234567-89ab-cdef-0123-456789abcdef",
    inheritedEnv: { PATH: "/usr/bin", HOME: "/user-home", DATABASE_URL: "remote", PGHOST: "remote",
      SUPABASE_ACCESS_TOKEN: "secret", DOCKER_HOST: "ssh://remote", DOCKER_CONTEXT: "production", NODE_OPTIONS: "--import=bad" },
    stdout: { write: vi.fn() },
  };
  return { root, source, tempRoot, write, inputs, calls, options };
}

describe("read-only staged replay planning", () => {
  it.each([{ argv: [] }, { argv: ["--plan"] }])("defaults to no execution for $argv", async ({ argv }) => {
    const h = harness();
    const execute = vi.fn();
    const before = readdirSync(h.tempRoot);
    const result = await runReplayCli({ argv, load: () => h.inputs, execute, stdout: { write: vi.fn() } });
    expect(result.status).toBe("planned-not-executed");
    expect(result.migrationCount).toBe(4);
    expect(execute).not.toHaveBeenCalled();
    expect(readdirSync(h.tempRoot)).toEqual(before);
    expect(result.inventory.map((file) => file.path)).not.toContain(".env.local");
    expect(result.inventory[1]).toMatchObject({ size: Buffer.byteLength("select 'raw bytes';\r\n"), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it.each(["--help", "-h"])("help %s does not even inventory files", async (arg) => {
    const load = vi.fn();
    const execute = vi.fn();
    const stdout = { write: vi.fn() };
    expect(await runReplayCli({ argv: [arg], load, execute, stdout })).toEqual({ status: "help" });
    expect(load).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(stdout.write).toHaveBeenCalledWith(USAGE);
  });

  it.each([["--linked"], ["--execute-disposable-local", "--execute-disposable-local"], ["--plan", "--execute-disposable-local"]])(
    "rejects unknown/duplicate args before reading or writing %j", async (...args) => {
      const load = vi.fn();
      const execute = vi.fn();
      await expect(runReplayCli({ argv: args, load, execute })).rejects.toThrow("Unknown or duplicated");
      expect(load).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

  it("requires explicit consent and Linux before any subprocess/temp allocation", async () => {
    const h = harness();
    await expect(executeReplay({ ...h.options, consent: false })).rejects.toThrow("consent");
    await expect(executeReplay({ ...h.options, platform: "win32" })).rejects.toThrow("Linux CI");
    expect(h.options.choosePorts).not.toHaveBeenCalled();
    expect(h.options.runProcess).not.toHaveBeenCalled();
    expect(readdirSync(h.tempRoot)).toEqual([]);
  });

  it("only the exact execution flag dispatches the runner", async () => {
    const h = harness();
    const execute = vi.fn(async () => ({ status: "mocked" }));
    const stdout = { write: vi.fn() };
    await runReplayCli({ argv: ["--execute-disposable-local"], load: () => h.inputs, execute, stdout });
    expect(execute).toHaveBeenCalledWith({ consent: true, inputs: h.inputs, stdout });
  });
});

describe("frozen input inventories", () => {
  it("preserves original four-digit versions alongside timestamp versions", () => {
    const h = harness();
    h.write("supabase/migrations/0001_initial_schema.sql", "select 0;\n");
    h.write("supabase/migrations/0019_legacy_end.sql", "select 0;\n");
    expect(loadReplayInputs(h.source).migrations.map((file) => file.version)).toEqual([
      "0001", "0019", "20260701000000", PREFIX_VERSION, "20260831210000", "20260901000000",
    ]);
  });
  it("rejects duplicate versions and unexpected predecessor", () => {
    const h = harness();
    h.write(`supabase/migrations/${PREFIX_VERSION}_duplicate.sql`, "select 1;");
    expect(() => loadReplayInputs(h.source)).toThrow("Duplicate migration version");
    const other = harness();
    other.write("supabase/migrations/20260831100000_unexpected.sql", "select 1;");
    expect(() => loadReplayInputs(other.source)).toThrow("predecessor/order");
  });

  it("rejects nonregular files and symlinked parent directories", () => {
    const h = harness();
    mkdirSync(join(h.source, "supabase/migrations/20260601000000_not_a_file.sql"));
    expect(() => loadReplayInputs(h.source)).toThrow("Not a regular file");
    const other = harness();
    const linkRoot = join(other.root, "linked-source");
    mkdirSync(linkRoot);
    symlinkSync(join(other.source, "supabase"), join(linkRoot, "supabase"), "junction");
    expect(() => loadReplayInputs(linkRoot)).toThrow("Symlinked migration directory");
  });

  it("rejects source drift before starting a database", async () => {
    const h = harness();
    h.write("supabase/migrations/20260701000000_initial.sql", "changed\n");
    await expect(executeReplay(h.options)).rejects.toThrow("Source files changed");
    expect(h.options.runProcess).not.toHaveBeenCalled();
    expect(readdirSync(h.tempRoot)).toEqual([]);
  });

  it.each(["../escaped.sql", "/absolute.sql", "C:\\outside.sql", "supabase/../../escaped.sql"])(
    "refuses injected copied path %s before writing outside the disposable root", async (path) => {
      const h = harness();
      const inputs = { ...h.inputs, fixture: { ...h.inputs.fixture, path } };
      await expect(executeReplay({ ...h.options, inputs })).rejects.toThrow("Copied file path");
      expect(h.options.runProcess).not.toHaveBeenCalled();
      expect(existsSync(join(h.tempRoot, "escaped.sql"))).toBe(false);
      expect(readdirSync(h.tempRoot)).toEqual([]);
    });

  it("requires exact ordered ledger JSON, not only matching count", () => {
    const rows = [{ version: "a" }, { version: "b" }];
    expect(() => assertExactLedger('["a","b"]', rows)).not.toThrow();
    for (const wrong of ['["b","a"]', '["a"]', '["a","b","fixture"]', '["a","a"]', "not-json"]) {
      expect(() => assertExactLedger(wrong, rows)).toThrow();
    }
  });
});

describe("mocked disposable database orchestration (NO database executed)", () => {
  it("replays prefix, fixture, suffix and all smokes with exact copies and owned cleanup", async () => {
    const h = harness({ afterCommand: (call) => {
      expect(existsSync(join(call.options.cwd, ".env.local"))).toBe(false);
      expect(existsSync(join(call.options.cwd, "supabase/.temp/project-ref"))).toBe(false);
      expect(call.config).not.toContain("REAL-PROJECT");
      expect(call.config).toContain("enabled = false");
      expect(readFileSync(join(call.options.cwd, "supabase/migrations/20260701000000_initial.sql"), "utf8"))
        .toBe("select 'raw bytes';\r\n");
    } });
    const result = await executeReplay(h.options);
    expect(result).toMatchObject({ status: "fixture-assisted-replay-passed", migrationCount: 4, productionEvidence: false, bareResetFixed: false });
    expect(h.calls.map((call) => call.label)).toEqual([
      "supabase-version", "psql-version", "db start", "db reset", "ledger",
      "stage1_identity_v3_prerequisite.sql", "migration up", "ledger",
      ...SMOKE_PATHS.map((path) => basename(path)), "ledger", "stop --project-id",
    ]);
    expect(h.calls.find((call) => call.label === "db start").migrationNames).toHaveLength(2);
    expect(h.calls.find((call) => call.label === "migration up").migrationNames).toHaveLength(4);
    const project = result.projectId;
    for (const call of h.calls) {
      expect(call.options.cwd).not.toBe(h.source);
      expect(call.options).toMatchObject({ shell: false, windowsHide: true });
      expect(call.args).not.toContain("--linked");
      expect(call.args).not.toContain("--db-url");
      expect(call.options.env).toMatchObject({ DOCKER_HOST: "unix:///var/run/docker.sock", PGAPPNAME: project, PGPASSWORD: "postgres" });
      for (const key of ["PGHOST", "DATABASE_URL", "SUPABASE_ACCESS_TOKEN", "DOCKER_CONTEXT", "NODE_OPTIONS", "HOME"]) {
        expect(call.options.env).not.toHaveProperty(key);
      }
      if (call.executable === "psql" && call.label !== "psql-version") {
        expect(call.args).toEqual(expect.arrayContaining(["--no-psqlrc", "--host=127.0.0.1", "--port=58001", "--set=ON_ERROR_STOP=1"]));
      }
    }
    expect(h.calls.at(-1).args).toEqual(["stop", "--project-id", project, "--no-backup", "--workdir", h.calls[0].options.cwd]);
    expect(readdirSync(h.tempRoot)).toEqual([]);
    expect(replayPlan(loadReplayInputs(h.source))).toEqual(replayPlan(h.inputs));
  });

  it.each(["db start", "db reset", "stage1_identity_v3_prerequisite.sql", "migration up", ...SMOKE_PATHS.map((path) => basename(path))])(
    "cleans its project after failure at %s including partial start", async (failAt) => {
      const h = harness({ failAt });
      await expect(executeReplay(h.options)).rejects.toThrow("failed");
      expect(h.calls.filter((call) => call.label === "stop --project-id")).toHaveLength(1);
      expect(readdirSync(h.tempRoot)).toEqual([]);
      expect(h.options.stdout.write).not.toHaveBeenCalled();
    });

  it("preserves recovery directory and primary error when its stop fails", async () => {
    const h = harness({ failAt: ["db reset", "stop --project-id"] });
    await expect(executeReplay(h.options)).rejects.toThrow(/Reset prefix failed.*Stop disposable database failed.*Preserved recovery workdir/);
    const [preserved] = readdirSync(h.tempRoot);
    expect(preserved).toMatch(/^awardping-fixture-replay-/);
    expect(existsSync(join(h.tempRoot, preserved, "supabase/config.toml"))).toBe(true);
    expect(h.options.stdout.write).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects wrong %s suffix-applied ledger and cleans up", async (suffixTarget) => {
    const h = harness({ mutateLedger: (rows, suffixApplied) => suffixApplied === suffixTarget ? [...rows, "synthetic-fixture"] : rows });
    await expect(executeReplay(h.options)).rejects.toThrow("ledger differs");
    expect(h.calls.at(-1).label).toBe("stop --project-id");
    expect(readdirSync(h.tempRoot)).toEqual([]);
  });

  it.each(["", "stage1_identity_v3_prerequisite_ok|wrong-hash\n", `${FIXTURE_SUCCESS_ROW}\nextra\n`, `${FIXTURE_SUCCESS_ROW}\n${FIXTURE_SUCCESS_ROW}\n`])(
    "rejects missing/wrong/extra fixture receipt %j before applying suffix", async (fixtureReceipt) => {
      const h = harness({ fixtureReceipt });
      await expect(executeReplay(h.options)).rejects.toThrow("exactly the committed success status and v3 hash");
      expect(h.calls.some((call) => call.label === "migration up")).toBe(false);
      expect(h.calls.at(-1).label).toBe("stop --project-id");
      expect(readdirSync(h.tempRoot)).toEqual([]);
    });

  it("detects copied-byte corruption before applying suffix", async () => {
    const h = harness({ afterCommand: (call) => {
      if (call.label === "stage1_identity_v3_prerequisite.sql") {
        writeFileSync(join(call.options.cwd, "supabase/migrations/20260701000000_initial.sql"), "corrupt\n");
      }
    } });
    await expect(executeReplay(h.options)).rejects.toThrow("Copied file drifted");
    expect(h.calls.some((call) => call.label === "migration up")).toBe(false);
    expect(h.calls.at(-1).label).toBe("stop --project-id");
  });

  it("fails closed on source changes even after otherwise successful smokes", async () => {
    const h = harness({ afterCommand: (call, context) => {
      if (call.label === "stop --project-id") context.write("supabase/config.toml", "[db]\nmajor_version = 17\n# drift\n");
    } });
    await expect(executeReplay(h.options)).rejects.toThrow("Source files drifted");
    expect(h.options.stdout.write).not.toHaveBeenCalled();
  });

  it("rejects CLI version mismatch before start and removes temporary files", async () => {
    const h = harness({ version: "2.109.2" });
    await expect(executeReplay(h.options)).rejects.toThrow("exactly 2.109.1");
    expect(h.calls.map((call) => call.label)).toEqual(["supabase-version"]);
    expect(readdirSync(h.tempRoot)).toEqual([]);
  });

  it("uses different disposable directories/project ids for separate runs", async () => {
    const first = harness();
    const second = harness();
    const results = await Promise.all([
      executeReplay({ ...first.options, uuid: undefined }), executeReplay({ ...second.options, uuid: undefined }),
    ]);
    expect(results[0].projectId).not.toBe(results[1].projectId);
    expect(first.calls[0].options.cwd).not.toBe(second.calls[0].options.cwd);
  });

  it.each([[54322, 58002], [58001, 58001], [58001.5, 58002]])("refuses unsafe ports %j", async (...ports) => {
    const h = harness();
    await expect(executeReplay({ ...h.options, choosePorts: async () => ports })).rejects.toThrow("Unsafe local replay ports");
    expect(h.calls).toEqual([]);
    expect(readdirSync(h.tempRoot)).toEqual([]);
  });
});

it("scrubs auth/service/remote process environment rather than merely overwriting PGHOST", () => {
  const env = localEnvironment({ PATH: "/bin", PGSERVICE: "prod", PGHOSTADDR: "1.2.3.4", PGOPTIONS: "bad",
    SUPABASE_DB_PASSWORD: "secret", AWS_SECRET_ACCESS_KEY: "secret", DOCKER_CERT_PATH: "/prod", ENV: "/startup" }, "/temporary", "test-id");
  expect(Object.keys(env).sort()).toEqual(["DOCKER_CONFIG", "DOCKER_HOST", "PATH", "PGAPPNAME", "PGCONNECT_TIMEOUT", "PGPASSFILE", "PGPASSWORD", "PGSERVICEFILE", "PGSSLMODE", "XDG_CONFIG_HOME", "XDG_DATA_HOME"].sort());
});

it("documents limits without changing the existing CI workflow or frozen migrations", () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const doc = readFileSync(join(repository, "docs/stage1-fixture-migration-smoke.md"), "utf8");
  expect(doc).toContain("bare `supabase db start` or full `supabase db reset`");
  expect(doc).toContain("not executed against PostgreSQL");
  expect(doc).toContain("--execute-disposable-local");
  expect(doc).toContain("Linux");
});
