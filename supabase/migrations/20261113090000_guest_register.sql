-- Guest register (Immigration (Hotel Records) Order 1972), direct bookings.
--
-- Every guest aged 16 or over gives their full name and nationality. A guest
-- who isn't British, Irish or a Commonwealth citizen also gives their
-- passport or ID card number, where it was issued, and where they're going
-- next. The register is kept for at least 12 months and then deleted.
--
-- Guests fill it in on guest-register.html, through a private link in their
-- booking confirmation email (and a reminder in the check-in day email if
-- it's still missing). The guest-register function checks the link and
-- saves through save_guest_register below. Owners read and correct it on
-- guest-register-admin.html.

-- 1. One row per guest aged 16+. Only the owners (with 2FA) can read it.
create table if not exists public.guest_register (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  position smallint not null,
  full_name text not null,
  nationality text not null,
  id_required boolean not null default false,
  id_document_number text,
  id_document_issued_at text,
  next_destination text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guest_register_booking_position_key unique (booking_id, position),
  constraint guest_register_name_check check (length(trim(full_name)) between 2 and 100),
  constraint guest_register_nationality_check check (length(trim(nationality)) between 2 and 60),
  constraint guest_register_id_details_check check (
    not id_required or (
      coalesce(trim(id_document_number), '') <> ''
      and coalesce(trim(id_document_issued_at), '') <> ''
      and coalesce(trim(next_destination), '') <> ''
    )
  )
);
alter table public.guest_register enable row level security;
drop policy if exists owner_full_access_guest_register on public.guest_register;
create policy owner_full_access_guest_register on public.guest_register as permissive for all to authenticated
  using ((select public.is_verified_owner()))
  with check ((select public.is_verified_owner()));
revoke all on public.guest_register from anon;

-- 2. When the guest (or an owner) last saved the register for a booking.
alter table public.bookings
  add column if not exists guest_register_saved_at timestamptz;

-- 3. Replaces a booking's register in one transaction, so a failed save
--    never leaves it half-written. Called by the guest-register function
--    (service role) only; the checks on what's allowed live there.
create or replace function public.save_guest_register(p_booking_id uuid, p_guests jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.guest_register where booking_id = p_booking_id;
  insert into public.guest_register
    (booking_id, position, full_name, nationality, id_required, id_document_number, id_document_issued_at, next_destination)
  select p_booking_id,
         (g.ord)::smallint,
         g.value->>'full_name',
         g.value->>'nationality',
         coalesce((g.value->>'id_required')::boolean, false),
         nullif(g.value->>'id_document_number', ''),
         nullif(g.value->>'id_document_issued_at', ''),
         nullif(g.value->>'next_destination', '')
  from jsonb_array_elements(p_guests) with ordinality as g(value, ord);
  update public.bookings set guest_register_saved_at = now() where id = p_booking_id;
end;
$$;
revoke all on function public.save_guest_register(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_guest_register(uuid, jsonb) to service_role;

-- 4. Delete each stay's register 12 months after checkout (the law asks for
--    at least 12 months from arrival). Runs daily at 03:15 UTC.
select cron.unschedule('delete-old-guest-register')
  where exists (select 1 from cron.job where jobname = 'delete-old-guest-register');
select cron.schedule('delete-old-guest-register', '15 3 * * *', $$
  delete from public.guest_register gr
  using public.bookings b
  where b.id = gr.booking_id
    and b.checkout < (current_date - interval '12 months');
$$);
