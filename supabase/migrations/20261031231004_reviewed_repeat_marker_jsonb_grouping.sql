-- Preserve the intended JSONB subtraction in the finite widget marker guard.
-- Group arrow extraction before arithmetic precedence; all predicates stay exact.
DO $marker_jsonb_grouping$
DECLARE v_before text;v_after text;
BEGIN
 v_before:=pg_get_functiondef('private.awardping_reviewed_marker_valid(jsonb,jsonb,text,uuid,jsonb)'::regprocedure);
 IF encode(extensions.digest(convert_to(v_before,'UTF8'),'sha256'),'hex')<>'78e58f2dd17c06e7bf97cbdd1362dd0bfe52fc325f0ccd79d53dd04a25a5d66f' THEN RAISE EXCEPTION 'Reviewed marker grouping preimage changed.' USING ERRCODE='40001';END IF;
 v_after:=replace(v_before,$marker_group_before$m->'raw_container_attributes'-'aria-labelledby'$marker_group_before$,$marker_group_after$(m->'raw_container_attributes')-'aria-labelledby'$marker_group_after$);
 IF encode(extensions.digest(convert_to(v_after,'UTF8'),'sha256'),'hex')<>'414d748034203d41348c4598a6b7ef686aafb28b6f12c3930f77c7dc7dc4199e' THEN RAISE EXCEPTION 'Reviewed marker grouping replacement differs.' USING ERRCODE='40001';END IF;
 EXECUTE v_after;
END;
$marker_jsonb_grouping$;
