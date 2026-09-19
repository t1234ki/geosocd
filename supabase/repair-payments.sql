-- Run this once after fresh-auth-setup.sql.
-- It repairs permissions needed by the Paystack webhook.

grant usage on schema public to service_role;
grant select, insert, update on public.organizations to service_role;
grant select, insert, update on public.profiles to service_role;
grant select, insert, update on public.dues to service_role;
grant select, insert, update on public.payments to service_role;
grant select, insert, update on public.receipts to service_role;
grant select, insert, update on public.notifications to service_role;

-- Remove accidental browser write access. Only verified server code creates payments.
drop policy if exists "members create own payments" on public.payments;
drop policy if exists "members update own payments" on public.payments;
revoke insert, update on public.payments from authenticated;

-- Keep the admin dashboard able to read its ledger and manage dues.
grant select on public.payments to authenticated;
grant select, insert, update, delete on public.dues to authenticated;