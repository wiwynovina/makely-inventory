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
