-- Freshroots Reorder Desk: who may see and change decisions, and where they live.
-- Mirrors the claude.ai artifact's rules: the team reads, only Editors write, a run is never replaced once it exists.

-- Desk access. Every new sign-in account starts as a viewer; the owner sets role = 'editor' for Raghav and Deepa.
create table public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  role text not null default 'viewer' check (role in ('editor', 'viewer')),
  created_at timestamptz not null default now()
);
comment on table public.members is 'Desk access. New accounts are viewers; set role to editor for the people who approve orders.';

-- One record per export (Monday and Thursday runs are separate), holding its decisions and AI briefs.
create table public.runs (
  id text primary key,
  data jsonb not null,
  source text generated always as (data ->> 'source') stored,
  as_of text generated always as (data ->> 'asOf') stored,
  updated_at timestamptz not null default now()
);
create index runs_source_as_of on public.runs (source, as_of);

-- The caller's desk role, or null if they are not on the desk.
create function public.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.members where user_id = (select auth.uid())
$$;
revoke execute on function public.my_role() from public, anon;
grant execute on function public.my_role() to authenticated;

alter table public.members enable row level security;
alter table public.runs enable row level security;

create policy "team sees the team" on public.members for select to authenticated
  using (user_id = (select auth.uid()) or (select public.my_role()) is not null);
create policy "team reads runs" on public.runs for select to authenticated
  using ((select public.my_role()) is not null);
create policy "editors create runs" on public.runs for insert to authenticated
  with check ((select public.my_role()) = 'editor');
create policy "editors change runs" on public.runs for update to authenticated
  using ((select public.my_role()) = 'editor') with check ((select public.my_role()) = 'editor');
-- No delete policy: runs and their decisions are the audit trail.

-- Add decisions or briefs to a run without replacing what others saved. Runs as the caller, so the rules above apply.
-- Returns false when the run doesn't exist or the caller may not change it.
create function public.merge_run(run_id text, patch jsonb) returns boolean
language sql security invoker set search_path = '' as $$
  with changed as (
    update public.runs set
      data = (data || (patch - 'decisions' - 'briefs'))
        || jsonb_build_object(
             'decisions', coalesce(data -> 'decisions', '{}'::jsonb) || coalesce(patch -> 'decisions', '{}'::jsonb),
             'briefs', coalesce(data -> 'briefs', '{}'::jsonb) || coalesce(patch -> 'briefs', '{}'::jsonb)),
      updated_at = now()
    where id = run_id
    returning 1)
  select exists (select 1 from changed)
$$;
revoke execute on function public.merge_run(text, jsonb) from public, anon;
grant execute on function public.merge_run(text, jsonb) to authenticated;

-- Every account the owner creates gets a viewer seat.
create function public.add_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.members (user_id, email) values (new.id, coalesce(new.email, '')) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.add_member();

-- Decisions made by one person appear live for everyone else on the run.
alter publication supabase_realtime add table public.runs;
