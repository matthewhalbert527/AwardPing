import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createR2Client, getR2Bucket } from "@/lib/r2";
import monitoring from "../../config/program-text-monitoring.json";
import { loadProgramTextCapture } from "../../scripts/lib/program-text-artifacts.mjs";
import { prepareProgramTextSourceOperation, approveProgramTextSourceOperation, revokeProgramTextSourceOperation,
  loadProgramTextSourcePendingBundle, loadProgramTextSourceApprovalReceipt } from "../../scripts/lib/program-text-source-approval.mjs";

function context() {
  const client = createR2Client(), bucket = getR2Bucket();
  return { epoch: monitoring.epoch, loadCapture: (ref: Parameters<typeof loadProgramTextCapture>[0]) => loadProgramTextCapture(ref, { client, bucket }) };
}

/** Call only after the normal administrator and same-origin mutation checks. */
export const prepareProgramTextSource = (proposal: unknown, actor: string) =>
  prepareProgramTextSourceOperation(createSupabaseAdminClient(), proposal, actor, context());
export const approveProgramTextSource = (id: string, expectedHash: string, actor: string) =>
  approveProgramTextSourceOperation(createSupabaseAdminClient(), id, expectedHash, actor, context());
export const revokeProgramTextSource = (id: string, expectedHash: string, reason: string, actor: string) =>
  revokeProgramTextSourceOperation(createSupabaseAdminClient(), id, expectedHash, reason, actor);
export async function loadProgramTextSourcePending(id: string) {
  const db = createSupabaseAdminClient();
  const approved = await loadProgramTextSourceApprovalReceipt(db, id, { epoch: monitoring.epoch });
  if (approved) return { status: "approved_record", ...approved };
  const { descriptor, pending, proof } = await loadProgramTextSourcePendingBundle(db, id);
  return { ...descriptor, approved: false, current: false, already_approved: false, proposal: pending.validation.proposal, provider_link: pending.validation.provider_link,
    target_text: proof?.document.text ?? null, url_alias_boundary: pending.url_alias_boundary ?? [] };
}
