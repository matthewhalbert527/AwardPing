alter table public.awards
  add column if not exists workflow_status text not null default 'watching' check (
    workflow_status in ('watching', 'needs_review', 'in_progress', 'ready', 'done')
  ),
  add column if not exists priority text not null default 'normal' check (
    priority in ('normal', 'high')
  ),
  add column if not exists owner_member_id uuid references public.office_members(id) on delete set null,
  add column if not exists last_reviewed_at timestamptz;

create table if not exists public.award_notes (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  award_id uuid not null references public.awards(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  author_member_id uuid references public.office_members(id) on delete set null,
  body text not null check (char_length(trim(body)) > 0 and char_length(body) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.award_tasks (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id) on delete cascade,
  award_id uuid not null references public.awards(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  assigned_member_id uuid references public.office_members(id) on delete set null,
  title text not null check (char_length(trim(title)) > 0 and char_length(title) <= 240),
  status text not null default 'todo' check (status in ('todo', 'done')),
  completed_at timestamptz,
  completed_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.award_notes enable row level security;
alter table public.award_tasks enable row level security;

drop policy if exists "awards workflow editable by office members" on public.awards;
create policy "awards workflow editable by office members" on public.awards
  for update using (
    office_id is not null and public.is_office_member(awards.office_id, auth.uid())
  )
  with check (
    office_id is not null and public.is_office_member(awards.office_id, auth.uid())
  );

drop policy if exists "award notes visible to office members" on public.award_notes;
create policy "award notes visible to office members" on public.award_notes
  for select using (public.is_office_member(award_notes.office_id, auth.uid()));

drop policy if exists "award notes created by office members" on public.award_notes;
create policy "award notes created by office members" on public.award_notes
  for insert with check (
    author_user_id = auth.uid()
    and public.is_office_member(award_notes.office_id, auth.uid())
  );

drop policy if exists "award tasks visible to office members" on public.award_tasks;
create policy "award tasks visible to office members" on public.award_tasks
  for select using (public.is_office_member(award_tasks.office_id, auth.uid()));

drop policy if exists "award tasks created by office members" on public.award_tasks;
create policy "award tasks created by office members" on public.award_tasks
  for insert with check (
    created_by_user_id = auth.uid()
    and public.is_office_member(award_tasks.office_id, auth.uid())
  );

drop policy if exists "award tasks editable by office members" on public.award_tasks;
create policy "award tasks editable by office members" on public.award_tasks
  for update using (public.is_office_member(award_tasks.office_id, auth.uid()))
  with check (public.is_office_member(award_tasks.office_id, auth.uid()));

create index if not exists awards_office_workflow_idx
  on public.awards (office_id, workflow_status, priority, updated_at desc);

create index if not exists awards_owner_member_idx
  on public.awards (owner_member_id);

create index if not exists award_notes_award_created_idx
  on public.award_notes (award_id, created_at desc);

create index if not exists award_tasks_award_status_idx
  on public.award_tasks (award_id, status, created_at desc);

create index if not exists award_tasks_assigned_idx
  on public.award_tasks (assigned_member_id, status);
