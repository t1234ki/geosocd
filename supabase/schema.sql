create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

insert into public.organizations (name)
select 'GEODues Association'
where not exists (select 1 from public.organizations where name = 'GEODues Association');

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  index_number text,
  full_name text not null default '',
  phone text,
  role text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now()
);
  alter table public.profiles add column if not exists index_number text;
  alter table public.profiles add column if not exists organization_id uuid references public.organizations(id) on delete set null;
  alter table public.profiles add column if not exists full_name text not null default '';
  alter table public.profiles add column if not exists phone text;
  alter table public.profiles add column if not exists role text not null default 'member';

create table if not exists public.dues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid references public.profiles(id) on delete cascade,
  title text not null,
  amount integer not null check (amount > 0),
  due_date date not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'overdue')),
  index_numbers text[] not null default '{}',
  created_at timestamptz not null default now()
);
  alter table public.dues alter column member_id drop not null;
  alter table public.dues add column if not exists index_numbers text[] not null default '{}';

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  due_id uuid not null unique references public.dues(id) on delete cascade,
  event_name text not null,
  ticket_type text not null default 'single' check (ticket_type in ('single', 'double', 'vip')),
  capacity integer check (capacity is null or capacity > 0),
  cancelled_at timestamptz,
  description text not null default '',
  image_url text,
  index_numbers text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  due_id uuid not null references public.dues(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null,
  paystack_reference text unique not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  refund_status text not null default 'none' check (refund_status in ('none', 'requested', 'refunded')),
  refund_reason text,
  refunded_at timestamptz,
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
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
  alter table public.receipts add column if not exists receipt_number text;
  alter table public.notifications add column if not exists provider_reference text;

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.dues enable row level security;
alter table public.payments enable row level security;
alter table public.receipts enable row level security;
alter table public.notifications enable row level security;
alter table public.tickets enable row level security;
alter table public.audit_logs enable row level security;
alter table public.tickets add column if not exists ticket_type text not null default 'single';
alter table public.tickets add column if not exists capacity integer;
alter table public.tickets add column if not exists cancelled_at timestamptz;
alter table public.payments add column if not exists refund_status text not null default 'none';
alter table public.payments add column if not exists refund_reason text;
alter table public.payments add column if not exists refunded_at timestamptz;

create or replace function public.enforce_ticket_purchase_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ticket_capacity integer;
  paid_count integer;
begin
  if new.status <> 'paid' then return new; end if;
  select capacity into ticket_capacity from public.tickets where due_id = new.due_id;
  if not found then return new; end if;
  if exists (select 1 from public.payments where due_id = new.due_id and member_id = new.member_id and status = 'paid' and id <> coalesce(new.id, gen_random_uuid())) then
    raise exception 'This member has already purchased this ticket';
  end if;
  if ticket_capacity is not null then
    select count(*) into paid_count from public.payments where due_id = new.due_id and status = 'paid' and id <> coalesce(new.id, gen_random_uuid());
    if paid_count >= ticket_capacity then raise exception 'This ticket is sold out'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_ticket_purchase_rules on public.payments;
create trigger enforce_ticket_purchase_rules before insert or update on public.payments for each row execute procedure public.enforce_ticket_purchase_rules();

create or replace function public.is_org_admin(target_org uuid)
returns boolean
language sql
security definer
set search_path = public
set row_security = off
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and organization_id = target_org and role = 'admin');
$$;

revoke all on function public.is_org_admin(uuid) from public;
grant execute on function public.is_org_admin(uuid) to authenticated;
grant usage on schema public to service_role;
grant select, insert, update on public.organizations, public.profiles, public.dues, public.payments, public.receipts, public.notifications, public.tickets to service_role;
grant select, insert, update, delete on public.tickets to authenticated;
grant select, insert on public.audit_logs to authenticated;

drop policy if exists "profiles visible to self or org admins" on public.profiles;
drop policy if exists "members update own profile" on public.profiles;
drop policy if exists "admins manage profiles" on public.profiles;
drop policy if exists "members read own dues" on public.dues;
drop policy if exists "admins manage dues" on public.dues;
drop policy if exists "members read own payments" on public.payments;
drop policy if exists "members create own payments" on public.payments;
drop policy if exists "members create own payments" on public.payments;
drop policy if exists "admins manage payments" on public.payments;
drop policy if exists "members read own receipts" on public.receipts;
drop policy if exists "admins read receipts" on public.receipts;
drop policy if exists "members read own notifications" on public.notifications;
drop policy if exists "admins read notifications" on public.notifications;
drop policy if exists "members read matching tickets" on public.tickets;
drop policy if exists "admins manage tickets" on public.tickets;
drop policy if exists "admins read audit logs" on public.audit_logs;
drop policy if exists "admins insert audit logs" on public.audit_logs;

create policy "profiles visible to self or org admins" on public.profiles for select using (id = auth.uid() or public.is_org_admin(organization_id));
create policy "members update own profile" on public.profiles for update using (id = auth.uid());
create policy "admins manage profiles" on public.profiles for all using (public.is_org_admin(organization_id));
create policy "members read own dues" on public.dues for select using (public.is_org_admin(organization_id) or (organization_id = (select organization_id from public.profiles where id = auth.uid()) and (member_id = auth.uid() or (member_id is null and (cardinality(index_numbers) = 0 or (select index_number from public.profiles where id = auth.uid()) = any(index_numbers))))));
create policy "admins manage dues" on public.dues for all using (public.is_org_admin(organization_id));
create policy "members read own payments" on public.payments for select using (member_id = auth.uid() or exists (select 1 from public.dues d where d.id = due_id and public.is_org_admin(d.organization_id)));
create policy "admins manage payments" on public.payments for all using (exists (select 1 from public.dues d where d.id = due_id and public.is_org_admin(d.organization_id)));
create policy "members read own receipts" on public.receipts for select using (exists (select 1 from public.payments p where p.id = payment_id and p.member_id = auth.uid()));
create policy "admins read receipts" on public.receipts for select using (exists (select 1 from public.payments p join public.dues d on d.id = p.due_id where p.id = payment_id and public.is_org_admin(d.organization_id)));
create policy "members read own notifications" on public.notifications for select using (member_id = auth.uid());
create policy "admins read notifications" on public.notifications for select using (exists (select 1 from public.profiles p where p.id = member_id and public.is_org_admin(p.organization_id)));
create policy "members read matching tickets" on public.tickets for select using (
  organization_id = (select organization_id from public.profiles where id = auth.uid())
  and (cardinality(index_numbers) = 0 or (select index_number from public.profiles where id = auth.uid()) = any(index_numbers))
);
create policy "admins manage tickets" on public.tickets for all using (public.is_org_admin(organization_id));
create policy "admins read audit logs" on public.audit_logs for select using (public.is_org_admin(organization_id));
create policy "admins insert audit logs" on public.audit_logs for insert with check (public.is_org_admin(organization_id) and actor_id = auth.uid());

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
  select id into association_id from public.organizations order by created_at limit 1;
  if association_id is null then
    insert into public.organizations (name) values ('GEODues Association') returning id into association_id;
  end if;
  account_role := case when exists (select 1 from public.profiles where role = 'admin') then 'member' else 'admin' end;
  insert into public.profiles (id, organization_id, index_number, full_name, phone, role)
  values (
    new.id,
    association_id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'index_number', '')), ''),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1), ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'phone', new.phone, '')), ''),
    account_role
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

update public.profiles
set organization_id = (select id from public.organizations order by created_at limit 1)
where organization_id is null;

update public.profiles
set role = 'admin'
where id = (select id from public.profiles order by created_at limit 1)
  and not exists (select 1 from public.profiles where role = 'admin');

create or replace function public.create_association(association_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in';
  end if;

  if exists (select 1 from public.profiles where id = auth.uid() and organization_id is not null) then
    raise exception 'This account already belongs to an association';
  end if;

  insert into public.organizations (name) values (trim(association_name)) returning id into new_organization_id;
  update public.profiles set organization_id = new_organization_id, role = 'admin' where id = auth.uid();
  return new_organization_id;
end;
$$;

