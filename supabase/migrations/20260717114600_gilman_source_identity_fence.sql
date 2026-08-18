-- The Gilman-McCain Scholarship shares the official Gilman domain but is a
-- distinct program. It must never satisfy a Benjamin A. Gilman International
-- Scholarship Stage 1 source role.

insert into public.stage1_award_source_identity_rules (
  cohort_key,
  rule_key,
  url_pattern,
  title_pattern,
  reason,
  policy_version
)
values (
  'gilman',
  'exclude_gilman_mccain',
  'gilman[-_]?mccain|gilmanmccain|/program/gilman-mccain-scholarships(?:/|$)',
  'gilman[- ]?mccain|gilmanmccain',
  'Gilman-McCain is a distinct scholarship and cannot supply Benjamin A. Gilman International Scholarship facts or updates.',
  'stage1-publication-v1'
)
on conflict (cohort_key, rule_key) do update
set
  url_pattern = excluded.url_pattern,
  title_pattern = excluded.title_pattern,
  reason = excluded.reason,
  policy_version = excluded.policy_version,
  updated_at = pg_catalog.now()
where public.stage1_award_source_identity_rules.url_pattern
    is distinct from excluded.url_pattern
  or public.stage1_award_source_identity_rules.title_pattern
    is distinct from excluded.title_pattern
  or public.stage1_award_source_identity_rules.reason
    is distinct from excluded.reason
  or public.stage1_award_source_identity_rules.policy_version
    is distinct from excluded.policy_version;

do $awardping_gilman_identity_postcondition$
declare
  v_url_pattern text;
  v_title_pattern text;
begin
  select identity_rule.url_pattern, identity_rule.title_pattern
  into v_url_pattern, v_title_pattern
  from public.stage1_award_source_identity_rules identity_rule
  where identity_rule.cohort_key = 'gilman'
    and identity_rule.rule_key = 'exclude_gilman_mccain';

  if v_url_pattern is null
    or v_title_pattern is null
    or not (
      'https://www.gilmanscholarship.org/program/gilman-mccain-scholarships/'
      ~* v_url_pattern
    )
    or not ('Gilman-McCain Scholarship eligibility' ~* v_title_pattern)
    or 'https://www.gilmanscholarship.org/applicants/eligibility/'
      ~* v_url_pattern
    or 'Gilman Scholarship eligibility' ~* v_title_pattern then
    raise exception using
      errcode = '55000',
      message = 'The Gilman source-identity fence failed its distinct-program postcondition.';
  end if;
end;
$awardping_gilman_identity_postcondition$;
