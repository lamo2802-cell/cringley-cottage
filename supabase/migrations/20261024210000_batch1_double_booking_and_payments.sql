-- Batch 1 of the 2026-10-24 health check: stop double bookings, record
-- Stripe payments atomically, and keep a log of every booking email sent.

-- 1. Two live direct bookings (including holds and owner closures) can never
--    overlap, even if two guests press "Book Now" at the same moment.
--    Airbnb/Booking.com rows are left out: their iCal feeds can echo back
--    dates we exported to them, and those clashes are caught in code.
alter table public.bookings
  add constraint no_overlapping_direct_bookings
  exclude using gist (daterange(checkin, checkout, '[)') with &&)
  where (source = 'direct' and status <> 'cancelled');

-- 2. Arrival day with the balance still unpaid: the guest gets a pay-now
--    email instead of the key-safe code, and the owners get one alert.
alter table public.bookings
  add column if not exists unpaid_arrival_alert_sent_at timestamptz;

-- 3. A payment refunded because its dates were taken is logged as a
--    negative 'refund' row, so the Stripe payments export still balances.
alter table public.booking_payments drop constraint booking_payments_purpose_check;
alter table public.booking_payments
  add constraint booking_payments_purpose_check
  check (purpose = any (array['initial'::text, 'balance'::text, 'refund'::text]));

-- 4. Every email the booking functions send, and whether Resend accepted it.
create table if not exists public.email_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  function_name text not null,
  recipient text not null,
  subject text not null,
  ok boolean not null,
  error text,
  booking_id uuid references public.bookings(id) on delete set null
);
create index if not exists email_log_created_at_idx on public.email_log (created_at desc);
alter table public.email_log enable row level security;
create policy owner_read_email_log on public.email_log
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

-- 5. Records one Stripe payment and updates its booking in a single
--    transaction, called only by stripe-webhook (service role). Either all
--    of it happens or none of it does, so the webhook can safely ask Stripe
--    to retry on any error. Returns:
--      duplicate          this payment was already recorded (Stripe resent it)
--      no_booking         the booking id in the payment's metadata doesn't exist
--      recorded           payment recorded and booking updated
--      clash              initial payment, but the dates are no longer free
--                         (or the booking was already paid): nothing booked,
--                         the caller refunds it
create or replace function public.record_stripe_payment(
  p_booking_id uuid,
  p_payment_intent_id text,
  p_checkout_session_id text,
  p_amount numeric,
  p_purpose text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  b public.bookings%rowtype;
  v_ref text;
  v_window int;
  v_new_paid numeric;
  v_due date;
  v_clash boolean;
begin
  -- One payment at a time, so two payments for the same dates can't both
  -- pass the clash check below.
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
    -- Expired holds that the 10-minute cleanup job hasn't reached yet don't
    -- count, and must be cleared so the overlap constraint lets this one in.
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

    -- Usage only counts once a payment really lands, and is bumped in one
    -- statement so two simultaneous uses can't both read the old count.
    if b.discount_code is not null then
      update discount_codes set times_used = times_used + 1 where code = b.discount_code;
    end if;

    v_new_paid := round(coalesce(b.amount_paid, 0) + p_amount, 2);
    -- A cancelled booking whose dates are still free (its hold ran out while
    -- the guest was paying) is simply reinstated.
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
$$;

revoke execute on function public.record_stripe_payment(uuid, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.record_stripe_payment(uuid, text, text, numeric, text) to service_role;
