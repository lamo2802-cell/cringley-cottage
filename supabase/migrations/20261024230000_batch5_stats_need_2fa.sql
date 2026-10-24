-- Batch 5: two small tidy-ups found while taking the structure snapshot.
--
-- 1. The booking stats on the admin Reports tab (revenue, nights) only
--    checked for an owner account, not for the 2FA step that everything
--    else in admin now needs since Batch 2. Make it match.
-- 2. The public availability view could be written through in principle.
--    The bookings security rules already block that, but the view has no
--    reason to accept writes, so take the write permissions away.

create or replace function public.get_booking_stats(date_from date, date_to date)
 returns table(total_nights_all_sources integer, direct_nights integer, airbnb_nights integer, booking_com_nights integer, direct_bookings_count integer, total_revenue numeric, total_discount_given numeric, blocked_nights integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_verified_owner() then
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

revoke insert, update, delete, truncate on public.availability from anon, authenticated;
