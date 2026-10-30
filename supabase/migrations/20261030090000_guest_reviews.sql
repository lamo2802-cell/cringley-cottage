-- Guest reviews from direct bookings.
--
-- The day after checkout, send-guest-messages emails each direct guest a
-- private link (review.html?t=...) that works once for their booking. The
-- guest-review function checks the link and saves the review. New reviews
-- wait 3 days so the owners can read them, then show on the site by
-- themselves unless held back for a reason the reviews policy allows.

-- 1. Reviews: which booking a direct review came from, and its status.
--    pending   = waiting out the 3-day check (live once publish_at passes)
--    published = live (all reviews pasted in by the owners so far)
--    held      = held back for a policy reason, recorded in held_reason
alter table public.reviews
  add column if not exists booking_id uuid references public.bookings(id) on delete set null,
  add column if not exists status text not null default 'published',
  add column if not exists publish_at timestamptz,
  add column if not exists held_reason text,
  add column if not exists held_at timestamptz,
  add column if not exists submitted_at timestamptz;

alter table public.reviews drop constraint if exists reviews_status_check;
alter table public.reviews add constraint reviews_status_check
  check (status in ('pending', 'published', 'held'));
alter table public.reviews drop constraint if exists reviews_held_needs_reason;
alter table public.reviews add constraint reviews_held_needs_reason
  check (status <> 'held' or coalesce(held_reason, '') <> '');

-- One review per booking, whatever the page does.
create unique index if not exists reviews_booking_id_key on public.reviews (booking_id) where booking_id is not null;

-- 2. The public site reads every live review (for the full list), and the
--    carousel picks the featured ones out of those. It can't see held
--    reviews, reviews still in their check window, or the booking link.
drop policy if exists public_read_featured_reviews on public.reviews;
drop policy if exists public_read_live_reviews on public.reviews;
create policy public_read_live_reviews on public.reviews as permissive for select to anon
  using (status = 'published' or (status = 'pending' and publish_at <= now()));

revoke select on public.reviews from anon;
grant select (id, guest_name, source, rating, rating_max, review_text, review_date, featured, created_at)
  on public.reviews to anon;

-- 3. One review link per booking. Only a hash of the link code is stored.
create table if not exists public.review_invites (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
alter table public.review_invites enable row level security;
drop policy if exists owner_full_access_review_invites on public.review_invites;
create policy owner_full_access_review_invites on public.review_invites as permissive for all to authenticated
  using ((select public.is_verified_owner()))
  with check ((select public.is_verified_owner()));
revoke all on public.review_invites from anon;

-- 4. The guest's private note to the hosts. Kept out of the reviews table so
--    it can never reach the public feed.
create table if not exists public.review_private_notes (
  review_id uuid primary key references public.reviews(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now()
);
alter table public.review_private_notes enable row level security;
drop policy if exists owner_full_access_review_private_notes on public.review_private_notes;
create policy owner_full_access_review_private_notes on public.review_private_notes as permissive for all to authenticated
  using ((select public.is_verified_owner()))
  with check ((select public.is_verified_owner()));
revoke all on public.review_private_notes from anon;

-- 5. When the review request goes out (UK time, the day after checkout),
--    and when it went for each booking.
alter table public.site_settings
  add column if not exists review_email_time time not null default '10:00';
alter table public.bookings
  add column if not exists review_request_sent_at timestamptz;
