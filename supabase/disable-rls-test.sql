-- TEST ONLY: this removes database protection from GEODues tables.
-- Run this only to isolate whether RLS causes the current signup/dashboard error.
-- Restore the policies from schema.sql before production.

begin;

drop policy if exists "profiles visible to self or org admins" on public.profiles;
drop policy if exists "members update own profile" on public.profiles;
drop policy if exists "admins manage profiles" on public.profiles;
drop policy if exists "members read own dues" on public.dues;
drop policy if exists "admins manage dues" on public.dues;
drop policy if exists "members read own payments" on public.payments;
drop policy if exists "members create own payments" on public.payments;
drop policy if exists "admins manage payments" on public.payments;
drop policy if exists "members read own receipts" on public.receipts;
drop policy if exists "admins read receipts" on public.receipts;
drop policy if exists "members read own notifications" on public.notifications;
drop policy if exists "admins read notifications" on public.notifications;

alter table public.organizations disable row level security;
alter table public.profiles disable row level security;
alter table public.dues disable row level security;
alter table public.payments disable row level security;
alter table public.receipts disable row level security;
alter table public.notifications disable row level security;

commit;

-- After testing, restore protection by rerunning schema.sql.
