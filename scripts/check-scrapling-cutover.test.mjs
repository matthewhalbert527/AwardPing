import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkScraplingCutover, main } from "./check-scrapling-cutover.mjs";

const roots = [];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "awardping-cutover-preflight-test-")); roots.push(root);
  const appDir = join(root, "app"), requirements = "scrapling==0.4.15\n";
  const requirementsHash = hash(requirements);
  const runtime = join(root, "runtime", `scrapling-${requirementsHash}`);
  const pythonPath = join(runtime, "Scripts", "python.exe"), base = join(root, "base", "python.exe");
  const manifestPath = join(appDir, ".awardping-scrapling-manifest.json");
  const bindingPath = join(appDir, ".awardping-scrapling-runtime.json");
  const receiptPath = join(runtime, "runtime-receipt.json");
  const put = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
  const json = (path, value) => put(path, JSON.stringify(value));
  const inventory = (path, name = path) => { const bytes = readFileSync(path); return { path: name, bytes: bytes.length, sha256: hash(bytes) }; };
  const awardIds = Array.from({ length: 25 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  const manifest = {
    schema: "awardping.scrapling-source-manifest.v1", profile: "scrapling-evidence-v1",
    reviewed_at: "2026-10-17T12:00:00Z", award_ids: awardIds,
    sources: [{ id: "10000000-0000-4000-8000-000000000000", award_id: awardIds[0],
      url: "https://example.edu/award", kind: "html", roles: ["eligibility"] }],
  };
  put(join(appDir, "scripts", "scrapling", "requirements.txt"), requirements);
  put(base, "not executable - fixture only"); put(pythonPath, "not executable - fixture only");
  put(join(runtime, "requirements.txt"), requirements);
  put(join(runtime, "pyvenv.cfg"), `home = ${dirname(base)}\ninclude-system-site-packages = false\n`);
  json(manifestPath, manifest);
  const receipt = {
    schema: "awardping.scrapling-runtime.v1", runtime_root: runtime,
    requirements_sha256: requirementsHash, python_executable: pythonPath, python_version: "3.12.14",
    base_python_executable: base, packages: { scrapling: "0.4.15" }, base_files: [inventory(base)],
    files: ["Scripts/python.exe", "requirements.txt", "pyvenv.cfg"].map(name => inventory(join(runtime, name), name)),
    excluded_generated_files: ["**/__pycache__/*.pyc", "**/__pycache__/*.pyo"],
  };
  json(receiptPath, receipt);
  const binding = { schema: "awardping.scrapling-installation.v1", source_count: 1,
    manifest_sha256: hash(readFileSync(manifestPath)), requirements_sha256: requirementsHash,
    python_executable: pythonPath, runtime_root: runtime, receipt_path: receiptPath,
    receipt_sha256: hash(readFileSync(receiptPath)) };
  json(bindingPath, binding);
  return { options: { appDir, manifestPath, pythonPath }, manifest, binding, bindingPath, json,
    resealManifest: () => { json(manifestPath, manifest); binding.manifest_sha256 = hash(readFileSync(manifestPath)); json(bindingPath, binding); } };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const full = resolve(root);
    if (!full.startsWith(resolve(tmpdir()) + sep) || !basename(full).startsWith("awardping-cutover-preflight-test-")) throw new Error("Unsafe fixture cleanup");
    rmSync(full, { recursive: true });
  }
});

describe("read-only local Scrapling cutover preflight", () => {
  it("verifies real local bindings without executing fake Python or authorizing activation", () => {
    const f = fixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Unexpected network access"); });
    const before = readFileSync(f.options.manifestPath);
    const result = checkScraplingCutover(f.options);
    expect(result).toMatchObject({ status: "local_binding_verified_not_ready_for_cutover",
      production_ready: false, activation_authorized: false, external_actions: 0,
      source_manifest: { source_count: 1, selected_award_count: 1, declared_award_count: 25, live_approval_verified: false },
      verified_local_binding: { sourceCount: 1, verifiedFiles: 4 } });
    expect(result.remaining_gates).toHaveLength(6);
    expect(readFileSync(f.options.manifestPath).equals(before)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects invalid source identities even if the local receipt matches their bytes", () => {
    const f = fixture(); f.manifest.sources[0].url = "http://127.0.0.1/"; f.resealManifest();
    expect(() => checkScraplingCutover(f.options)).toThrow();
  });
  it("rejects runtime tampering before reporting local binding verification", () => {
    const f = fixture(); writeFileSync(f.options.pythonPath, "modified");
    expect(() => checkScraplingCutover(f.options)).toThrow("file size mismatch");
  });
  it("rejects receipt hash mismatches", () => {
    const f = fixture(); f.binding.receipt_sha256 = "0".repeat(64); f.json(f.bindingPath, f.binding);
    expect(() => checkScraplingCutover(f.options)).toThrow("receipt hash mismatch");
  });
  it.each([undefined, {}, { appDir: ".", manifestPath: "manifest.json", pythonPath: "python.exe" }])(
    "requires all three explicit absolute paths: %j", options => {
      expect(() => checkScraplingCutover(options)).toThrow("Explicit absolute");
    },
  );
  it("prints JSON with independent missing gates when invoked through the CLI entrypoint", () => {
    const f = fixture(), log = vi.spyOn(console, "log").mockImplementation(() => {});
    main(["--app-dir", f.options.appDir, "--manifest", f.options.manifestPath, "--python", f.options.pythonPath]);
    expect(JSON.parse(log.mock.calls[0][0]).production_ready).toBe(false);
  });
  it.each([["--apply"], ["--env", "secret.env"], ["--app-dir", "one", "--app-dir", "two"], ["--python"]])(
    "rejects unsupported, duplicate or incomplete arguments: %j", args => {
      expect(() => main(args)).toThrow("Usage:");
    },
  );
  it("prints help without reading installation or credentials", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    main(["--help"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("No credentials, network, Python execution"));
  });
});
