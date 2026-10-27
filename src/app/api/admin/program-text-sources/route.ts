import { NextResponse } from "next/server";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { approveProgramTextSource, loadProgramTextSourcePending, prepareProgramTextSource, revokeProgramTextSource,
  inspectProgramTextPappgCanonical, prepareProgramTextPappgCanonical } from "@/lib/program-text-source-approval.server";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
async function authorize() {
  const user = await getCurrentUser();
  return !user ? { error: reply({ error: "Sign in to review a source." }, 401), actor: null }
    : !isSiteAdminEmail(user.email) ? { error: reply({ error: "Administrator access required." }, 403), actor: null } : { error: null, actor: user.id };
}
async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw Error("json");
  const limit = 256 * 1024;
  if (Number(request.headers.get("content-length")) > limit) throw Error("size");
  const reader = request.body?.getReader(); if (!reader) throw Error("json");
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength;
    if (length > limit) { await reader.cancel(); throw Error("size"); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export async function GET(request: Request) {
  const auth = await authorize(); if (auth.error) return auth.error;
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].length === 1 && query.getAll("inspection").length === 1 && query.get("inspection") === "pappg") {
    try { return reply(await inspectProgramTextPappgCanonical()); }
    catch { return reply({ error: "The preserved PAPPG catalogue could not be confirmed." }, 409); }
  }
  if ([...query.keys()].some(key => key !== "id") || query.getAll("id").length !== 1 || !uuid(query.get("id"))) return reply({ error: "Choose one pending source." }, 400);
  try { return reply(await loadProgramTextSourcePending(query.get("id")!)); }
  catch { return reply({ error: "The pending source or its saved proof could not be confirmed." }, 409); }
}
export async function POST(request: Request) {
  const origin = validateSameOriginAdminMutation(request);
  if (origin) { Object.entries(headers).forEach(([key, value]) => origin.headers.set(key, value)); return origin; }
  const auth = await authorize(); if (auth.error) return auth.error;
  let value: unknown;
  try { value = await body(request); }
  catch (error) { return reply({ error: "Submit one bounded JSON source operation." }, error instanceof Error && error.message === "size" ? 413 : 400); }
  if (!object(value)) return reply({ error: "Choose an explicit source operation." }, 400);
  try {
    let result: unknown;
    if (value.action === "prepare" && exact(value, ["action", "proposal"]) && object(value.proposal)) result = await prepareProgramTextSource(value.proposal, auth.actor!);
    else if (value.action === "prepare_pappg_canonical" && exact(value, ["action", "proposal", "catalogue_disposition"]) && object(value.proposal) && object(value.catalogue_disposition))
      result = await prepareProgramTextPappgCanonical(value.proposal, value.catalogue_disposition, auth.actor!);
    else if (value.action === "approve" && exact(value, ["action", "id", "expected_hash"]) && uuid(value.id) && hash(value.expected_hash)) result = await approveProgramTextSource(value.id, value.expected_hash, auth.actor!);
    else if (value.action === "revoke" && exact(value, ["action", "id", "expected_hash", "reason"]) && uuid(value.id) && hash(value.expected_hash) && typeof value.reason === "string" && value.reason.trim().length >= 20 && value.reason.length <= 2000) result = await revokeProgramTextSource(value.id, value.expected_hash, value.reason, auth.actor!);
    else return reply({ error: "Invalid or incomplete source operation." }, 400);
    return reply({ ok: true, result });
  } catch { return reply({ error: "Source ownership, retained proof, or approval versions failed validation. No successful operation was confirmed." }, 409); }
}
