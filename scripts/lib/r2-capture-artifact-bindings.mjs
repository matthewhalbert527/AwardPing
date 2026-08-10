import crypto from "node:crypto";
import {
  verifyVisualTextGeometryBinding,
  visualTextGeometryLayoutFingerprint,
} from "./visual-event-localization.mjs";

export const r2CaptureArtifactBindingsSchema =
  "awardping.r2.capture-artifact-bindings.v1";

export function isR2CaptureGeometryReady(capture) {
  const geometry = objectValue(capture?.text_geometry);
  const screenshot = objectValue(geometry.screenshot);
  const paintStack = objectValue(geometry.paint_stack);
  const captureVerification = objectValue(geometry.capture_verification);
  const availabilityStatus = String(geometry.availability_status || "").trim();
  const expectedImageHash = String(
    capture?.image_hash || screenshot.image_hash || "",
  ).trim();
  const binding = verifyVisualTextGeometryBinding(geometry, expectedImageHash);
  const capturedLayoutFingerprint = visualTextGeometryLayoutFingerprint({
    ...geometry,
    version: 1,
  });

  return Boolean(
    capture?.kind !== "pdf"
      && !availabilityStatus.startsWith("unavailable_")
      && Number(geometry.run_count || 0) > 0
      && binding.valid
      && paintStack.contract === "browser-paint-stack-v1"
      && paintStack.status === "verified"
      && captureVerification.contract === "visual-screenshot-layout-binding-v1"
      && captureVerification.status === "verified"
      && captureVerification.before_fingerprint === capturedLayoutFingerprint
      && captureVerification.after_fingerprint === capturedLayoutFingerprint
      && screenshot.alignment_status === "verified",
  );
}

export function collectR2CaptureArtifactFiles(capture, { exists = () => true } = {}) {
  const files = [];
  const geometryReady = isR2CaptureGeometryReady(capture);
  const addIfPresent = (name, fileName, path, contentType) => {
    if (!path || !exists(path)) return;
    files.push({ name, fileName, path, contentType });
  };

  addIfPresent("page", "page.jpg", capture?.page_path, "image/jpeg");
  addIfPresent("thumb", "thumb.jpg", capture?.thumb_path, "image/jpeg");
  addIfPresent("pdf", "document.pdf", capture?.pdf_path, "application/pdf");
  addIfPresent("text", "text.txt", capture?.text_path, "text/plain; charset=utf-8");
  if (geometryReady) {
    addIfPresent(
      "layout",
      "layout.json",
      capture?.layout_path,
      "application/json; charset=utf-8",
    );
  }
  addIfPresent("meta", "meta.json", capture?.meta_path, "application/json; charset=utf-8");
  const expansionStates = geometryReady
    ? retainedR2ExpansionStates(capture?.expansion_state_screenshots)
    : [];
  for (const [index, state] of expansionStates.entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    addIfPresent(
      `expansion_state_${suffix}`,
      `expansion-state-${suffix}.jpg`,
      state.page_path,
      "image/jpeg",
    );
    addIfPresent(
      `expansion_state_${suffix}_layout`,
      `expansion-state-${suffix}-layout.json`,
      state.layout_path,
      "application/json; charset=utf-8",
    );
  }
  return files;
}

export function prepareR2CaptureArtifacts(files, { readFile } = {}) {
  if (!Array.isArray(files) || files.length < 1) {
    throw new Error("At least one R2 capture artifact is required.");
  }
  if (typeof readFile !== "function") {
    throw new Error("An R2 capture artifact reader is required.");
  }

  const names = new Set();
  const fileNames = new Set();
  const artifacts = files
    .map((file) => {
      const name = requiredText(file?.name, "R2 capture artifact slot");
      const fileName = requiredText(file?.fileName, `R2 capture filename for ${name}`);
      const path = requiredText(file?.path, `R2 capture path for ${name}`);
      const contentType = requiredText(
        file?.contentType,
        `R2 capture content type for ${name}`,
      );
      if (names.has(name) || fileNames.has(fileName)) {
        throw new Error(`Duplicate R2 capture artifact slot or filename: ${name}.`);
      }
      names.add(name);
      fileNames.add(fileName);

      const body = Buffer.from(readFile(path));
      if (body.length < 1) {
        throw new Error(`R2 capture artifact ${name} is empty.`);
      }
      return {
        name,
        fileName,
        contentType,
        body,
        binding: {
          sha256: crypto.createHash("sha256").update(body).digest("hex"),
          byte_length: body.length,
          content_type: contentType,
          hash_mode: "raw_sha256",
        },
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    artifacts,
    artifactBindings: Object.fromEntries(
      artifacts.map((artifact) => [artifact.name, artifact.binding]),
    ),
  };
}

export function assertR2CaptureArtifactSlots(kind, artifactBindings, {
  layoutClaimed = false,
  expansionStateCount = 0,
} = {}) {
  const slots = Object.keys(artifactBindings || {}).sort();
  const required = kind === "pdf"
    ? ["meta", "pdf", "text"]
    : ["meta", "page", "text", "thumb"];
  for (const slot of required) {
    if (!slots.includes(slot)) {
      throw new Error(`R2 ${kind || "webpage"} capture is missing required ${slot} evidence.`);
    }
  }

  if (kind === "pdf") {
    if (slots.some((slot) => !required.includes(slot))) {
      throw new Error("R2 PDF captures may contain only pdf, text, and meta evidence.");
    }
    return;
  }

  if (layoutClaimed && !slots.includes("layout")) {
    throw new Error("R2 webpage capture claims text geometry without a layout artifact.");
  }

  const expansionPages = new Set();
  const expansionLayouts = new Set();
  for (const slot of slots) {
    if (required.includes(slot) || slot === "layout") continue;
    const page = slot.match(/^expansion_state_(0[1-9]|[1-9][0-9]+)$/);
    const layout = slot.match(/^expansion_state_(0[1-9]|[1-9][0-9]+)_layout$/);
    if (page) expansionPages.add(Number(page[1]));
    else if (layout) expansionLayouts.add(Number(layout[1]));
    else throw new Error(`R2 webpage capture has an unsupported artifact slot: ${slot}.`);
  }

  if (expansionPages.size !== expansionLayouts.size) {
    throw new Error("R2 expansion screenshots and layouts must be complete pairs.");
  }
  const indexes = [...expansionPages].sort((left, right) => left - right);
  if (
    indexes.some((index, offset) => index !== offset + 1 || !expansionLayouts.has(index))
  ) {
    throw new Error("R2 expansion screenshot/layout pairs must be contiguous from 01.");
  }
  if (!Number.isSafeInteger(expansionStateCount) || expansionStateCount < 0) {
    throw new Error("R2 expansion state count is invalid.");
  }
  if (indexes.length !== expansionStateCount) {
    throw new Error("R2 retained expansion state count does not match its artifact pairs.");
  }
  if (expansionStateCount > 0 && !slots.includes("layout")) {
    throw new Error("R2 expansion evidence requires the main layout artifact.");
  }
}

export function assertR2CaptureArtifactIdentity(capture, prepared, { sourceId } = {}) {
  const artifacts = new Map(
    (prepared?.artifacts || []).map((artifact) => [artifact.name, artifact]),
  );
  const kind = capture?.kind === "pdf" ? "pdf" : "webpage";
  const primarySlot = kind === "pdf" ? "pdf" : "page";
  const primaryHashField = kind === "pdf" ? "file_hash" : "image_hash";
  assertSameSha256(
    artifacts.get(primarySlot)?.binding?.sha256,
    capture?.[primaryHashField],
    `${primarySlot} bytes and capture ${primaryHashField}`,
  );

  const textArtifact = artifacts.get("text");
  if (!textArtifact) throw new Error("R2 capture text artifact is missing.");
  const text = decodeWriterTextArtifact(textArtifact.body);
  assertSameSha256(
    crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
    capture?.text_hash,
    "text bytes and capture text_hash",
  );
  if (!Number.isSafeInteger(capture?.text_length) || capture.text_length !== text.length) {
    throw new Error("R2 text bytes and capture text_length do not match.");
  }

  const expectedImageHash = kind === "pdf" ? capture?.file_hash : capture?.image_hash;
  const layoutArtifact = artifacts.get("layout");
  if (layoutArtifact) {
    const layout = parseJsonArtifact(layoutArtifact.body, "main layout");
    const binding = verifyVisualTextGeometryBinding(layout, expectedImageHash);
    if (!binding.valid) {
      throw new Error(`R2 main layout binding is invalid: ${binding.reason}.`);
    }
    assertSameSha256(
      layout.geometry_hash,
      capture?.layout_hash || capture?.text_geometry?.geometry_hash,
      "main layout geometry identity",
    );
    assertSameSha256(
      layout.screenshot?.image_hash,
      expectedImageHash,
      "main layout screenshot identity",
    );
  }

  for (const [index, state] of (capture?.expansion_state_screenshots || []).entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    if (!artifacts.has(`expansion_state_${suffix}`)) continue;
    const expectedStateId = `expansion-state-${suffix}`;
    if (state?.state_id !== expectedStateId) {
      throw new Error(`R2 expansion state ${suffix} has a non-canonical state ID.`);
    }
    assertSameSha256(
      artifacts.get(`expansion_state_${suffix}`)?.binding?.sha256,
      state?.image_hash,
      `expansion state ${suffix} screenshot identity`,
    );
    const stateLayout = parseJsonArtifact(
      artifacts.get(`expansion_state_${suffix}_layout`)?.body,
      `expansion state ${suffix} layout`,
    );
    if (stateLayout.state_id !== expectedStateId) {
      throw new Error(`R2 expansion state ${suffix} layout has the wrong state ID.`);
    }
    const stateBinding = verifyVisualTextGeometryBinding(stateLayout, state?.image_hash);
    if (!stateBinding.valid) {
      throw new Error(
        `R2 expansion state ${suffix} layout binding is invalid: ${stateBinding.reason}.`,
      );
    }
    assertSameSha256(
      stateLayout.geometry_hash,
      state?.layout_hash || state?.text_geometry?.geometry_hash,
      `expansion state ${suffix} layout identity`,
    );
    assertSameSha256(
      stateLayout.screenshot?.image_hash,
      state?.image_hash,
      `expansion state ${suffix} layout screenshot identity`,
    );
  }

  const metadata = parseJsonArtifact(artifacts.get("meta")?.body, "capture metadata");
  if (metadata.kind !== kind) {
    throw new Error("R2 metadata kind does not match the capture kind.");
  }
  if (sourceId && metadata.source?.id !== sourceId) {
    throw new Error("R2 metadata source ID does not match the pointer source.");
  }
  if (metadata.captured_at !== capture?.captured_at) {
    throw new Error("R2 metadata timestamp does not match the capture timestamp.");
  }
  for (const field of ["text_hash", primaryHashField]) {
    assertSameSha256(metadata[field], capture?.[field], `metadata ${field} identity`);
  }
  const expectedLayoutHash = capture?.layout_hash || capture?.text_geometry?.geometry_hash || null;
  if (expectedLayoutHash) {
    assertSameSha256(metadata.layout_hash, expectedLayoutHash, "metadata layout identity");
  }
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function decodeWriterTextArtifact(body) {
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("R2 capture text artifact is not valid UTF-8.");
  }
  const text = raw.endsWith("\r\n")
    ? raw.slice(0, -2)
    : raw.endsWith("\n")
      ? raw.slice(0, -1)
      : null;
  if (text === null || text.endsWith("\n") || text.endsWith("\r")) {
    throw new Error("R2 capture text must have exactly one writer framing newline.");
  }
  return text;
}

function parseJsonArtifact(body, label) {
  if (!body) throw new Error(`R2 ${label} artifact is missing.`);
  try {
    const value = JSON.parse(Buffer.from(body).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`R2 ${label} artifact is not a JSON object.`);
  }
}

function assertSameSha256(actual, expected, label) {
  const left = String(actual || "").trim();
  const right = String(expected || "").trim();
  if (!/^[0-9a-f]{64}$/.test(left) || left !== right) {
    throw new Error(`R2 ${label} does not match.`);
  }
}

function retainedR2ExpansionStates(states) {
  const retained = [];
  for (const [index, state] of (Array.isArray(states) ? states : []).entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    if (
      state?.state_id !== `expansion-state-${suffix}`
      || !/^[0-9a-f]{64}$/.test(String(state?.text_hash || ""))
      || !Number.isSafeInteger(state?.text_length)
      || state.text_length < 0
      || !isR2CaptureGeometryReady({
        kind: "webpage",
        image_hash: state?.image_hash,
        text_geometry: state?.text_geometry,
      })
    ) {
      break;
    }
    retained.push(state);
  }
  return retained;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
