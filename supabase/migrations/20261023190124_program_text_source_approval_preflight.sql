create or replace function public.program_text_source_is_approved(p_source_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
select private.awardping_program_source_allowed(p_source_id);
$$;
revoke all on function public.program_text_source_is_approved(uuid) from public,anon,authenticated;
grant execute on function public.program_text_source_is_approved(uuid) to service_role;
