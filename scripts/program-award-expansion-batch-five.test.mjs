import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {parse} from 'libpg-query';
const migration=readFileSync(new URL('../supabase/migrations/20261102023101_program_award_expansion_batch_five.sql',import.meta.url),'utf8');
const config=JSON.parse(readFileSync(new URL('../config/program-award-expansion.json',import.meta.url),'utf8'));
const oldMigration=readFileSync(new URL('../supabase/migrations/20261101155527_program_award_expansion_batch_four.sql',import.meta.url),'utf8');
const candidates=JSON.parse(migration.match(/\$candidates\$([\s\S]+?)\$candidates\$/)[1]);
const oldCandidates=JSON.parse(oldMigration.match(/\$candidates\$([\s\S]+?)\$candidates\$/)[1]);
const functionBody=name=>migration.match(new RegExp('CREATE OR REPLACE FUNCTION (?:public|private)\\.'+name+'\\([\\s\\S]+?\\$function\\$;'))[0];

describe('fixed fifth basic-information cohort',()=>{
  it('parses without admitting, collecting, publishing or changing the original25 registry',async()=>{
    const parsed=await parse(migration);
    expect(parsed.stmts.length).toBeGreaterThan(12);
    expect(migration).not.toMatch(/execute\s+pg_get_functiondef|alter table public\.stage1_award_registry/i);
    expect(migration).not.toMatch(/^\s*(?:select|perform) public\.(?:create_program_award_expansion_batch_five_owners|admit_program_award_expansion_batch|activate_program_award_expansion_batch)/m);
    expect(migration).toContain('check(launch_rank between 1 and 50)');
    expect(migration).toContain('check(batch in (1,2,3,4,5))');
  });
  it('preserves all20 prior reviewed candidates and binds all five new identities to the app',()=>{
    expect(candidates).toHaveLength(25);expect(candidates.slice(0,20)).toEqual(oldCandidates);
    expect(candidates.slice(20).map(c=>c.cohort_key)).toEqual(['doe_csgf','amgen_us','fulbright_uk_summer','suli','chevening']);
    expect(candidates.slice(20).map(c=>c.launch_rank)).toEqual([46,47,48,49,50]);
    expect(candidates.slice(20).map(c=>c.source_urls.length)).toEqual([4,1,1,4,5]);
    for(const candidate of candidates){const {source_urls,...identity}=candidate;expect(config.awards.find(c=>c.cohort_key===candidate.cohort_key)).toEqual(identity);expect(source_urls).toContain(candidate.official_homepage);}
  });
  it('preserves optimized publication and minimal identity reads while bounding25 activated additions',()=>{
    const full=functionBody('get_program_award_expansion_publication'),identity=functionBody('get_program_award_expansion_identities');
    expect(full).toContain('basic_snapshot as materialized');
    expect(full.match(/public\.get_program_basic_facts\(/g)).toHaveLength(1);
    expect(identity).not.toContain('get_program_basic_facts');
    expect(identity).toContain('STABLE');expect(identity).not.toContain('SECURITY DEFINER');
    for(const body of [full,identity])expect(body).toContain('jsonb_array_length(result) not in(0,5,10,15,20,25)');
  });
  it('retains silent baselines, exact source aliases, original history and fresh authenticated follow checks',()=>{
    const admit=functionBody('admit_program_award_expansion_batch'),track=functionBody('track_office_program_expansion_atomic');
    expect(admit).toContain('if p_batch not in (1,2,3,4,5)');expect(admit).toContain('Expansion is bounded to twenty-five awards.');
    expect(migration.match(/generate_series\(1,p_batch-1\) previous\(batch\)/g)).toHaveLength(2);
    expect(admit).toContain("q->'expected_text_monitoring_state' is distinct from '{}'::jsonb");
    expect(admit).toContain("actual_boundary is distinct from q->'url_alias_boundary'");
    expect(admit).toContain("'baseline_only'");expect(admit).toContain("'server_first_capture_eligible',false");
    expect(track).toContain('v_actor_user_id uuid:=(select auth.uid())');
    expect(track).toContain("m.status='active' and m.role in ('owner','admin') for share");
    expect(track).toContain('v_database_source_bindings is distinct from p_expected_source_bindings');
    expect(migration.match(/launch_rank between 26 and 50/g)).toHaveLength(3);
    for(const retained of ['untrack_office_program_expansion_atomic','program_award_expansion_get_form_authority','create_program_award_expansion_batch_four_owners'])
      expect(migration).not.toMatch(new RegExp('CREATE OR REPLACE FUNCTION (?:public|private)\\.'+retained+'\\('));
  });
  it('restricts new owner creation to the one blank Chevening record and checks insertion authority',()=>{
    const owner=functionBody('create_program_award_expansion_batch_five_owners');
    expect(owner).toContain('60d68065-a9ee-4ef5-9096-1467c299538e');
    expect(owner).toContain('v_existing=1 and v_exact=1');expect(owner).toContain('if v_exact<>1 then');
    expect(owner).toContain('lock table public.shared_awards in share row exclusive mode');
    expect(owner).toContain("inserted.public_facts='{}'::jsonb");
    expect(owner).not.toMatch(/\bupdate\s+public\.|insert into public\.(?:shared_award_sources|program_award_members|program_basic_fact)/i);
    for(const guard of ["t.tgtype=23","t.tgenabled='O'","t.tgfoid='public.set_shared_award_slug()'::regprocedure",'t.tgnargs=0','octet_length(t.tgargs)=0','t.tgqual is null',"array['name','slug']::text[]"])expect(owner).toContain(guard);
    expect(migration).toContain('revoke all on function public.create_program_award_expansion_batch_five_owners(jsonb,text,text) from public,anon,authenticated,service_role');
    expect(migration).toContain('grant execute on function public.create_program_award_expansion_batch_five_owners(jsonb,text,text) to service_role');
    expect(migration).toContain('p.provolatile::text=');
    expect(migration).toContain('p.proacl::text is not distinct from');
  });
});
