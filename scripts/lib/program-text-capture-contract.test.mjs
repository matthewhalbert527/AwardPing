import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as contract from "./program-text-capture-contract.mjs";
import * as acquisition from "./program-text-capture.mjs";

const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222", url: "https://example.org/award" };
const text = "Award 🎓. The application deadline is March 15, 2027.";
const fixture = () => contract.buildProgramTextCapture({ source, acquisition: "http_html", captured_at: "2026-10-25T16:00:00.000Z",
  raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), content_type: "text/html", text,
  blocks: [{ id: "full", text, start_utf16: 0, end_utf16: text.length }], extractor: { name: "fixture", version: "1" } });
const shell = "Loading... Skip to page contentSkip to chat Skip to page contentSkip to chat";
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function captureFor(value, overrides = {}) {
  return contract.buildProgramTextCapture({ source, acquisition: "http_html", captured_at: "2026-10-25T16:00:00.000Z",
    raw_bytes: Buffer.from(`<html><body>${value}</body></html>`), content_type: "text/html", text: value,
    blocks: [{ id: "body", text: value, start_utf16: 0, end_utf16: value.length }], extractor: { name: "fixture", version: "1" }, ...overrides });
}
// Reproduce the original identity algorithm to test already retained captures,
// not just a new builder which might repair its own completeness flag.
function historicalComplete(capture) {
  const complete = { ...capture, completeness: { status: "complete", reasons: [] } };
  complete.capture_id = hash(JSON.stringify(canonical([complete.schema, complete.capture_profile, complete.source, complete.final_url,
    complete.captured_at, complete.acquisition, complete.extractor, complete.raw_source.content_type,
    complete.raw_source.sha256, complete.raw_source.byte_length, complete.text_sha256, complete.blocks, complete.completeness])));
  return complete;
}

describe("engine-free retained text capture contract", () => {
  it("imports only hashing and the unchanged public URL policy, never PC capture/OCR/file/process engines", () => {
    const code = readFileSync(new URL("./program-text-capture-contract.mjs", import.meta.url), "utf8");
    const dependencies = [...code.matchAll(/^import\s+.*?from\s+["']([^"']+)["'];/gm)].map(match => match[1]);
    expect(dependencies).toEqual(["node:crypto", "./public-network-safety.mjs"]);
    expect(code).not.toMatch(/\b(?:spawn|fileURLToPath|readFileSync|writeFileSync|captureScraplingSource|extractProgramTextPdfOcr|fetchProgramTextBrowserPdf)\s*\(/);
    expect(code).not.toMatch(/(?:import|require)\s*\([^)]*(?:ocr|capture\.mjs|playwright|scrapling|child_process|node:fs)/);
  });
  it.each(["PROGRAM_TEXT_CAPTURE_SCHEMA", "PROGRAM_TEXT_CAPTURE_PROFILE", "programTextCaptureLimits", "buildProgramTextCapture",
    "validateProgramTextCapture", "blocksFromHtmlDocument"])("preserves the existing acquisition export %s as the same contract", name => {
    expect(acquisition[name]).toBe(contract[name]);
  });
  it("validates immutable original bytes, exact source identity and UTF16 blocks without any extraction engine", () => {
    const capture = fixture();
    expect(contract.validateProgramTextCapture(capture, { source })).toBe(capture);
    expect(capture.text.slice(capture.blocks[0].start_utf16, capture.blocks[0].end_utf16)).toBe(text);
    expect(capture.capture_id).toMatch(/^[a-f0-9]{64}$/);
    expect(() => contract.validateProgramTextCapture(capture, { source: { ...source, shared_award_id: source.id } })).toThrow("source_identity_mismatch");
    const changed = { ...capture, raw_source: { ...capture.raw_source, bytes: Buffer.from("modified") } };
    expect(() => contract.validateProgramTextCapture(changed)).toThrow("invalid_raw_source");
    expect(() => contract.validateProgramTextCapture({ ...capture, screenshot: {} })).toThrow("invalid_contract");
  });
  it.each(["http://127.0.0.1/a", "http://169.254.169.254/a", "http://[::1]/a", "http://[64:ff9b::7f00:1]/a",
    "https://localhost/a", "https://internal.test/a", "https://user:password@example.org/a", "https://example.org/a#fragment"])("keeps the original public URL rejection for %s", url => {
    expect(() => contract.buildProgramTextCapture({ ...fixture(), source: { ...source, url }, final_url: url,
      raw_bytes: Buffer.from("original"), content_type: "text/html" })).toThrow();
  });
  it("shares only frozen pure adapter helpers and preserves complete projection", () => {
    expect(Object.isFrozen(contract.programTextCaptureInternals)).toBe(true);
    const projection = contract.blocksFromHtmlDocument({ text, blocks: [{ text, kind: "p", heading_path: [{ text: "Deadline" }] }] });
    expect(projection).toMatchObject([{ text, start_utf16: 0, end_utf16: text.length, heading: "Deadline" }]);
    expect(contract.programTextCaptureInternals.isAcquisition("pdf_text")).toBe(true);
    expect(contract.programTextCaptureInternals.isAcquisition("image")).toBe(false);
  });
});

describe("recognizable loading-only HTML cannot verify program details", () => {
  it.each([shell, "Loading...", "Loading… Skip to main content", "PLEASE WAIT...\nSkip to page content\nSkip to chat",
    "Loading content...Skip to navigationSkip to content", "Skip to page contentSkip to chat", "Loading\u200b...\u00a0Skip to chat"])("holds shell-only text %s", value => {
    expect(contract.isProgramTextHtmlShell(value)).toBe(true);
    expect(() => captureFor(value)).toThrow("html_application_shell_only");
    const incomplete = captureFor(value, { completeness: { status: "incomplete", reasons: ["html_application_shell_only"] } });
    expect(contract.validateProgramTextCapture(incomplete)).toBe(incomplete);
    expect(() => contract.validateProgramTextCapture(historicalComplete(incomplete))).toThrow("html_application_shell_only");
  });
  it.each(["Closed.", "Applications are now open.", "Deadline: May 1.", "Loading... Applications close May 1, 2027.",
    "Skip to main content. Applicants must be U.S. citizens.", "Downloading application materials.", "Loading scholarship information: applications are closed."])("does not impose a length floor or reject substantive prose: %s", value => {
    expect(contract.isProgramTextHtmlShell(value)).toBe(false);
    expect(contract.validateProgramTextCapture(captureFor(value)).completeness.status).toBe("complete");
  });
  it("does not misclassify empty or non-text input as this specific quality problem", () => {
    for (const value of ["", " ", null, {}, undefined]) expect(contract.isProgramTextHtmlShell(value)).toBe(false);
  });
  it("does not allow a projected application URL to disguise a shell-only body", () => {
    const url = "https://example.org/application", projected = `${shell}\n\n${url}`;
    const options = { blocks: [{ id: "body", text: shell, start_utf16: 0, end_utf16: shell.length },
      { id: "source-link-000001", kind: "source_link", text: url, start_utf16: shell.length + 2, end_utf16: projected.length }] };
    expect(() => captureFor(projected, options)).toThrow("html_application_shell_only");
    const incomplete = captureFor(projected, { ...options, completeness: { status: "incomplete", reasons: ["html_application_shell_only"] } });
    expect(() => contract.validateProgramTextCapture(historicalComplete(incomplete))).toThrow("html_application_shell_only");
  });
  it("marks HTTP and rendered adapter observations incomplete before retaining them", async () => {
    const document = { text: shell, blocks: [{ text: shell, kind: "text", heading_path: [] }] };
    const html = Buffer.from(`<html><body>${shell}</body></html>`);
    for (const mode of ["http_html", "rendered_html"]) {
      const capture = await acquisition.captureProgramTextSource({ source, acquisition: mode, adapters: {
        fetch: async () => ({ status: 200, buffer: html, finalUrl: source.url, contentType: "text/html" }),
        renderedHtml: async () => ({ capture_profile: "scrapling-visible-v1", status_code: 200, html: html.toString(),
          final_url: source.url, captured_at: "2026-10-25T16:00:00.000Z", content_type: "text/html" }),
        htmlExtraction: async () => document,
      } });
      expect(capture.completeness).toEqual({ status: "incomplete", reasons: ["html_application_shell_only"] });
      expect(capture.text).toBe(shell);
    }
  });
  it("does not apply an HTML-shell rule to PDF/native or OCR evidence", () => {
    for (const mode of ["pdf_text", "pdf_ocr"]) {
      const capture = captureFor(shell, { acquisition: mode, content_type: "application/pdf", raw_bytes: Buffer.from("%PDF-1.4\nretained PDF fixture") });
      expect(contract.validateProgramTextCapture(capture).completeness.status).toBe("complete");
    }
  });
  it("pins only the independently restored historical HTML hash, never invalidating general references", () => {
    expect(shell.length).toBe(76);
    expect(hash(shell)).toBe("0690da223815dc8171e2ec5e6699cf455373bb41644063cd276de152a1ac197c");
    const ref = { acquisition: "http_html", text_length: shell.length, text_sha256: hash(shell) };
    expect(contract.isKnownProgramTextHtmlShellReference(ref)).toBe(true);
    expect(contract.isKnownProgramTextHtmlShellReference({ ...ref, acquisition: "rendered_html" })).toBe(true);
    for (const changed of [{ ...ref, acquisition: "pdf_text" }, { ...ref, acquisition: "pdf_ocr" },
      { ...ref, text_length: 77 }, { ...ref, text_sha256: hash("Different short award announcement.") }, {}, null]) {
      expect(contract.isKnownProgramTextHtmlShellReference(changed)).toBe(false);
    }
  });
});
