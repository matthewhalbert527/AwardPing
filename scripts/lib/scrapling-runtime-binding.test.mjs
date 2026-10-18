import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyScraplingRuntimeBinding } from "./scrapling-runtime-binding.mjs";

const fixtures = [];
const hash = value => createHash("sha256").update(value).digest("hex");
const json = (path, value) => writeFileSync(path, JSON.stringify(value));
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const inventory = (path, name) => { const bytes = readFileSync(path); return { path: name, bytes: bytes.length, sha256: hash(bytes) }; };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "awardping-runtime-binding-test-"));
  fixtures.push(root);
  const appDir = join(root, "app");
  const requirements = Buffer.from("scrapling[fetchers]==0.4.15\nplaywright==1.64.0\n");
  const requirementsHash = hash(requirements);
  const runtimeRoot = join(root, "runtime", `scrapling-${requirementsHash}`);
  const pythonPath = join(runtimeRoot, "Scripts", "python.exe");
  const basePython = join(root, "base-python", "python.exe");
  const manifestPath = join(appDir, ".awardping-scrapling-manifest.json");
  const bindingPath = join(appDir, ".awardping-scrapling-runtime.json");
  const receiptPath = join(runtimeRoot, "runtime-receipt.json");
  put(join(appDir, "scripts", "scrapling", "requirements.txt"), requirements);
  put(basePython, "fake interpreter; never executed");
  put(join(dirname(basePython), "python312.dll"), "fake DLL; never loaded");
  put(pythonPath, "fake venv launcher; never executed");
  put(join(runtimeRoot, "requirements.txt"), requirements);
  put(join(runtimeRoot, "pyvenv.cfg"), `home = ${dirname(basePython)}\ninclude-system-site-packages = false\nversion = 3.12.14\n`);
  put(join(runtimeRoot, "Lib", "site-packages", "scrapling", "__init__.py"), "# fake source; never imported\n");
  const manifest = { schema: "awardping.scrapling-source-manifest.v1", profile: "scrapling-evidence-v1", sources: [{ id: "scope checked by the separate source manifest validator" }] };
  json(manifestPath, manifest);
  const fileNames = ["Scripts/python.exe", "requirements.txt", "pyvenv.cfg", "Lib/site-packages/scrapling/__init__.py"];
  const receipt = { schema: "awardping.scrapling-runtime.v1", runtime_root: runtimeRoot,
    requirements_sha256: requirementsHash, python_executable: pythonPath, python_version: "3.12.14",
    base_python_executable: basePython, packages: { scrapling: "0.4.15", playwright: "1.64.0", pip: "25.0.1" },
    base_files: [inventory(basePython, basePython), inventory(join(dirname(basePython), "python312.dll"), join(dirname(basePython), "python312.dll"))],
    files: fileNames.map(name => inventory(join(runtimeRoot, name), name)),
    excluded_generated_files: ["**/__pycache__/*.pyc", "**/__pycache__/*.pyo"] };
  json(receiptPath, receipt);
  const binding = { schema: "awardping.scrapling-installation.v1", manifest_sha256: hash(readFileSync(manifestPath)),
    source_count: 1, requirements_sha256: requirementsHash, python_executable: pythonPath, runtime_root: runtimeRoot,
    receipt_path: receiptPath, receipt_sha256: hash(readFileSync(receiptPath)) };
  json(bindingPath, binding);
  const seal = () => { json(receiptPath, receipt); binding.receipt_sha256 = hash(readFileSync(receiptPath)); json(bindingPath, binding); };
  return { root, appDir, runtimeRoot, pythonPath, basePython, manifestPath, bindingPath, receiptPath, receipt, binding, seal,
    verify: overrides => verifyScraplingRuntimeBinding({ appDir, manifestPath, pythonPath, ...overrides }) };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    const full = resolve(root);
    if (!full.startsWith(resolve(tmpdir()) + sep) || !basename(full).startsWith("awardping-runtime-binding-test-")) throw new Error("Unsafe fixture cleanup");
    rmSync(full, { recursive: true, force: true });
  }
});

describe("Scrapling runtime startup binding", () => {
  it("stays completely off without both configured opt-ins, without reading paths", () => {
    expect(verifyScraplingRuntimeBinding()).toBeNull();
    expect(verifyScraplingRuntimeBinding({ appDir: "does-not-exist" })).toBeNull();
    expect(() => verifyScraplingRuntimeBinding({ manifestPath: "configured" })).toThrow("both manifest and interpreter");
    expect(() => verifyScraplingRuntimeBinding({ pythonPath: "configured" })).toThrow("both manifest and interpreter");
  });

  it("verifies a complete installer-shaped receipt without executing the fake interpreter", () => {
    const f = fixture();
    const result = f.verify();
    expect(result).toMatchObject({ manifestPath: f.manifestPath, pythonPath: f.pythonPath, runtimeRoot: f.runtimeRoot,
      receiptPath: f.receiptPath, sourceCount: 1, verifiedFiles: 6, requirementsSha256: f.binding.requirements_sha256 });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects a different configured interpreter even if its bytes match", () => {
    const f = fixture();
    const other = join(f.root, "other-python.exe");
    put(other, readFileSync(f.pythonPath));
    expect(() => f.verify({ pythonPath: other })).toThrow("identity mismatch");
  });

  it("requires the fixed app-local manifest, not a same-byte alternative", () => {
    const f = fixture();
    const other = join(f.root, "manifest.json");
    put(other, readFileSync(f.manifestPath));
    expect(() => f.verify({ manifestPath: other })).toThrow("installation binding");
  });

  it.each(["manifest_sha256", "requirements_sha256", "receipt_sha256"])("rejects changed %s", field => {
    const f = fixture();
    f.binding[field] = "0".repeat(64); json(f.bindingPath, f.binding);
    expect(() => f.verify()).toThrow();
  });

  it.each(["schema", "source_count", "python_executable", "runtime_root", "receipt_path"])("rejects changed installation %s", field => {
    const f = fixture();
    f.binding[field] = field === "source_count" ? 2 : "invalid"; json(f.bindingPath, f.binding);
    expect(() => f.verify()).toThrow();
  });

  it("detects modified manifest raw bytes independently of equivalent JSON", () => {
    const f = fixture();
    writeFileSync(f.manifestPath, `${readFileSync(f.manifestPath, "utf8")}\n`);
    expect(() => f.verify()).toThrow("manifest binding mismatch");
  });

  it("detects modified receipt before trusting its inventory", () => {
    const f = fixture();
    f.receipt.files[0].sha256 = "0".repeat(64); json(f.receiptPath, f.receipt);
    expect(() => f.verify()).toThrow("receipt hash mismatch");
  });

  it.each(["Scripts/python.exe", "Lib/site-packages/scrapling/__init__.py"])("detects same-size tampering with %s", name => {
    const f = fixture();
    const file = join(f.runtimeRoot, name);
    writeFileSync(file, Buffer.alloc(readFileSync(file).length, 88));
    expect(() => f.verify()).toThrow("file integrity mismatch");
  });

  it("detects base interpreter/DLL tampering", () => {
    const f = fixture();
    put(join(dirname(f.basePython), "python312.dll"), "different");
    expect(() => f.verify()).toThrow("file size mismatch");
  });

  it("detects missing and unexpected runtime files", () => {
    const f = fixture();
    rmSync(join(f.runtimeRoot, "Lib/site-packages/scrapling/__init__.py"));
    expect(() => f.verify()).toThrow("inventory incomplete");
    put(join(f.runtimeRoot, "unexpected.py"), "not in receipt");
    expect(() => f.verify()).toThrow("unexpected runtime file");
  });

  it("matches the receipt's explicit generated-cache exclusion, not arbitrary Python files", () => {
    const f = fixture();
    put(join(f.runtimeRoot, "Lib/site-packages/scrapling/__pycache__/__init__.cpython-312.pyc"), "generated cache");
    expect(f.verify().verifiedFiles).toBe(6);
    put(join(f.runtimeRoot, "Lib/site-packages/scrapling/__pycache__/payload.py"), "not generated bytecode");
    expect(() => f.verify()).toThrow("unexpected runtime file");
  });

  it.each(["../outside", "/absolute", "Scripts\\python.exe", "Scripts/python.exe:stream", "a//b", "a/./b", "runtime-receipt.json"])("rejects unsafe inventory entry %s", path => {
    const f = fixture();
    f.receipt.files.push({ path, bytes: 0, sha256: hash("") }); f.seal();
    expect(() => f.verify()).toThrow("inventory path");
  });

  it("rejects duplicate inventory paths and omitted required launcher", () => {
    const f = fixture();
    f.receipt.files.push({ ...f.receipt.files[0] }); f.seal();
    expect(() => f.verify()).toThrow("inventory path");
    f.receipt.files = f.receipt.files.filter(entry => entry.path !== "Scripts/python.exe"); f.seal();
    expect(() => f.verify()).toThrow("required runtime file");
  });

  it.each(["schema", "requirements_sha256", "python_executable", "runtime_root", "python_version"])("rejects receipt identity %s mismatch", field => {
    const f = fixture();
    f.receipt[field] = "invalid"; f.seal();
    expect(() => f.verify()).toThrow();
  });

  it("rejects unpinned packages and mismatched package versions", () => {
    const f = fixture();
    f.receipt.packages.scrapling = "0.4.14"; f.seal();
    expect(() => f.verify()).toThrow("package pin mismatch");
    f.receipt.packages.scrapling = "0.4.15"; f.receipt.packages.extra = "1.0"; f.seal();
    expect(() => f.verify()).toThrow("unexpected package inventory");
  });

  it("rejects weakened generated-file exclusions", () => {
    const f = fixture();
    f.receipt.excluded_generated_files.push("**/*.py"); f.seal();
    expect(() => f.verify()).toThrow("receipt identity mismatch");
  });

  it("checks both app and copied requirements bytes", () => {
    const f = fixture();
    put(join(f.runtimeRoot, "requirements.txt"), "scrapling==0.0.0\n");
    expect(() => f.verify()).toThrow("runtime requirements mismatch");
    put(join(f.appDir, "scripts/scrapling/requirements.txt"), "scrapling==0.0.0\n");
    expect(() => f.verify()).toThrow("application requirements mismatch");
  });

  it.each(["true", "false\ninclude-system-site-packages = true"])("rejects unsafe venv isolation %s", value => {
    const f = fixture();
    const path = join(f.runtimeRoot, "pyvenv.cfg");
    put(path, `home = ${dirname(f.basePython)}\ninclude-system-site-packages = ${value}\n`);
    f.receipt.files = f.receipt.files.map(entry => entry.path === "pyvenv.cfg" ? inventory(path, entry.path) : entry); f.seal();
    expect(() => f.verify()).toThrow("isolation mismatch");
  });

  it("rejects receipt-declared base dependencies outside the base Python directory", () => {
    const f = fixture();
    const extra = join(f.root, "elsewhere", "python3.dll"); put(extra, "fake");
    f.receipt.base_files.push(inventory(extra, extra)); f.seal();
    expect(() => f.verify()).toThrow("base dependency");
  });

  it("rejects path traversal and Windows device/alternate-stream paths before reading", () => {
    const f = fixture();
    for (const path of [join(f.appDir, "x") + sep + ".." + sep + ".awardping-scrapling-manifest.json", "relative", "\\\\host\\share\\manifest", "C:\\temp\\NUL", "C:\\temp\\file:stream"]) {
      expect(() => f.verify({ manifestPath: path })).toThrow();
    }
  });

  it("rejects a linked directory in the runtime, including generated-cache locations", () => {
    const f = fixture();
    const external = join(f.root, "outside"); mkdirSync(external);
    symlinkSync(external, join(f.runtimeRoot, "__pycache__"), process.platform === "win32" ? "junction" : "dir");
    expect(() => f.verify()).toThrow("linked runtime entry");
  });

  it("rejects a linked parent app directory", () => {
    const f = fixture();
    const linked = join(f.root, "linked-app");
    symlinkSync(f.appDir, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => f.verify({ appDir: linked })).toThrow("linked or invalid path");
  });

  it("rejects oversized metadata before parsing it", () => {
    const f = fixture();
    writeFileSync(f.bindingPath, Buffer.alloc(65537, 32));
    expect(() => f.verify()).toThrow("metadata size limit");
  });
});
