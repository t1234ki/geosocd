create extension if not exists btree_gist;

create table if not exists public.hotel_room_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null default '',
  nightly_rate integer not null check (nightly_rate > 0),
  capacity integer not null default 2 check (capacity > 0),
  amenities text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.hotel_rooms (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.hotel_room_categories(id) on delete restrict,
  room_name text not null unique,
  floor_number integer not null default 1,
  wing text not null default 'A',
  sort_order integer not null default 0,
  operational_status text not null default 'active' check (operational_status in ('active', 'maintenance')),
  created_at timestamptz not null default now()
);

create table if not exists public.hotel_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.hotel_reservations (
  id uuid primary key default gen_random_uuid(),
  booking_reference text not null unique,
  room_id uuid not null references public.hotel_rooms(id) on delete restrict,
  guest_user_id uuid references auth.users(id) on delete set null,
  guest_full_name text not null,
  guest_email text not null,
  guest_phone text not null,
  check_in date not null,
  check_out date not null,
  guest_count integer not null default 1 check (guest_count > 0),
  nightly_rate integer not null check (nightly_rate > 0),
  total_amount integer not null check (total_amount > 0),
  status text not null default 'reserved' check (status in ('reserved', 'checked_in', 'checked_out', 'cancelled')),
  arrival_notes text not null default '',
  created_at timestamptz not null default now(),
  check (check_out > check_in)
);

alter table public.hotel_reservations drop constraint if exists hotel_room_active_dates_excl;
alter table public.hotel_reservations add constraint hotel_room_active_dates_excl
  exclude using gist (room_id with =, daterange(check_in, check_out, '[)') with &&)
  where (status in ('reserved', 'checked_in'));

create index if not exists hotel_reservations_dates_idx on public.hotel_reservations (check_in, check_out) where status in ('reserved', 'checked_in');
create index if not exists hotel_rooms_deck_idx on public.hotel_rooms (floor_number, wing, sort_order);

create or replace function public.hotel_is_staff()
returns boolean language sql stable security definer set search_path = public set row_security = off
as $$ select exists (select 1 from public.hotel_staff where user_id = auth.uid()); $$;

create or replace function public.hotel_room_availability(p_check_in date, p_check_out date)
returns table (id uuid, category_id uuid, category_name text, description text, nightly_rate integer, capacity integer, amenities text[], room_name text, floor_number integer, wing text, sort_order integer, availability text)
language sql stable security definer set search_path = public set row_security = off
as $$
  select r.id, c.id, c.name, c.description, c.nightly_rate, c.capacity, c.amenities,
         r.room_name, r.floor_number, r.wing, r.sort_order,
         case when r.operational_status = 'maintenance' then 'maintenance'
              when exists (select 1 from public.hotel_reservations b where b.room_id = r.id and b.status = 'checked_in' and daterange(b.check_in, b.check_out, '[)') && daterange(p_check_in, p_check_out, '[)')) then 'occupied'
              when exists (select 1 from public.hotel_reservations b where b.room_id = r.id and b.status = 'reserved' and daterange(b.check_in, b.check_out, '[)') && daterange(p_check_in, p_check_out, '[)')) then 'reserved'
              else 'available' end
  from public.hotel_rooms r join public.hotel_room_categories c on c.id = r.category_id
  where p_check_out > p_check_in and r.operational_status in ('active', 'maintenance')
  order by r.floor_number, r.wing, r.sort_order, r.room_name;
$$;

grant execute on function public.hotel_room_availability(date, date) to anon, authenticated;

create or replace function public.hotel_create_reservation(
  p_room_id uuid, p_full_name text, p_email text, p_phone text,
  p_check_in date, p_check_out date, p_guest_count integer default 1
) returns jsonb language plpgsql security definer set search_path = public set row_security = off
as $$
declare
  v_room record;
  v_reference text;
  v_nights integer;
  v_booking hotel_reservations%rowtype;
begin
  if p_check_in < current_date or p_check_out <= p_check_in then raise exception 'Choose valid arrival and departure dates.'; end if;
  if length(trim(p_full_name)) < 2 or position('@' in p_email) < 2 or length(trim(p_phone)) < 7 then raise exception 'Enter your name, valid email, and phone number.'; end if;
  select r.id, r.operational_status, c.nightly_rate, c.capacity into v_room
  from public.hotel_rooms r join public.hotel_room_categories c on c.id = r.category_id where r.id = p_room_id for update of r;
  if not found or v_room.operational_status <> 'active' then raise exception 'This room is not available to reserve.'; end if;
  if v_room.nightly_rate is null or v_room.nightly_rate < 1 then raise exception 'This room rate has not been configured. Please call the hotel.'; end if;
  if p_guest_count < 1 or p_guest_count > v_room.capacity then raise exception 'Guest count exceeds this room capacity.'; end if;
  v_nights := p_check_out - p_check_in;
  v_reference := 'JH-' || upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 8));
  insert into public.hotel_reservations (booking_reference, room_id, guest_user_id, guest_full_name, guest_email, guest_phone, check_in, check_out, guest_count, nightly_rate, total_amount)
  values (v_reference, p_room_id, auth.uid(), trim(p_full_name), lower(trim(p_email)), trim(p_phone), p_check_in, p_check_out, p_guest_count, v_room.nightly_rate, v_room.nightly_rate * v_nights)
  returning * into v_booking;
  return jsonb_build_object('id', v_booking.id, 'booking_reference', v_booking.booking_reference, 'guest_full_name', v_booking.guest_full_name, 'guest_email', v_booking.guest_email, 'guest_phone', v_booking.guest_phone, 'check_in', v_booking.check_in, 'check_out', v_booking.check_out, 'guest_count', v_booking.guest_count, 'nightly_rate', v_booking.nightly_rate, 'total_amount', v_booking.total_amount, 'status', v_booking.status);
exception when exclusion_violation or unique_violation then
  raise exception 'This room was just reserved for overlapping dates. Please choose another room.';
end;
$$;

grant execute on function public.hotel_create_reservation(uuid, text, text, text, date, date, integer) to anon, authenticated;

create or replace function public.hotel_find_reservation(p_booking_reference text, p_email text)
returns jsonb language sql stable security definer set search_path = public set row_security = off
as $$
  select jsonb_build_object('booking_reference', b.booking_reference, 'guest_full_name', b.guest_full_name, 'guest_email', b.guest_email, 'guest_phone', b.guest_phone, 'check_in', b.check_in, 'check_out', b.check_out, 'guest_count', b.guest_count, 'nightly_rate', b.nightly_rate, 'total_amount', b.total_amount, 'status', b.status, 'room_name', r.room_name, 'category_name', c.name, 'amenities', c.amenities)
  from public.hotel_reservations b join public.hotel_rooms r on r.id = b.room_id join public.hotel_room_categories c on c.id = r.category_id
  where upper(b.booking_reference) = upper(trim(p_booking_reference)) and lower(b.guest_email) = lower(trim(p_email))
  limit 1;
$$;

grant execute on function public.hotel_find_reservation(text, text) to anon, authenticated;

create or replace function public.hotel_staff_reservations()
returns table (id uuid, booking_reference text, guest_full_name text, guest_email text, guest_phone text, check_in date, check_out date, guest_count integer, total_amount integer, status text, room_name text, category_name text)
language plpgsql stable security definer set search_path = public set row_security = off
as $$
begin
  if not public.hotel_is_staff() then raise exception 'Hotel staff access required.'; end if;
  return query
  select b.id, b.booking_reference, b.guest_full_name, b.guest_email, b.guest_phone, b.check_in, b.check_out, b.guest_count, b.total_amount, b.status, r.room_name, c.name
  from public.hotel_reservations b join public.hotel_rooms r on r.id = b.room_id join public.hotel_room_categories c on c.id = r.category_id
  order by b.check_in, b.created_at desc;
end;
$$;

create or replace function public.hotel_update_reservation_status(p_reservation_id uuid, p_status text)
returns boolean language plpgsql security definer set search_path = public set row_security = off
as $$
begin
  if not public.hotel_is_staff() then raise exception 'Staff access required.'; end if;
  if p_status not in ('reserved', 'checked_in', 'checked_out', 'cancelled') then raise exception 'Invalid reservation status.'; end if;
  if p_status = 'checked_in' and exists (
    select 1 from public.hotel_reservations target
    join public.hotel_reservations conflict on conflict.room_id = target.room_id and conflict.id <> target.id
    where target.id = p_reservation_id and conflict.status = 'checked_in'
      and daterange(target.check_in, target.check_out, '[)') && daterange(conflict.check_in, conflict.check_out, '[)')
  ) then raise exception 'Room has an overlapping checked-in guest.'; end if;
  update public.hotel_reservations set status = p_status where id = p_reservation_id;
  return found;
end;
$$;

grant execute on function public.hotel_staff_reservations() to authenticated;
grant execute on function public.hotel_update_reservation_status(uuid, text) to authenticated;

alter table public.hotel_room_categories enable row level security;
alter table public.hotel_rooms enable row level security;
alter table public.hotel_staff enable row level security;
alter table public.hotel_reservations enable row level security;

drop policy if exists hotel_categories_public_read on public.hotel_room_categories;
create policy hotel_categories_public_read on public.hotel_room_categories for select using (true);
drop policy if exists hotel_categories_staff_write on public.hotel_room_categories;
create policy hotel_categories_staff_write on public.hotel_room_categories for all to authenticated using (public.hotel_is_staff()) with check (public.hotel_is_staff());
drop policy if exists hotel_rooms_staff_manage on public.hotel_rooms;
create policy hotel_rooms_staff_manage on public.hotel_rooms for all to authenticated using (public.hotel_is_staff()) with check (public.hotel_is_staff());
drop policy if exists hotel_staff_self_read on public.hotel_staff;
create policy hotel_staff_self_read on public.hotel_staff for select to authenticated using (user_id = auth.uid());
drop policy if exists hotel_reservations_staff_manage on public.hotel_reservations;
create policy hotel_reservations_staff_manage on public.hotel_reservations for all to authenticated using (public.hotel_is_staff()) with check (public.hotel_is_staff());

grant select on public.hotel_room_categories to anon, authenticated;
grant select, insert, update, delete on public.hotel_room_categories, public.hotel_rooms, public.hotel_staff, public.hotel_reservations to authenticated;
grant usage on schema public to anon, authenticated;
