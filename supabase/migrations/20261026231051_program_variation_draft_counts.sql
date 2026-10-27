-- Incremental discovery may refine a draft count without discarding its
-- already reviewed source identities. Sealed inventories remain immutable.
create function public.revise_program_variation_expected_count(
 p_inventory uuid,p_expected_revision uuid,p_expected_hash text,p_expected_variants integer,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare inventory_row public.program_variation_inventories%rowtype;previous_count integer;active_count integer;previous_revision uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage1-national-25-release',0));
 select * into strict inventory_row from public.program_variation_inventories where id=p_inventory for update;
 if inventory_row.status<>'draft' or inventory_row.revision is distinct from p_expected_revision
  or private.awardping_variation_inventory_hash(inventory_row.id) is distinct from p_expected_hash
  or not exists(select 1 from public.program_variation_inventory_draft_heads h where h.inventory_id=inventory_row.id
    and h.cohort_key=inventory_row.cohort_key and h.revision=inventory_row.revision)
 then raise exception 'Current exact draft inventory version is required.' using errcode='40001';end if;
 select count(*)::integer into active_count from public.program_variation_scopes scope
 where scope.inventory_id=inventory_row.id and scope.scope_key<>'common' and not scope.retired;
 if p_expected_variants is null or p_expected_variants<active_count or p_expected_variants<0
  or length(btrim(coalesce(p_reason,''))) not between 20 and 2000 or length(btrim(coalesce(p_actor,''))) not between 1 and 320
 then raise exception 'A reviewed count cannot hide existing current routes.' using errcode='23514';end if;
 if p_expected_variants<>inventory_row.expected_variants then
  previous_count:=inventory_row.expected_variants;previous_revision:=inventory_row.revision;
  update public.program_variation_inventories set expected_variants=p_expected_variants,revision=gen_random_uuid()
  where id=inventory_row.id returning * into inventory_row;
  update public.program_variation_inventory_draft_heads set revision=inventory_row.revision where inventory_id=inventory_row.id;
  insert into public.program_variation_review_events(action,subject_id,details,actor) values('draft_count_revised',inventory_row.id,
   jsonb_build_object('previous_count',previous_count,'expected_variants',p_expected_variants,'previous_revision',previous_revision,
    'revision',inventory_row.revision,'reason',p_reason),p_actor);
 end if;
 return to_jsonb(inventory_row)||jsonb_build_object('scope_count',(select count(*) from public.program_variation_scopes scope where scope.inventory_id=inventory_row.id),
  'draft_hash',private.awardping_variation_inventory_hash(inventory_row.id));
end $$;
revoke all on function public.revise_program_variation_expected_count(uuid,uuid,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.revise_program_variation_expected_count(uuid,uuid,text,integer,text,text) to service_role;
notify pgrst,'reload schema';
