import { parseProgramTextChangeDetails } from "../../scripts/lib/program-change-contract.mjs";

type TextEvent = {
  id: string;
  shared_award_id: string;
  shared_award_source_id?: string | null;
  source_url: string;
  summary: string;
  change_details?: unknown;
  visual_review_candidate_id?: string | null;
};
type TextEvidence = {
  change_event_id: string;
  shared_award_id: string;
  shared_award_source_id: string | null;
  visual_review_candidate_id: string | null;
  candidate_signature: string | null;
  bucket: string | null;
  evidence_schema_version: string;
  evidence_status: string;
  previous_capture: unknown;
  current_capture: unknown;
  localization: unknown;
  verified_at: string | null;
  backfilled_at: string | null;
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join() === [...keys].sort().join();
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max;
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const iso = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
// Unlike JSON capture timestamps, PostgREST serializes timestamptz with an
// explicit UTC offset and may retain six fractional digits.
const databaseUtcTime = (value: unknown): value is string => typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19) && Date.parse(value) <= Date.now() + 5 * 60_000;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(object(value)[key])])) : value;
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function httpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 10_000) return false;
  try { const parsed = new URL(value); return ["https:", "http:"].includes(parsed.protocol) && parsed.href === value && !parsed.username && !parsed.password && !parsed.hash && !parsed.port; }
  catch { return false; }
}

/** Immutable source references are validated at publication and checked again at public eligibility. */
function validReference(value: unknown, event: TextEvent) {
  const ref = object(value), source = object(ref.source), extractor = object(ref.extractor), complete = object(ref.completeness), artifacts = object(ref.artifacts);
  if (!exact(ref, ["schema", "kind", "capture_id", "source", "final_url", "captured_at", "acquisition", "extractor", "text_sha256", "text_length", "blocks_sha256", "completeness", "artifacts"]) ||
      ref.schema !== "awardping.program-text-reference.v1" || ref.kind !== "program_text" || !hex(ref.capture_id) || !hex(ref.text_sha256) || !hex(ref.blocks_sha256) ||
      !uuid(source.id) || !uuid(source.shared_award_id) || source.id !== event.shared_award_source_id || source.shared_award_id !== event.shared_award_id ||
      source.url !== event.source_url || !httpUrl(source.url) || !httpUrl(ref.final_url) || !iso(ref.captured_at) || !integer(ref.text_length, 1, 1_000_000) ||
      Object.keys(source).some(key => !["id", "shared_award_id", "url", "title", "page_type"].includes(key)) ||
      ["title", "page_type"].some(key => source[key] !== undefined && (typeof source[key] !== "string" || (source[key] as string).length > 10_000)) ||
      !exact(extractor, ["name", "version"]) || !bounded(extractor.name, 160) || !bounded(extractor.version, 160) ||
      !["http_html", "rendered_html", "pdf_text", "pdf_ocr"].includes(String(ref.acquisition)) ||
      !exact(complete, ["status", "reasons"]) || complete.status !== "complete" || !Array.isArray(complete.reasons) || complete.reasons.length ||
      !exact(artifacts, ["raw", "text", "metadata"])) return false;
  const pdf = String(ref.acquisition).startsWith("pdf_"), prefix = `program-text/sources/${source.id}/${ref.capture_id}/`;
  for (const role of ["raw", "text", "metadata"] as const) {
    const artifact = object(artifacts[role]);
    const name = role === "raw" ? pdf ? "original.pdf" : "original.html" : role === "text" ? "text.txt" : "metadata.json";
    const maxBytes = role === "raw" ? (pdf ? 20 : 5) * 1024 * 1024 : role === "text" ? 8 * 1024 * 1024 : 32 * 1024 * 1024;
    if (!exact(artifact, ["object_key", "sha256", "byte_length", "content_type"]) || artifact.object_key !== prefix + name || !hex(artifact.sha256) || !integer(artifact.byte_length, 1, maxBytes)) return false;
    if (role === "text" && (artifact.content_type !== "text/plain; charset=utf-8" || artifact.sha256 !== ref.text_sha256 || artifact.byte_length < (ref.text_length as number) || artifact.byte_length > 3 * (ref.text_length as number))) return false;
    if (role === "metadata" && artifact.content_type !== "application/json") return false;
    if (role === "raw" && (typeof artifact.content_type !== "string" || artifact.content_type.length > 200 ||
        !(pdf ? /^application\/pdf(?:;|$)/i : /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i).test(artifact.content_type))) return false;
  }
  return true;
}

function supportingBlocks(value: unknown, textLength: number) {
  if (!Array.isArray(value) || value.length > 2000) return null;
  const ids = new Map<string, Record<string, unknown>>(); let end = 0;
  for (const item of value) {
    const block = object(item);
    if (!bounded(block.id, 200) || ids.has(block.id) || !bounded(block.text, 1_000_000) ||
        !integer(block.start_utf16, end, textLength) || !integer(block.end_utf16, block.start_utf16 + 1, textLength) ||
        block.end_utf16 - block.start_utf16 !== block.text.length ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(block.text) ||
        Object.keys(block).some(key => !["id", "text", "start_utf16", "end_utf16", "heading", "page", "kind", "context"].includes(key))) return null;
    ids.set(block.id, block); end = block.end_utf16;
  }
  return ids;
}

/** Never treats a missing screenshot or an old visual status as text authority. */
export function hasPublishableProgramTextEvidence(event: TextEvent, evidence: TextEvidence) {
  const details = parseProgramTextChangeDetails(event.change_details);
  const proof = object(evidence.localization), supporting = object(proof.supporting_blocks);
  if (!details || event.summary !== details.summary || evidence.evidence_schema_version !== "program-text-event-evidence-v1" || evidence.evidence_status !== "verified_text" ||
      evidence.change_event_id !== event.id || evidence.shared_award_id !== event.shared_award_id || evidence.shared_award_source_id !== event.shared_award_source_id ||
      !uuid(event.visual_review_candidate_id) || evidence.visual_review_candidate_id !== event.visual_review_candidate_id || !hex(evidence.candidate_signature) || !bounded(evidence.bucket, 255) ||
      !databaseUtcTime(evidence.verified_at) || evidence.backfilled_at !== null ||
      !exact(proof, ["schema", "epoch", "comparison_id", "program_changes", "supporting_blocks"]) || proof.schema !== "awardping.program-text-publication.v1" ||
      !uuid(proof.epoch) || !hex(proof.comparison_id) || proof.comparison_id !== evidence.candidate_signature || !equal(proof.program_changes, details.program_changes) || !exact(supporting, ["previous", "current"]) ||
      !validReference(evidence.previous_capture, event) || !validReference(evidence.current_capture, event)) return false;
  const previous = object(evidence.previous_capture), current = object(evidence.current_capture);
  if (previous.capture_id === current.capture_id || previous.final_url !== current.final_url || previous.acquisition !== current.acquisition || !equal(previous.extractor, current.extractor) ||
      Date.parse(previous.captured_at as string) >= Date.parse(current.captured_at as string) || Date.parse(evidence.verified_at) < Date.parse(current.captured_at as string)) return false;
  const sides = { previous: supportingBlocks(supporting.previous, previous.text_length as number), current: supportingBlocks(supporting.current, current.text_length as number) };
  if (!sides.previous || !sides.current) return false;
  for (const change of details.program_changes) for (const side of ["previous", "current"] as const) {
    const quote = change[`${side}_quote`];
    if (quote === null) continue;
    const blocks = sides[side];
    if (!blocks) return false;
    const block = blocks.get(quote.block_id);
    if (!block || quote.start_utf16 < (block.start_utf16 as number) || quote.end_utf16 > (block.end_utf16 as number)) return false;
    const offset = quote.start_utf16 - (block.start_utf16 as number), text = block.text as string;
    if (text.slice(offset, quote.end_utf16 - (block.start_utf16 as number)) !== quote.text || text.indexOf(quote.text) !== offset || text.indexOf(quote.text, offset + 1) >= 0) return false;
  }
  return true;
}
