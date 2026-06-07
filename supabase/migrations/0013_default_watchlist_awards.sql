create or replace function public.default_watchlist_awards()
returns table (
  sort_order int,
  name text,
  homepage text,
  aliases text[]
)
language sql
stable
security definer set search_path = public
as $$
  values
    (1, 'Truman Scholarship', 'https://www.truman.gov/', array[
      'truman scholarship'
    ]),
    (2, 'Udall Scholarship', 'https://www.udall.gov/OurPrograms/Scholarship/Scholarship.aspx', array[
      'udall scholarship'
    ]),
    (3, 'Goldwater Scholarship', 'https://goldwaterscholarship.gov/', array[
      'goldwater scholarship'
    ]),
    (4, 'NSF Graduate Research Fellowship Program', 'https://www.nsfgrfp.org/', array[
      'nsf graduate research fellowship program',
      'national science foundation graduate research fellowship',
      'national science foundation graduate research fellowship program'
    ]),
    (5, 'Fulbright U.S. Student Program', 'https://us.fulbrightonline.org/', array[
      'fulbright u.s. student program'
    ]),
    (6, 'Rhodes Scholarship', 'https://www.rhodeshouse.ox.ac.uk/scholarships/the-rhodes-scholarship/', array[
      'rhodes scholarship',
      'rhodes scholarships'
    ]),
    (7, 'Marshall Scholarship', 'https://www.marshallscholarship.org/', array[
      'marshall scholarship'
    ]),
    (8, 'Mitchell Scholarship', 'https://www.us-irelandalliance.org/mitchellscholarship', array[
      'mitchell scholarship'
    ]),
    (9, 'Gates Cambridge Scholarship', 'https://www.gatescambridge.org/programme/the-scholarship/', array[
      'gates cambridge scholarship'
    ]),
    (10, 'Knight-Hennessy Scholars', 'https://knight-hennessy.stanford.edu/', array[
      'knight-hennessy scholars',
      'knight-hennessy scholars program'
    ]),
    (11, 'Schwarzman Scholars', 'https://www.schwarzmanscholars.org/', array[
      'schwarzman scholars',
      'schwarzman scholarship'
    ]),
    (12, 'Boren Awards', 'https://www.borenawards.org/', array[
      'boren awards',
      'boren awards for international study',
      'boren scholarship/fellowship urgd/grad',
      'us national security education program (nsep) - boren fellowships'
    ]),
    (13, 'Gilman Scholarship', 'https://www.gilmanscholarship.org/', array[
      'gilman scholarship',
      'gilman international scholarship'
    ]),
    (14, 'Critical Language Scholarship', 'https://clscholarship.org/', array[
      'critical language scholarship',
      'critical language scholarships program',
      'critical languages scholarship',
      'u.s. department of state - critical language scholarship (cls) program'
    ]),
    (15, 'Pickering Fellowship', 'https://pickeringfellowship.org/', array[
      'pickering fellowship',
      'pickering foreign affairs fellowship',
      'u.s. department of state - thomas r. pickering foreign affairs fellowship'
    ]),
    (16, 'Rangel Fellowship', 'https://rangelprogram.org/', array[
      'rangel fellowship',
      'rangel international affairs fellowship',
      'charles b. rangel international affairs fellowship',
      'u.s. department of state - charles b. rangel international affairs program - graduate fellowship'
    ]),
    (17, 'Payne Fellowship', 'https://www.paynefellows.org/', array[
      'payne fellowship',
      'donald m. payne international development graduate fellowship',
      'donald m. payne international development fellowship'
    ]),
    (18, 'Hollings Scholarship', 'https://www.noaa.gov/office-education/hollings-scholarship', array[
      'hollings scholarship',
      'noaa hollings scholarship',
      'ernest f. hollings undergraduate scholarship (noaa)'
    ]),
    (19, 'Beinecke Scholarship', 'https://beineckescholarship.org/', array[
      'beinecke scholarship',
      'beinecke scholarship program'
    ]),
    (20, 'Soros Fellowship for New Americans', 'https://www.pdsoros.org/', array[
      'soros fellowship for new americans',
      'soros fellowships for new americans',
      'paul & daisy soros fellowships for new americans'
    ])
$$;

create or replace function public.seed_default_awards_for_office(
  target_office_id uuid,
  target_user_id uuid
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  default_award record;
  matched_shared_award_id uuid;
  office_award_id uuid;
  seeded_awards integer := 0;
begin
  if target_office_id is null or target_user_id is null then
    return 0;
  end if;

  if not exists (
    select 1
    from public.office_members
    where office_id = target_office_id
      and user_id = target_user_id
      and status = 'active'
  ) then
    return 0;
  end if;

  for default_award in
    select * from public.default_watchlist_awards()
    order by sort_order asc
  loop
    select shared_award.id into matched_shared_award_id
    from public.shared_awards shared_award
    where shared_award.status = 'active'
      and shared_award.search_key = any(default_award.aliases)
    order by array_position(default_award.aliases, shared_award.search_key) asc,
      shared_award.created_at asc
    limit 1;

    if matched_shared_award_id is null then
      insert into public.shared_awards (
        search_key,
        name,
        official_homepage,
        summary,
        confidence,
        status,
        source
      )
      values (
        default_award.aliases[1],
        default_award.name,
        default_award.homepage,
        null,
        0.85,
        'active',
        'admin'
      )
      on conflict (search_key) do update set
        official_homepage = coalesce(public.shared_awards.official_homepage, excluded.official_homepage),
        summary = coalesce(public.shared_awards.summary, excluded.summary),
        confidence = greatest(public.shared_awards.confidence, excluded.confidence),
        status = 'active',
        updated_at = now()
      returning id into matched_shared_award_id;
    else
      update public.shared_awards
      set official_homepage = coalesce(official_homepage, default_award.homepage),
        updated_at = now()
      where id = matched_shared_award_id
        and official_homepage is null;
    end if;

    insert into public.shared_award_sources (
      shared_award_id,
      url,
      title,
      page_type,
      confidence,
      reason,
      source
    )
    values (
      matched_shared_award_id,
      default_award.homepage,
      default_award.name,
      'homepage',
      0.85,
      'Default watchlist official homepage.',
      'admin'
    )
    on conflict (shared_award_id, url) do nothing;

    select award.id into office_award_id
    from public.awards award
    where award.office_id = target_office_id
      and award.shared_award_id = matched_shared_award_id
      and award.status = 'active'
    order by award.created_at asc
    limit 1;

    if office_award_id is null then
      insert into public.awards (
        office_id,
        user_id,
        shared_award_id,
        name,
        official_homepage,
        summary,
        confidence,
        status
      )
      select
        target_office_id,
        target_user_id,
        shared_award.id,
        shared_award.name,
        shared_award.official_homepage,
        nullif(shared_award.summary, 'Default nationally competitive award monitored for new offices.'),
        shared_award.confidence,
        'active'
      from public.shared_awards shared_award
      where shared_award.id = matched_shared_award_id
      returning id into office_award_id;

      seeded_awards := seeded_awards + 1;
    end if;

    insert into public.award_sources (
      award_id,
      office_id,
      user_id,
      shared_award_source_id,
      url,
      title,
      page_type,
      confidence,
      reason,
      selected
    )
    select
      office_award_id,
      target_office_id,
      target_user_id,
      shared_source.id,
      shared_source.url,
      shared_source.title,
      shared_source.page_type,
      shared_source.confidence,
      shared_source.reason,
      true
    from public.shared_award_sources shared_source
    where shared_source.shared_award_id = matched_shared_award_id
      and not exists (
        select 1
        from public.award_sources existing_source
        where existing_source.award_id = office_award_id
          and existing_source.shared_award_source_id = shared_source.id
      );

    insert into public.monitors (
      office_id,
      user_id,
      award_id,
      shared_award_source_id,
      label,
      url,
      content_type,
      cadence,
      page_type,
      source_label,
      status,
      next_check_at
    )
    select
      target_office_id,
      target_user_id,
      office_award_id,
      shared_source.id,
      shared_award.name || ' - ' ||
        case shared_source.page_type
          when 'homepage' then 'Homepage'
          when 'deadline' then 'Deadline'
          when 'application' then 'Application'
          when 'eligibility' then 'Eligibility'
          when 'requirements' then 'Requirements'
          when 'pdf' then 'PDF guide'
          when 'faq' then 'FAQ'
          else 'Other source'
        end,
      shared_source.url,
      case
        when shared_source.page_type = 'pdf'
          or lower(split_part(shared_source.url, '?', 1)) like '%.pdf'
          then 'pdf'
        else 'auto'
      end,
      'daily',
      shared_source.page_type,
      shared_source.title,
      'active',
      now()
    from public.shared_award_sources shared_source
    join public.shared_awards shared_award on shared_award.id = shared_source.shared_award_id
    where shared_source.shared_award_id = matched_shared_award_id
      and not exists (
        select 1
        from public.monitors existing_monitor
        where existing_monitor.office_id = target_office_id
          and existing_monitor.award_id = office_award_id
          and existing_monitor.shared_award_source_id = shared_source.id
      );
  end loop;

  return seeded_awards;
end;
$$;

create or replace function public.ensure_default_office_for_user(target_user_id uuid, target_email text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  default_office_id uuid;
begin
  select om.office_id into default_office_id
  from public.office_members om
  where om.user_id = target_user_id
  order by om.created_at asc
  limit 1;

  if default_office_id is not null then
    return default_office_id;
  end if;

  insert into public.offices (name, created_by)
  values ('New award office', target_user_id)
  returning id into default_office_id;

  insert into public.office_members (office_id, user_id, email, role, notification_preference, status)
  values (default_office_id, target_user_id, target_email, 'owner', 'immediate', 'active')
  on conflict (office_id, user_id) do nothing;

  perform public.seed_default_awards_for_office(default_office_id, target_user_id);

  return default_office_id;
end;
$$;

do $$
declare
  office_row record;
begin
  for office_row in
    select office.id as office_id,
      member.user_id
    from public.offices office
    join lateral (
      select office_member.user_id
      from public.office_members office_member
      where office_member.office_id = office.id
        and office_member.status = 'active'
      order by
        case office_member.role
          when 'owner' then 1
          when 'admin' then 2
          else 3
        end,
        office_member.created_at asc
      limit 1
    ) member on true
  loop
    perform public.seed_default_awards_for_office(office_row.office_id, office_row.user_id);
  end loop;
end $$;
