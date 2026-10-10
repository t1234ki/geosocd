# Jonat Hotel Reservation Setup

The frontend is ready, but the project was previously a dues app and its Supabase database has no hotel inventory. Apply `jonat-hotel.sql` in the Supabase SQL Editor before enabling reservations.

## 1. Set up the schema

Run the complete contents of `jonat-hotel.sql` in Supabase SQL Editor. It creates room categories, physical rooms, staff access, reservations, availability/search functions, pay-at-hotel reservation creation, booking lookup, and staff status updates.

No room rates or room inventory are seeded. Add the hotel's confirmed rates and room numbers from the staff console so the booking page does not display invented inventory or prices.

## 2. Provision hotel staff

Create the staff member with Supabase Auth first. Then, as a project administrator, add that authenticated user ID to the allowlist:

```sql
insert into public.hotel_staff (user_id, full_name)
values ('AUTH_USER_UUID', 'Front desk staff name');
```

Staff sign-in is available from the site header. Only users in `hotel_staff` can read guest manifests, manage rooms/categories, or change reservation status.

## 3. Add inventory

Sign in using the staff account, create categories with confirmed GHS nightly rates and capacities, then add physical room names/numbers, floor, wing, and deck order. Set rooms to maintenance when they should not appear as bookable.

## 4. Booking behavior

Guests can reserve without an account; optional guest registration auto-fills contact details. Reservations are pay-at-hotel and are confirmed atomically with an overlap exclusion constraint. Booking lookup requires the reference and the email used for the reservation.

Status flow: `reserved` locks dates, `checked_in` marks the guest in-house, and `checked_out` or `cancelled` releases the room. The database blocks overlapping active reservations.

## Property facts used in the interface

Public listings identify Jonat Hotel at Pedu Estate Road, Cape Coast, Ghana, and list phone `+233 20 421 7037`. Public listings mention restaurant, bar, garden, room service, a 24-hour front desk, and private parking. Confirm current hotel facilities, exact address wording, contact number, rates, and room inventory with hotel management before launch.
