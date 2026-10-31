import { NextResponse } from "next/server";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { decideAlertReview } from "@/lib/alert-review.server";
import { loadAlertReviewBoard } from "@/lib/alert-groups.server";
import type { AlertReviewStatus } from "@/components/admin-alert-review-board";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
async function authorize() {
  const user = await getCurrentUser();
  return !user ? { error: reply({ error: "Sign in to review alerts." }, 401), actor: null } :
    !isSiteAdminEmail(user.email) ? { error: reply({ error: "Administrator access required." }, 403), actor: null } : { error: null, actor: user.id };
}
async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw Error("json");
  const limit = 4096;
  if (Number(request.headers.get("content-length")) > limit) throw Error("size");
  const reader = request.body?.getReader();
  if (!reader) throw Error("json");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) { await reader.cancel(); throw Error("size"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export async function GET(request: Request) {
  const auth = await authorize(); if (auth.error) return auth.error;
  const query = new URL(request.url).searchParams, status = query.get("status") ?? "pending";
  if ([...query.keys()].some(key => key !== "status") || query.getAll("status").length > 1 || !["pending", "approved", "dismissed"].includes(status)) {
    return reply({ error: "Choose one supported alert view." }, 400);
  }
  try { return reply(await loadAlertReviewBoard(status as AlertReviewStatus)); }
  catch { return reply({ error: "The alert list could not be confirmed. Refresh before reviewing." }, 409); }
}
export async function POST(request: Request) {
  const origin = validateSameOriginAdminMutation(request);
  if (origin) { Object.entries(headers).forEach(([key, value]) => origin.headers.set(key, value)); return origin; }
  const auth = await authorize(); if (auth.error) return auth.error;
  let value: unknown;
  try { value = await readBody(request); }
  catch (error) { return reply({ error: "Submit one bounded JSON alert decision." }, error instanceof Error && error.message === "size" ? 413 : 400); }
  if (!object(value) || Object.keys(value).length !== 3 || !["id", "expected_hash", "action"].every(key => Object.hasOwn(value, key)) ||
      typeof value.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id) ||
      typeof value.expected_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.expected_hash) || !["approve", "dismiss"].includes(value.action as string)) {
    return reply({ error: "The exact alert, version and decision are required." }, 400);
  }
  try {
    const result = await decideAlertReview({ id: value.id, expected_hash: value.expected_hash, action: value.action as "approve" | "dismiss" }, auth.actor!);
    return reply(result);
  } catch { return reply({ error: "The alert or its source evidence changed, or the decision was not confirmed. Refresh before trying again." }, 409); }
}
