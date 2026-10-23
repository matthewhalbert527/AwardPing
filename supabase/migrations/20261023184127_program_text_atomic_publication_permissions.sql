-- The private evidence table intentionally rejects direct service-role inserts.
-- Give only the validated, fixed-table atomic text publisher owner privileges;
-- do not restore broad INSERT access or change any historical visual gate.
alter function public.publish_program_text_event(uuid,jsonb,jsonb) security definer;
revoke all on function public.publish_program_text_event(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.publish_program_text_event(uuid,jsonb,jsonb) to service_role;
