// Fixed, local native-text extraction subprocess. No PDF/image rendering or model calls.
import { PDFParse } from "pdf-parse";
const limit = 28 * 1024 * 1024;
let chunks = [], size = 0;
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) throw new Error("input_limit");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")); chunks = [];
  if (!Number.isInteger(input.max_pages) || input.max_pages < 1 || input.max_pages > 1000 ||
      typeof input.pdf_base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.pdf_base64)) throw new Error("invalid_input");
  const bytes = Buffer.from(input.pdf_base64, "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== input.pdf_base64 ||
      !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("invalid_pdf");
  const parser = new PDFParse({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false,
    useWorkerFetch: false, useSystemFonts: false, disableFontFace: true, useWasm: false });
  try {
    const result = await parser.getText({ first: input.max_pages });
    if (!Number.isInteger(result.total) || result.total < 1 || result.total > input.max_pages ||
        !Array.isArray(result.pages) || result.pages.length !== result.total ||
        result.pages.some((page, index) => page?.num !== index + 1 || typeof page.text !== "string")) throw new Error("page_coverage");
    const output = JSON.stringify({ total: result.total, pages: result.pages.map(page => ({ num: page.num, text: page.text })) });
    if (Buffer.byteLength(output) > 8 * 1024 * 1024) throw new Error("output_limit");
    process.stdout.write(output);
  } finally { await parser.destroy(); }
} catch {
  process.stderr.write("Program text PDF extraction failed"); process.exitCode = 1;
}
