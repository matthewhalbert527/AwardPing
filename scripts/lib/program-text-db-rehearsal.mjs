import { randomUUID } from "node:crypto";
import { buildProgramTextCapture } from "./program-text-capture.mjs";
import { programTextReference } from "./program-text-storage.mjs";
import { buildProgramTextComparison, buildProgramTextReviewPackets, validateProgramTextReviewResult } from "./program-text-review.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
function quotedBody(text, prefix) {
  let index = 0;
  while (text.includes(`$${prefix}_${index}$`)) index++;
  const tag = `$${prefix}_${index}$`;
  return `${tag}${text}${tag}`;
}
const jsonSql = value => `${quotedBody(JSON.stringify(value), "awardping_fixture_json")}::jsonb`;
const assertRejected = (label, statements, state = "23514") => `
  v_rejected:=false;
  begin
${statements}
  exception when sqlstate '${state}' then v_rejected:=true;
  end;
  assert v_rejected, '${label} was accepted';
  v_negatives:=v_negatives+1;`;

/** Build a reviewable rollback-only SQL probe. This module never opens a DB,
 * writes artifacts, calls providers, or claims that the synthetic facts are real. */
export function buildProgramTextDbRehearsal({ source, award_name = "Synthetic rollback contract probe", observed_at = new Date(Date.now() - 120_000).toISOString(),
  epoch = randomUUID(), candidate_id = randomUUID() } = {}) {
  if (!uuid(epoch) || !uuid(candidate_id) || !source || !uuid(source.id) || !uuid(source.shared_award_id) ||
      typeof award_name !== "string" || !award_name.trim() || award_name.length > 300 ||
      typeof observed_at !== "string" || !Number.isFinite(Date.parse(observed_at)) || new Date(observed_at).toISOString() !== observed_at ||
      Date.parse(observed_at) > Date.now() - 1000) throw new Error("Rehearsal requires source identity and past canonical observation time");
  const capture = (day, at) => {
    const text = `SYNTHETIC DATABASE REHEARSAL 🧪\nApplication deadline: October ${day}, 2098 at 5 p.m. UTC.`;
    return buildProgramTextCapture({ source, captured_at: at, acquisition: "http_html", extractor: { name: "synthetic-db-rehearsal", version: "1" },
      raw_bytes: Buffer.from(`<main><p>${text}</p></main>`), content_type: "text/html; charset=utf-8", text,
      blocks: [{ id: "synthetic-deadline", text, start_utf16: 0, end_utf16: text.length }] });
  };
  const previous = capture(1, new Date(Date.parse(observed_at) - 86400_000).toISOString()), current = capture(15, observed_at);
  const previousRef = programTextReference(previous), currentRef = programTextReference(current);
  const comparison = buildProgramTextComparison(previous, current, { epoch, cycle_id: null });
  const plan = buildProgramTextReviewPackets(comparison);
  if (plan.status !== "ready" || plan.packets.length !== 1 || comparison.changed_blocks.length !== 1) throw new Error("Rehearsal fixture did not produce one complete comparison");
  const row = comparison.changed_blocks[0], quote = block => ({ block_id: block.id, text: block.text.slice(block.text.indexOf("Application deadline:")) });
  const responses = [{ schema: "awardping.program-text-review.v1", comparison_id: comparison.comparison_id, packet_id: plan.packets[0].packet_id,
    ...comparison.context, blocks: [{ id: row.id, disposition: "program_change", reason: "Synthetic test only; this is not an observed award fact.", changes: [{
      field: "deadline", operation: "replace", summary: "The application deadline changed in this synthetic contract rehearsal.",
      previous_quote: quote(row.previous), current_quote: quote(row.current), applicant_impact: true,
    }] }] }];
  const validation = validateProgramTextReviewResult(comparison, plan, responses);
  if (validation.status !== "accepted") throw new Error("Rehearsal synthetic review did not validate");
  const details = validation.details;
  const baseline = { schema: "awardping.program-text-state.v1", epoch, status: "baseline_ready", baseline_ref: previousRef, latest_ref: previousRef,
    first_captured_at: previousRef.captured_at, last_checked_at: previousRef.captured_at, successful_checks: 1 };
  const awaiting = { ...baseline, status: "awaiting_review", latest_ref: currentRef, last_checked_at: currentRef.captured_at, successful_checks: 2 };
  const localization = { schema: "awardping.program-text-publication.v1", epoch, comparison_id: comparison.comparison_id, program_changes: details.program_changes,
    supporting_blocks: { previous: [row.previous], current: [row.current] } };
  const candidate = { id: candidate_id, shared_award_id: source.shared_award_id, shared_award_source_id: source.id,
    candidate_scope: "program_text_change", candidate_signature: comparison.comparison_id, source_url: source.url, source_title: source.title || null,
    source_page_type: source.page_type || null, previous_snapshot_ref: previousRef, new_snapshot_ref: currentRef,
    previous_text_hash: previousRef.text_sha256, new_text_hash: currentRef.text_sha256, status: "succeeded",
    deterministic_diff: { comparison_id: comparison.comparison_id, changed_blocks: 1 }, deterministic_classification: "program_text_review",
    prompt_payload: { comparison, packet_plan: plan, program_identity: { award_id: source.shared_award_id, award_name, source_url: source.url, source_title: source.title || null } },
    ai_result: { responses, program_text_validation: validation }, worker_metadata: { monitoring_contract: "program-text-v1", epoch,
      evidence_signature: comparison.comparison_id, bucket: "synthetic-rollback-only-not-uploaded", synthetic_rollback_rehearsal: true } };
  const columns = ["id", "shared_award_id", "shared_award_source_id", "candidate_scope", "candidate_signature", "source_url", "source_title", "source_page_type",
    "previous_snapshot_ref", "new_snapshot_ref", "previous_text_hash", "new_text_hash", "status", "deterministic_diff", "deterministic_classification", "prompt_payload", "ai_result", "worker_metadata"];
  const casts = new Map([["id", "uuid"], ["shared_award_id", "uuid"], ["shared_award_source_id", "uuid"],
    ...["previous_snapshot_ref", "new_snapshot_ref", "deterministic_diff", "prompt_payload", "ai_result", "worker_metadata"].map(key => [key, "jsonb"])]);
  const insertValues = columns.map(key => casts.get(key) === "jsonb" ? `v_candidate->'${key}'` : `(v_candidate->>'${key}')${casts.get(key) ? `::${casts.get(key)}` : ""}`);
  const body = `
declare
  v_source_id uuid:='${source.id}'; v_candidate_id uuid:='${candidate_id}';
  v_expected_identity jsonb:=${jsonSql({ id: source.id, shared_award_id: source.shared_award_id, url: source.url })};
  v_original_source jsonb; v_source jsonb; v_old_events bigint; v_old_candidates bigint; v_old_evidence bigint;
  v_baseline jsonb:=${jsonSql(baseline)}; v_awaiting jsonb:=${jsonSql(awaiting)};
  v_candidate jsonb:=${jsonSql(candidate)}; v_details jsonb:=${jsonSql(details)}; v_localization jsonb:=${jsonSql(localization)};
  v_evidence jsonb; v_bad jsonb; v_bad_candidate jsonb; v_bad_evidence jsonb; v_result jsonb; v_again jsonb;
  v_rejected boolean; v_negatives integer:=0; v_event_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
  select to_jsonb(s) into strict v_original_source from public.shared_award_sources s where id=v_source_id for update;
  assert v_original_source->'text_monitoring_state'='{}'::jsonb, 'Rehearsal refuses an existing text epoch';
  assert v_original_source->>'id'=v_expected_identity->>'id'
    and v_original_source->>'shared_award_id'=v_expected_identity->>'shared_award_id'
    and v_original_source->>'url'=v_expected_identity->>'url', 'Source identity changed';
  assert private.awardping_program_source_allowed(v_source_id), 'Source is not currently approved and required';
  select count(*) into v_old_events from public.shared_award_change_events where shared_award_source_id=v_source_id;
  select count(*) into v_old_candidates from public.shared_award_visual_review_candidates where shared_award_source_id=v_source_id;
  select count(*) into v_old_evidence from public.shared_award_change_event_visual_evidence where shared_award_source_id=v_source_id;
  assert not exists(select 1 from public.shared_award_visual_review_candidates where id=v_candidate_id), 'Fixture candidate already exists';
  assert private.awardping_program_utf16_length('A🧪B')=4, 'UTF16 non-BMP length mismatch';
  assert private.awardping_program_utf16_slice('A🧪B',1,3)='🧪', 'UTF16 non-BMP slice mismatch';
  assert private.awardping_program_utf16_slice('A🧪B',1,2) is null, 'Split surrogate accepted';
  perform public.set_program_text_source_state(v_source_id,'{}'::jsonb,v_baseline);
  assert (select text_monitoring_state from public.shared_award_sources where id=v_source_id)=v_baseline, 'Initial baseline did not persist inside transaction';
  assert (select count(*) from public.shared_award_change_events where shared_award_source_id=v_source_id)=v_old_events, 'Initial coverage created an update';
  assert (select count(*) from public.shared_award_visual_review_candidates where shared_award_source_id=v_source_id)=v_old_candidates, 'Initial coverage queued a review';
  assert (select count(*) from public.shared_award_change_event_visual_evidence where shared_award_source_id=v_source_id)=v_old_evidence, 'Initial coverage created evidence';
${assertRejected("Stale source CAS", "    perform public.set_program_text_source_state(v_source_id,'{}'::jsonb,v_awaiting);", "40001")}
${assertRejected("False successful-check counter", "    perform public.set_program_text_source_state(v_source_id,v_baseline,jsonb_set(v_awaiting,'{successful_checks}','9'::jsonb));")}
${assertRejected("Wrong source identity", "    perform public.set_program_text_source_state(v_source_id,v_baseline,jsonb_set(v_awaiting,'{latest_ref,source,shared_award_id}',to_jsonb('70000000-0000-0000-0000-000000000001'::text)));")}
${assertRejected("Changed monitoring epoch", "    perform public.set_program_text_source_state(v_source_id,v_baseline,jsonb_set(v_awaiting,'{epoch}',to_jsonb('80000000-0000-0000-0000-000000000001'::text)));")}
  insert into public.shared_award_visual_review_candidates(${columns.join(",")}) values(${insertValues.join(",")});
  perform public.set_program_text_source_state(v_source_id,v_baseline,v_awaiting);
  v_evidence:=jsonb_build_object('change_event_id','90000000-0000-0000-0000-000000000001',
    'shared_award_id',v_candidate->'shared_award_id','shared_award_source_id',v_candidate->'shared_award_source_id',
    'visual_review_candidate_id',v_candidate_id,'candidate_signature',v_candidate->'candidate_signature',
    'bucket',v_candidate#>'{worker_metadata,bucket}','evidence_schema_version','program-text-event-evidence-v1',
    'evidence_status','verified_text','previous_capture',v_candidate->'previous_snapshot_ref','current_capture',v_candidate->'new_snapshot_ref',
    'localization',v_localization,'verified_at',clock_timestamp());
  perform public.awardping_validate_program_text_evidence(v_evidence,v_candidate,v_details);
${assertRejected("Malformed exact quotation", `    v_bad:=jsonb_set(v_details,'{program_changes,0,current_quote,end_utf16}',to_jsonb((v_details#>>'{program_changes,0,current_quote,end_utf16}')::integer+1));
    v_bad_candidate:=jsonb_set(v_candidate,'{ai_result,program_text_validation,details}',v_bad);
    v_bad_evidence:=jsonb_set(v_evidence,'{localization,program_changes}',v_bad->'program_changes');
    perform public.awardping_validate_program_text_evidence(v_bad_evidence,v_bad_candidate,v_bad);`)}
${assertRejected("Wrong event source", "    perform public.awardping_validate_program_text_evidence(jsonb_set(v_evidence,'{shared_award_source_id}',to_jsonb('70000000-0000-0000-0000-000000000001'::text)),v_candidate,v_details);")}
${assertRejected("Wrong publication epoch", "    perform public.publish_program_text_event(v_candidate_id,v_details,jsonb_set(v_localization,'{epoch}',to_jsonb('80000000-0000-0000-0000-000000000001'::text)));")}
${assertRejected("Missing program-change summary", `    v_bad:=v_details-'summary';
    v_bad_candidate:=jsonb_set(v_candidate,'{ai_result,program_text_validation,details}',v_bad);
    perform public.awardping_validate_program_text_evidence(v_evidence,v_bad_candidate,v_bad);`)}
  assert v_negatives=8, 'A negative contract check did not run';
  assert (select count(*) from public.shared_award_change_events where shared_award_source_id=v_source_id)=v_old_events, 'A rejected comparison leaked an event';
  v_result:=public.publish_program_text_event(v_candidate_id,v_details,v_localization);
  assert v_result->>'published'='true' and v_result->>'already_published'='false', 'Positive publication did not succeed';
  v_event_id:=(v_result->>'event_id')::uuid;
  set constraints all immediate;
  assert (select count(*) from public.shared_award_change_events where shared_award_source_id=v_source_id)=v_old_events+1, 'Publication event count mismatch';
  assert (select count(*) from public.shared_award_visual_review_candidates where shared_award_source_id=v_source_id)=v_old_candidates+1, 'Candidate count mismatch';
  assert (select count(*) from public.shared_award_change_event_visual_evidence where shared_award_source_id=v_source_id)=v_old_evidence+1, 'Evidence count mismatch';
  assert exists(select 1 from public.shared_award_change_events e join public.shared_award_change_event_visual_evidence proof on proof.change_event_id=e.id
    where e.id=v_event_id and e.visual_review_candidate_id=v_candidate_id and e.change_details=v_details and e.summary=v_details->>'summary'
    and proof.visual_review_candidate_id=v_candidate_id and proof.candidate_signature=v_candidate->>'candidate_signature'
    and proof.evidence_schema_version='program-text-event-evidence-v1' and proof.evidence_status='verified_text'
    and proof.previous_capture=v_candidate->'previous_snapshot_ref' and proof.current_capture=v_candidate->'new_snapshot_ref'
    and proof.localization=v_localization and proof.verified_at is not null), 'Published event/evidence is not exact';
  assert exists(select 1 from public.shared_award_visual_review_candidates c where c.id=v_candidate_id and c.status='published'
    and c.worker_metadata->>'change_event_id'=v_event_id::text and c.worker_metadata->>'baseline_advanced'='true'), 'Candidate reverse binding missing';
  select to_jsonb(s) into strict v_source from public.shared_award_sources s where id=v_source_id;
  assert v_source#>'{text_monitoring_state,baseline_ref}'=v_candidate->'new_snapshot_ref'
    and v_source#>'{text_monitoring_state,latest_ref}'=v_candidate->'new_snapshot_ref'
    and v_source#>>'{text_monitoring_state,successful_checks}'='2'
    and v_source#>>'{text_monitoring_state,first_captured_at}'=v_baseline->>'first_captured_at'
    and v_source#>>'{text_monitoring_state,last_program_update_at}' is not null, 'Publication state or coverage count mismatch';
  assert v_source-array['text_monitoring_state','last_checked_at','next_check_at','updated_at']=
    v_original_source-array['text_monitoring_state','last_checked_at','next_check_at','updated_at'], 'Rehearsal altered unrelated source fields';
  v_again:=public.publish_program_text_event(v_candidate_id,v_details,v_localization);
  assert v_again->>'event_id'=v_event_id::text and v_again->>'already_published'='true', 'Publication is not idempotent';
  set constraints all immediate;
  assert (select count(*) from public.shared_award_change_events where shared_award_source_id=v_source_id)=v_old_events+1, 'Idempotency created duplicate events';
  assert (select text_monitoring_state#>>'{successful_checks}' from public.shared_award_sources where id=v_source_id)='2', 'Idempotency changed coverage counts';
  raise notice 'AwardPing synthetic text DB rehearsal passed; transaction will roll back.';
end;
`;
  const sql = `-- SYNTHETIC CONTRACT TEST ONLY. No uploads, paid reviews, or committed award facts.\nbegin;\nset local role service_role;\nset local lock_timeout='2s';\nset local statement_timeout='30s';\nset local plpgsql.check_asserts=on;\ndo ${quotedBody(body, "awardping_program_rehearsal")};\nrollback;\n`;
  return { schema: "awardping.program-text-db-rehearsal.v1", source: { ...source }, epoch, candidate_id,
    comparison_id: comparison.comparison_id, fixture: { previous: previousRef, current: currentRef, baseline, awaiting, candidate, details, localization }, sql,
    after_rollback_query: `select jsonb_build_object('source_state_empty',s.text_monitoring_state='{}'::jsonb,'candidate_absent',not exists(select 1 from public.shared_award_visual_review_candidates where id='${candidate_id}'::uuid),'event_absent',not exists(select 1 from public.shared_award_change_events where visual_review_candidate_id='${candidate_id}'::uuid),'evidence_absent',not exists(select 1 from public.shared_award_change_event_visual_evidence where visual_review_candidate_id='${candidate_id}'::uuid)) as rollback_verified from public.shared_award_sources s where s.id='${source.id}'::uuid;` };
}
