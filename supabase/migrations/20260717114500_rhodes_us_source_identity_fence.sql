-- Rhodes is a global scholarship, but this Stage 1 cohort is explicitly the
-- United States competition. Country/constituency-specific guidance from the
-- same official domain must not satisfy a Rhodes (US) source role.

insert into public.stage1_award_source_identity_rules (
  cohort_key,
  rule_key,
  url_pattern,
  title_pattern,
  reason,
  policy_version
)
values (
  'rhodes_us',
  'exclude_rhodes_non_us_constituencies',
  '(?:^|[/_.-])(?:australia|bermuda|canada|china|east[-_]?africa|germany|hong[-_]?kong|india|israel|jamaica|caribbean|kenya|malaysia|new[-_]?zealand|pakistan|saudi[-_]?arabia|singapore|southern[-_]?africa|syria|jordan|lebanon|palestine|united[-_]?arab[-_]?emirates|west[-_]?africa|zambia|zimbabwe|england|scotland|wales|united[-_]?kingdom)(?:[/_.-]|$)',
  '(?:rhodes|information for candidates|candidate guidance|constituency).{0,100}(?:^|[^A-Za-z0-9_])(?:australia|australian|bermuda|bermudian|canada|canadian|china|chinese|east africa|germany|german|hong kong|india|indian|israel|israeli|jamaica|caribbean|kenya|kenyan|malaysia|malaysian|new zealand|pakistan|pakistani|saudi arabia|singapore|singaporean|southern africa|syria|syrian|jordan|jordanian|lebanon|lebanese|palestine|palestinian|united arab emirates|emirati|west africa|zambia|zambian|zimbabwe|zimbabwean|england|scotland|wales|united kingdom|british)(?:$|[^A-Za-z0-9_])|(?:^|[^A-Za-z0-9_])(?:australia|australian|bermuda|bermudian|canada|canadian|china|chinese|east africa|germany|german|hong kong|india|indian|israel|israeli|jamaica|caribbean|kenya|kenyan|malaysia|malaysian|new zealand|pakistan|pakistani|saudi arabia|singapore|singaporean|southern africa|syria|syrian|jordan|jordanian|lebanon|lebanese|palestine|palestinian|united arab emirates|emirati|west africa|zambia|zambian|zimbabwe|zimbabwean|england|scotland|wales|united kingdom|british)(?:$|[^A-Za-z0-9_]).{0,100}(?:rhodes|information for candidates|candidate guidance|constituency)',
  'A country- or constituency-specific Rhodes source outside the United States cannot supply Rhodes (US) facts or updates.',
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

do $awardping_rhodes_us_identity_postcondition$
declare
  v_url_pattern text;
  v_title_pattern text;
begin
  select identity_rule.url_pattern, identity_rule.title_pattern
  into v_url_pattern, v_title_pattern
  from public.stage1_award_source_identity_rules identity_rule
  where identity_rule.cohort_key = 'rhodes_us'
    and identity_rule.rule_key = 'exclude_rhodes_non_us_constituencies';

  if v_url_pattern is null
    or v_title_pattern is null
    or not (
      'https://www.rhodeshouse.ox.ac.uk/media/example/canada-information-for-candidates-2027.pdf'
      ~* v_url_pattern
    )
    or not (
      'Rhodes Scholarship Canada Information for Candidates'
      ~* v_title_pattern
    )
    or 'https://www.rhodeshouse.ox.ac.uk/files/usainformationforcandidates/'
      ~* v_url_pattern
    or 'Rhodes Scholarship USA Information for Candidates'
      ~* v_title_pattern then
    raise exception using
      errcode = '55000',
      message = 'The Rhodes (US) source-identity fence failed its country-specific postcondition.';
  end if;
end;
$awardping_rhodes_us_identity_postcondition$;
