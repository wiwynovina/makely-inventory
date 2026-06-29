create or replace function public.can_read_inventory()
returns boolean
language sql
stable
as 'select exists (
  select 1
  from public.profiles
  where id = (select auth.uid())
    and role in (''admin'', ''staff'', ''viewer'')
)';

create or replace function public.can_write_inventory()
returns boolean
language sql
stable
as 'select exists (
  select 1
  from public.profiles
  where id = (select auth.uid())
    and role in (''admin'', ''staff'')
)';

create or replace function public.is_inventory_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as 'select exists (
  select 1
  from public.profiles
  where id = (select auth.uid())
    and role = ''admin''
)';

alter table public.profiles enable row level security;
alter table public.colors enable row level security;
alter table public.restock_records enable row level security;
alter table public.stock_opname_sessions enable row level security;
alter table public.stock_opname_lines enable row level security;
alter table public.usage_records enable row level security;

drop policy if exists "profiles select own" on public.profiles;
drop policy if exists "profiles update admin" on public.profiles;
drop policy if exists "inventory read colors" on public.colors;
drop policy if exists "inventory write colors" on public.colors;
drop policy if exists "inventory read restocks" on public.restock_records;
drop policy if exists "inventory write restocks" on public.restock_records;
drop policy if exists "inventory read opname sessions" on public.stock_opname_sessions;
drop policy if exists "inventory write opname sessions" on public.stock_opname_sessions;
drop policy if exists "inventory read opname lines" on public.stock_opname_lines;
drop policy if exists "inventory write opname lines" on public.stock_opname_lines;
drop policy if exists "inventory read usage records" on public.usage_records;
drop policy if exists "inventory write usage records" on public.usage_records;

create policy "profiles select own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id or public.is_inventory_admin());

create policy "profiles update admin" on public.profiles
  for update to authenticated
  using (public.is_inventory_admin())
  with check (true);

create policy "inventory read colors" on public.colors for select to authenticated using (public.can_read_inventory());
create policy "inventory write colors" on public.colors for all to authenticated using (public.can_write_inventory()) with check (public.can_write_inventory());

create policy "inventory read restocks" on public.restock_records for select to authenticated using (public.can_read_inventory());
create policy "inventory write restocks" on public.restock_records for all to authenticated using (public.can_write_inventory()) with check (public.can_write_inventory());

create policy "inventory read opname sessions" on public.stock_opname_sessions for select to authenticated using (public.can_read_inventory());
create policy "inventory write opname sessions" on public.stock_opname_sessions for all to authenticated using (public.can_write_inventory()) with check (public.can_write_inventory());

create policy "inventory read opname lines" on public.stock_opname_lines for select to authenticated using (public.can_read_inventory());
create policy "inventory write opname lines" on public.stock_opname_lines for all to authenticated using (public.can_write_inventory()) with check (public.can_write_inventory());

create policy "inventory read usage records" on public.usage_records for select to authenticated using (public.can_read_inventory());
create policy "inventory write usage records" on public.usage_records for all to authenticated using (public.can_write_inventory()) with check (public.can_write_inventory());

grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.colors to authenticated;
grant select, insert, update, delete on public.restock_records to authenticated;
grant select, insert, update, delete on public.stock_opname_sessions to authenticated;
grant select, insert, update, delete on public.stock_opname_lines to authenticated;
grant select, insert, update, delete on public.usage_records to authenticated;
grant select on public.inventory_forecast to authenticated;
