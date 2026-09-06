import { describe, expect, it } from "vitest";
import { isPdfPayload, pdfDownloadFallbackReason } from "./lib/visual-capture-run-report.mjs";

// A real PDF must be accepted whatever the server labels it, including a
// text/html label with a short preamble before %PDF (misconfigured .gov hosts);
// an HTML label with no PDF header in the first KB is the bot-wall case.
describe("pdf payload detection", () => {
  const pdfWithPreamble = Buffer.concat([Buffer.from(" ".repeat(200)), Buffer.from("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj")]);
  const html = Buffer.from("<!doctype html><html><head><title>Access denied</title></head><body>challenge</body></html>");

  it("accepts a PDF body regardless of the content-type label", () => {
    expect(isPdfPayload({ contentType: "text/html; charset=utf-8", buffer: pdfWithPreamble })).toBe(true);
    expect(isPdfPayload({ contentType: "application/octet-stream", buffer: pdfWithPreamble })).toBe(true);
    expect(isPdfPayload({ contentType: null, buffer: Buffer.from("%PDF-1.4 x") })).toBe(true);
  });

  it("refuses an HTML body and never treats it as a PDF", () => {
    expect(isPdfPayload({ contentType: "text/html", buffer: html })).toBe(false);
    expect(isPdfPayload({ contentType: "application/pdf", buffer: html })).toBe(false);
    expect(pdfDownloadFallbackReason({ status: 200, contentType: "text/html", buffer: html })).toBe("non_pdf_content");
    expect(pdfDownloadFallbackReason({ status: 200, contentType: "text/html", buffer: pdfWithPreamble })).toBeNull();
    expect(pdfDownloadFallbackReason({ status: 403, contentType: "text/html", buffer: html })).toBe("http_403");
  });
});
