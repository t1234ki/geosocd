-- Run this in Supabase SQL Editor and share the result if signup still fails.

select
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'profiles'
order by ordinal_position;

select
  conname,
  pg_get_constraintdef(oid) as constraint_definition
from pg_constraint
where conrelid = 'public.profiles'::regclass
order by conname;

select
  tgname,
  pg_get_triggerdef(oid) as trigger_definition
from pg_trigger
where tgrelid = 'auth.users'::regclass
  and not tgisinternal;
