// A finite transport exception for three observed, anonymous public downloads.
// This identifies bytes and redirects, not provider ownership or approved facts.
export const PROGRAM_TEXT_PUBLIC_DRIVE_PDF_VERSION = "2.4.5/program-text-v1/public-drive-pdf-v1";
export const PROGRAM_TEXT_PUBLIC_DRIVE_PDF_FILE_IDS = Object.freeze([
  "1zHNkNkZRMby5z2qqkwsiexbOGX-ao6_H",
  "1ovb7IAawhtIWBws8kpYojXx_lLZusseQ",
  "1ynJ0l9ZPi_PNIzOPrFPJcEgNvK6S9Vs0",
]);

/** Literal HTTPS URLs only: no normalization can hide another query or ID. */
export function programTextPublicDrivePdfIdentity(value) {
  if (typeof value !== "string") return null;
  const match = /^https:\/\/drive\.usercontent\.google\.com\/(uc|download)\?([^#]+)$/.exec(value);
  if (!match) return null;
  const parts = match[2].split("&");
  if (parts.length !== 2 || parts.filter(part => part === "export=download").length !== 1) return null;
  const id = parts.find(part => part.startsWith("id="))?.slice(3);
  if (!PROGRAM_TEXT_PUBLIC_DRIVE_PDF_FILE_IDS.includes(id) || !parts.includes(`id=${id}`)) return null;
  return { file_id: id, pathname: `/${match[1]}` };
}

/** Only the observed /uc -> /download transition, or /download unchanged. */
export function isProgramTextPublicDrivePdfTransition(requestedUrl, finalUrl) {
  const requested = programTextPublicDrivePdfIdentity(requestedUrl);
  const final = programTextPublicDrivePdfIdentity(finalUrl);
  return !!requested && !!final && requested.file_id === final.file_id && final.pathname === "/download";
}

/** Existing-key provenance tag; it never substitutes for source approval. */
export function isProgramTextPublicDrivePdfMetadata(value) {
  return value?.source?.page_type === "pdf" && value?.acquisition === "pdf_text" &&
    value?.extractor?.name === "pdf-parse" && value?.extractor?.version === PROGRAM_TEXT_PUBLIC_DRIVE_PDF_VERSION &&
    isProgramTextPublicDrivePdfTransition(value.source.url, value.final_url);
}

export function isProgramTextPublicDrivePdfContentType(value) {
  return typeof value === "string" && /^application\/(?:pdf|octet-stream)(?:;|$)/i.test(value);
}

/** Necessary byte envelope only. Acquisition still requires a real all-page
 * native parse; a magic marker alone never establishes a complete document. */
export function hasProgramTextPublicDrivePdfEnvelope(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 11 && bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) &&
    /%%EOF[\x00\t\n\f\r ]*$/.test(bytes.subarray(-1024).toString("latin1"));
}
