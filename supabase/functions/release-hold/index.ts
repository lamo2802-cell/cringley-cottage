import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Releases dates early so nobody has to wait for a hold to run out.
//
// { hold_id }: the visitor closed the tab or went back before submitting.
// Only ever touches a row that is still a live, unfinished hold, never a
// submitted booking, so it can't be used to cancel someone's real booking.
//
// { booking_id }: the guest pressed back on the Stripe page. The booking has
// their details but no payment yet. Its Stripe page is closed first, so it
// can no longer be paid; if Stripe says it has already been paid, nothing is
// cancelled.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// True once the Stripe page can no longer take a payment.
async function closeCheckoutSession(sessionId: string): Promise<boolean> {
  if (!STRIPE_SECRET_KEY) return false;
  const headers = { "Authorization": `Bearer ${STRIPE_SECRET_KEY}` };
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, { method: "POST", headers });
  if (res.ok) return true;
  // Stripe refuses to expire a session that isn't open: fine if it has
  // already expired, but not if it was paid.
  const check = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { headers });
  if (!check.ok) return false;
  const session = await check.json();
  return session.status === "expired";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const hold_id = body?.hold_id;
    const booking_id = body?.booking_id;
    if (!hold_id && !booking_id) return json({ ok: false, error: "hold_id or booking_id required" }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    if (hold_id) {
      const { error } = await supabase
        .from("bookings")
        .update({ status: "cancelled" })
        .eq("id", hold_id)
        .eq("source", "direct")
        .eq("status", "pending")
        .not("hold_expires_at", "is", null)
        .is("guest_email", null); // only an unfinished hold, never a completed enquiry
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    const { data: booking } = await supabase
      .from("bookings")
      .select("id, source, status, amount_paid, stripe_checkout_session_id")
      .eq("id", booking_id)
      .maybeSingle();
    const unpaid = booking && booking.source === "direct" && booking.status === "pending" && !(Number(booking.amount_paid) > 0);
    if (!unpaid) return json({ ok: true, released: false });

    if (booking.stripe_checkout_session_id && !(await closeCheckoutSession(booking.stripe_checkout_session_id))) {
      return json({ ok: true, released: false });
    }

    const { error } = await supabase
      .from("bookings")
      .update({ status: "cancelled", hold_expires_at: null })
      .eq("id", booking.id)
      .eq("status", "pending");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, released: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
