-- Add ticket capacity and enforce one paid ticket per member.
alter table public.tickets add column if not exists capacity integer;

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