import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";

export const scraplingBaselineTransitionSchema = "awardping.scrapling-baseline-transition.v1";
const profile = "scrapling-evidence-v2";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const sha = value => createHash("sha256").update(value).digest("hex");
const loaded = new WeakSet();
const slots = ["meta", "text", "html", "page", "thumb"];
const limits = { meta: 16 * 1024 ** 2, text: 6 * 1024 ** 2 + 1, html: 8 * 1024 ** 2, page: 32 * 1024 ** 2, thumb: 8 * 1024 ** 2 };
export class ScraplingBaselineTransitionError extends Error {
  constructor(reason) { super(`Scrapling baseline transition held: ${reason}`); this.name = "ScraplingBaselineTransitionError"; this.scraplingBaselineTransitionHold = true; }
}
const fail = reason => { throw new ScraplingBaselineTransitionError(reason); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const at = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const url = value => { try { const u = new URL(value); return typeof value === "string" && u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.port && u.href === value; } catch { return false; } };
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const decode = bytes => { try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (!Buffer.from(text).equals(bytes)) fail("UTF-8 framing"); return text; } catch { fail("UTF-8 framing"); } };
const pageType = value => value === null || (typeof value === "string" && value.length > 0 && value.length <= 80 && value !== "pdf");
const identity = (source, row) => source?.id === row.source_id && source.shared_award_id === row.stored_owner_id && source.url === row.url && (source.page_type ?? null) === row.page_type;
const crossing = (baseline, captureProfile) => Boolean(baseline && captureProfile === profile && baseline.capture_profile !== captureProfile);
const approvals = source => JSON.stringify([source.source, source.admin_review_status, source.page_metadata, source.reason, source.admin_review_note, source.admin_reviewed_by, source.admin_reviewed_at, source.page_metadata_generated_at, source.page_metadata_model]);

// Every read is regular, bounded and checked before/after through the same
// handle. No symlink/junction ancestor or unbounded readFile follows a path.
function readRegular(path, maximum) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.length > 32760) fail("absolute reference path required");
  path = resolve(path);
  const check = () => {
    for (let current = dirname(path); ; current = dirname(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("linked reference ancestor");
      if (dirname(current) === current) break;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) fail("reference file type/size");
    return stat;
  };
  const before = check(); const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) fail("reference changed before read");
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) fail("short reference read"); offset += count; }
    const after = fstatSync(fd); const pathAfter = check();
    if ([after, pathAfter].some(stat => stat.size !== opened.size || stat.dev !== opened.dev || stat.ino !== opened.ino || stat.mtimeMs !== opened.mtimeMs || stat.ctimeMs !== opened.ctimeMs)) fail("reference changed during read");
    return bytes;
  } finally { closeSync(fd); }
}

/** SHA-bound evidence, NOT source approval, factual acceptance or permission to migrate.
 * The JSON is exactly JSON.stringify(value, null, 2) + LF (also rejects duplicate keys).
 * Five raw references are retained; only full text/native text, NOT unstable HTML
 * attribute ordering or pixels, are required equal in a later capture.
 */
export function loadScraplingBaselineTransition({ path, sha256 } = {}) {
  try { return loadReference(path, sha256); } catch (error) { if (error instanceof ScraplingBaselineTransitionError) throw error; fail("reference file unavailable or invalid"); }
}
function loadReference(path, sha256) {
  if (typeof sha256 !== "string" || !digest.test(sha256)) fail("explicit file SHA256 required");
  const bytes = readRegular(path, 2 * 1024 ** 2);
  if (sha(bytes) !== sha256) fail("pin file SHA256 mismatch");
  const text = decode(bytes); let value;
  try { value = JSON.parse(text); } catch { fail("pin JSON"); }
  if (JSON.stringify(value, null, 2) + "\n" !== text || !exact(value, ["schema", "sources"]) || value.schema !== scraplingBaselineTransitionSchema || !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 25) fail("pin schema/canonical JSON");
  const ids = new Set(); const paths = new Set(); let total = bytes.length;
  for (const row of value.sources) {
    if (!exact(row, ["source_id", "stored_owner_id", "url", "page_type", "old_baseline", "target_profile", "reference_captured_at", "review_text_sha256", "native_visible_text_sha256", "reference_artifacts"]) || !uuid.test(row.source_id) || !uuid.test(row.stored_owner_id) || ids.has(row.source_id) || !url(row.url) || !pageType(row.page_type) || row.target_profile !== profile || !at(row.reference_captured_at) || !digest.test(row.review_text_sha256) || !digest.test(row.native_visible_text_sha256) || !Array.isArray(row.reference_artifacts) || row.reference_artifacts.length !== 5) fail("reference row identity/schema");
    const old = row.old_baseline;
    if (!exact(old, ["source_id", "stored_owner_id", "url", "page_type", "capture_profile", "captured_at", "text_hash"]) || !identity({ id: old.source_id, shared_award_id: old.stored_owner_id, url: old.url, page_type: old.page_type }, row) || typeof old.capture_profile !== "string" || !/^[a-z0-9-]{1,80}$/.test(old.capture_profile) || old.capture_profile === profile || !at(old.captured_at) || Date.parse(old.captured_at) >= Date.parse(row.reference_captured_at) || !digest.test(old.text_hash)) fail("old baseline reference binding");
    ids.add(row.source_id); const artifacts = {};
    for (const [index, binding] of row.reference_artifacts.entries()) {
      if (!exact(binding, ["kind", "path", "sha256", "byte_length"]) || binding.kind !== slots[index] || typeof binding.path !== "string" || !isAbsolute(binding.path) || !digest.test(binding.sha256) || !Number.isSafeInteger(binding.byte_length) || binding.byte_length < 1 || binding.byte_length > limits[binding.kind]) fail("reference artifact binding");
      const key = process.platform === "win32" ? resolve(binding.path).toLowerCase() : resolve(binding.path);
      if (paths.has(key) || total + binding.byte_length > 128 * 1024 ** 2) fail("duplicate/aggregate reference bound");
      paths.add(key); total += binding.byte_length;
      const raw = readRegular(binding.path, binding.byte_length);
      if (raw.length !== binding.byte_length || sha(raw) !== binding.sha256) fail("reference raw binding mismatch");
      if (binding.kind === "meta" || binding.kind === "text") artifacts[binding.kind] = raw;
    }
    let meta; try { meta = JSON.parse(decode(artifacts.meta)); } catch { fail("reference metadata JSON"); }
    const rawText = artifacts.text;
    if (rawText.at(-1) !== 10 || sha(rawText.subarray(0, -1)) !== row.review_text_sha256 || !decode(rawText.subarray(0, -1)).length) fail("reference text writer LF/hash");
    if (!identity(meta?.source, row) || meta.status_code !== 200 || meta.final_url !== row.url || meta.captured_at !== row.reference_captured_at || meta.capture_profile !== profile || meta.capture_behavior_name !== profile || meta.capture_behavior_version !== 2 || typeof meta.scrapling?.visible_text !== "string" || !meta.scrapling.visible_text.length || sha(meta.scrapling.visible_text) !== row.native_visible_text_sha256 || meta.scrapling.visible_text_sha256 !== row.native_visible_text_sha256) fail("reference metadata identity/native binding");
  }
  const guard = freeze({ ...value, sha256 }); loaded.add(guard); return guard;
}

export function requiresScraplingBaselineTransition({ baseline, baselineRefresh = false, captureProfile } = {}) {
  return baselineRefresh === true && crossing(baseline, captureProfile);
}

/** Pre-network validation; a reference binds the exact OLD baseline too. */
export function getScraplingBaselineTransitionReference({ guard, source, baseline, baselineRefresh = false, captureProfile } = {}) {
  if (!crossing(baseline, captureProfile)) return null;
  if (baselineRefresh !== true || captureProfile !== profile) fail("explicit v2 cross-profile baseline refresh required");
  if (!object(guard) || !loaded.has(guard)) fail("loaded SHA-bound reference required");
  const row = guard.sources.find(item => item.source_id === source?.id);
  if (!row || !identity(source, row) || source.source !== "admin" || source.admin_review_status !== "open") fail("source identity changed or not bound/admin-open");
  const old = row.old_baseline;
  if (!identity(baseline.source, row) || baseline.capture_profile !== old.capture_profile || baseline.captured_at !== old.captured_at || baseline.text_hash !== old.text_hash) fail("old baseline changed since reference");
  return row;
}

/** Call after a fresh source reread and capture, BEFORE any baseline/pointer write. */
export function assertScraplingBaselineTransition({ guard, sourceBefore, sourceAfter, baseline, capture, baselineRefresh = false, captureProfile } = {}) {
  const row = getScraplingBaselineTransitionReference({ guard, source: sourceBefore, baseline, baselineRefresh, captureProfile });
  if (!row) return { required: false, factual_approval: false, migration_authority: false };
  if (!identity(sourceAfter, row) || sourceAfter.source !== "admin" || sourceAfter.admin_review_status !== "open" || approvals(sourceBefore) !== approvals(sourceAfter) || !identity(capture?.source, row)) fail("source identity/approval changed or capture absent");
  if (capture.status_code !== 200 || capture.capture_profile !== profile || capture.capture_behavior_name !== profile || capture.capture_behavior_version !== 2 || capture.final_url !== row.url || !at(capture.captured_at) || Date.parse(capture.captured_at) < Date.parse(row.reference_captured_at) || Date.parse(capture.captured_at) <= Date.parse(row.old_baseline.captured_at)) fail("capture profile/URL/time mismatch");
  if (typeof capture.text !== "string" || !capture.text.length || Buffer.byteLength(capture.text) > 6 * 1024 ** 2 || sha(capture.text) !== row.review_text_sha256 || typeof capture.scrapling?.visible_text !== "string" || !capture.scrapling.visible_text.length || Buffer.byteLength(capture.scrapling.visible_text) > 6 * 1024 ** 2 || sha(capture.scrapling.visible_text) !== row.native_visible_text_sha256 || capture.scrapling.visible_text_sha256 !== row.native_visible_text_sha256) fail("full review/native text changed");
  return { required: true, reference_sha256: guard.sha256, source_id: row.source_id, monitoring_first_coverage_only: true, factual_approval: false, migration_authority: false, website_change_certified: false };
}
