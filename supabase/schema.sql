create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role text not null default 'staff' check (role in ('admin', 'staff', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  next_role text;
begin
  select case when exists (select 1 from public.profiles) then 'staff' else 'admin' end
    into next_role;

  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    next_role
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user() from authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.current_staff_role()
returns text
language sql
stable
as 'select role from public.profiles where id = (select auth.uid())';

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
    select 1 from public.profiles
    where id = (select auth.uid())
      and role = ''admin''
  )';

create table if not exists public.colors (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  hex text not null,
  category text not null default 'Classic',
  current_stock_grams numeric(12,2) not null default 0 check (current_stock_grams >= 0),
  estimated_bead_count integer not null default 0 check (estimated_bead_count >= 0),
  cost_per_gram numeric(12,2) not null default 0 check (cost_per_gram >= 0),
  minimum_stock_grams numeric(12,2) not null default 0 check (minimum_stock_grams >= 0),
  safety_stock_grams numeric(12,2) not null default 0 check (safety_stock_grams >= 0),
  storage_location text not null default '',
  active boolean not null default true,
  previous_stock_grams numeric(12,2) not null default 0 check (previous_stock_grams >= 0),
  last_opname_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.restock_records (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  color_id uuid not null references public.colors(id) on delete restrict,
  quantity_grams numeric(12,2) not null check (quantity_grams > 0),
  purchase_cost numeric(14,2) not null check (purchase_cost >= 0),
  supplier text not null default '',
  batch_number text not null default '',
  notes text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.stock_opname_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'confirmed')),
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table if not exists public.stock_opname_lines (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.stock_opname_sessions(id) on delete cascade,
  color_id uuid not null references public.colors(id) on delete restrict,
  previous_system_stock numeric(12,2) not null default 0,
  restock_since_last_opname numeric(12,2) not null default 0,
  actual_stock_grams numeric(12,2),
  calculated_usage numeric(12,2) generated always as (
    greatest(0, previous_system_stock + restock_since_last_opname - coalesce(actual_stock_grams, previous_system_stock))
  ) stored,
  difference numeric(12,2) generated always as (
    coalesce(actual_stock_grams, previous_system_stock) - (previous_system_stock + restock_since_last_opname)
  ) stored,
  unique (session_id, color_id)
);

create table if not exists public.usage_records (
  id uuid primary key default gen_random_uuid(),
  color_id uuid not null references public.colors(id) on delete restrict,
  opening_stock_grams numeric(12,2) not null default 0,
  restock_grams numeric(12,2) not null default 0,
  closing_stock_grams numeric(12,2) not null default 0,
  usage_grams numeric(12,2) generated always as (
    greatest(0, opening_stock_grams + restock_grams - closing_stock_grams)
  ) stored,
  period_start timestamptz not null,
  period_end timestamptz not null,
  opname_session_id uuid references public.stock_opname_sessions(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create or replace view public.inventory_forecast
with (security_invoker = true)
as
select
  c.id as color_id,
  c.code,
  c.name,
  c.current_stock_grams,
  c.safety_stock_grams,
  c.minimum_stock_grams,
  c.cost_per_gram,
  coalesce(sum(u.usage_grams) filter (where u.period_end >= now() - interval '30 days'), 0) as usage_30_days,
  coalesce(sum(u.usage_grams) filter (where u.period_end >= now() - interval '30 days'), 0) / 30 as average_daily_usage,
  case
    when c.current_stock_grams <= 0 then 'Out of Stock'
    when c.current_stock_grams <= c.minimum_stock_grams then 'Reorder Now'
    when coalesce(sum(u.usage_grams) filter (where u.period_end >= now() - interval '30 days'), 0) <= 0 then 'Healthy'
    when (c.current_stock_grams - c.safety_stock_grams) / nullif(coalesce(sum(u.usage_grams) filter (where u.period_end >= now() - interval '30 days'), 0) / 30, 0) <= 14 then 'Reorder Soon'
    else 'Healthy'
  end as reorder_status,
  greatest(0, (coalesce(sum(u.usage_grams) filter (where u.period_end >= now() - interval '30 days'), 0) / 30 * 14) + c.safety_stock_grams - c.current_stock_grams) as recommended_order_14_days,
  greatest(0, (coalesce(sum(u.usage_grams) filter (where u.period_end >= now() - interval '30 days'), 0) / 30 * 30) + c.safety_stock_grams - c.current_stock_grams) as recommended_order_30_days,
  c.current_stock_grams * c.cost_per_gram as inventory_value
from public.colors c
left join public.usage_records u on u.color_id = c.id
group by c.id;

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
