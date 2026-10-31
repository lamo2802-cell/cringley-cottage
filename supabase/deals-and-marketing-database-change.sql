-- Deals (limited-time / date-window % off) and the marketing opt-out box.
-- Safe to run more than once.

-- 1. Deals. A deal takes percent_off off the nightly price for every night
--    of a stay that falls between stay_from and stay_to (both inclusive).
--    It can only be booked between book_from and book_by (either may be
--    blank), and only while active. min_nights is the shortest stay it
--    applies to (blank = any stay the calendar allows).
create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  percent_off numeric(5,2) not null,
  stay_from date not null,
  stay_to date not null,
  book_from date,
  book_by date,
  min_nights integer,
  active boolean not null default true,
  show_popup boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deals_percent_range check (percent_off > 0 and percent_off <= 50),
  constraint deals_stay_order check (stay_to >= stay_from),
  constraint deals_book_order check (book_from is null or book_by is null or book_by >= book_from),
  constraint deals_min_nights check (min_nights is null or min_nights between 1 and 28)
);
alter table public.deals enable row level security;

drop policy if exists owner_full_access_deals on public.deals;
create policy owner_full_access_deals on public.deals as permissive for all to authenticated
  using ((select public.is_verified_owner()))
  with check ((select public.is_verified_owner()));

-- The public site only sees deals that can be booked today (UK date).
drop policy if exists public_read_live_deals on public.deals;
create policy public_read_live_deals on public.deals as permissive for select to anon
  using (
    active
    and stay_to >= (now() at time zone 'Europe/London')::date
    and (book_from is null or book_from <= (now() at time zone 'Europe/London')::date)
    and (book_by is null or book_by >= (now() at time zone 'Europe/London')::date)
  );
grant select on public.deals to anon;

-- 2. What a booking got from a deal. deal holds a copy of the deal as it was
--    when booked (id, title, percent_off, stay_from, stay_to), so changing
--    or deleting the deal later never changes an existing booking.
alter table public.bookings
  add column if not exists deal jsonb,
  add column if not exists deal_amount numeric(10,2) not null default 0,
  -- How the guest's marketing choice was collected:
  --   'consent_tickbox'  = old unticked box they chose to tick
  --   'soft_opt_in'      = ticked box they could untick (PECR soft opt-in)
  add column if not exists marketing_basis text;

-- 3. Whether a deal and a discount code can both apply to one booking.
--    false (default) = the guest gets whichever saves them more.
alter table public.site_settings
  add column if not exists deals_stack_with_codes boolean not null default false;
grant select (deals_stack_with_codes) on public.site_settings to anon;

-- 4. Record the basis for guests who already ticked the old box.
update public.bookings set marketing_basis = 'consent_tickbox'
  where marketing_consent and marketing_basis is null;
