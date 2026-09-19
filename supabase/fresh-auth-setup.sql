-- Run this entire script once in Supabase SQL Editor.
-- It preserves the tables, repairs legacy columns, and recreates signup safely.

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

insert into public.organizations (name)
select 'GEODues Association'
where not exists (select 1 from public.organizations);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  index_number text,
  full_name text not null default '',
  phone text,
  role text not null default 'member',
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists organization_id uuid references public.organizations(id) on delete set null;
alter table public.profiles add column if not exists index_number text;
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists role text;

-- Convert the old user_role enum before assigning the text default.
alter table public.profiles alter column role drop default;
alter table public.profiles alter column role type text using role::text;
alter table public.profiles alter column organization_id drop not null;
alter table public.profiles alter column index_number drop not null;
alter table public.profiles alter column phone drop not null;
alter table public.profiles alter column full_name set default '';
alter table public.profiles alter column role set default 'member';
update public.profiles
set full_name = coalesce(nullif(trim(full_name), ''), 'GEODues user'),
    role = case when role = 'admin' then 'admin' else 'member' end
where full_name is null or trim(full_name) = '' or role is null or role not in ('admin', 'member');
alter table public.profiles alter column full_name set not null;
alter table public.profiles alter column role set not null;

-- Remove legacy role checks that reference the old enum, then use a text check.
do $$
declare
  check_constraint record;
begin
  for check_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', check_constraint.conname);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_role_check check (role in ('admin', 'member'));

create table if not exists public.dues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid references public.profiles(id) on delete cascade,
  title text not null,
  amount integer not null check (amount > 0),
  due_date date not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'overdue')),
  created_at timestamptz not null default now()
);

alter table public.dues alter column member_id drop not null;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  due_id uuid not null references public.dues(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null,
  paystack_reference text unique not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null unique references public.payments(id) on delete cascade,
  receipt_number text not null unique,
  issued_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  payment_id uuid references public.payments(id) on delete set null,
  channel text not null check (channel in ('sms', 'email')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  recipient text not null,
  message text not null,
  provider_reference text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.dues enable row level security;
alter table public.payments enable row level security;
alter table public.receipts enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "profiles visible to self or org admins" on public.profiles;
drop policy if exists "members update own profile" on public.profiles;
drop policy if exists "admins manage profiles" on public.profiles;

create or replace function public.is_org_admin(target_org uuid)
returns boolean
language sql
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and organization_id = target_org
      and role = 'admin'
  );
$$;

revoke all on function public.is_org_admin(uuid) from public;
grant execute on function public.is_org_admin(uuid) to authenticated;

create policy "profiles visible to self or org admins"
on public.profiles for select
using (id = auth.uid() or public.is_org_admin(organization_id));

create policy "members update own profile"
on public.profiles for update
using (id = auth.uid());

create policy "admins manage profiles"
on public.profiles for all
using (public.is_org_admin(organization_id));

drop policy if exists "members read own dues" on public.dues;
drop policy if exists "admins manage dues" on public.dues;
drop policy if exists "members read own payments" on public.payments;
drop policy if exists "members create own payments" on public.payments;
drop policy if exists "admins manage payments" on public.payments;
drop policy if exists "members read own receipts" on public.receipts;
drop policy if exists "admins read receipts" on public.receipts;
drop policy if exists "members read own notifications" on public.notifications;
drop policy if exists "admins read notifications" on public.notifications;

create policy "members read own dues" on public.dues for select
using (organization_id = (select organization_id from public.profiles where id = auth.uid()) and (member_id = auth.uid() or member_id is null) or public.is_org_admin(organization_id));
create policy "admins manage dues" on public.dues for all
using (public.is_org_admin(organization_id));
create policy "members read own payments" on public.payments for select
using (member_id = auth.uid() or exists (select 1 from public.dues d where d.id = due_id and public.is_org_admin(d.organization_id)));
create policy "admins manage payments" on public.payments for all
using (exists (select 1 from public.dues d where d.id = due_id and public.is_org_admin(d.organization_id)));
create policy "members read own receipts" on public.receipts for select
using (exists (select 1 from public.payments p where p.id = payment_id and p.member_id = auth.uid()));
create policy "admins read receipts" on public.receipts for select
using (exists (select 1 from public.payments p join public.dues d on d.id = p.due_id where p.id = payment_id and public.is_org_admin(d.organization_id)));
create policy "members read own notifications" on public.notifications for select
using (member_id = auth.uid());
create policy "admins read notifications" on public.notifications for select
using (exists (select 1 from public.profiles p where p.id = member_id and public.is_org_admin(p.organization_id)));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  association_id uuid;
  account_role text;
begin
  select id into association_id
  from public.organizations
  order by created_at
  limit 1;

  if association_id is null then
    insert into public.organizations (name)
    values ('GEODues Association')
    returning id into association_id;
  end if;

  account_role := case
    when exists (select 1 from public.profiles where role = 'admin') then 'member'
    else 'admin'
  end;

  insert into public.profiles (id, organization_id, index_number, full_name, phone, role)
  values (
    new.id,
    association_id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'index_number', '')), ''),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1), 'GEODues user'),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'phone', new.phone, '')), ''),
    account_role
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

grant usage on schema public to anon, authenticated;
grant usage on schema public to service_role;
grant select on public.organizations to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.dues to authenticated;
grant select on public.payments to authenticated;
grant select on public.receipts, public.notifications to authenticated;
grant select, insert, update on public.organizations, public.profiles, public.dues, public.payments, public.receipts, public.notifications to service_role;