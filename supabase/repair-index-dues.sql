-- Add index targeting to existing dues tables.
alter table public.dues
  add column if not exists index_numbers text[] not null default '{}';

-- Recreate member visibility so targeted dues are visible only to matching indexes.
drop policy if exists "members read own dues" on public.dues;

create policy "members read own dues" on public.dues
for select using (
  public.is_org_admin(organization_id)
  or (
    organization_id = (select organization_id from public.profiles where id = auth.uid())
    and (
      member_id = auth.uid()
      or (
        member_id is null
        and (
          cardinality(index_numbers) = 0
          or (select index_number from public.profiles where id = auth.uid()) = any(index_numbers)
        )
      )
    )
  )
);
