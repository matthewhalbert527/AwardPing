-- Notes and follow-up tasks are office-owned children of an office-owned
-- award. Legacy policies checked only the child office_id, so a browser client
-- could attach a child from its own office to a guessed award UUID belonging to
-- another office. Reject any historical mismatch and make that relationship a
-- database invariant before retiring direct browser mutations.

do $$
begin
  if exists (
    select 1
    from public.award_notes note
    join public.awards award on award.id = note.award_id
    where note.office_id is distinct from award.office_id
  ) or exists (
    select 1
    from public.award_tasks task
    join public.awards award on award.id = task.award_id
    where task.office_id is distinct from award.office_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cross-office award notes or tasks require reviewed manual repair.';
  end if;

  if exists (
    select 1
    from public.award_notes note
    join public.office_members member on member.id = note.author_member_id
    where note.author_member_id is not null
      and note.office_id is distinct from member.office_id
  ) or exists (
    select 1
    from public.award_tasks task
    join public.office_members member on member.id = task.assigned_member_id
    where task.assigned_member_id is not null
      and task.office_id is distinct from member.office_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cross-office award note authors or task assignees require reviewed manual repair.';
  end if;
end;
$$;

alter table public.office_members
  add constraint office_members_id_office_id_key unique (id, office_id);

alter table public.award_notes
  drop constraint if exists award_notes_award_id_fkey,
  drop constraint if exists award_notes_author_member_id_fkey,
  add constraint award_notes_award_office_fkey
    foreign key (award_id, office_id)
    references public.awards(id, office_id)
    on delete cascade,
  add constraint award_notes_author_member_office_fkey
    foreign key (author_member_id, office_id)
    references public.office_members(id, office_id)
    on delete set null (author_member_id);

alter table public.award_tasks
  drop constraint if exists award_tasks_award_id_fkey,
  drop constraint if exists award_tasks_assigned_member_id_fkey,
  add constraint award_tasks_award_office_fkey
    foreign key (award_id, office_id)
    references public.awards(id, office_id)
    on delete cascade,
  add constraint award_tasks_assigned_member_office_fkey
    foreign key (assigned_member_id, office_id)
    references public.office_members(id, office_id)
    on delete set null (assigned_member_id);

-- The application routes derive office_id from the authorized parent award
-- and use the service role. Remove the older direct Data API mutation paths so
-- callers cannot bypass those parent/assignee checks with handcrafted rows.
drop policy if exists "award notes created by office members" on public.award_notes;
drop policy if exists "award tasks created by office members" on public.award_tasks;
drop policy if exists "award tasks editable by office members" on public.award_tasks;

revoke all on table public.award_notes from anon;
revoke all on table public.award_tasks from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.award_notes from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.award_tasks from authenticated;

grant select on table public.award_notes to authenticated;
grant select on table public.award_tasks to authenticated;
grant select, insert, update, delete on table public.award_notes to service_role;
grant select, insert, update, delete on table public.award_tasks to service_role;
