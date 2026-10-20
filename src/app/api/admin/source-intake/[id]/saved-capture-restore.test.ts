import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({
  user: { email: "admin@awardping.com" } as { email: string } | null,
  admin: true, origin: false, verifierFails: false, stale: false,
  current: {} as Record<string, unknown>, effects: [] as Array<Record<string, unknown>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-request-security", () => ({ validateSameOriginAdminMutation: () =>
  state.origin ? new Response("Forbidden", { status: 403 }) : null }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => state.user, isSiteAdminEmail: () => state.admin }));
vi.mock("@/lib/config", () => ({ hasSupabaseAdminConfig: () => true, hasSupabaseConfig: () => true,
  appConfig: { r2Bucket: "test-bucket", r2Endpoint: "https://example.r2.cloudflarestorage.com", r2AccessKeyId: "test", r2SecretAccessKey: "test" } }));
vi.mock("../../../../../../scripts/lib/intake-artifact-r2-verification.mjs", () => ({
  IntakeArtifactRetentionError: class extends Error {},
  verifySavedFirstObservationHtmlCapture: vi.fn(async () => {
    state.effects.push({ type: "verify" });
    if (state.verifierFails) throw new Error("secret-key-and-private-path");
    return { capture: { text: "Sealed text.", captured_at: "2026-10-18T00:00:00.000Z", retained_artifact: { request_id: "request" } },
      evidence: { file_sha256: "a".repeat(64) } };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({
  from: (table: string) => {
    let patch: Record<string, unknown> | null = null;
    const filters: Array<unknown[]> = [];
    const q = { select: () => q, eq: (k: string,v: unknown) => { filters.push(["eq",k,v]); return q; },
      is: (k: string,v: unknown) => { filters.push(["is",k,v]); return q; },
      update: (p: Record<string, unknown>) => { patch=p; state.effects.push({type:"update",table,patch:p,filters}); return q; },
      maybeSingle: async () => ({ data: patch ? (state.stale ? null : {...state.current,...patch}) : state.current, error: null }) };
    return q;
  },
}) }));

import { PATCH } from "./route";
const id="11111111-1111-4111-8111-111111111111";
const at="2026-10-19T00:00:00.000Z";
const saved={retained_artifact:{request_id:id}, description:"Untrusted description must not activate"};
const request=(body: unknown={action:"restore_saved_capture",savedCaptureMetadata:saved,expectedUpdatedAt:at}) => new Request(
  `https://awardping.com/api/admin/source-intake/${id}`, {method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const context={params:Promise.resolve({id})};

describe("authenticated saved first-observation restoration", () => {
  beforeEach(() => {
    state.user={email:"admin@awardping.com"};state.admin=true;state.origin=false;state.verifierFails=false;state.stale=false;state.effects=[];
    state.current={id,status:"needs_manual_review",status_reason:"intake_local_conflict",updated_at:at,worker_run_id:null,
      capture_metadata:{captured_at:"2026-10-19T00:00:00.000Z",text:"failed refetch"},ai_review:{raw:{finishReason:"MAX_TOKENS"}},
      deterministic_review:{old:true},discovered_links:{links:["old"]},error:"old failure",failed_at:at,matched_shared_award_id:"award"};
  });
  it("restores only sealed core into manual hold and retains the complete failed row and original supplied JSON", async () => {
    const before=structuredClone(state.current);
    const r=await PATCH(request(),context);expect(r.status).toBe(200);
    const effect=state.effects.find(e=>e.type==="update")!;
    const p=effect.patch as Record<string,unknown>;
    expect(Object.keys(p).sort()).toEqual(["capture_metadata","discovered_links","status","status_reason","updated_at"]);
    expect(p.discovered_links).toEqual({links:[],pdf_links:[]});
    expect(p.status).toBe("needs_manual_review");expect(p.status_reason).toBe("saved_original_capture_restored_manual_review");
    const cap=p.capture_metadata as Record<string,unknown>;
    expect(cap).not.toHaveProperty("description");
    const audit=cap.saved_first_observation_restore as Record<string,unknown>;
    expect(audit.previous_request).toEqual(before);expect(audit.supplied_original_capture_metadata).toEqual(saved);
    expect(audit.digest_encoding).toBe("canonical-json-recursive-sorted-object-keys-v1");
    expect(audit).toMatchObject({creates_api_charge:false,queues_review:false,approves_source:false,publishes_update:false});
    expect(effect.filters).toContainEqual(["eq","updated_at",at]);
    expect(effect.filters).toContainEqual(["eq","status_reason","intake_local_conflict"]);
    expect(effect.filters).toContainEqual(["is","worker_run_id",null]);
    expect(state.current).toEqual(before);
    expect((await r.json()).retry).toMatchObject({creates_api_charge:false,refetches_page:false,runs_ai_review:false});
  });
  it.each(["signed_out","not_admin","cross_origin"])("rejects %s before verification or mutation", async mode => {
    if(mode==="signed_out")state.user=null;if(mode==="not_admin")state.admin=false;if(mode==="cross_origin")state.origin=true;
    expect((await PATCH(request(),context)).status).toBe(mode==="signed_out"?401:403);expect(state.effects).toEqual([]);
  });
  it.each(["stale_timestamp","owned_row","oversize_input","oversize_audit"])("rejects %s before verification", async mode => {
    let body: unknown;
    if(mode==="stale_timestamp")body={action:"restore_saved_capture",savedCaptureMetadata:saved,expectedUpdatedAt:"old"};
    if(mode==="owned_row")state.current.worker_run_id="someone";
    if(mode==="oversize_input")body={action:"restore_saved_capture",savedCaptureMetadata:{value:"x".repeat(129*1024)},expectedUpdatedAt:at};
    if(mode==="oversize_audit")state.current.ai_review={old:"x".repeat(2*1024*1024)};
    const response=await PATCH(request(body),context);expect([400,409]).toContain(response.status);expect(state.effects).toEqual([]);
  });
  it("never leaks a verifier failure or mutates after it", async () => {
    state.verifierFails=true;const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    const r=await PATCH(request(),context);expect(r.status).toBe(500);expect(JSON.stringify(await r.json())).not.toContain("secret-key");
    expect(state.effects).toEqual([{type:"verify"}]);expect(JSON.stringify(log.mock.calls)).not.toContain("secret-key");log.mockRestore();
  });
  it("reports a lost CAS without retry, pending status or source approval", async () => {
    state.stale=true;const r=await PATCH(request(),context);expect(r.status).toBe(409);
    expect(state.effects.map(e=>e.type)).toEqual(["verify","update"]);
  });
  it("keeps audit digests reproducible after JSONB changes object-key order", async () => {
    await PATCH(request(),context);
    const p=state.effects.find(e=>e.type==="update")!.patch as Record<string,unknown>;
    const cap=p.capture_metadata as Record<string,unknown>;
    const audit=cap.saved_first_observation_restore as Record<string,unknown>;
    const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==="object"
      ?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])):value;
    const sorted=(value:unknown):unknown=>Array.isArray(value)?value.map(sorted):value&&typeof value==="object"
      ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,sorted(v)])):value;
    const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(sorted(reorder(value)))).digest("hex");
    expect(digest(audit.previous_request)).toBe(audit.previous_request_sha256);
    expect(digest(audit.supplied_original_capture_metadata)).toBe(audit.supplied_original_capture_metadata_sha256);
  });
  it("does not send a malformed restore action to the generic pending fallback", async () => {
    const r=await PATCH(request({action:"restore_saved_capture",savedCaptureMetadata:[],expectedUpdatedAt:at}),context);
    expect(r.status).toBe(400);expect(state.effects).toEqual([]);
  });
  it("caps the actual request stream before parsing", async () => {
    const r=await PATCH(request({value:"x".repeat(257*1024)}),context);expect(r.status).toBe(400);expect(state.effects).toEqual([]);
  });
});
