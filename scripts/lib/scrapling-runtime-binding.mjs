import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

const digest = /^[0-9a-f]{64}$/;
const excluded = ["**/__pycache__/*.pyc", "**/__pycache__/*.pyo"];
const maxFiles = 100000;
const maxFileBytes = 512 * 1024 * 1024;
const maxTotalBytes = 2 * 1024 * 1024 * 1024;
const fail = reason => { throw new Error(`Scrapling runtime binding: ${reason}`); };
const hash = value => createHash("sha256").update(value).digest("hex");
const identity = value => process.platform === "win32" ? value.toLowerCase() : value;
const samePath = (a, b) => identity(a) === identity(b);
const generated = path => /(^|\/)__pycache__\/[^/]+\.py[co]$/.test(path);

function localPath(value) {
  if (typeof value !== "string" || !value || value.length > 32760 || !isAbsolute(value) ||
      /[\x00-\x1f<>"|?*]/.test(value) || value.startsWith("\\\\") || value.startsWith("//") ||
      (process.platform === "win32" && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(":")))) fail("invalid local path");
  const parts = value.slice(parse(value).root.length).split(/[\\/]/);
  if (parts.some(part => part === "." || part === ".." || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail("unsafe path component");
  return resolve(value);
}

function checkedPath(value, directory = false) {
  const full = localPath(value);
  let cursor = parse(full).root;
  const parts = full.slice(cursor.length).split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) fail("linked or invalid path");
  }
  const stat = lstatSync(full);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      !samePath(realpathSync(full), full)) fail("linked or invalid path");
  return full;
}

function boundedRead(path, limit) {
  const full = checkedPath(path);
  const stat = lstatSync(full);
  if (stat.size > limit) fail("metadata size limit");
  const fd = openSync(full, "r");
  try {
    const start = fstatSync(fd);
    if (start.size !== stat.size || start.dev !== stat.dev || start.ino !== stat.ino) fail("metadata identity changed");
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let total = 0;
    let count;
    while (total < buffer.length && (count = readSync(fd, buffer, total, buffer.length - total, null))) total += count;
    const end = fstatSync(fd);
    const current = lstatSync(full);
    if (total !== stat.size || end.size !== stat.size || end.mtimeMs !== start.mtimeMs || current.isSymbolicLink() ||
        current.ino !== start.ino || current.dev !== start.dev || current.mtimeMs !== start.mtimeMs) fail("metadata changed during verification");
    return buffer.subarray(0, total);
  } finally { closeSync(fd); }
}

function readJson(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("invalid JSON metadata"); }
}

function verifyFile(path, expected, budget) {
  if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > maxFileBytes ||
      !digest.test(expected.sha256)) fail("invalid file binding");
  budget.bytes += expected.bytes;
  if (budget.bytes > maxTotalBytes) fail("runtime byte limit");
  const full = checkedPath(path);
  const initial = lstatSync(full);
  if (initial.size !== expected.bytes) fail("file size mismatch");
  const fd = openSync(full, "r");
  try {
    const start = fstatSync(fd);
    if (!start.isFile() || start.size !== expected.bytes || start.dev !== initial.dev || start.ino !== initial.ino) fail("file identity changed");
    const sha = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) {
      total += count;
      if (total > expected.bytes) fail("file changed during verification");
      sha.update(buffer.subarray(0, count));
    }
    const end = fstatSync(fd);
    const current = lstatSync(full);
    if (total !== expected.bytes || sha.digest("hex") !== expected.sha256 || current.isSymbolicLink() ||
        current.dev !== start.dev || current.ino !== start.ino || current.size !== start.size ||
        end.size !== start.size || end.mtimeMs !== start.mtimeMs || current.mtimeMs !== start.mtimeMs) fail("file integrity mismatch");
  } finally { closeSync(fd); }
}

function verifyInventory(runtimeRoot, entries, budget) {
  if (!Array.isArray(entries) || !entries.length || entries.length > maxFiles) fail("invalid runtime inventory");
  const expected = new Map();
  for (const entry of entries) {
    if (typeof entry?.path !== "string" || !entry.path || entry.path.includes("\\") || entry.path.includes(":") ||
        entry.path.startsWith("/") || entry.path.split("/").some(part => !part || part === "." || part === "..") ||
        entry.path === "runtime-receipt.json" || generated(entry.path) || expected.has(identity(entry.path))) fail("invalid inventory path");
    expected.set(identity(entry.path), entry);
  }
  for (const required of ["Scripts/python.exe", "requirements.txt", "pyvenv.cfg"]) {
    if (!expected.has(identity(required))) fail("required runtime file missing from receipt");
  }
  const queue = [runtimeRoot];
  let observed = 0;
  let nodes = 0;
  while (queue.length) {
    const directory = queue.pop();
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (++nodes > maxFiles * 2) fail("runtime entry limit");
      const full = join(directory, item.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) fail("linked runtime entry");
      if (stat.isDirectory()) { queue.push(full); continue; }
      if (!stat.isFile()) fail("invalid runtime entry");
      const path = full.slice(runtimeRoot.length + 1).split(sep).join("/");
      if (path === "runtime-receipt.json" || generated(path)) continue;
      const entry = expected.get(identity(path));
      if (!entry || entry.path !== path || ++observed > maxFiles) fail("unexpected runtime file");
      verifyFile(full, entry, budget);
    }
  }
  if (observed !== expected.size) fail("runtime inventory incomplete");
}

function verifyPins(bytes, packages) {
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) fail("invalid package inventory");
  const pins = new Map();
  for (const line of bytes.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim())) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[A-Za-z0-9_,.-]+\])?==([0-9][A-Za-z0-9.!+_-]*)$/.exec(line);
    const name = match?.[1].toLowerCase().replace(/[-_.]+/g, "-");
    if (!match || pins.has(name)) fail("invalid dependency pins");
    pins.set(name, match[2]);
    if (packages[name] !== match[2]) fail("package pin mismatch");
  }
  if (!pins.has("scrapling") || Object.keys(packages).some(name => !pins.has(name) && !["pip", "setuptools", "wheel"].includes(name))) fail("unexpected package inventory");
}

/** Verify the installer-produced binding before opting in. No process/network activity.
 * The app binding is the trust anchor, not a signature: protect it like worker code.
 * This checks a startup snapshot, not continued integrity after verification returns.
 * Receipt scope excludes generated bytecode and does not cover the full base stdlib.
 */
export function verifyScraplingRuntimeBinding({ appDir, manifestPath, pythonPath } = {}) {
  if (!manifestPath && !pythonPath) return null;
  if (!manifestPath || !pythonPath) fail("both manifest and interpreter are required");
  const app = checkedPath(appDir, true);
  const bindingPath = join(app, ".awardping-scrapling-runtime.json");
  const bindingBytes = boundedRead(bindingPath, 65536);
  const binding = readJson(bindingBytes);
  const manifest = checkedPath(manifestPath);
  const python = checkedPath(pythonPath);
  if (!samePath(manifest, join(app, ".awardping-scrapling-manifest.json")) || binding.schema !== "awardping.scrapling-installation.v1" ||
      !digest.test(binding.manifest_sha256) || !digest.test(binding.requirements_sha256) || !digest.test(binding.receipt_sha256) ||
      !Number.isInteger(binding.source_count) || binding.source_count < 1 || binding.source_count > 300) fail("invalid installation binding");
  const requirementsPath = join(app, "scripts", "scrapling", "requirements.txt");
  const requirements = boundedRead(requirementsPath, 65536);
  if (hash(requirements) !== binding.requirements_sha256) fail("application requirements mismatch");
  const runtimeRoot = checkedPath(join(dirname(app), "runtime", `scrapling-${binding.requirements_sha256}`), true);
  const receiptPath = join(runtimeRoot, "runtime-receipt.json");
  if (!samePath(localPath(binding.runtime_root), runtimeRoot) || !samePath(localPath(binding.python_executable), python) ||
      !samePath(python, join(runtimeRoot, "Scripts", "python.exe")) || !samePath(localPath(binding.receipt_path), receiptPath)) fail("interpreter or runtime identity mismatch");
  const manifestBytes = boundedRead(manifest, 256 * 1024);
  const sourceManifest = readJson(manifestBytes);
  if (hash(manifestBytes) !== binding.manifest_sha256 || sourceManifest?.schema !== "awardping.scrapling-source-manifest.v1" ||
      sourceManifest.profile !== "scrapling-evidence-v1" || !Array.isArray(sourceManifest.sources) ||
      sourceManifest.sources.length !== binding.source_count) fail("source manifest binding mismatch");
  const receiptBytes = boundedRead(receiptPath, 32 * 1024 * 1024);
  if (hash(receiptBytes) !== binding.receipt_sha256) fail("runtime receipt hash mismatch");
  const receipt = readJson(receiptBytes);
  if (receipt?.schema !== "awardping.scrapling-runtime.v1" || receipt.requirements_sha256 !== binding.requirements_sha256 ||
      !samePath(localPath(receipt.runtime_root), runtimeRoot) || !samePath(localPath(receipt.python_executable), python) ||
      !/^3\.(?:1[0-9]|[2-9][0-9])\.\d+$/.test(receipt.python_version) ||
      JSON.stringify(receipt.excluded_generated_files) !== JSON.stringify(excluded)) fail("runtime receipt identity mismatch");
  const runtimeRequirements = boundedRead(join(runtimeRoot, "requirements.txt"), 65536);
  if (!runtimeRequirements.equals(requirements)) fail("runtime requirements mismatch");
  verifyPins(requirements, receipt.packages);
  const basePython = checkedPath(receipt.base_python_executable);
  const config = boundedRead(join(runtimeRoot, "pyvenv.cfg"), 65536).toString("utf8");
  const homes = [...config.matchAll(/^home\s*=\s*(.+?)\s*$/gm)];
  const isolation = [...config.matchAll(/^include-system-site-packages\s*=\s*(.+?)\s*$/gim)];
  if (isolation.length !== 1 || isolation[0][1].toLowerCase() !== "false" || homes.length !== 1 ||
      !samePath(localPath(homes[0][1]), dirname(basePython))) fail("runtime isolation mismatch");
  if (!Array.isArray(receipt.base_files) || receipt.base_files.length < 1 || receipt.base_files.length > 3) fail("invalid base inventory");
  const basePaths = new Set();
  const allowedBaseNames = [basename(basePython), "python3.dll", `python${receipt.python_version.split(".").slice(0, 2).join("")}.dll`];
  const budget = { bytes: 0 };
  for (const entry of receipt.base_files) {
    const path = checkedPath(entry.path);
    if (!samePath(dirname(path), dirname(basePython)) || !allowedBaseNames.includes(basename(path)) || basePaths.has(identity(path))) fail("invalid base dependency");
    basePaths.add(identity(path));
    verifyFile(path, entry, budget);
  }
  if (!basePaths.has(identity(basePython))) fail("base interpreter absent from receipt");
  verifyInventory(runtimeRoot, receipt.files, budget);
  for (const [path, initial] of [[bindingPath, bindingBytes], [manifest, manifestBytes], [receiptPath, receiptBytes], [requirementsPath, requirements]]) {
    if (!boundedRead(path, initial.length).equals(initial)) fail("binding changed during verification");
  }
  return Object.freeze({ manifestPath: manifest, pythonPath: python, runtimeRoot, receiptPath,
    manifestSha256: binding.manifest_sha256, requirementsSha256: binding.requirements_sha256,
    receiptSha256: binding.receipt_sha256, sourceCount: binding.source_count,
    verifiedFiles: receipt.files.length + receipt.base_files.length, verifiedBytes: budget.bytes });
}
