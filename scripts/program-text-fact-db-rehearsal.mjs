#!/usr/bin/env node
/** Generates a rollback-only SQL runtime rehearsal. It never executes SQL or
 * creates provider/capture/storage requests. All synthetic facts say TEST ONLY. */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { buildProgramTextCapture } from "./lib/program-text-capture.mjs";
import { programTextReference } from "./lib/program-text-storage.mjs";
import { emptyProgramFactReview, validateProgramFactReview } from "./lib/program-text-facts.mjs";
import { prepareSupabaseServiceHeaders } from "./supabase-service-client.mjs";

const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const uuid = x => typeof x === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const quoteSql = text => "'" + String(text).replaceAll("'", "''") + "'";
const digestSql = expression => `encode(extensions.digest(convert_to(coalesce((${expression}),''),'UTF8'),'sha256'),'hex')`;
const canonical = x => Array.isArray(x) ? x.map(canonical) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, canonical(x[key])])) : x;
const jsonSql = value => `${quoteSql(JSON.stringify(value))}::jsonb`;

export function factDbRehearsalVerificationQuery(sourceIds) {
  const ids = sourceIds.map(quoteSql).join(",");
  return `select jsonb_build_object(
 'source_count',(select count(*) from public.shared_award_sources where id in (${ids})),
 'source_states_sha256',${digestSql(`select string_agg(jsonb_build_object('id',id,'owner',shared_award_id,'url',url,'status',admin_review_status,'state',text_monitoring_state,'last_checked_at',last_checked_at,'next_check_at',next_check_at,'updated_at',updated_at,'legacy_page_metadata',page_metadata)::text,'|' order by id) from public.shared_award_sources where id in (${ids})`)},
 'roster_sha256',${digestSql("select string_agg(to_jsonb(r)::text,'|' order by cohort_key,source_role) from public.program_text_source_roster r")},
 'legacy_registry_sha256',${digestSql("select string_agg(to_jsonb(r)::text,'|' order by cohort_key) from public.stage1_award_registry r")},
 'legacy_fact_ledger_sha256',${digestSql("select string_agg(to_jsonb(r)::text,'|' order by id) from public.stage1_award_fact_publication_ledger r")},
 'text_queue_sha256',${digestSql("select string_agg(to_jsonb(r)::text,'|' order by id) from public.shared_award_visual_review_candidates r where candidate_scope='program_text_change'")},
 'failed_text_reviews',(select count(*) from public.shared_award_visual_review_candidates where candidate_scope='program_text_change' and status='failed'),
 'fact_reviews',(select count(*) from public.program_text_fact_reviews),
 'fact_review_events',(select count(*) from public.program_text_fact_review_events),
 'roster_events',(select count(*) from public.program_text_source_roster_events),
 'release',(select to_jsonb(r) from public.program_text_fact_release r where release_key='national-25-text-facts')
 ) as rollback_verification;`;
}

function fixtureCapture(source, at) {
  const text = "🎓 TEST ONLY — fictitious SQL runtime rehearsal; never award advice. " +
    "TEST ONLY opening dates: January 1, 2027 and February 1, 2027. " +
    "TEST ONLY deadlines: January 31, 2027 and March 31, 2027. " +
    "TEST ONLY statuses: Open and Upcoming. TEST ONLY funding: $100; stipend $20; tuition $30; travel $40. " +
    "TEST ONLY application: https://example.invalid/apply";
  return buildProgramTextCapture({ source: { id: source.id, shared_award_id: source.shared_award_id, url: source.url },
    acquisition: "http_html", captured_at: at, extractor: { name: "TEST ONLY SQL runtime fixture", version: "1" },
    raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), content_type: "text/html", text,
    blocks: [{ id: "TEST-ONLY-body", text, start_utf16: 0, end_utf16: text.length }] });
}

/** All input rows must come from one normal read-only roster snapshot. */
export async function generateProgramFactDbRehearsal({ registries, roles, members, sources, epoch, now = new Date(), expectedAwards = 25, expectedSources = 124 }) {
  if (!Array.isArray(registries) || registries.length !== expectedAwards || !Array.isArray(roles) || !Array.isArray(members) ||
    !Array.isArray(sources) || sources.length !== expectedSources || !uuid(epoch) || !Number.isFinite(now.getTime())) throw new Error("Incomplete rehearsal scope.");
  const ids = [...new Set(roles.flatMap(role => role.source_ids))].sort();
  if (ids.length !== sources.length || !ids.every(uuid) || new Set(registries.map(row => row.cohort_key)).size !== expectedAwards ||
    new Set(sources.map(row => row.id)).size !== sources.length || sources.some(source => !ids.includes(source.id) || source.admin_review_status !== "open")) throw new Error("Rehearsal source identity mismatch.");
  const firstAt = new Date(now.getTime() - 180_000).toISOString(), currentAt = new Date(now.getTime() - 120_000).toISOString(), advanceAt = new Date(now.getTime() - 60_000).toISOString();
  const captures = new Map(sources.map(source => [source.id, fixtureCapture(source, currentAt)]));
  const fixtureSources = sources.map(source => {
    // Construct both observations through the real capture builder; the first
    // becomes historical only inside this uncommitted SQL fixture.
    fixtureCapture(source, firstAt);
    const ref = programTextReference(captures.get(source.id));
    return { ...source, text_monitoring_state: { schema: "awardping.program-text-state.v1", epoch, status: "baseline_ready",
      successful_checks: 2, first_captured_at: firstAt, last_checked_at: currentAt, baseline_ref: ref, latest_ref: ref } };
  });
  const validations = [];
  for (const registry of [...registries].sort((a, b) => a.cohort_key.localeCompare(b.cohort_key))) {
    const programRoles = roles.filter(role => role.cohort_key === registry.cohort_key);
    const required = [...new Set(programRoles.flatMap(role => role.source_ids))];
    const context = { registry, roles: programRoles, sources: fixtureSources.filter(source => required.includes(source.id)),
      memberIds: members.filter(member => member.cohort_key === registry.cohort_key).map(member => member.shared_award_id), epoch,
      loadCapture: async ref => captures.get(ref.source.id), forApproval: true };
    const review = emptyProgramFactReview({ ...context, cycle: "TEST ONLY 2027 runtime fixture" }); review.reviewed_all_sources = true;
    for (const field of review.fields) { field.status = "not_published"; field.note = "TEST ONLY: this synthetic complete context intentionally publishes no real program detail."; }
    const source = context.sources[0], capture = captures.get(source.id);
    const support = text => [{ source_id: source.id, capture_id: capture.capture_id, block_id: capture.blocks[0].id,
      start_utf16: capture.text.indexOf(text), end_utf16: capture.text.indexOf(text) + text.length, text }];
    const set = (name, values) => { const field = review.fields.find(field => field.field === name); field.status = "verified";
      field.items = values.map(([value, track, text]) => ({ value, track, support: support(text) })); };
    set("overview", [["TEST ONLY — fictitious SQL runtime rehearsal; never award advice.", null, "TEST ONLY — fictitious SQL runtime rehearsal; never award advice."]]);
    set("opening_date", [["January 1, 2027", "TEST ONLY Track A", "January 1, 2027"], ["February 1, 2027", "TEST ONLY Track B", "February 1, 2027"]]);
    set("deadline", [["January 31, 2027", "TEST ONLY Track A", "January 31, 2027"], ["March 31, 2027", "TEST ONLY Track B", "March 31, 2027"]]);
    set("cycle_status", [["Open", "TEST ONLY Track A", "Open"], ["Upcoming", "TEST ONLY Track B", "Upcoming"]]);
    set("award_amounts", [["TEST ONLY $100", null, "$100"]]); set("stipend", [["TEST ONLY $20", null, "$20"]]);
    set("tuition", [["TEST ONLY $30", null, "$30"]]); set("travel_research_allowance", [["TEST ONLY $40", null, "$40"]]);
    set("application_url", [["https://example.invalid/apply", null, "https://example.invalid/apply"]]);
    validations.push(await validateProgramFactReview(review, context));
  }
  const original = sources.map(source => ({ id: source.id, shared_award_id: source.shared_award_id, url: source.url,
    admin_review_status: source.admin_review_status,
    // Existing source-state values contain integer counters and strings only.
    // The reviewed legacy canonical serializer has matching key ordering; bind
    // its hash instead of embedding every private historical reference twice.
    state_sha256: createHash("sha256").update(JSON.stringify(canonical(source.text_monitoring_state))).digest("hex") }));
  const payload = { sources: original, roster: roles.map(role => ({ cohort_key: role.cohort_key, source_role: role.source_role,
    revision: role.revision, source_ids: role.source_ids, evidence: role.evidence, manifest_status: role.manifest_status })),
    epoch, first_captured_at: firstAt,
    states: fixtureSources.map(source => ({ id: source.id, reference: source.text_monitoring_state.latest_ref })),
    // Transport each reference once per proof; SQL restores the original full
    // proof before calling its unchanged exact-schema/hash/quotation validator.
    validations: validations.map(validation => ({ ...validation, source_text: validation.source_text.map(({ reference, ...doc }) => ({ ...doc, source_id: reference.source.id })) })),
    advance_ref: programTextReference(fixtureCapture(fixtureSources[0], advanceAt)) };
  const payloadLiteral = jsonSql(payload);
  const query = `-- TEST ONLY: synthetic details never survive this transaction. No COMMIT.
BEGIN;
SET LOCAL statement_timeout='45s';
SET LOCAL lock_timeout='1s';
SET LOCAL idle_in_transaction_session_timeout='60s';
DO $awardping_rehearsal$
DECLARE p jsonb:=${payloadLiteral}; v jsonb; first_validation jsonb; bad jsonb; saved jsonb; duplicate_saved jsonb; approved jsonb;
 ids jsonb:='{}'; release_before public.program_text_fact_release%rowtype; published jsonb; snapshot jsonb;
 rejected boolean; source_id uuid; source_state jsonb; next_state jsonb; original_role public.program_text_source_roster%rowtype;
 changed_role jsonb; owner_role text:=current_user; deadline_index integer; absent_index integer; field_path text[];
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('stage1-national-25-release',0)) THEN
  RAISE EXCEPTION 'TEST ONLY rehearsal refused: another release/source-state operation holds the lock.' USING errcode='55P03'; END IF;
 IF (SELECT count(*) FROM public.stage1_award_registry)<>${expectedAwards}
  OR (SELECT count(*) FROM public.program_text_fact_reviews)<>0
  OR (SELECT count(*) FROM public.program_text_fact_review_events)<>0 THEN RAISE EXCEPTION 'TEST ONLY rehearsal requires untouched initial fact tables.'; END IF;
 SELECT * INTO STRICT release_before FROM public.program_text_fact_release WHERE release_key='national-25-text-facts' FOR UPDATE;
 IF release_before.is_active OR release_before.review_ids<>'{}'::jsonb THEN RAISE EXCEPTION 'TEST ONLY rehearsal refuses an active fact release.'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'sources') x LEFT JOIN public.shared_award_sources s ON s.id=(x->>'id')::uuid
  WHERE s.id IS NULL OR s.shared_award_id::text IS DISTINCT FROM x->>'shared_award_id' OR s.url IS DISTINCT FROM x->>'url'
   OR s.admin_review_status IS DISTINCT FROM x->>'admin_review_status'
   OR private.stage1_canonical_json_sha256(s.text_monitoring_state) IS DISTINCT FROM x->>'state_sha256')
  OR (SELECT jsonb_agg(jsonb_build_object('cohort_key',r.cohort_key,'source_role',r.source_role,'revision',r.revision,'source_ids',r.source_ids,
   'evidence',r.evidence,'manifest_status',r.manifest_status) ORDER BY r.cohort_key,r.source_role) FROM public.program_text_source_roster r)
  IS DISTINCT FROM (SELECT jsonb_agg(x ORDER BY x->>'cohort_key',x->>'source_role') FROM jsonb_array_elements(p->'roster') x)
 THEN RAISE EXCEPTION 'TEST ONLY rehearsal snapshot changed; generate once again after review, never retry automatically.'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  AND c.relname IN ('program_text_source_roster','program_text_source_roster_events','program_text_fact_reviews','program_text_fact_release','program_text_fact_review_events') AND NOT c.relrowsecurity)
  OR has_function_privilege('anon','public.save_program_text_fact_review(jsonb,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.approve_program_text_fact_review(uuid,text,text)','EXECUTE')
  OR has_function_privilege('anon','public.publish_program_text_fact_batch(uuid,jsonb,text)','EXECUTE')
  OR has_table_privilege('service_role','public.program_text_fact_reviews','INSERT,UPDATE,DELETE')
  OR has_table_privilege('authenticated','public.program_text_fact_release','SELECT,INSERT,UPDATE,DELETE')
 THEN RAISE EXCEPTION 'TEST ONLY rehearsal found a privilege/RLS regression.'; END IF;
 -- This is the ONLY source mutation: synthetic text state, with all originals
 -- checked above and all changes unconditionally rolled back below.
 UPDATE public.shared_award_sources s SET text_monitoring_state=jsonb_build_object(
  'schema','awardping.program-text-state.v1','epoch',p->'epoch','status','baseline_ready','successful_checks',2,
  'first_captured_at',p->'first_captured_at','last_checked_at',x#>'{reference,captured_at}',
  'baseline_ref',x->'reference','latest_ref',x->'reference')
 FROM jsonb_array_elements(p->'states') x WHERE s.id=(x->>'id')::uuid;
 IF (SELECT count(*) FROM jsonb_array_elements(p->'states') x WHERE private.awardping_program_fact_source_ready((x->>'id')::uuid))<>${expectedSources}
 THEN RAISE EXCEPTION 'TEST ONLY complete/repeated collection readiness rejected.'; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(p->'validations') LOOP
  v:=jsonb_set(v,'{source_text}',(SELECT jsonb_agg((doc-'source_id')||jsonb_build_object('reference',ref) ORDER BY doc_ord)
   FROM jsonb_array_elements(v->'source_text') WITH ORDINALITY docs(doc,doc_ord)
   JOIN LATERAL jsonb_array_elements(v#>'{review,capture_refs}') ref ON ref#>>'{source,id}'=doc->>'source_id'));
  IF first_validation IS NULL THEN first_validation:=v; END IF;
  IF private.awardping_program_fact_public_values(v->'review') IS DISTINCT FROM v->'public_facts'
   OR NOT private.awardping_program_fact_validation_valid(v,false) OR NOT private.awardping_program_fact_validation_valid(v,true)
  THEN RAISE EXCEPTION 'TEST ONLY JS/SQL full-proof or normalization mismatch for %',v#>>'{review,cohort_key}'; END IF;
  saved:=public.save_program_text_fact_review(v,'TEST ONLY rollback runtime rehearsal');
  duplicate_saved:=public.save_program_text_fact_review(v,'TEST ONLY rollback runtime rehearsal');
  IF saved IS DISTINCT FROM duplicate_saved THEN RAISE EXCEPTION 'TEST ONLY draft idempotence failed.'; END IF;
  rejected:=false;
  BEGIN PERFORM public.approve_program_text_fact_review((saved->>'id')::uuid,repeat('0',64),'TEST ONLY stale hash');
   EXCEPTION WHEN check_violation THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'TEST ONLY stale hash was accepted.'; END IF;
  approved:=public.approve_program_text_fact_review((saved->>'id')::uuid,saved->>'content_hash','TEST ONLY rollback runtime rehearsal');
  IF approved->>'status'<>'approved' OR NOT private.awardping_program_fact_review_current((saved->>'id')::uuid)
   OR approved IS DISTINCT FROM public.approve_program_text_fact_review((saved->>'id')::uuid,saved->>'content_hash','TEST ONLY rollback runtime rehearsal')
  THEN RAISE EXCEPTION 'TEST ONLY independent approval/current/idempotence failed.'; END IF;
  ids:=ids||jsonb_build_object(v#>>'{review,cohort_key}',saved->>'id');
 END LOOP;
 v:=first_validation;
 -- Anonymous and ordinary signed-in roles must fail at EXECUTE, not by virtue
 -- of malformed payloads. The block rollback also restores the original role.
 rejected:=false;
 BEGIN EXECUTE 'SET LOCAL ROLE anon'; PERFORM public.save_program_text_fact_review(v,'TEST ONLY unauthorized');
  EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
 IF NOT rejected OR current_user<>owner_role THEN RAISE EXCEPTION 'TEST ONLY anonymous authorization failed.'; END IF;
 rejected:=false;
 BEGIN EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.save_program_text_fact_review(v,'TEST ONLY unauthorized');
  EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
 IF NOT rejected OR current_user<>owner_role THEN RAISE EXCEPTION 'TEST ONLY authenticated authorization failed.'; END IF;
 bad:=jsonb_set(v,'{review,fields,0,items,0,support,0,text}',to_jsonb('TEST ONLY fabricated quote'::text));
 IF private.awardping_program_fact_validation_valid(bad,true) THEN RAISE EXCEPTION 'TEST ONLY fabricated quotation accepted.'; END IF;
 bad:=jsonb_set(v,'{source_text,0,blocks_json}',to_jsonb('[]'::text));
 IF private.awardping_program_fact_validation_valid(bad,true) THEN RAISE EXCEPTION 'TEST ONLY altered original blocks accepted.'; END IF;
 bad:=jsonb_set(v,'{review,roster,0,revision}',to_jsonb('00000000-0000-4000-8000-000000000001'::text));
 IF private.awardping_program_fact_validation_valid(bad,true) THEN RAISE EXCEPTION 'TEST ONLY stale roster accepted.'; END IF;
 bad:=jsonb_set(v,'{review,capture_refs,0,source,shared_award_id}',to_jsonb('00000000-0000-4000-8000-000000000001'::text));
 bad:=jsonb_set(bad,'{source_text,0,reference}',bad#>'{review,capture_refs,0}');
 IF private.awardping_program_fact_validation_valid(bad,true) THEN RAISE EXCEPTION 'TEST ONLY wrong capture owner accepted.'; END IF;
 SELECT ord::integer-1 INTO STRICT absent_index FROM jsonb_array_elements(v#>'{review,fields}') WITH ORDINALITY x(field,ord) WHERE field->>'field'='eligibility';
 field_path:=ARRAY['review','fields',absent_index::text,'status'];
 bad:=jsonb_set(v,field_path,to_jsonb('unresolved'::text)); bad:=jsonb_set(bad,'{blockers}',jsonb_build_array('eligibility'));
 bad:=jsonb_set(bad,'{public_facts}',private.awardping_program_fact_public_values(bad->'review'));
 IF NOT private.awardping_program_fact_validation_valid(bad,false) OR private.awardping_program_fact_validation_valid(bad,true)
 THEN RAISE EXCEPTION 'TEST ONLY unresolved draft/approval distinction failed.'; END IF;
 saved:=public.save_program_text_fact_review(bad,'TEST ONLY unresolved draft'); rejected:=false;
 BEGIN PERFORM public.approve_program_text_fact_review((saved->>'id')::uuid,saved->>'content_hash','TEST ONLY unresolved');
  EXCEPTION WHEN check_violation THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'TEST ONLY unresolved draft approved.'; END IF;
 SELECT ord::integer-1 INTO STRICT deadline_index FROM jsonb_array_elements(v#>'{review,fields}') WITH ORDINALITY x(field,ord) WHERE field->>'field'='deadline';
 bad:=jsonb_set(v,ARRAY['review','fields',deadline_index::text,'items','1','track'],'null');
 bad:=jsonb_set(bad,'{public_facts}',private.awardping_program_fact_public_values(bad->'review'));
 IF private.awardping_program_fact_validation_valid(bad,true) THEN RAISE EXCEPTION 'TEST ONLY conflicting unscoped tracks accepted.'; END IF;
 bad:=jsonb_set(v,ARRAY['review','fields',deadline_index::text,'items','0','value'],to_jsonb('January 31, 2028'::text));
 bad:=jsonb_set(bad,'{public_facts}',private.awardping_program_fact_public_values(bad->'review'));
 IF private.awardping_program_fact_validation_valid(bad,true) THEN RAISE EXCEPTION 'TEST ONLY unsupported date year accepted.'; END IF;
 rejected:=false;
 BEGIN PERFORM public.publish_program_text_fact_batch(release_before.revision,ids-(v#>>'{review,cohort_key}'),'TEST ONLY partial');
  EXCEPTION WHEN check_violation THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'TEST ONLY partial batch publication accepted.'; END IF;
 rejected:=false;
 BEGIN PERFORM public.publish_program_text_fact_batch('00000000-0000-4000-8000-000000000001',ids,'TEST ONLY stale release');
  EXCEPTION WHEN check_violation THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'TEST ONLY stale release revision accepted.'; END IF;
 published:=public.publish_program_text_fact_batch(release_before.revision,ids,'TEST ONLY rollback runtime rehearsal');
 snapshot:=public.get_program_text_fact_publication();
 IF published->>'is_active'<>'true' OR published->'review_ids' IS DISTINCT FROM ids OR published->>'revision'=release_before.revision::text
  OR snapshot->>'active'<>'true' OR jsonb_array_length(snapshot->'cohorts')<>${expectedAwards}
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'cohorts') r WHERE r->>'current'<>'true'
   OR r->'public_facts' IS DISTINCT FROM (SELECT x->'public_facts' FROM jsonb_array_elements(p->'validations') x WHERE x#>>'{review,cohort_key}'=r->>'cohort_key'))
  OR published IS DISTINCT FROM public.publish_program_text_fact_batch((published->>'revision')::uuid,ids,'TEST ONLY idempotent publication')
 THEN RAISE EXCEPTION 'TEST ONLY whole-25 atomic fact publication failed.'; END IF;
 -- A real no-text-change advancement through the existing guarded state RPC
 -- preserves the approved fact review; no paid candidate is created.
 source_id:=(p#>>'{advance_ref,source,id}')::uuid;
 SELECT text_monitoring_state INTO STRICT source_state FROM public.shared_award_sources WHERE id=source_id;
 next_state:=source_state||jsonb_build_object('baseline_ref',p->'advance_ref','latest_ref',p->'advance_ref',
  'successful_checks',3,'last_checked_at',p#>'{advance_ref,captured_at}');
 PERFORM public.set_program_text_source_state(source_id,source_state,next_state);
 IF EXISTS(SELECT 1 FROM jsonb_each_text(ids) x WHERE NOT private.awardping_program_fact_review_current(x.value::uuid))
 THEN RAISE EXCEPTION 'TEST ONLY no-change baseline advancement invalidated current details.'; END IF;
 UPDATE public.shared_award_sources SET text_monitoring_state=next_state||jsonb_build_object('last_program_update_at',clock_timestamp()+interval '1 second') WHERE id=source_id;
 IF NOT EXISTS(SELECT 1 FROM jsonb_each_text(ids) x WHERE NOT private.awardping_program_fact_review_current(x.value::uuid))
 THEN RAISE EXCEPTION 'TEST ONLY program change did not require reconciliation.'; END IF;
 UPDATE public.shared_award_sources SET text_monitoring_state=next_state WHERE id=source_id;
 SELECT * INTO STRICT original_role FROM public.program_text_source_roster WHERE cohort_key=v#>>'{review,cohort_key}' ORDER BY source_role LIMIT 1;
 changed_role:=public.replace_program_text_source_role(original_role.cohort_key,original_role.source_role,original_role.revision,
  original_role.source_ids,original_role.evidence,'TEST ONLY roster CAS');
 IF changed_role->>'revision'=original_role.revision::text OR private.awardping_program_fact_validation_valid(v,true)
  OR private.awardping_program_fact_review_current((ids->>(v#>>'{review,cohort_key}'))::uuid)
 THEN RAISE EXCEPTION 'TEST ONLY roster correction did not stale approval.'; END IF;
 rejected:=false;
 BEGIN PERFORM public.replace_program_text_source_role(original_role.cohort_key,original_role.source_role,original_role.revision,
   original_role.source_ids,original_role.evidence,'TEST ONLY stale roster CAS');
  EXCEPTION WHEN serialization_failure THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'TEST ONLY stale roster CAS accepted.'; END IF;
END;
$awardping_rehearsal$;
ROLLBACK;`;
  if (Buffer.byteLength(query) > 1_800_000) throw new Error("Rehearsal query exceeds its reviewed size cap.");
  return { schema: "awardping.program-fact-db-rehearsal.v1", query,
    expected: { rollback_only: true, synthetic_facts_only: true, awards: expectedAwards, sources: expectedSources, roles: roles.length,
      per_award: ["full-proof JS/SQL parity", "draft save idempotence", "stale hash rejection", "separate approval", "approval idempotence/current"],
      negative: ["anonymous EXECUTE", "authenticated EXECUTE", "fabricated quote", "altered original block JSON", "stale roster", "wrong owner", "unresolved approval", "unscoped tracks", "unsupported date year", "partial publication", "stale release revision", "stale role CAS"],
      final: ["whole-25 atomic publication", "idempotent publication", "guarded no-change baseline preserves approval", "program change stales approval", "roster change stales approval"],
      query_sha256: createHash("sha256").update(query).digest("hex"), query_bytes: Buffer.byteLength(query),
      input_sha256: createHash("sha256").update(JSON.stringify(canonical({ sources: original, roster: payload.roster }))).digest("hex"),
      verification_query: factDbRehearsalVerificationQuery(ids),
      execution_note: "Root must review and explicitly execute this query once. Any SQL error means failure, not completion. Execute verification_query independently before and after; every value must match. This generator never executes SQL." } };
}

async function readOnce(base, key, table, params) {
  const url = new URL(`/rest/v1/${table}`, base); for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const headers = prepareSupabaseServiceHeaders({ apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }, key);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Read-only rehearsal source request failed (${response.status}); no retry.`);
  const value = await response.json(); if (!Array.isArray(value)) throw new Error("Invalid read-only rehearsal response."); return value;
}
export async function loadProgramFactDbRehearsal(envPath) {
  const env = parseEnv(readFileSync(resolve(envPath), "utf8"));
  const base = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key || new URL(base).protocol !== "https:") throw new Error("Read-only service credentials are unavailable.");
  const [registries, roles, members] = await Promise.all([
    readOnce(base, key, "stage1_award_registry", { select: "cohort_key,canonical_shared_award_id", order: "cohort_key", limit: "26" }),
    readOnce(base, key, "program_text_source_roster", { select: "cohort_key,source_role,source_ids,manifest_status,evidence,revision", order: "cohort_key,source_role", limit: "201" }),
    readOnce(base, key, "stage1_award_members", { select: "cohort_key,shared_award_id", limit: "501" }),
  ]);
  if (registries.length !== 25 || roles.length !== 200 || members.length >= 501) throw new Error("Unexpected initial roster scope.");
  const ids = [...new Set(roles.flatMap(role => role.source_ids))]; if (ids.length !== 124 || !ids.every(uuid)) throw new Error("Unexpected initial source scope.");
  const sources = await readOnce(base, key, "shared_award_sources", { select: "id,shared_award_id,url,admin_review_status,text_monitoring_state", id: `in.(${ids.join(",")})`, order: "id", limit: "125" });
  const config = JSON.parse(readFileSync(new URL("../config/program-text-monitoring.json", import.meta.url), "utf8"));
  return generateProgramFactDbRehearsal({ registries, roles, members, sources, epoch: config.epoch });
}
async function main(argv) {
  const args = new Map(); for (const arg of argv) { const match = /^--(env|emit-sql)=(.+)$/.exec(arg);
    if (!match || args.has(match[1])) throw new Error("Use --env=PATH --emit-sql=true only."); args.set(match[1], match[2]); }
  if (!args.has("env") || args.get("emit-sql") !== "true") throw new Error("Explicit --env=PATH and --emit-sql=true are required; this never executes SQL.");
  process.stdout.write(JSON.stringify(await loadProgramFactDbRehearsal(args.get("env"))) + "\n");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)); } catch (error) { process.stderr.write(`Fact DB rehearsal generation failed: ${error.message}\n`); process.exitCode = 1; }
}
