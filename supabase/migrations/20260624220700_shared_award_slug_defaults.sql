create or replace function public.awardping_slugify(value text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(
      trim(
        both '-' from regexp_replace(
          regexp_replace(lower(coalesce(value, '')), '&', ' and ', 'g'),
          '[^a-z0-9]+',
          '-',
          'g'
        )
      ),
      ''
    ),
    'award'
  );
$$;

create or replace function public.set_shared_award_slug()
returns trigger
language plpgsql
as $$
declare
  base_slug text;
  candidate_slug text;
  duplicate_index integer := 2;
begin
  if new.slug is null or btrim(new.slug) = '' then
    base_slug := public.awardping_slugify(new.name);
  else
    base_slug := public.awardping_slugify(new.slug);
  end if;

  candidate_slug := base_slug;

  while exists (
    select 1
    from public.shared_awards
    where slug = candidate_slug
      and id <> new.id
  ) loop
    candidate_slug := base_slug || '-' || duplicate_index::text;
    duplicate_index := duplicate_index + 1;
  end loop;

  new.slug := candidate_slug;
  return new;
end;
$$;

drop trigger if exists set_shared_award_slug on public.shared_awards;
create trigger set_shared_award_slug
  before insert or update of name, slug on public.shared_awards
  for each row
  execute function public.set_shared_award_slug();
