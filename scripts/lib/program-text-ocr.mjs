import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hash = value => createHash("sha256").update(value).digest("hex");
const fail = reason => { throw Object.assign(new Error(`Program text OCR: ${reason}`), { code: `program_text_ocr_${reason}` }); };
const bridge = fileURLToPath(new URL("../program-text-ocr-windows.ps1", import.meta.url));
async function regular(file, maxBytes) {
  const stat = await fs.lstat(file);
  const key = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes || key(await fs.realpath(file)) !== key(file)) fail("invalid_tool_or_output");
  const bytes = await fs.readFile(file);
  if (bytes.length !== stat.size) fail("file_changed");
  return bytes;
}
function command(program, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATH"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    env.PSModulePath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules");
    const child = spawn(program, args, { windowsHide: true, shell: false, env, stdio: ["ignore", "pipe", "pipe"] });
    let parts = [], size = 0, stopped = false, killing;
    const stop = () => {
      stopped = true;
      if (killing || !child.pid) return;
      killing = process.platform === "win32" ? new Promise(done => {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => { child.kill(); done(); }); killer.once("close", done);
      }) : Promise.resolve(child.kill("SIGKILL"));
    };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.on("data", bytes => { size += bytes.length; if (size > 4 * 1024 * 1024) { parts = []; stop(); } else if (!stopped) parts.push(bytes); });
    child.stderr.on("data", () => {});
    child.once("error", () => { clearTimeout(timer); reject(new Error("Program text OCR tool failed")); });
    child.once("close", async code => { clearTimeout(timer); await killing;
      if (stopped || code !== 0) reject(new Error("Program text OCR tool failed"));
      else resolve(Buffer.concat(parts).toString("utf8").replace(/^\uFEFF/, "")); });
  });
}

/** Images exist only in this private temporary extraction directory and never leave it.
 * Windows OCR has no calibrated confidence/reading-order guarantee, so its text
 * is explicitly incomplete and cannot by itself approve a program update. */
export async function extractProgramTextPdfOcr(bytes, { pdf_sha256, timeoutMs = 90_000, popplerDirectory, tempRoot,
  powershellPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") } = {}) {
  if (process.platform !== "win32" || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 20 * 1024 * 1024 ||
      hash(bytes) !== pdf_sha256 || !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) fail("invalid_input");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !path.isAbsolute(popplerDirectory || "") || !path.isAbsolute(tempRoot || "")) fail("runtime_not_configured");
  const root = await fs.realpath(tempRoot), rootStat = await fs.lstat(tempRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("invalid_temporary_root");
  const programs = { pdfinfo: path.join(popplerDirectory, "pdfinfo.exe"), renderer: path.join(popplerDirectory, "pdftoppm.exe"), powershell: powershellPath, bridge };
  const pins = {};
  for (const [key, file] of Object.entries(programs)) pins[key] = hash(await regular(file, 100 * 1024 * 1024));
  const directory = await fs.mkdtemp(path.join(root, "program-text-ocr-"));
  const deadline = Date.now() + timeoutMs;
  const run = (program, args) => {
    const remaining = deadline - Date.now(); if (remaining < 1) fail("deadline");
    return command(program, args, Math.min(30_000, remaining));
  };
  try {
    if (process.platform === "win32") {
      const acl = await run(programs.powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", bridge, "-ProtectDirectory", directory]);
      if (acl.trim() !== "private") fail("private_directory_failed");
    }
    const pdf = path.join(directory, "source.pdf"); await fs.writeFile(pdf, bytes, { flag: "wx", mode: 0o600 });
    const info = await run(programs.pdfinfo, ["-enc", "UTF-8", pdf]);
    const match = /^Pages:\s+(\d+)\s*$/m.exec(info), total = Number(match?.[1]);
    if (!Number.isInteger(total) || total < 1 || total > 25 || /^Encrypted:\s+yes\b/m.test(info)) fail("unsupported_page_count_or_encryption");
    const pages = []; let engine = null;
    for (let page = 1; page <= total; page++) {
      const prefix = path.join(directory, `page-${page}`), png = `${prefix}.png`;
      await run(programs.renderer, ["-f", String(page), "-l", String(page), "-r", "144", "-scale-to", "2200", "-singlefile", "-png", pdf, prefix]);
      const image = await regular(png, 20 * 1024 * 1024), imageSha = hash(image);
      if (image.length < 24 || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail("invalid_internal_raster");
      const result = JSON.parse(await run(programs.powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", bridge, "-ImagePath", png]));
      if (result.schema !== "awardping.program-text-windows-ocr.v1" || result.image_sha256 !== imageSha || typeof result.text !== "string" || result.text.length > 100_000 ||
          result.engine !== "Windows.Media.Ocr" || typeof result.engine_version !== "string" || !/^[a-f0-9]{64}$/.test(result.engine_sha256 || "") ||
          result.confidence !== null || result.reading_order_verified !== false || hash(await regular(png, 20 * 1024 * 1024)) !== imageSha) fail("invalid_ocr_result");
      const currentEngine = `${result.engine_version}:${result.engine_sha256}`;
      if (engine && engine !== currentEngine) fail("ocr_engine_changed");
      engine = currentEngine;
      pages.push({ num: page, text: result.text, reading_order_verified: false });
      await fs.unlink(png);
    }
    if (hash(await regular(pdf, 20 * 1024 * 1024)) !== pdf_sha256) fail("original_changed");
    for (const [key, file] of Object.entries(programs)) if (hash(await regular(file, 100 * 1024 * 1024)) !== pins[key]) fail("tool_changed");
    return { total, pages, pdf_sha256, engine_version: engine };
  } finally {
    const actual = await fs.realpath(directory), relative = path.relative(root, actual);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(actual) !== root || !path.basename(actual).startsWith("program-text-ocr-")) fail("cleanup_target_invalid");
    await fs.rm(actual, { recursive: true, force: false });
  }
}
