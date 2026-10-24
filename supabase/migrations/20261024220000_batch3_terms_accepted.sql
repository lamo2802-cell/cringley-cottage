-- Batch 3: record when a guest ticked "I accept the Terms & Conditions".
alter table public.bookings
  add column if not exists terms_accepted_at timestamptz;
