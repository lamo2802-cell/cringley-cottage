import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Public lookup for the post-payment/post-confirmation page. Accepts EITHER
// a Stripe session_id (normal paid flow) OR a booking_id (100%-discount flow,
// where no Stripe session ever existed). Returns only what a guest needs to
// see about their own booking.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  try {
    const { session_id, booking_id } = await req.json();
    if (!session_id && !booking_id) {
      return new Response(JSON.stringify({ ok: false, error: "session_id or booking_id required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    let query = supabase
      .from("bookings")
      .select("booking_ref, checkin, checkout, status, payment_type, total_amount, amount_paid, balance_due_date, guest_first_name, discount_amount, discount_code");
    query = session_id ? query.eq("stripe_checkout_session_id", session_id) : query.eq("id", booking_id);
    const { data: booking, error } = await query.maybeSingle();

    if (error || !booking) {
      return new Response(JSON.stringify({ ok: false, error: "Not found" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const outstanding = Math.max(0, Math.round(((booking.total_amount || 0) - (booking.amount_paid || 0)) * 100) / 100);

    return new Response(JSON.stringify({
      ok: true,
      booking_ref: booking.booking_ref,
      first_name: booking.guest_first_name,
      checkin: booking.checkin,
      checkout: booking.checkout,
      status: booking.status,
      payment_type: booking.payment_type,
      total_amount: booking.total_amount,
      amount_paid: booking.amount_paid,
      outstanding,
      balance_due_date: booking.balance_due_date,
      discount_amount: booking.discount_amount,
      discount_code: booking.discount_code,
    }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
