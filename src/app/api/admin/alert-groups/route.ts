import { NextResponse } from "next/server";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import { validateSameOriginAdminMutation } from "@/lib/admin-request-security";
import { previewAlertGroup, saveAlertGroup, decideAlertGroup } from "@/lib/alert-groups.server";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
async function authorize() {
  const user = await getCurrentUser();
  return !user ? { error: reply({ error: "Sign in to review alerts." }, 401), actor: null } : !isSiteAdminEmail(user.email)
    ? { error: reply({ error: "Administrator access required." }, 403), actor: null } : { error: null, actor: user.id };
}
async function body(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw Error("json");
  if (Number(request.headers.get("content-length")) > 4096) throw Error("size");
  const reader = request.body?.getReader(); if (!reader) throw Error("json");
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
    if (size > 4096) { await reader.cancel(); throw Error("size"); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function GET(request: Request) {
  const auth = await authorize(); if (auth.error) return auth.error;
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(k => !["source", "target"].includes(k)) || query.getAll("source").length !== 1 || query.getAll("target").length !== 1 || !uuid(query.get("source")) || !uuid(query.get("target"))) return reply({ error: "Choose two exact recent updates." }, 400);
  try { return reply({ ok: true, preview: await previewAlertGroup(query.get("source")!, query.get("target")!) }); }
  catch { return reply({ error: "These updates could not be combined. Refresh and choose recent updates for the same award." }, 409); }
}
export async function POST(request: Request) {
  const origin = validateSameOriginAdminMutation(request);
  if (origin) { Object.entries(headers).forEach(([k, v]) => origin.headers.set(k, v)); return origin; }
  const auth = await authorize(); if (auth.error) return auth.error;
  let value: unknown;
  try { value = await body(request); } catch (e) { return reply({ error: "Submit one bounded JSON combined-update action." }, e instanceof Error && e.message === "size" ? 413 : 400); }
  if (!object(value)) return reply({ error: "Choose an explicit combined-update action." }, 400);
  try {
    if (value.action === "save") {
      if (!exact(value, ["action", "group_id", "expected_hash", "members"]) || !(value.group_id === null && value.expected_hash === null || uuid(value.group_id) && hash(value.expected_hash)) || !Array.isArray(value.members) || value.members.length < 2 || value.members.length > 8 || value.members.some(m => !object(m) || !exact(m, ["id", "content_hash"]) || !uuid(m.id) || !hash(m.content_hash)) || new Set(value.members.map(m => m.id)).size !== value.members.length) return reply({ error: "Choose the exact previewed members and version." }, 400);
      return reply(await saveAlertGroup({ group_id: value.group_id as string | null, expected_hash: value.expected_hash as string | null, members: value.members }, auth.actor!));
    }
    if (!["approve", "undo"].includes(value.action as string) || !exact(value, ["action", "id", "expected_hash"]) || !uuid(value.id) || !hash(value.expected_hash)) return reply({ error: "Choose the exact combined draft and version." }, 400);
    return reply(await decideAlertGroup({ id: value.id, expected_hash: value.expected_hash, action: value.action as "approve" | "undo" }, auth.actor!));
  } catch { return reply({ error: "The combined draft or original evidence changed, or the operation was not confirmed. Refresh before trying again." }, 409); }
}
