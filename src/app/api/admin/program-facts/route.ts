import { NextResponse } from "next/server";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { loadProgramFactBatch, loadProgramFactProposal, saveProgramFactProposal, prepareProgramFactProposal,
  approveProgramFactProposal, publishProgramFactBatch } from "@/lib/program-fact-review.server";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(key => Object.hasOwn(v, key));
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

async function authorize() {
  const user = await getCurrentUser();
  return !user ? { response: reply({ ok: false, error: "Sign in to review awards." }, 401), actor: null }
    : !isSiteAdminEmail(user.email) ? { response: reply({ ok: false, error: "Administrator access required." }, 403), actor: null }
      : { response: null, actor: user.id };
}

// Bound the bytes before JSON parsing; Content-Length alone is not trustworthy.
async function readBody(request: Request) {
  const limit = 4 * 1024 * 1024;
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("json");
  if (Number(request.headers.get("content-length")) > limit) throw new Error("size");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("json");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("size"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function GET(request: Request) {
  const auth = await authorize();
  if (auth.response) return auth.response;
  const id = new URL(request.url).searchParams.get("review");
  if (id !== null && !uuid(id)) return reply({ ok: false, error: "Choose one saved review." }, 400);
  try { return reply(id ? await loadProgramFactProposal(id) : await loadProgramFactBatch()); }
  catch { return reply({ ok: false, error: "The current review or its complete saved sources are unavailable. No approval changed." }, 409); }
}

export async function POST(request: Request) {
  const originError = validateSameOriginAdminMutation(request);
  if (originError) { Object.entries(headers).forEach(([k, v]) => originError.headers.set(k, v)); return originError; }
  const auth = await authorize();
  if (auth.response) return auth.response;
  let body: unknown;
  try { body = await readBody(request); }
  catch (error) { return reply({ ok: false, error: "Submit a bounded JSON award review." }, error instanceof Error && error.message === "size" ? 413 : 400); }
  if (!object(body)) return reply({ ok: false, error: "Choose an explicit review action." }, 400);
  const actor = auth.actor!;
  try {
    let result: unknown;
    if (body.action === "save" && keys(body, ["action", "review"]) && object(body.review)) {
      result = await saveProgramFactProposal(body.review, actor);
    } else if (body.action === "prepare" && keys(body, ["action", "cohort", "cycle"]) &&
      typeof body.cohort === "string" && /^[a-z0-9_-]{1,80}$/.test(body.cohort) &&
      typeof body.cycle === "string" && body.cycle.trim().length > 0 && body.cycle.length <= 120) {
      result = await prepareProgramFactProposal(body.cohort, body.cycle, actor);
    } else if (body.action === "approve" && keys(body, ["action", "id", "expected_hash"]) && uuid(body.id) &&
      typeof body.expected_hash === "string" && /^[a-f0-9]{64}$/.test(body.expected_hash)) {
      result = await approveProgramFactProposal(body.id, body.expected_hash, actor);
    } else if (body.action === "publish" && keys(body, ["action", "expected_revision", "review_ids"]) && uuid(body.expected_revision) &&
      object(body.review_ids) && Object.keys(body.review_ids).length === 25 && Object.entries(body.review_ids).every(([k, v]) => /^[a-z0-9_-]{1,80}$/.test(k) && uuid(v))) {
      result = await publishProgramFactBatch(body.expected_revision, body.review_ids as Record<string, string>, actor);
    } else return reply({ ok: false, error: "Invalid or incomplete review action. Nothing changed." }, 400);
    return reply({ ok: true, result });
  } catch { return reply({ ok: false, error: "Current sources, support passages, or review versions failed validation. Reload and resolve the award before approval or publication." }, 409); }
}
