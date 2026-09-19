alter table public.tickets add column if not exists cancelled_at timestamptz;
alter table public.payments add column if not exists refund_status text not null default 'none';
alter table public.payments add column if not exists refund_reason text;
alter table public.payments add column if not exists refunded_at timestamptz;

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
alter table public.audit_logs enable row level security;
grant select, insert on public.audit_logs to authenticated;
drop policy if exists "admins read audit logs" on public.audit_logs;
drop policy if exists "admins insert audit logs" on public.audit_logs;
create policy "admins read audit logs" on public.audit_logs for select using (public.is_org_admin(organization_id));
create policy "admins insert audit logs" on public.audit_logs for insert with check (public.is_org_admin(organization_id) and actor_id = auth.uid());