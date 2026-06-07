update public.shared_awards
set summary = null,
    updated_at = now()
where summary = 'Default nationally competitive award monitored for new offices.';

update public.awards
set summary = null,
    updated_at = now()
where summary = 'Default nationally competitive award monitored for new offices.';
