-- Cringley Cottage database structure, as it stood live on 2026-10-24.
--
-- A backup of the structure only: no guest data, no secrets. Built from the
-- live catalog (tables, constraints, indexes, row-level security, functions,
-- the availability view, the sequence and the scheduled jobs) so the site can
-- be rebuilt on a fresh Supabase project if it ever had to be.
--
-- Not covered here, and set in the Supabase dashboard instead: edge function
-- secrets (RESEND_API_KEY, STRIPE_*, SYNC_SECRET, CALENDAR_FEED_KEY), the
-- vault secret "sync_secret" the scheduled jobs read, auth settings and the
-- owner/staff accounts. The supabase/migrations folder holds the later
-- changes in order; this file is the whole picture in one place.
--
-- Extensions in use: pgcrypto, uuid-ossp, pg_cron, pg_net, supabase_vault,
-- pg_stat_statements.

-- ───────────────────────── Sequences ─────────────────────────

create sequence public.booking_ref_seq start 1;  -- live value was 4 on 2026-10-24

-- ───────────────────────── Tables ─────────────────────────

create table public.bookings (
  id uuid default gen_random_uuid() not null,
  checkin date not null,
  checkout date not null,
  source text not null,
  status text default 'confirmed'::text not null,
  external_uid text,
  guest_first_name text,
  guest_last_name text,
  guest_email text,
  guest_phone text,
  guests_count integer,
  message text,
  total_amount numeric(10,2),
  deposit_amount numeric(10,2),
  deposit_paid boolean default false not null,
  stripe_payment_intent_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  hold_expires_at timestamp with time zone,
  address_line1 text,
  address_line2 text,
  city text,
  postcode text,
  country text default 'United Kingdom'::text,
  has_dog boolean default false not null,
  payment_type text,
  amount_due numeric(10,2),
  stripe_checkout_session_id text,
  currency text default 'gbp'::text not null,
  booking_ref text,
  amount_paid numeric(10,2) default 0 not null,
  balance_due_date date,
  balance_reminder_sent_at timestamp with time zone,
  discount_code text,
  discount_percent numeric(5,2),
  discount_amount numeric(10,2) default 0 not null,
  is_blocked boolean default false not null,
  checkin_email_sent_at timestamp with time zone,
  checkout_email_sent_at timestamp with time zone,
  marketing_consent boolean default false not null,
  marketing_consent_at timestamp with time zone,
  children_count integer default 0 not null,
  unpaid_arrival_alert_sent_at timestamp with time zone,
  terms_accepted_at timestamp with time zone,
  constraint no_overlapping_direct_bookings EXCLUDE USING gist (daterange(checkin, checkout, '[)'::text) WITH &&) WHERE (((source = 'direct'::text) AND (status <> 'cancelled'::text))),
  constraint bookings_booking_ref_key UNIQUE (booking_ref),
  constraint bookings_source_external_uid_key UNIQUE (source, external_uid),
  constraint bookings_pkey PRIMARY KEY (id),
  constraint bookings_payment_type_check CHECK ((payment_type = ANY (ARRAY['deposit'::text, 'full'::text]))),
  constraint bookings_source_check CHECK (((source = 'direct'::text) OR (source = 'airbnb'::text) OR (source = 'booking_com'::text) OR (source ~~ like_escape('ext\_%'::text, '\'::text)))),
  constraint bookings_status_check CHECK ((status = ANY (ARRAY['confirmed'::text, 'pending'::text, 'cancelled'::text]))),
  constraint checkout_after_checkin CHECK ((checkout > checkin))
);
alter table public.bookings enable row level security;

create table public.booking_guests (
  id uuid default gen_random_uuid() not null,
  booking_id uuid not null,
  full_name text not null,
  guest_type text not null,
  created_at timestamp with time zone default now() not null,
  constraint booking_guests_pkey PRIMARY KEY (id),
  constraint booking_guests_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
  constraint booking_guests_guest_type_check CHECK ((guest_type = ANY (ARRAY['adult'::text, 'child'::text])))
);
alter table public.booking_guests enable row level security;

create table public.booking_payments (
  id uuid default gen_random_uuid() not null,
  booking_id uuid not null,
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  amount numeric(10,2) not null,
  purpose text not null,
  created_at timestamp with time zone default now() not null,
  constraint booking_payments_stripe_payment_intent_id_key UNIQUE (stripe_payment_intent_id),
  constraint booking_payments_pkey PRIMARY KEY (id),
  constraint booking_payments_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
  constraint booking_payments_purpose_check CHECK ((purpose = ANY (ARRAY['initial'::text, 'balance'::text, 'refund'::text])))
);
alter table public.booking_payments enable row level security;

create table public.discount_codes (
  id uuid default gen_random_uuid() not null,
  code text not null,
  percent_off numeric(5,2) not null,
  active boolean default true not null,
  max_uses integer,
  times_used integer default 0 not null,
  expires_at date,
  created_at timestamp with time zone default now() not null,
  constraint discount_codes_code_key UNIQUE (code),
  constraint discount_codes_pkey PRIMARY KEY (id),
  constraint discount_codes_percent_off_check CHECK (((percent_off > (0)::numeric) AND (percent_off <= (100)::numeric)))
);
alter table public.discount_codes enable row level security;

create table public.email_log (
  id bigint generated always as identity not null,
  created_at timestamp with time zone default now() not null,
  function_name text not null,
  recipient text not null,
  subject text not null,
  ok boolean not null,
  error text,
  booking_id uuid,
  constraint email_log_pkey PRIMARY KEY (id),
  constraint email_log_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
);
alter table public.email_log enable row level security;

create table public.fire_checks (
  id uuid default gen_random_uuid() not null,
  check_date date not null,
  check_type text not null,
  inspected_by text not null,
  inspected_by_user_id uuid,
  items jsonb not null,
  actions jsonb default '[]'::jsonb,
  notes text,
  created_at timestamp with time zone default now() not null,
  changeover_comments text,
  constraint fire_checks_pkey PRIMARY KEY (id),
  constraint fire_checks_inspected_by_user_id_fkey FOREIGN KEY (inspected_by_user_id) REFERENCES auth.users(id),
  constraint fire_checks_check_type_check CHECK ((check_type = ANY (ARRAY['change_of_occupancy'::text, 'daily'::text, 'weekly'::text, 'monthly'::text, 'six_monthly'::text])))
);
alter table public.fire_checks enable row level security;

create table public.ical_sources (
  id uuid default gen_random_uuid() not null,
  label text not null,
  url text not null,
  source_tag text not null,
  created_at timestamp with time zone default now() not null,
  last_synced_at timestamp with time zone,
  last_error text,
  consecutive_failures integer default 0 not null,
  failure_alert_sent_at timestamp with time zone,
  constraint ical_sources_source_tag_key UNIQUE (source_tag),
  constraint ical_sources_pkey PRIMARY KEY (id)
);
alter table public.ical_sources enable row level security;

create table public.marketing_sends (
  id uuid default gen_random_uuid() not null,
  subject text not null,
  body text not null,
  recipient_count integer not null,
  sent_by uuid,
  created_at timestamp with time zone default now() not null,
  constraint marketing_sends_pkey PRIMARY KEY (id),
  constraint marketing_sends_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES auth.users(id)
);
alter table public.marketing_sends enable row level security;

create table public.mfa_backup_codes (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  code_hash text not null,
  used_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  constraint mfa_backup_codes_pkey PRIMARY KEY (id)
);
alter table public.mfa_backup_codes enable row level security;

create table public.rate_limit_hits (
  key text not null,
  hit_at timestamp with time zone default now() not null
);
alter table public.rate_limit_hits enable row level security;

create table public.rates (
  id uuid default gen_random_uuid() not null,
  label text not null,
  date_from date not null,
  date_to date not null,
  nightly_rate numeric(10,2) not null,
  min_nights integer default 2 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint rates_pkey PRIMARY KEY (id),
  constraint rates_date_range CHECK ((date_to >= date_from))
);
alter table public.rates enable row level security;

create table public.reviews (
  id uuid default gen_random_uuid() not null,
  guest_name text,
  source text default 'direct'::text not null,
  rating numeric(3,1) default 5 not null,
  rating_max numeric(3,1) default 5 not null,
  review_text text not null,
  review_date date,
  featured boolean default true not null,
  created_at timestamp with time zone default now() not null,
  constraint reviews_pkey PRIMARY KEY (id)
);
alter table public.reviews enable row level security;

-- The email texts below are only the starting defaults. The live wording
-- (including the key-safe code) is data in the single site_settings row and
-- is deliberately not copied here.
create table public.site_settings (
  id integer default 1 not null,
  min_advance_nights integer default 2 not null,
  updated_at timestamp with time zone default now() not null,
  week_discount_percent numeric(5,2) default 10 not null,
  deposit_percent numeric(5,2) default 25 not null,
  full_payment_window_days integer default 14 not null,
  checkin_email_time time without time zone default '08:00:00'::time without time zone not null,
  checkout_email_time time without time zone default '10:00:00'::time without time zone not null,
  checkin_email_text text default 'Your key safe code is [ADD CODE HERE]. The key safe is fixed to the wall to the right of the front door — just enter the code, lift the lid, and the door key is inside.

Please help yourself in from 3pm. The WiFi details are on the welcome card on the kitchen table.

We hope you have a wonderful stay at Cringley Cottage!'::text not null,
  checkout_email_text text default 'Just a reminder that check-out is by 10am tomorrow. Before you head off, please could you:

- Turn off all lights and radiators
- Make sure all windows are closed and secured
- Pop the key back in the safe and scramble the code

Thank you for staying with us — safe travels home!'::text not null,
  offer_email_subject text default 'A little something from Cringley Cottage'::text not null,
  offer_email_text text default 'We wanted to let you know about a special offer for returning guests — [describe your offer here, e.g. 10% off any midweek stay booked before the end of the month].

Simply book as usual on our website and we''ll take care of the rest.

We''d love to welcome you back to Cringley Cottage!'::text not null,
  dog_surcharge_enabled boolean default false not null,
  dog_surcharge_amount numeric default 0 not null,
  constraint site_settings_pkey PRIMARY KEY (id),
  constraint single_row CHECK ((id = 1))
);
alter table public.site_settings enable row level security;

-- ───────────────────────── Indexes ─────────────────────────

CREATE INDEX bookings_date_range_idx ON public.bookings USING btree (checkin, checkout) WHERE (status <> 'cancelled'::text);
CREATE INDEX bookings_ref_email_idx ON public.bookings USING btree (booking_ref, lower(guest_email));
CREATE INDEX email_log_created_at_idx ON public.email_log USING btree (created_at DESC);
CREATE INDEX mfa_backup_codes_user_id_idx ON public.mfa_backup_codes USING btree (user_id);
CREATE INDEX rate_limit_hits_hit_at_idx ON public.rate_limit_hits USING btree (hit_at);
CREATE INDEX rate_limit_hits_key_idx ON public.rate_limit_hits USING btree (key, hit_at);

-- ───────────────────────── View ─────────────────────────

-- security_invoker, so the bookings row-level security applies to whoever
-- reads it. The public site reads this to grey out booked dates.
create view public.availability with (security_invoker = true) as
  SELECT checkin, checkout, source, status
  FROM bookings
  WHERE ((status <> 'cancelled'::text) AND ((hold_expires_at IS NULL) OR (hold_expires_at > now())));

-- ───────────────────────── Functions ─────────────────────────

CREATE OR REPLACE FUNCTION public.is_verified_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner' and (auth.jwt() ->> 'aal') = 'aal2',
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.claim_discount_use(p_code text)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  with claimed as (
    update discount_codes set times_used = times_used + 1
    where code = upper(trim(p_code)) and active
      and (expires_at is null or expires_at >= current_date)
      and (max_uses is null or times_used < max_uses)
    returning 1
  )
  select exists (select 1 from claimed);
$function$;

CREATE OR REPLACE FUNCTION public.get_booking_stats(date_from date, date_to date)
 RETURNS TABLE(total_nights_all_sources integer, direct_nights integer, airbnb_nights integer, booking_com_nights integer, direct_bookings_count integer, total_revenue numeric, total_discount_given numeric, blocked_nights integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from 'owner' then
    raise exception 'owner only';
  end if;

  return query
  select
    coalesce(sum(case when not b.is_blocked then (b.checkout - b.checkin) else 0 end) filter (where b.status <> 'cancelled'), 0)::int,
    coalesce(sum(case when b.source = 'direct' and not b.is_blocked then (b.checkout - b.checkin) else 0 end) filter (where b.status <> 'cancelled'), 0)::int,
    coalesce(sum(case when b.source = 'airbnb' then (b.checkout - b.checkin) else 0 end) filter (where b.status <> 'cancelled'), 0)::int,
    coalesce(sum(case when b.source = 'booking_com' then (b.checkout - b.checkin) else 0 end) filter (where b.status <> 'cancelled'), 0)::int,
    coalesce(count(*) filter (where b.source = 'direct' and not b.is_blocked and b.status = 'confirmed'), 0)::int,
    coalesce(sum(b.amount_paid) filter (where b.source = 'direct' and not b.is_blocked and b.status = 'confirmed'), 0)::numeric,
    coalesce(sum(b.discount_amount) filter (where b.source = 'direct' and not b.is_blocked and b.status = 'confirmed'), 0)::numeric,
    coalesce(sum(case when b.is_blocked then (b.checkout - b.checkin) else 0 end) filter (where b.status <> 'cancelled'), 0)::int
  from public.bookings b
  where b.checkin >= date_from and b.checkin <= date_to;
end;
$function$;

CREATE OR REPLACE FUNCTION public.hit_rate_limit(p_key text, p_window_seconds integer, p_max integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  n int;
begin
  perform pg_advisory_xact_lock(hashtext('rate_limit:' || p_key));
  delete from rate_limit_hits where hit_at < now() - interval '1 day';
  select count(*) into n from rate_limit_hits
    where key = p_key and hit_at > now() - make_interval(secs => p_window_seconds);
  if n >= p_max then
    return false;
  end if;
  insert into rate_limit_hits (key) values (p_key);
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.nextval_booking_ref()
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select nextval('public.booking_ref_seq');
$function$;

CREATE OR REPLACE FUNCTION public.record_stripe_payment(p_booking_id uuid, p_payment_intent_id text, p_checkout_session_id text, p_amount numeric, p_purpose text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  b public.bookings%rowtype;
  v_ref text;
  v_window int;
  v_new_paid numeric;
  v_due date;
  v_clash boolean;
begin
  perform pg_advisory_xact_lock(hashtext('record_stripe_payment'));

  select * into b from bookings where id = p_booking_id for update;
  if not found then
    return jsonb_build_object('result', 'no_booking');
  end if;

  insert into booking_payments (booking_id, stripe_payment_intent_id, stripe_checkout_session_id, amount, purpose)
  values (p_booking_id, p_payment_intent_id, p_checkout_session_id, p_amount, p_purpose)
  on conflict (stripe_payment_intent_id) do nothing;
  if not found then
    return jsonb_build_object('result', 'duplicate');
  end if;

  if p_purpose = 'initial' then
    update bookings set status = 'cancelled'
      where id <> b.id and status = 'pending'
        and hold_expires_at is not null and hold_expires_at < now()
        and checkin < b.checkout and checkout > b.checkin;

    select exists (
      select 1 from bookings o
      where o.id <> b.id and o.status <> 'cancelled'
        and o.checkin < b.checkout and o.checkout > b.checkin
    ) into v_clash;

    if v_clash or b.status = 'confirmed' or coalesce(b.amount_paid, 0) > 0 then
      if b.status = 'pending' then
        update bookings set status = 'cancelled', hold_expires_at = null where id = b.id;
      end if;
      return jsonb_build_object('result', 'clash', 'already_confirmed', b.status = 'confirmed');
    end if;

    v_ref := b.booking_ref;
    if v_ref is null then
      v_ref := 'CC-' || extract(year from now())::int || '-' || lpad(nextval('booking_ref_seq')::text, 4, '0');
    end if;

    v_due := null;
    if b.payment_type = 'deposit' then
      select coalesce(full_payment_window_days, 14) into v_window from site_settings where id = 1;
      v_due := b.checkin - coalesce(v_window, 14);
    end if;

    if b.discount_code is not null then
      update discount_codes set times_used = times_used + 1 where code = b.discount_code;
    end if;

    v_new_paid := round(coalesce(b.amount_paid, 0) + p_amount, 2);
    update bookings set
      amount_paid = v_new_paid,
      status = 'confirmed',
      deposit_paid = true,
      stripe_payment_intent_id = p_payment_intent_id,
      hold_expires_at = null,
      booking_ref = v_ref,
      balance_due_date = v_due
    where id = b.id;
  else
    v_new_paid := round(coalesce(b.amount_paid, 0) + p_amount, 2);
    update bookings set
      amount_paid = v_new_paid,
      balance_due_date = case when v_new_paid >= coalesce(total_amount, 0) - 0.01 then null else balance_due_date end
    where id = b.id;
  end if;

  return jsonb_build_object('result', 'recorded');
end;
$function$;

-- Who may call which function (Supabase grants execute to PUBLIC by default;
-- these are the live grants after that was tightened).
revoke all on function public.nextval_booking_ref() from public, anon, authenticated;
revoke all on function public.record_stripe_payment(uuid, text, text, numeric, text) from public, anon, authenticated;
revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_discount_use(text) from public, anon, authenticated;
revoke all on function public.get_booking_stats(date, date) from public, anon;
grant execute on function public.get_booking_stats(date, date) to authenticated;

-- ───────────────────────── Row-level security ─────────────────────────
-- Owner access needs the 2FA step (is_verified_owner). The public site can
-- read rates, settings, featured reviews and, through column grants, only
-- the dates/source/status/hold columns of bookings.

create policy owner_full_access_booking_guests on public.booking_guests as PERMISSIVE for ALL to authenticated
  using (( SELECT is_verified_owner() AS is_verified_owner))
  with check (( SELECT is_verified_owner() AS is_verified_owner));
create policy owner_full_access_booking_payments on public.booking_payments as PERMISSIVE for ALL to authenticated
  using (( SELECT is_verified_owner() AS is_verified_owner))
  with check (( SELECT is_verified_owner() AS is_verified_owner));
create policy anon_read_for_availability_view on public.bookings as PERMISSIVE for SELECT to anon
  using (true);
create policy owner_full_access_bookings on public.bookings as PERMISSIVE for ALL to authenticated
  using (( SELECT is_verified_owner() AS is_verified_owner))
  with check (( SELECT is_verified_owner() AS is_verified_owner));
create policy owner_full_access_discount_codes on public.discount_codes as PERMISSIVE for ALL to authenticated
  using (( SELECT is_verified_owner() AS is_verified_owner))
  with check (( SELECT is_verified_owner() AS is_verified_owner));
create policy owner_read_email_log on public.email_log as PERMISSIVE for SELECT to authenticated
  using (( SELECT is_verified_owner() AS is_verified_owner));
create policy owner_full_access_fire_checks on public.fire_checks as PERMISSIVE for ALL to authenticated
  using (( SELECT is_verified_owner() AS is_verified_owner))
  with check (( SELECT is_verified_owner() AS is_verified_owner));
create policy staff_insert_fire_checks on public.fire_checks as PERMISSIVE for INSERT to authenticated
  with check (((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'staff'::text) AND (inspected_by_user_id = auth.uid())));
create policy staff_select_own_fire_checks on public.fire_checks as PERMISSIVE for SELECT to authenticated
  using (((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'staff'::text) AND (inspected_by_user_id = auth.uid())));
create policy owner_full_access_ical_sources on public.ical_sources as PERMISSIVE for ALL to authenticated
  using (( SELECT is_verified_owner() AS is_verified_owner))
  with check (( SELECT is_verified_owner() AS is_verified_owner));
create policy owner_full_access_marketing_sends on public.marketing_sends as PERMISSIVE for ALL to authenticated
  using (( SELECT is_verified_owner() AS is_verified_owner))
  with check (( SELECT is_verified_owner() AS is_verified_owner));
create policy owner_full_access_rates on public.rates as PERMISSIVE for ALL to authenticated
  using (( SELECT is_verified_owner() AS is_verified_owner))
  with check (( SELECT is_verified_owner() AS is_verified_owner));
create policy public_read_rates on public.rates as PERMISSIVE for SELECT to anon
  using (true);
create policy owner_full_access_reviews on public.reviews as PERMISSIVE for ALL to authenticated
  using (( SELECT is_verified_owner() AS is_verified_owner))
  with check (( SELECT is_verified_owner() AS is_verified_owner));
create policy public_read_featured_reviews on public.reviews as PERMISSIVE for SELECT to anon
  using ((featured = true));
create policy owner_write_site_settings on public.site_settings as PERMISSIVE for ALL to authenticated
  using (( SELECT is_verified_owner() AS is_verified_owner))
  with check (( SELECT is_verified_owner() AS is_verified_owner));
create policy public_read_site_settings on public.site_settings as PERMISSIVE for SELECT to anon
  using (true);

-- Column-level read access for the public (anon) role on the two tables
-- where it isn't the whole row.
revoke select on public.bookings from anon;
grant select (checkin, checkout, hold_expires_at, source, status) on public.bookings to anon;
revoke select on public.site_settings from anon;
grant select (id, min_advance_nights, week_discount_percent, deposit_percent, full_payment_window_days,
              dog_surcharge_enabled, dog_surcharge_amount) on public.site_settings to anon;

-- ───────────────────────── Scheduled jobs (pg_cron) ─────────────────────────
-- The jobs read the shared secret from the vault at run time, so no secret
-- appears in the job text.

select cron.schedule('expire-stale-holds', '*/10 * * * *', $$
  update public.bookings
  set status = 'cancelled'
  where status = 'pending'
    and hold_expires_at is not null
    and hold_expires_at < now();
$$);

select cron.schedule('send-balance-reminders-daily', '0 9 * * *', $$
  select net.http_post(
    url := 'https://yfeyswuxhgezkpcjhznp.supabase.co/functions/v1/send-balance-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')
    )
  );
$$);

select cron.schedule('send-guest-messages-every-15min', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://yfeyswuxhgezkpcjhznp.supabase.co/functions/v1/send-guest-messages',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')
    )
  );
$$);

select cron.schedule('sync-airbnb-booking-calendars', '0 */2 * * *', $$
  select net.http_post(
    url := 'https://yfeyswuxhgezkpcjhznp.supabase.co/functions/v1/sync-calendars',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')
    )
  );
$$);
