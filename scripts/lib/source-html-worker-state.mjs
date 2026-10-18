import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SOURCE_HTML_PROFILE, assertSourceHtmlAbsence, assertSourceHtmlArtifactSlots,
  sourceHtmlArtifactProjection } from "./source-html-evidence.mjs";
import { collectR2CaptureArtifactFiles, prepareR2CaptureArtifacts, assertR2CaptureArtifactIdentity,
  r2CaptureArtifactBindingsSchema } from "./r2-capture-artifact-bindings.mjs";

function localFile(root, value) {
  if (typeof value !== "string" || !value) throw new Error("Source HTML artifact path missing.");
  const path = resolve(root, value), rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Source HTML artifact escaped archive.");
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error("Source HTML artifact contains a symbolic link.");
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > 24 * 1024 * 1024 || realpathSync(path) !== path) {
    throw new Error("Source HTML artifact is not a bounded regular file.");
  }
  return path;
}

export function verifyLocalSourceHtmlCapture(capture, { archiveRoot, source = capture?.source } = {}) {
  const root = realpathSync(archiveRoot);
  assertSourceHtmlAbsence(capture);
  if (source?.id !== capture.source?.id || source?.shared_award_id !== capture.source?.shared_award_id || source?.url !== capture.source?.url) {
    throw new Error("Source HTML capture source identity mismatch.");
  }
  for (const slot of ["html", "meta", "text"]) {
    const fromFile = localFile(root, capture.files?.[slot]), fromPath = localFile(root, capture[`${slot}_path`]);
    if (fromFile !== fromPath) throw new Error("Source HTML retained path mismatch.");
  }
  const prepared = prepareR2CaptureArtifacts(collectR2CaptureArtifactFiles(capture, { exists: existsSync }), {
    readFile: value => readFileSync(localFile(root, value)),
  });
  assertR2CaptureArtifactIdentity(capture, prepared, { sourceId: source.id });
  return sourceHtmlArtifactProjection();
}

export function sourceHtmlBaselineEvidence(baseline, { archiveRoot } = {}) {
  try {
    if (baseline?.capture_profile !== SOURCE_HTML_PROFILE || baseline.kind !== "webpage") throw new Error("Source HTML baseline profile required.");
    const root = realpathSync(archiveRoot), files = baseline.capture || {};
    for (const [key, value] of Object.entries(files)) {
      if (!["dir", "html", "meta", "text"].includes(key) && value != null && !(key === "expansion_states" && Array.isArray(value) && !value.length)) {
        throw new Error("Source HTML baseline has visual artifact claims.");
      }
    }
    const paths = Object.fromEntries(["html", "meta", "text"].map(slot => [`${slot}Path`, localFile(root, files[slot])]));
    const metadata = JSON.parse(readFileSync(paths.metaPath, "utf8"));
    if (baseline.captured_at !== metadata.captured_at || baseline.final_url !== metadata.final_url ||
        baseline.text_hash !== metadata.text_hash || baseline.image_hash || baseline.file_hash || baseline.layout_hash ||
        baseline.text_geometry || baseline.body_text_hash !== metadata.body_text_hash || baseline.main_content_hash !== metadata.main_content_hash ||
        baseline.source_html_body_hash !== metadata.source_html?.capture?.source_http?.body_sha256 ||
        JSON.stringify(baseline.summary_metadata?.retained_artifact_projection || baseline.retained_artifact_projection) !== JSON.stringify(metadata.retained_artifact_projection) ||
        JSON.stringify(baseline.source_html) !== JSON.stringify(metadata.source_html)) {
      throw new Error("Source HTML baseline metadata mismatch.");
    }
    const capture = { ...metadata, ...Object.fromEntries(["html", "meta", "text"].map(slot => [`${slot}_path`, paths[`${slot}Path`]])) };
    verifyLocalSourceHtmlCapture(capture, { archiveRoot: root, source: baseline.source });
    return { ok: true, kind: "webpage", localizationStatus: "source_html_no_screenshot", ...paths };
  } catch (error) {
    return { ok: false, missing: ["source_html_evidence_invalid"], error: error.message };
  }
}

export function sourceHtmlR2Metadata(capture, artifactBindings) {
  assertSourceHtmlAbsence(capture);
  assertSourceHtmlArtifactSlots(artifactBindings);
  return { artifact_bindings_schema: r2CaptureArtifactBindingsSchema, artifact_bindings: artifactBindings,
    capture_profile: SOURCE_HTML_PROFILE, source_html: capture.source_html,
    retained_artifact_projection: sourceHtmlArtifactProjection(), final_url: capture.final_url,
    page_title: capture.page_title, status_code: capture.status_code, content_type: capture.content_type,
    text_length: capture.text_length, text_object_bytes: artifactBindings.text.byte_length,
    body_text_length: capture.body_text_length, main_content_text_length: capture.main_content_text_length,
    baseline_facts: capture.baseline_facts || null, baseline_facts_metadata: capture.baseline_facts_metadata || null,
    monitoring_disposition: capture.monitoring_disposition || null };
}
