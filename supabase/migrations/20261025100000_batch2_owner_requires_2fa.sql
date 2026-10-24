-- Batch 2 of the 2026-10-24 health check: owner access needs the 2FA step,
-- not just the password. Supabase marks a session that has passed the
-- authenticator code as aal2; a password-only session is aal1 and now sees
-- none of the owner data.

create or replace function public.is_verified_owner()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner' and (auth.jwt() ->> 'aal') = 'aal2',
    false
  );
$$;

alter policy owner_full_access_booking_guests on public.booking_guests
  using ((select public.is_verified_owner())) with check ((select public.is_verified_owner()));
alter policy owner_full_access_booking_payments on public.booking_payments
  using ((select public.is_verified_owner())) with check ((select public.is_verified_owner()));
alter policy owner_full_access_bookings on public.bookings
  using ((select public.is_verified_owner())) with check ((select public.is_verified_owner()));
alter policy owner_full_access_discount_codes on public.discount_codes
  using ((select public.is_verified_owner())) with check ((select public.is_verified_owner()));
alter policy owner_read_email_log on public.email_log
  using ((select public.is_verified_owner()));
alter policy owner_full_access_fire_checks on public.fire_checks
  using ((select public.is_verified_owner())) with check ((select public.is_verified_owner()));
alter policy owner_full_access_ical_sources on public.ical_sources
  using ((select public.is_verified_owner())) with check ((select public.is_verified_owner()));
alter policy owner_full_access_marketing_sends on public.marketing_sends
  using ((select public.is_verified_owner())) with check ((select public.is_verified_owner()));
alter policy owner_full_access_rates on public.rates
  using ((select public.is_verified_owner())) with check ((select public.is_verified_owner()));
alter policy owner_full_access_reviews on public.reviews
  using ((select public.is_verified_owner())) with check ((select public.is_verified_owner()));
alter policy owner_write_site_settings on public.site_settings
  using ((select public.is_verified_owner())) with check ((select public.is_verified_owner()));
