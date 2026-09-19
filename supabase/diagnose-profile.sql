-- Run this in Supabase SQL Editor and inspect the result.
-- It identifies legacy constraints that can break the auth signup trigger.

select
  c.conname as constraint_name,
  c.contype as constraint_type,
  pg_get_constraintdef(c.oid) as definition
from pg_constraint c
where c.conrelid = 'public.profiles'::regclass
order by c.conname;

select
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;

select count(*) as organization_count from public.organizations;
select count(*) as profile_count from public.profiles;
