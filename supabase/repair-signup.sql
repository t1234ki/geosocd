-- Run this once in Supabase SQL Editor if signup still says
-- "Database error saving new user". It refreshes only the auth profile trigger.

insert into public.organizations (name)
select 'GEODues Association'
where not exists (select 1 from public.organizations where name = 'GEODues Association');

alter table public.profiles add column if not exists organization_id uuid references public.organizations(id) on delete set null;
alter table public.profiles add column if not exists index_number text;
alter table public.profiles add column if not exists full_name text not null default '';
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists role text not null default 'member';
alter table public.profiles alter column organization_id drop not null;
alter table public.profiles alter column index_number drop not null;
alter table public.profiles alter column phone drop not null;
alter table public.profiles alter column full_name set default '';

-- Older versions used a user_role enum that did not contain "member".
-- Convert it to the text role used by the current app before setting defaults.
alter table public.profiles alter column role drop default;
alter table public.profiles alter column role type text using role::text;
update public.profiles set role = 'member' where role is null or role not in ('admin', 'member');
alter table public.profiles alter column role set not null;
alter table public.profiles alter column role set default 'member';

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
  )
  on conflict (id) do update set
    organization_id = excluded.organization_id,
    index_number = excluded.index_number,
    full_name = excluded.full_name,
    phone = excluded.phone,
    role = excluded.role;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

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
