import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Public lookup by booking reference + email, for the "pay my balance" page.
// Requires BOTH to match — a booking ref alone (sequential, guessable) isn't
// enough to see or pay someone else's booking.

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
    const { booking_ref, email } = await req.json();
    if (!booking_ref || !email) {
      return new Response(JSON.stringify({ ok: false, error: "Booking reference and email are both required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: booking, error } = await supabase
      .from("bookings")
      .select("id, booking_ref, checkin, checkout, status, payment_type, total_amount, amount_paid, balance_due_date, guest_first_name, guest_email")
      .eq("booking_ref", String(booking_ref).trim().toUpperCase())
      .maybeSingle();

    // Compare the email exactly (ignoring case) here rather than with a
    // database pattern match, where "%" would match any address.
    const emailMatches = !!booking && (booking.guest_email || "").trim().toLowerCase() === String(email).trim().toLowerCase();
    if (error || !booking || !emailMatches) {
      return new Response(JSON.stringify({ ok: false, error: "No booking found with that reference and email — please check and try again." }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const outstanding = Math.max(0, Math.round(((booking.total_amount || 0) - (booking.amount_paid || 0)) * 100) / 100);

    return new Response(JSON.stringify({
      ok: true,
      booking_id: booking.id,
      booking_ref: booking.booking_ref,
      first_name: booking.guest_first_name,
      checkin: booking.checkin,
      checkout: booking.checkout,
      status: booking.status,
      total_amount: booking.total_amount,
      amount_paid: booking.amount_paid,
      outstanding,
      balance_due_date: booking.balance_due_date,
    }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
