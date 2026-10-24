-- Batch 4 of the 2026-10-24 health check: rate limits on the public booking
-- functions, a one-use-at-a-time discount claim, and calendar sync failure
-- tracking.

-- 1. Rate limits. Each row is one request from one visitor to one function.
--    The key holds a hash of the visitor's IP address, never the address
--    itself, and rows are deleted after a day.
create table if not exists public.rate_limit_hits (
  key text not null,
  hit_at timestamptz not null default now()
);
create index if not exists rate_limit_hits_key_idx on public.rate_limit_hits (key, hit_at);
create index if not exists rate_limit_hits_hit_at_idx on public.rate_limit_hits (hit_at);
alter table public.rate_limit_hits enable row level security;

-- Records one request and returns true if it's allowed, false if this key
-- has already made p_max requests in the last p_window_seconds.
create or replace function public.hit_rate_limit(p_key text, p_window_seconds int, p_max int)
returns boolean
language plpgsql
set search_path = public
as $$
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
$$;
revoke execute on function public.hit_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, int, int) to service_role;

-- 2. Uses up one go of a discount code, but only if it still has one left,
--    in a single statement so two guests can't both take the last use.
--    Used for 100% codes, which confirm without a payment.
create or replace function public.claim_discount_use(p_code text)
returns boolean
language sql
set search_path = public
as $$
  with claimed as (
    update discount_codes set times_used = times_used + 1
    where code = upper(trim(p_code)) and active
      and (expires_at is null or expires_at >= current_date)
      and (max_uses is null or times_used < max_uses)
    returning 1
  )
  select exists (select 1 from claimed);
$$;
revoke execute on function public.claim_discount_use(text) from public, anon, authenticated;
grant execute on function public.claim_discount_use(text) to service_role;

-- 3. Calendar sync health, per feed, so a feed that keeps failing gets
--    noticed instead of silently going stale.
alter table public.ical_sources
  add column if not exists last_synced_at timestamptz,
  add column if not exists last_error text,
  add column if not exists consecutive_failures int not null default 0,
  add column if not exists failure_alert_sent_at timestamptz;
