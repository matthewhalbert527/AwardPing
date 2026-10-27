import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parse } from 'libpg-query';
import { buildProgramVariationRollbackFixture } from './lib/program-variation-rollback-fixture.mjs';

const migration = '20261027003530_program_variation_inventory_gaps.sql';
const sql = readFileSync(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
const ast = await parse(sql);
const functions = ast.stmts.map(row => row.stmt.CreateFunctionStmt).filter(Boolean);
const functionName = fn => fn.funcname.map(part => part.String.sval).join('.');
const functionBody = fn => fn.options.find(part => part.DefElem.defname === 'as').DefElem.arg.List.items[0].String.sval;
const body = name => functionBody(functions.find(fn => functionName(fn) === name));
const mutation = body('public.set_program_variation_inventory_gaps');
const seal = body('public.seal_program_variation_inventory');

// SQL generator only: no database, captures, provider calls or execution path.
// Root may build this with the actual exact25 registry and configured epoch,
// review the result, then execute ONCE inside its existing BEGIN/ROLLBACK.
// The original fixture refuses nonempty variation tables and preserves the
// entire synthetic source/approval history only within that transaction.
export async function buildProgramVariationGapRollbackFixture(registries, epoch) {
  let plan = await buildProgramVariationRollbackFixture(registries, epoch);
  const declarations = 'DECLARE packet jsonb;';
  const marker = "  IF packet->'child'<>'null' THEN\n   bad:=public.revise_program_variation_expected_count";
  const afterSeal = "  payload:=jsonb_set(packet->'envelope','{unit,inventory_id}',sealed->'id');";
  if (plan.split(declarations).length !== 2 || plan.split(marker).length !== 2 || plan.split(afterSeal).length !== 2) throw new Error('Reviewed rollback fixture changed.');
  plan = plan.replace(declarations, 'DECLARE gap_snapshot jsonb;gap_after jsonb;gap_entry jsonb;gap_count bigint;gap_tests integer:=0;packet jsonb;');
  plan = plan.replace(marker, () => String.raw`  gap_snapshot:=jsonb_build_object('source',(select to_jsonb(s) from public.shared_award_sources s where s.id=(fixture_source->>'id')::uuid),
   'roster',(select jsonb_agg(to_jsonb(r) order by source_role) from public.program_text_source_roster r where r.cohort_key=packet#>>'{registry,cohort_key}'),
   'queue_count',(select count(*) from public.shared_award_visual_review_candidates),'fact_reviews',(select count(*) from public.program_text_fact_reviews),
   'unit_reviews',(select count(*) from public.program_variation_unit_reviews),'approvals',(select count(*) from public.program_variation_award_approvals),
   'release',(select to_jsonb(r) from public.program_variation_release r where release_key='national-25-provider-variations'));
  IF tests=0 THEN
   -- A preserved empty-gap v1 draft still hashes exactly as the old function.
   UPDATE public.program_variation_inventories SET inventory_hash_version=1 WHERE id=(inv->>'id')::uuid;
   appended:=public.get_program_variation_admin_page(packet#>>'{registry,cohort_key}',(inv->>'id')::uuid)->'inventory';
   IF appended->>'inventory_hash_version'<>'1' OR appended->'coverage_gaps'<>'[]'::jsonb THEN RAISE EXCEPTION 'Old empty-gap inventory was converted';END IF;gap_tests:=gap_tests+1;
   IF appended->>'draft_hash' IS DISTINCT FROM (select encode(extensions.digest(convert_to(jsonb_build_object('cohort_key',i.cohort_key,'cycle',i.cycle,
    'expected_variants',i.expected_variants,'previous_revision',i.previous_revision,'scopes',coalesce((select jsonb_agg(jsonb_build_object(
     'scope_key',s.scope_key,'label',s.label,'attributes',s.attributes,'source_roles',s.source_roles,'provider_support',s.provider_support,
     'retired',s.retired,'evidence_hash',e.content_hash) order by s.scope_key) from public.program_variation_scopes s
     join public.program_variation_inventory_evidence e on e.id=s.evidence_id where s.inventory_id=i.id),'[]'))::text,'UTF8'),'sha256'),'hex')
    from public.program_variation_inventories i where i.id=(inv->>'id')::uuid) THEN RAISE EXCEPTION 'Historical v1 hash bytes changed';END IF;gap_tests:=gap_tests+1;
   FOREACH gap_entry IN ARRAY ARRAY['null'::jsonb,'{}'::jsonb,'[null]'::jsonb,
    '[{"key":"bad key","label":"Needs guidance","source_url":null}]'::jsonb,
    '[{"key":"current","label":" ","source_url":null}]'::jsonb,
    '[{"key":"current","label":" Needs guidance","source_url":null}]'::jsonb,
    '[{"key":"current","label":"Needs guidance","source_url":"http://www.nsf.gov/"}]'::jsonb,
    '[{"key":"current","label":"Needs guidance","source_url":"https://127.0.0.1/"}]'::jsonb,
    '[{"key":"current","label":"Needs guidance","source_url":"https://[::1]/"}]'::jsonb,
    '[{"key":"current","label":"Needs guidance","source_url":"https://localhost/"}]'::jsonb,
    '[{"key":"current","label":"Needs guidance","source_url":"https://host.internal/"}]'::jsonb,
    '[{"key":"current","label":"Needs guidance","source_url":"https://user:password@www.nsf.gov/"}]'::jsonb,
    '[{"key":"current","label":"Needs guidance","source_url":"https://www.nsf.gov:8443/"}]'::jsonb,
    '[{"key":"current","label":"Needs guidance","source_url":"https://www.nsf.gov/#private"}]'::jsonb,
    '[{"key":"current","label":"Needs guidance","source_url":null,"approved":true}]'::jsonb,
    '[{"key":"duplicate","label":"First gap","source_url":null},{"key":"duplicate","label":"Second gap","source_url":null}]'::jsonb,
    jsonb_build_array(jsonb_build_object('key','current','label',repeat('x',501),'source_url',null)),
    jsonb_build_array(jsonb_build_object('key','current','label','unsafe'||chr(10)||'label','source_url',null)),
    (select jsonb_agg(jsonb_build_object('key','gap-'||n,'label','Needs guidance','source_url',null)) from generate_series(1,51) n)] LOOP
    failed:=false;BEGIN PERFORM public.set_program_variation_inventory_gaps((inv->>'id')::uuid,(appended->>'revision')::uuid,appended->>'draft_hash',gap_entry,
     'TEST ONLY invalid gap input must remain held.','rollback fixture');EXCEPTION WHEN check_violation THEN failed:=true;END;
    IF NOT failed THEN RAISE EXCEPTION 'Malformed gap input was accepted: %',gap_entry;END IF;gap_tests:=gap_tests+1;
   END LOOP;
   failed:=false;BEGIN PERFORM public.set_program_variation_inventory_gaps((inv->>'id')::uuid,(appended->>'revision')::uuid,repeat('0',64),'[]',
    'Wrong hash must not change the current inventory.','rollback fixture');EXCEPTION WHEN serialization_failure THEN failed:=true;END;
   IF NOT failed THEN RAISE EXCEPTION 'Wrong gap hash accepted';END IF;gap_tests:=gap_tests+1;
   failed:=false;BEGIN PERFORM public.set_program_variation_inventory_gaps((inv->>'id')::uuid,gen_random_uuid(),appended->>'draft_hash','[]',
    'Wrong revision must not change the current inventory.','rollback fixture');EXCEPTION WHEN serialization_failure THEN failed:=true;END;
   IF NOT failed THEN RAISE EXCEPTION 'Wrong gap revision accepted';END IF;gap_tests:=gap_tests+1;
   failed:=false;BEGIN
    UPDATE public.program_variation_inventory_draft_heads SET revision=gen_random_uuid() WHERE inventory_id=(inv->>'id')::uuid;
    PERFORM public.set_program_variation_inventory_gaps((inv->>'id')::uuid,(appended->>'revision')::uuid,appended->>'draft_hash','[]',
     'Wrong draft head must not change current coverage.','rollback fixture');
   EXCEPTION WHEN serialization_failure THEN failed:=true;END;
   IF NOT failed THEN RAISE EXCEPTION 'Stale draft head accepted';END IF;gap_tests:=gap_tests+1;
   IF has_function_privilege('anon','public.set_program_variation_inventory_gaps(uuid,uuid,text,jsonb,text,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.set_program_variation_inventory_gaps(uuid,uuid,text,jsonb,text,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.set_program_variation_inventory_gaps(uuid,uuid,text,jsonb,text,text)','EXECUTE')
    OR has_table_privilege('service_role','public.program_variation_review_events','UPDATE')
    OR has_table_privilege('service_role','public.program_variation_inventories','UPDATE') THEN RAISE EXCEPTION 'Gap privilege boundary failed';END IF;gap_tests:=gap_tests+1;
  END IF;
  gap_count:=(select count(*) from public.program_variation_review_events where subject_id=(inv->>'id')::uuid and action='inventory_gaps_set');
  bad:=public.set_program_variation_inventory_gaps((inv->>'id')::uuid,(appended->>'revision')::uuid,appended->>'draft_hash',
   '[{"key":"annual-guidance","label":"TEST ONLY current annual rules need review.","source_url":"https://www.nsf.gov/rules"}]',
   'TEST ONLY governing guidance must be reviewed before sealing.','rollback fixture');
  IF bad->>'revision'=appended->>'revision' OR bad->>'draft_hash'=appended->>'draft_hash' OR bad->>'inventory_hash_version'<>'2'
   OR (select revision::text from public.program_variation_inventory_draft_heads where inventory_id=(inv->>'id')::uuid)<>bad->>'revision'
   OR (select count(*) from public.program_variation_review_events where subject_id=(inv->>'id')::uuid and action='inventory_gaps_set')<>gap_count+1
   OR NOT exists(select 1 from public.program_variation_review_events where subject_id=(inv->>'id')::uuid and action='inventory_gaps_set'
    and details->'previous_gaps'='[]'::jsonb and details->'coverage_gaps'=bad->'coverage_gaps' and details->>'previous_revision'=appended->>'revision'
    and details->>'previous_hash'=appended->>'draft_hash' and details->>'draft_hash'=bad->>'draft_hash') THEN RAISE EXCEPTION 'Gap addition was not versioned/audited';END IF;gap_tests:=gap_tests+1;
  extra:=public.set_program_variation_inventory_gaps((inv->>'id')::uuid,(bad->>'revision')::uuid,bad->>'draft_hash',bad->'coverage_gaps',
   'TEST ONLY identical curation is an idempotent operation.','rollback fixture');
  IF extra->>'revision'<>bad->>'revision' OR extra->>'draft_hash'<>bad->>'draft_hash'
   OR (select count(*) from public.program_variation_review_events where subject_id=(inv->>'id')::uuid and action='inventory_gaps_set')<>gap_count+1
   THEN RAISE EXCEPTION 'Identical gaps changed audit/version';END IF;gap_tests:=gap_tests+1;
  IF tests=0 THEN
   BEGIN
    extra:=public.create_program_variation_inventory(packet#>>'{registry,cohort_key}','2099 TEST ONLY replacement draft',1,null,'rollback fixture');
    IF extra->'coverage_gaps'<>bad->'coverage_gaps' OR extra->>'inventory_hash_version'<>'2'
     OR NOT exists(select 1 from public.program_variation_review_events where subject_id=(extra->>'id')::uuid and action='inventory_created'
      and details->>'previous_draft_id'=bad->>'id' and details->>'previous_draft_revision'=bad->>'revision'
      and details->'inherited_coverage_gaps'=bad->'coverage_gaps') THEN RAISE EXCEPTION 'Replacement draft silently discarded existing gaps';END IF;gap_tests:=gap_tests+1;
    failed:=false;BEGIN PERFORM public.set_program_variation_inventory_gaps((bad->>'id')::uuid,(bad->>'revision')::uuid,bad->>'draft_hash','[]',
     'TEST ONLY a superseded draft cannot remove current gap records.','rollback fixture');EXCEPTION WHEN serialization_failure THEN failed:=true;END;
    IF NOT failed THEN RAISE EXCEPTION 'Superseded draft gap mutation accepted';END IF;gap_tests:=gap_tests+1;
    failed:=false;BEGIN PERFORM public.seal_program_variation_inventory((extra->>'id')::uuid,(extra->>'revision')::uuid,extra->>'draft_hash',true,'rollback fixture');
     EXCEPTION WHEN check_violation THEN IF SQLERRM NOT LIKE 'Resolve every recorded inventory coverage gap%' THEN RAISE;END IF;failed:=true;END;
    IF NOT failed THEN RAISE EXCEPTION 'Inherited gap was bypassed by a replacement draft';END IF;gap_tests:=gap_tests+1;
    RAISE EXCEPTION 'TEST ONLY replacement draft rollback' USING errcode='ZX004';
   EXCEPTION WHEN SQLSTATE 'ZX004' THEN NULL;END;
  END IF;
  failed:=false;BEGIN PERFORM public.seal_program_variation_inventory((inv->>'id')::uuid,(bad->>'revision')::uuid,bad->>'draft_hash',true,'rollback fixture');
   EXCEPTION WHEN check_violation THEN IF SQLERRM NOT LIKE 'Resolve every recorded inventory coverage gap%' THEN RAISE;END IF;failed:=true;END;
  IF NOT failed THEN RAISE EXCEPTION 'Open gap was sealed';END IF;gap_tests:=gap_tests+1;
  extra:=public.get_program_variation_admin_page(packet#>>'{registry,cohort_key}',(inv->>'id')::uuid);
  IF extra#>'{inventory,coverage_gaps}'<>bad->'coverage_gaps' THEN RAISE EXCEPTION 'Private admin page omitted gaps';END IF;gap_tests:=gap_tests+1;
  IF NOT exists(select 1 from jsonb_array_elements(public.get_program_variation_admin_batch()->'awards') award where award->>'cohort_key'=packet#>>'{registry,cohort_key}'
   and award->'coverage_gaps'=bad->'coverage_gaps' and award->>'coverage_gap_count'='1' and (award->'blockers') ? 'inventory_coverage_gaps'
   and award->>'coverage_gap_inventory_id'=bad->>'id' and award->>'coverage_gap_revision'=bad->>'revision' and award->>'coverage_gap_hash'=bad->>'draft_hash'
   and award->>'coverage_gap_status'='draft' and (award->'blockers') ? 'provider_inventory_unsealed' and award->'inventory_id'='null'::jsonb)
   THEN RAISE EXCEPTION 'Private batch omitted draft coverage blocker';END IF;gap_tests:=gap_tests+1;
  failed:=false;BEGIN PERFORM public.set_program_variation_inventory_gaps((inv->>'id')::uuid,(bad->>'revision')::uuid,bad->>'draft_hash','[]','fixed','rollback fixture');
   EXCEPTION WHEN check_violation THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Unaudited gap removal accepted';END IF;gap_tests:=gap_tests+1;
  extra:=public.set_program_variation_inventory_gaps((inv->>'id')::uuid,(bad->>'revision')::uuid,bad->>'draft_hash','[]',
   'TEST ONLY current governing guidance was completely reviewed.','rollback fixture');
  IF extra->'coverage_gaps'<>'[]'::jsonb OR extra->>'revision'=bad->>'revision' OR extra->>'draft_hash'=bad->>'draft_hash'
   OR NOT exists(select 1 from public.program_variation_review_events where subject_id=(inv->>'id')::uuid and action='inventory_gaps_set'
    and details->'previous_gaps'=bad->'coverage_gaps' and details->'coverage_gaps'='[]'::jsonb and length(details->>'reason')>=20)
   THEN RAISE EXCEPTION 'Gap removal lost audit/version';END IF;gap_tests:=gap_tests+1;
  appended:=extra;
  gap_after:=jsonb_build_object('source',(select to_jsonb(s) from public.shared_award_sources s where s.id=(fixture_source->>'id')::uuid),
   'roster',(select jsonb_agg(to_jsonb(r) order by source_role) from public.program_text_source_roster r where r.cohort_key=packet#>>'{registry,cohort_key}'),
   'queue_count',(select count(*) from public.shared_award_visual_review_candidates),'fact_reviews',(select count(*) from public.program_text_fact_reviews),
   'unit_reviews',(select count(*) from public.program_variation_unit_reviews),'approvals',(select count(*) from public.program_variation_award_approvals),
   'release',(select to_jsonb(r) from public.program_variation_release r where release_key='national-25-provider-variations'));
  IF gap_after<>gap_snapshot THEN RAISE EXCEPTION 'Gap curation changed source, queue, facts, approvals or release';END IF;gap_tests:=gap_tests+1;
${marker}`);
  plan = plan.replace(afterSeal, () => String.raw`  failed:=false;BEGIN PERFORM public.set_program_variation_inventory_gaps((inv->>'id')::uuid,(sealed->>'revision')::uuid,sealed->>'content_hash','[]',
   'TEST ONLY sealed inventories cannot be modified by gap curation.','rollback fixture');EXCEPTION WHEN serialization_failure THEN failed:=true;END;
  IF NOT failed THEN RAISE EXCEPTION 'Sealed gap mutation accepted';END IF;gap_tests:=gap_tests+1;
  failed:=false;BEGIN UPDATE public.program_variation_inventories SET inventory_hash_version=1 WHERE id=(inv->>'id')::uuid;
   EXCEPTION WHEN check_violation THEN failed:=true;END;IF NOT failed THEN RAISE EXCEPTION 'Historical sealed hash version was editable';END IF;gap_tests:=gap_tests+1;
  IF packet->'child'<>'null' THEN
   extra:=public.create_program_variation_inventory(packet#>>'{registry,cohort_key}','2099 TEST ONLY successor draft',1,(sealed->>'revision')::uuid,'rollback fixture');
   bad:=public.set_program_variation_inventory_gaps((extra->>'id')::uuid,(extra->>'revision')::uuid,extra->>'draft_hash',
    '[{"key":"new-cycle-rules","label":"TEST ONLY successor cycle guidance remains unresolved.","source_url":null}]',
    'TEST ONLY future draft curation cannot rebind the sealed approval.','rollback fixture');
   IF NOT exists(select 1 from jsonb_array_elements(public.get_program_variation_admin_batch()->'awards') award where award->>'cohort_key'=packet#>>'{registry,cohort_key}'
    and award->>'inventory_id'=sealed->>'id' and award->>'inventory_revision'=sealed->>'revision' and award->>'inventory_sealed'='true'
    and award->>'coverage_gap_inventory_id'=bad->>'id' and award->>'coverage_gap_revision'=bad->>'revision'
    and award->>'coverage_gap_hash'=bad->>'draft_hash' and award->>'coverage_gap_status'='draft' and award->'coverage_gaps'=bad->'coverage_gaps'
    and (award->'blockers') ? 'inventory_coverage_gaps' and not (award->'blockers') ? 'provider_inventory_missing')
   THEN RAISE EXCEPTION 'Successor draft gaps were paired with the sealed inventory version';END IF;gap_tests:=gap_tests+1;
   IF (select content_hash from public.program_variation_inventories where id=(sealed->>'id')::uuid)<>sealed->>'content_hash'
    OR private.awardping_variation_inventory_hash((sealed->>'id')::uuid)<>sealed->>'content_hash' THEN RAISE EXCEPTION 'Successor gaps changed sealed hash';END IF;gap_tests:=gap_tests+1;
  END IF;
${afterSeal}`);
  const resultMarker = "'assertions',tests,'awards',25,'paid_calls',0,'persistent_writes',0";
  if (plan.split(resultMarker).length !== 2) throw new Error('Reviewed rollback result changed.');
  plan = plan.replace(resultMarker, "'assertions',tests,'gap_assertions',gap_tests,'awards',25,'paid_calls',0,'persistent_writes',0");
  return plan.replace('END $fixture$;', ' SET CONSTRAINTS ALL IMMEDIATE;\nEND $fixture$;');
}

describe('private versioned inventory coverage gaps', () => {
  it('parses additive migration SQL and exposes only service-authorized operations', () => {
    expect(functions.map(functionName)).toEqual(['private.awardping_variation_coverage_gaps_valid', 'private.awardping_variation_inventory_hash',
      'private.awardping_variation_preserve_sealed_gaps', 'public.set_program_variation_inventory_gaps', 'public.create_program_variation_inventory',
      'public.seal_program_variation_inventory', 'public.get_program_variation_admin_batch']);
    expect(sql).toContain('from public,anon,authenticated'); expect(sql).toContain('to service_role');
    expect(sql).toContain("security definer set search_path=''"); expect(sql).not.toMatch(/grant\s+(?:all|update|insert|delete)\s/i);
  });
  it('takes the common lock, exact draft/head/revision/hash checks before writing', () => {
    const write = mutation.indexOf('update public.program_variation_inventories');
    for (const guard of ["pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0))", 'for update', "i.status<>'draft'",
      'i.revision is distinct from p_expected_revision', 'old_hash is distinct from p_expected_hash', 'h.revision=i.revision',
      'private.awardping_variation_coverage_gaps_valid(p_coverage_gaps)']) {
      expect(mutation.indexOf(guard)).toBeGreaterThanOrEqual(0); expect(mutation.indexOf(guard)).toBeLessThan(write);
    }
    expect(mutation).toContain("using errcode='40001'"); expect(mutation).not.toMatch(/exception\s+when/i);
  });
  it('only versions gaps, draft head and immutable old/new audit; never touches source/fact approval', () => {
    expect(mutation).toContain('set coverage_gaps=p_coverage_gaps,inventory_hash_version=2,revision=gen_random_uuid()');
    expect(mutation).toContain("values('inventory_gaps_set'");
    for (const key of ['previous_gaps','coverage_gaps','previous_revision','revision','previous_hash','draft_hash','reason']) expect(mutation).toContain(`'${key}'`);
    expect(mutation).not.toMatch(/(?:update|insert into|delete from) public\.(?:shared_|program_text_|program_variation_(?:scopes|unit_reviews|award_approvals|release))/i);
    expect(mutation).not.toMatch(/set\s+(?:status|content_hash|cycle|expected_variants)\s*=/i);
  });
  it('hashes v2 gaps including empty gaps while preserving historical v1 seals', () => {
    expect(sql).toContain('inventory_hash_version smallint not null default 1'); expect(sql).toContain('inventory_hash_version set default 2');
    expect(body('private.awardping_variation_inventory_hash')).toContain("'schema','awardping.program-variation-inventory.v2','coverage_gaps',i.coverage_gaps");
    expect(body('private.awardping_variation_inventory_hash')).toContain("else '{}'::jsonb end");
    expect(sql).not.toMatch(/update public\.program_variation_inventories set inventory_hash_version/i);
    expect(sql).toContain("old.status='sealed'"); expect(sql).toContain('new.inventory_hash_version is distinct from old.inventory_hash_version');
  });
  it('blocks every open gap before sealing and preserves all prior evidence/retirement checks', () => {
    expect(seal.indexOf('jsonb_array_length(i.coverage_gaps)>0')).toBeLessThan(seal.indexOf("set status='sealed'"));
    for (const guard of ['private.awardping_variation_inventory_sources_current(i.id)', 'h is distinct from i.previous_revision', 'actual_hash is distinct from p_expected_hash',
      'p_complete_provider_inventory_reviewed is distinct from true', "scope_key='common' and not retired", '<>i.expected_variants', 'oldscope.scope_key']) expect(seal).toContain(guard);
  });
  it('exposes current-draft gaps only in private board output, with a separate explicit blocker', () => {
    const batch = body('public.get_program_variation_admin_batch');
    expect(batch).toContain("'coverage_gaps',coalesce(draft.coverage_gaps,i.coverage_gaps,'[]'::jsonb)");
    for (const field of ['coverage_gap_inventory_id','coverage_gap_revision','coverage_gap_hash','coverage_gap_status','provider_inventory_unsealed']) expect(batch).toContain(`'${field}'`);
    expect(batch).toContain("'inventory_coverage_gaps'");
    expect(functions.map(functionName).some(name => /public_context|publication|publish|approve/.test(name))).toBe(false);
  });
  it('inherits open manual gaps into successor drafts and records exact prior draft identity', () => {
    const create = body('public.create_program_variation_inventory');
    expect(create).toContain('previous.id=head.inventory_id and previous.revision=head.revision');
    expect(create).toContain("previous.cohort_key=head.cohort_key and previous.status='draft'");
    expect(create).toContain("coalesce(prior_draft.coverage_gaps,'[]'::jsonb)");
    expect(create).toContain("'previous_draft_id',prior_draft.id,'previous_draft_revision',prior_draft.revision");
    expect(create).toContain("'inherited_coverage_gaps',i.coverage_gaps");
    expect(create.indexOf("pg_advisory_xact_lock")).toBeLessThan(create.indexOf('insert into public.program_variation_inventories'));
  });
  it('prepares a parseable full rollback-only rehearsal without connecting or executing', async () => {
    const registries = Array.from({ length: 25 }, (_, n) => ({ cohort_key: `award_${String(n).padStart(2,'0')}`, canonical_shared_award_id: `10000000-0000-4000-8000-${String(n+1).padStart(12,'0')}` }));
    const plan = await buildProgramVariationGapRollbackFixture(registries, '10000000-0000-4000-8000-000000000100');
    expect((await parse(plan)).stmts.length).toBeGreaterThan(3); expect(plan.trimStart()).toMatch(/^--.*\nBEGIN;/); expect(plan.trimEnd()).toMatch(/ROLLBACK;$/);
    for (const proof of ['Historical v1 hash bytes changed', 'Malformed gap input was accepted', 'Gap addition was not versioned/audited', 'Open gap was sealed',
      'Private batch omitted draft coverage blocker', 'Gap removal lost audit/version', 'Gap curation changed source, queue, facts, approvals or release',
      'Sealed gap mutation accepted', 'Historical sealed hash version was editable', 'Replacement draft silently discarded existing gaps',
      'Inherited gap was bypassed by a replacement draft', 'SET CONSTRAINTS ALL IMMEDIATE', "'gap_assertions',gap_tests"]) expect(plan).toContain(proof);
    expect(plan).not.toMatch(/https:\/\/[^'\s]+supabase|fetch\(|exec(?:ute)?_sql|apply_migration/i);
  });
});
