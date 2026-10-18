-- Fix three SETOF-text column references in the existing semantic-side check.
-- CREATE OR REPLACE preserves existing ownership/ACL; no evidence rule changes.
-- The unaliased SETOF text column is named after its function, not `value`.

CREATE OR REPLACE FUNCTION public.awardping_visual_event_has_semantic_side(p_change_details jsonb, p_side text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_fact jsonb;
  v_value text;
begin
  if p_side not in ('previous', 'current') or pg_catalog.jsonb_typeof(p_change_details) <> 'object' then
    return false;
  end if;
  for v_value in
    select text_value.value from public.awardping_visual_json_text_values(
      case when p_side = 'previous'
        then p_change_details -> 'exact_before'
        else p_change_details -> 'exact_after'
      end
    ) as text_value(value)
  loop
    if public.awardping_normalize_visual_exact_text(v_value) <> '' then return true; end if;
  end loop;
  for v_value in
    select text_value.value from public.awardping_visual_json_text_values(
      p_change_details -> 'structured_diff' ->
        case when p_side = 'previous' then 'removed_text' else 'added_text' end
    ) as text_value(value)
  loop
    if public.awardping_normalize_visual_exact_text(v_value) <> '' then return true; end if;
  end loop;
  for v_fact in
    select value
    from pg_catalog.jsonb_array_elements(
      coalesce(
        case when pg_catalog.jsonb_typeof(p_change_details -> 'changed_facts') = 'array'
          then p_change_details -> 'changed_facts' end,
        '[]'::jsonb
      ) || coalesce(
        case when pg_catalog.jsonb_typeof(p_change_details -> 'changed_award_facts') = 'array'
          then p_change_details -> 'changed_award_facts' end,
        '[]'::jsonb
      )
    )
  loop
    for v_value in
      select text_value.value from public.awardping_visual_json_text_values(
        v_fact -> case when p_side = 'previous' then 'removed_text' else 'added_text' end
      ) as text_value(value)
    loop
      if public.awardping_normalize_visual_exact_text(v_value) <> '' then return true; end if;
    end loop;
  end loop;
  return false;
end;
$function$
;
