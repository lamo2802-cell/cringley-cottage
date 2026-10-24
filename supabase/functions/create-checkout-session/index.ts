import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Creates a Stripe Checkout session. purpose "initial" (default) charges the
// booking's amount_due, computed by create-booking. purpose "balance" charges
// whatever is still outstanding (total_amount - amount_paid) — used by the
// pay-balance page. Both always read the amount server-side; never trust the
// request body for a figure.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function formEncode(obj: Record<string, string>): string {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
  if (!STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "Stripe is not configured yet (STRIPE_SECRET_KEY missing)" }), { status: 503, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  try {
    const { booking_id, return_origin, purpose } = await req.json();
    const payPurpose = purpose === "balance" ? "balance" : "initial";
    if (!booking_id) {
      return new Response(JSON.stringify({ ok: false, error: "booking_id required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: booking, error } = await supabase
      .from("bookings")
      .select("id, booking_ref, checkin, checkout, amount_due, total_amount, amount_paid, payment_type, currency, guest_email, status")
      .eq("id", booking_id)
      .maybeSingle();

    if (error || !booking) {
      return new Response(JSON.stringify({ ok: false, error: "Booking not found" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    let amountToCharge: number;
    let description: string;

    if (payPurpose === "balance") {
      if (booking.status !== "confirmed") {
        return new Response(JSON.stringify({ ok: false, error: "This booking isn't confirmed yet" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      const outstanding = Math.round(((booking.total_amount || 0) - (booking.amount_paid || 0)) * 100) / 100;
      if (outstanding <= 0) {
        return new Response(JSON.stringify({ ok: false, error: "Nothing outstanding on this booking" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      amountToCharge = outstanding;
      description = `Balance payment — Cringley Cottage, ${booking.checkin} to ${booking.checkout} (${booking.booking_ref || ""})`;
    } else {
      if (!booking.amount_due || booking.amount_due <= 0) {
        return new Response(JSON.stringify({ ok: false, error: "No amount due on this booking" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      amountToCharge = booking.amount_due;
      const label = booking.payment_type === "full" ? "Full payment" : "Deposit (25%)";
      description = `${label} — Cringley Cottage, ${booking.checkin} to ${booking.checkout}`;
    }

    let base = (typeof return_origin === "string" && return_origin.startsWith("http")) ? return_origin : "https://www.cringleycottage.com/";
    if (!base.endsWith("/")) base += "/";

    const params: Record<string, string> = {
      mode: "payment",
      "line_items[0][price_data][currency]": booking.currency || "gbp",
      "line_items[0][price_data][product_data][name]": description,
      "line_items[0][price_data][unit_amount]": String(Math.round(amountToCharge * 100)),
      "line_items[0][quantity]": "1",
      success_url: `${base}booking-confirmed.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: payPurpose === "balance" ? `${base}pay-balance.html` : `${base}#availability`,
      "metadata[booking_id]": booking.id,
      "metadata[purpose]": payPurpose,
    };
    // Copy the description and ids onto the underlying payment too, so the
    // Stripe dashboard's Payments list (and payout reports) show what each
    // payment was for. A deposit has no booking ref yet — stripe-webhook adds
    // it once the payment lands.
    params["payment_intent_data[description]"] = description;
    params["payment_intent_data[metadata][booking_id]"] = booking.id;
    params["payment_intent_data[metadata][purpose]"] = payPurpose;
    if (booking.booking_ref) params["payment_intent_data[metadata][booking_ref]"] = booking.booking_ref;
    if (booking.guest_email) params.customer_email = booking.guest_email;

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formEncode(params),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      return new Response(JSON.stringify({ ok: false, error: session?.error?.message || "Stripe error" }), { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    await supabase.from("bookings").update({ stripe_checkout_session_id: session.id }).eq("id", booking.id);

    return new Response(JSON.stringify({ ok: true, checkout_url: session.url }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
