import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as contract from "./program-text-capture-contract.mjs";
import * as acquisition from "./program-text-capture.mjs";

const source = { id: "11111111-1111-4111-8111-111111111111", shared_award_id: "22222222-2222-4222-8222-222222222222", url: "https://example.org/award" };
const text = "Award 🎓. The application deadline is March 15, 2027.";
const fixture = () => contract.buildProgramTextCapture({ source, acquisition: "http_html", captured_at: "2026-10-25T16:00:00.000Z",
  raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), content_type: "text/html", text,
  blocks: [{ id: "full", text, start_utf16: 0, end_utf16: text.length }], extractor: { name: "fixture", version: "1" } });

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
