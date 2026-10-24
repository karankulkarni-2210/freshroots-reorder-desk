-- Keep the role helper out of the public API: the access rules still use it, but nobody can call it over REST.
create schema if not exists private;
grant usage on schema private to authenticated;

create function private.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.members where user_id = (select auth.uid())
$$;
revoke execute on function private.my_role() from public, anon;
grant execute on function private.my_role() to authenticated;

alter policy "team sees the team" on public.members
  using (user_id = (select auth.uid()) or (select private.my_role()) is not null);
alter policy "team reads runs" on public.runs
  using ((select private.my_role()) is not null);
alter policy "editors create runs" on public.runs
  with check ((select private.my_role()) = 'editor');
alter policy "editors change runs" on public.runs
  using ((select private.my_role()) = 'editor') with check ((select private.my_role()) = 'editor');

drop function public.my_role();

-- The new-member trigger runs on its own; nobody needs to call it directly.
revoke execute on function public.add_member() from public, anon, authenticated;
