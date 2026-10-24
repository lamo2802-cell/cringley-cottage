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
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = "Cringley Cottage <hello@cringleycottage.com>";
const OWNER_EMAILS = ["lamo2802@gmail.com", "rpeacey987@gmail.com"];
// Stripe's shortest allowed checkout lifetime is 30 minutes; a minute's
// margin covers clock drift. The dates are held a few minutes longer than
// the payment page lives, so a guest can never pay after their hold has
// gone and someone else has booked the dates.
const CHECKOUT_MINUTES = 31;
const HOLD_MARGIN_MINUTES = 5;
// After paying (or backing out) the guest is only ever sent back to the
// real site, never to an address supplied by the browser.
const ALLOWED_RETURN_ORIGINS = ["https://www.cringleycottage.com/", "https://cringleycottage.com/"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function escapeHtml(s: unknown): string {
  return (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Tells the owners when a guest got as far as payment but Stripe wouldn't
// open, so they can follow up. Logged to email_log like every booking email.
async function alertOwners(supabase: any, booking: any, problem: string) {
  const subject = "A guest couldn't get to the payment page";
  const html = `<p>A guest filled in the booking form but the Stripe payment page could not be opened, so <strong>nothing has been booked</strong>.</p>
    <p>Guest: ${escapeHtml(booking.guest_first_name)} ${escapeHtml(booking.guest_last_name)}<br>
    Email: ${escapeHtml(booking.guest_email)}<br>Phone: ${escapeHtml(booking.guest_phone)}<br>
    Dates: ${escapeHtml(booking.checkin)} to ${escapeHtml(booking.checkout)}<br>
    Problem: ${escapeHtml(problem)}</p><p>Please get in touch with them to complete the booking.</p>`;
  let ok = false;
  let error: string | null = null;
  if (!RESEND_API_KEY) {
    error = "RESEND_API_KEY not set";
  } else {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM_EMAIL, to: OWNER_EMAILS, subject, html }),
      });
      ok = res.ok;
      if (!ok) error = `Resend ${res.status}: ${(await res.text()).slice(0, 500)}`;
    } catch (e) {
      error = String(e);
    }
  }
  await supabase.from("email_log").insert({
    function_name: "create-checkout-session", recipient: OWNER_EMAILS.join(", "), subject, ok, error, booking_id: booking.id,
  });
}

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
      .select("id, booking_ref, checkin, checkout, amount_due, total_amount, amount_paid, payment_type, currency, guest_email, guest_first_name, guest_last_name, guest_phone, status, hold_expires_at")
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
      // Only a booking that's still a live, unpaid hold can take a first
      // payment — never a cancelled or already-confirmed one.
      const holdLive = booking.hold_expires_at && new Date(booking.hold_expires_at).getTime() > Date.now();
      if (booking.status !== "pending" || (booking.amount_paid || 0) > 0 || !holdLive) {
        return new Response(JSON.stringify({ ok: false, error: "Your held dates have expired. Please select dates again." }), { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      if (!booking.amount_due || booking.amount_due <= 0) {
        return new Response(JSON.stringify({ ok: false, error: "No amount due on this booking" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      amountToCharge = booking.amount_due;
      const { data: settings } = await supabase.from("site_settings").select("deposit_percent").eq("id", 1).maybeSingle();
      const label = booking.payment_type === "full" ? "Full payment" : `Deposit (${Number(settings?.deposit_percent ?? 25)}%)`;
      description = `${label} — Cringley Cottage, ${booking.checkin} to ${booking.checkout}`;
    }

    let base = typeof return_origin === "string" ? return_origin : "";
    if (!base.endsWith("/")) base += "/";
    if (!ALLOWED_RETURN_ORIGINS.includes(base)) base = ALLOWED_RETURN_ORIGINS[0];
    const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60;

    const params: Record<string, string> = {
      mode: "payment",
      "line_items[0][price_data][currency]": booking.currency || "gbp",
      "line_items[0][price_data][product_data][name]": description,
      "line_items[0][price_data][unit_amount]": String(Math.round(amountToCharge * 100)),
      "line_items[0][quantity]": "1",
      success_url: `${base}booking-confirmed.html?session_id={CHECKOUT_SESSION_ID}`,
      // Backing out of a first payment frees the guest's dates straight away
      // (index.html passes this id to release-hold), so they can try again.
      cancel_url: payPurpose === "balance" ? `${base}pay-balance.html` : `${base}?payment_cancelled=${booking.id}#availability`,
      "metadata[booking_id]": booking.id,
      "metadata[purpose]": payPurpose,
    };
    if (payPurpose === "initial") params.expires_at = String(expiresAt);
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
      const problem = session?.error?.message || "Stripe error";
      if (payPurpose === "initial") await alertOwners(supabase, booking, problem);
      return new Response(JSON.stringify({ ok: false, error: problem }), { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const sessionUpdates: Record<string, unknown> = { stripe_checkout_session_id: session.id };
    if (payPurpose === "initial") sessionUpdates.hold_expires_at = new Date((expiresAt + HOLD_MARGIN_MINUTES * 60) * 1000).toISOString();
    await supabase.from("bookings").update(sessionUpdates).eq("id", booking.id);

    return new Response(JSON.stringify({ ok: true, checkout_url: session.url }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
