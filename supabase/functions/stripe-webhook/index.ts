import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Stripe webhook — the authoritative source for "did this actually get paid".
// Handles both the initial (deposit/full) payment and later balance payments.
// The payment and booking update happen in the record_stripe_payment
// database function (one transaction, which also re-checks the dates are
// still free and counts discount-code usage). Then sends the guest a branded
// confirmation email and Mark/Ruth an owner notification, both via Resend.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = "Cringley Cottage <hello@cringleycottage.com>";
const OWNER_EMAILS = ["lamo2802@gmail.com", "rpeacey987@gmail.com"];
const SITE_BASE_URL = "https://www.cringleycottage.com/";
// If a payment lands on dates someone else has taken, refund it straight
// away (true) or leave it for the owners to refund by hand (false). The
// owners are emailed either way.
const AUTO_REFUND_ON_CLASH = true;

// Stripe's own libraries reject signatures more than 5 minutes old, so a
// captured webhook can't be replayed later. A header can carry several v1
// signatures while the signing secret is being rotated — any one may match.
const SIGNATURE_TOLERANCE_SECONDS = 300;

async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const pairs = sigHeader.split(",").map(p => p.split("=") as [string, string]);
  const timestamp = pairs.find(([k]) => k === "t")?.[1];
  const signatures = pairs.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, "0")).join("");
  return signatures.some(signature => {
    if (computed.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  });
}

function money(n: number): string { return "£" + Number(n).toFixed(2).replace(/\.00$/, ""); }
function fmtDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
// Every guest-supplied field (name, email, phone, address, message) reaches
// this file straight from the public booking form — escape it before it goes
// into an HTML email, whether that email goes to the guest themselves or to
// the owner's own inbox, which is the more sensitive of the two recipients.
function escapeHtml(s: unknown): string {
  return (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function emailShell(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;background:#e9e3d6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9e3d6;padding:32px 16px;"><tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;">
  <tr><td style="background:#232120;padding:28px 32px;text-align:center;">
    <div style="display:inline-block;border:1px solid rgba(255,255,255,0.35);border-radius:2px;padding:10px 22px;">
      <span style="font-family:Georgia,'Times New Roman',serif;font-size:19px;letter-spacing:3px;color:#f3ede3;text-transform:uppercase;">Cringley Cottage</span>
    </div>
  </td></tr>
  <tr><td style="padding:36px 40px 8px;">${bodyHtml}</td></tr>
  <tr><td style="padding:28px 40px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #e5ddd0;padding-top:20px;">
      <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:13px;color:#7a6f60;">Cringley Cottage &middot; Askrigg &middot; Yorkshire Dales &middot; <a href="https://www.cringleycottage.com/" style="color:#5e7a52;text-decoration:underline;">www.cringleycottage.com</a></p>
      <p style="margin:0;font-family:Georgia,serif;font-size:12px;color:#a39a89;">Questions? Just reply to this email &mdash; we read every message.</p>
    </td></tr></table>
  </td></tr>
  </table></td></tr></table></body></html>`;
}
function heading(text: string): string {
  return `<h1 style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#232120;margin:0 0 14px;">${text}</h1>`;
}
function para(text: string): string {
  return `<p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.6;color:#4a453d;margin:0 0 14px;">${text}</p>`;
}
function infoRow(label: string, value: string, bold = false): string {
  const weight = bold ? "600" : "400";
  const color = bold ? "#5e7a52" : "#232120";
  return `<tr>
    <td style="padding:6px 0;border-top:1px solid #e5ddd0;color:#7a6f60;font-size:13px;font-family:'Helvetica Neue',Arial,sans-serif;">${label}</td>
    <td style="padding:6px 0;border-top:1px solid #e5ddd0;text-align:right;font-weight:${weight};color:${color};font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;">${value}</td>
  </tr>`;
}
function infoBox(rows: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f0e8;border-radius:4px;margin:4px 0 18px;">
    <tr><td style="padding:18px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
  </table>`;
}
function button(text: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px;"><tr><td style="background:#5e7a52;border-radius:3px;">
    <a href="${url}" style="display:inline-block;padding:13px 28px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;letter-spacing:0.5px;text-transform:uppercase;color:#ffffff;text-decoration:none;">${text}</a>
  </td></tr></table>`;
}

// What every guest needs for the stay itself, kept the same in every
// confirmation: times, where the cottage is, parking, and the terms.
const TERMS_URL = `${SITE_BASE_URL}terms.html`;
function stayDetailsBox(): string {
  return infoBox(
    infoRow("Check-in", "From 3pm") +
    infoRow("Check-out", "By 10am") +
    infoRow("Address", "Cringley Cottage, Silver Street,<br>Askrigg, Leyburn DL8 3HS") +
    infoRow("Parking", "On-street in the village, or Parkins Garth car park at the village entrance")
  );
}
function nightsBetween(checkin: string, checkout: string): number {
  return Math.round((new Date(checkout + "T00:00:00").getTime() - new Date(checkin + "T00:00:00").getTime()) / 86400000);
}
function guestsLabel(total: number | null, children: number | null): string {
  const kids = Math.max(0, Number(children) || 0);
  const adults = Math.max(0, (Number(total) || 0) - kids);
  if (!adults && !kids) return "";
  const parts = [`${adults} adult${adults === 1 ? "" : "s"}`];
  if (kids > 0) parts.push(`${kids} child${kids === 1 ? "" : "ren"}`);
  return parts.join(", ");
}

// The booking ref (CC-YYYY-NNNN) is only assigned once the first payment
// lands, so it can't be put on the Stripe payment when checkout starts.
// Stamp it on afterwards so the payment can be found by booking ref in the
// Stripe dashboard and matched to the Zoho invoice. Best-effort — a failure
// here must never block confirming the booking.
async function tagStripePayment(paymentIntentId: string, ref: string, description: string) {
  if (!STRIPE_SECRET_KEY || !paymentIntentId.startsWith("pi_")) return;
  try {
    const body = new URLSearchParams({ description, "metadata[booking_ref]": ref });
    await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch { /* best-effort */ }
}

// Email failures used to vanish silently. Each send is now recorded in
// email_log (admin shows the failures), and the result is returned so the
// caller can react. Never throws.
const emailLogDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
async function sendEmail(to: string | string[], subject: string, html: string, bookingId?: string): Promise<boolean> {
  let ok = false;
  let error: string | null = null;
  if (!RESEND_API_KEY) {
    error = "RESEND_API_KEY not set";
  } else {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
      });
      ok = res.ok;
      if (!ok) error = `Resend ${res.status}: ${(await res.text()).slice(0, 500)}`;
    } catch (e) {
      error = String(e);
    }
  }
  await emailLogDb.from("email_log").insert({
    function_name: "stripe-webhook", recipient: [to].flat().join(", "), subject, ok, error, booking_id: bookingId ?? null,
  });
  return ok;
}

// The guest paid for dates that were taken while they were on the Stripe
// page. Money back automatically, using the payment id as the idempotency
// key so a retried webhook can never refund twice.
async function refundPayment(paymentIntentId: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!STRIPE_SECRET_KEY || !paymentIntentId.startsWith("pi_")) return { ok: false, error: "No Stripe payment to refund" };
  try {
    const res = await fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `clash-refund-${paymentIntentId}`,
      },
      body: new URLSearchParams({ payment_intent: paymentIntentId, reason: "requested_by_customer" }),
    });
    const data = await res.json();
    return res.ok ? { ok: true, id: data.id } : { ok: false, error: data?.error?.message || `Stripe ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!STRIPE_WEBHOOK_SECRET) return new Response("Webhook not configured", { status: 503 });

  const sigHeader = req.headers.get("stripe-signature");
  const payload = await req.text();
  if (!sigHeader || !(await verifyStripeSignature(payload, sigHeader, STRIPE_WEBHOOK_SECRET))) {
    return new Response("Invalid signature", { status: 400 });
  }

  let event;
  try { event = JSON.parse(payload); } catch { return new Response("Bad payload", { status: 400 }); }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // The guest left the Stripe page open until it expired without paying:
  // give their dates back now rather than waiting for the hold to run out.
  if (event.type === "checkout.session.expired") {
    const session = event.data.object;
    const bookingId = session?.metadata?.booking_id;
    if (bookingId && session?.metadata?.purpose !== "balance") {
      const { error } = await supabase.from("bookings").update({ status: "cancelled" })
        .eq("id", bookingId).eq("status", "pending").eq("stripe_checkout_session_id", session.id);
      if (error) return json({ error: error.message }, 500);
    }
    return json({ received: true });
  }

  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return json({ received: true });
  }

  const session = event.data.object;
  const bookingId = session?.metadata?.booking_id;
  const purpose = session?.metadata?.purpose === "balance" ? "balance" : "initial";
  const paymentIntentId = session.payment_intent || session.id;
  if (!bookingId || session.payment_status !== "paid") return json({ received: true });

  const paidAmount = (session.amount_total || 0) / 100;

  // Records the payment and updates the booking in one database
  // transaction. Any error here goes back to Stripe as a 500, so Stripe
  // retries; a retry of a payment that did get recorded comes back as
  // "duplicate" and stops there.
  const { data: outcome, error: recordErr } = await supabase.rpc("record_stripe_payment", {
    p_booking_id: bookingId,
    p_payment_intent_id: paymentIntentId,
    p_checkout_session_id: session.id,
    p_amount: paidAmount,
    p_purpose: purpose,
  });
  if (recordErr) return json({ error: recordErr.message }, 500);

  const result = outcome?.result;
  if (result === "duplicate") return json({ received: true, duplicate: true });

  if (result === "no_booking") {
    await sendEmail(OWNER_EMAILS, "Stripe payment with no matching booking",
      emailShell(heading("Payment with no booking") +
        para(`Stripe took a payment of <strong>${money(paidAmount)}</strong> (payment ID ${escapeHtml(paymentIntentId)}) for a booking that doesn't exist on the website. Please check it in the Stripe dashboard and refund it if needed.`)));
    return json({ received: true });
  }

  const { data: booking, error: loadErr } = await supabase.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (loadErr || !booking) return json({ received: true });

  const dates = `${fmtDate(booking.checkin)} &rarr; ${fmtDate(booking.checkout)}`;
  const guestName = `${escapeHtml(booking.guest_first_name)} ${escapeHtml(booking.guest_last_name)}`;

  if (result === "clash") {
    const refund = AUTO_REFUND_ON_CLASH ? await refundPayment(paymentIntentId) : { ok: false, error: "Automatic refunds are switched off" };
    if (refund.ok) {
      await supabase.from("booking_payments").insert({
        booking_id: bookingId, stripe_payment_intent_id: refund.id, stripe_checkout_session_id: session.id,
        amount: -paidAmount, purpose: "refund",
      });
      if (booking.guest_email) {
        await sendEmail(booking.guest_email, "Sorry — those dates were just taken",
          emailShell(heading("We're so sorry") +
            para(`Dear ${escapeHtml(booking.guest_first_name) || "there"},`) +
            para(`While your payment was going through, the dates you chose (${dates}) were booked by someone else, so we couldn't confirm your stay.`) +
            para(`We've refunded your payment of <strong>${money(paidAmount)}</strong> in full. It usually reaches your account within 5–10 working days.`) +
            para("We'd love to find you other dates — just reply to this email and we'll help.") +
            button("See available dates", `${SITE_BASE_URL}#availability`)), bookingId);
      }
    }
    await sendEmail(OWNER_EMAILS, refund.ok ? "Double booking avoided — payment refunded" : "ACTION NEEDED: payment for dates already booked",
      emailShell(heading(refund.ok ? "Payment refunded automatically" : "Please refund this payment") +
        para(refund.ok
          ? `A guest paid for dates that had already been taken by the time their payment landed. Nothing was booked and their ${money(paidAmount)} has been refunded in Stripe. The guest has been emailed.`
          : `A guest paid for dates that are already booked. Nothing was booked, but the refund could not be made automatically (${escapeHtml(refund.error)}). Please refund it in the Stripe dashboard and contact the guest.`) +
        infoBox(infoRow("Guest", guestName) + infoRow("Email", escapeHtml(booking.guest_email)) + infoRow("Phone", escapeHtml(booking.guest_phone))
          + infoRow("Dates", dates) + infoRow("Amount", money(paidAmount), true) + infoRow("Stripe payment ID", escapeHtml(paymentIntentId)))), bookingId);
    return json({ received: true, clash: true, refunded: refund.ok });
  }

  const ref = booking.booking_ref;
  const newAmountPaid = Number(booking.amount_paid || 0);
  const paymentKind = purpose === "balance" ? "Balance" : (booking.payment_type === "full" ? "Full payment" : "Deposit");
  if (ref) await tagStripePayment(paymentIntentId, ref, `${paymentKind} — Cringley Cottage ${ref}, ${booking.checkin} to ${booking.checkout}`);
  const outstanding = Math.max(0, Math.round(((booking.total_amount || 0) - newAmountPaid) * 100) / 100);
  const manageUrl = `${SITE_BASE_URL}pay-balance.html${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const guestInfoUrl = `${SITE_BASE_URL}guest-info.html`;

  let guestEmailOk = true;
  if (booking.guest_email) {
    let guestHtml: string;
    let subject: string;
    if (purpose === "initial") {
      subject = `Booking Confirmed — ${ref}`;
      const nights = nightsBetween(booking.checkin, booking.checkout);
      const guests = guestsLabel(booking.guests_count, booking.children_count);
      let rows = infoRow("Booking reference", escapeHtml(ref), true)
        + infoRow("Dates", dates)
        + infoRow("Nights", String(nights))
        + (guests ? infoRow("Guests", guests) : "")
        + infoRow("Dog", booking.has_dog ? "Yes" : "No")
        + (booking.discount_amount > 0 ? infoRow("Discount applied", `&minus;${money(booking.discount_amount)} (${escapeHtml(booking.discount_code)})`) : "")
        + infoRow("Total cost", money(booking.total_amount))
        + infoRow("Paid today", money(paidAmount));
      if (outstanding > 0) rows += infoRow("Balance due", `${money(outstanding)} by ${fmtDate(booking.balance_due_date)}`, true);
      guestHtml = emailShell(
        heading("Booking confirmed") +
        para(`Dear ${escapeHtml(booking.guest_first_name) || "there"},`) +
        para("Thank you — your booking at Cringley Cottage is confirmed!") +
        infoBox(rows) +
        (outstanding > 0
          ? para(`You can pay the remaining balance any time before ${fmtDate(booking.balance_due_date)}. We'll send you a reminder about a week before.`) +
            button("Pay your balance", manageUrl)
          : para("Your stay is paid in full — nothing more to do!")) +
        stayDetailsBox() +
        para(`Your booking is made under our <a href="${TERMS_URL}" style="color:#5e7a52;">booking terms</a>, including the cancellation policy. We'll email your key-safe code on the morning you arrive.`) +
        para("We look forward to welcoming you to Cringley Cottage!") +
        button("View guest information", guestInfoUrl)
      );
    } else {
      // Normally the guest pays everything that's left, but say what's
      // true if a smaller amount came through (or the price changed since).
      const paidInFull = outstanding <= 0;
      subject = paidInFull ? `Paid in Full — ${ref}` : `Payment Received — ${ref}`;
      guestHtml = emailShell(
        heading(paidInFull ? "Thank you, you're all paid" : "Payment received") +
        para(`Dear ${escapeHtml(booking.guest_first_name) || "there"},`) +
        para(paidInFull
          ? `Thank you — we've received your payment of <strong>${money(paidAmount)}</strong>, so your stay is now paid in full. There's nothing more to pay.`
          : `Thank you — we've received your payment of <strong>${money(paidAmount)}</strong>. There's still <strong>${money(outstanding)}</strong> left to pay${booking.balance_due_date ? ` by ${fmtDate(booking.balance_due_date)}` : ""}.`) +
        infoBox(
          infoRow("Booking reference", escapeHtml(ref), true) +
          infoRow("Dates", dates) +
          infoRow("Total cost", money(booking.total_amount)) +
          infoRow("Paid so far", money(newAmountPaid)) +
          infoRow(paidInFull ? "Status" : "Still to pay", paidInFull ? "Paid in full" : money(outstanding), true)
        ) +
        (paidInFull ? "" : button("Pay the rest", manageUrl)) +
        stayDetailsBox() +
        para("We'll email your key-safe code on the morning you arrive. We look forward to welcoming you to Cringley Cottage!") +
        button("View guest information", guestInfoUrl)
      );
    }
    guestEmailOk = await sendEmail(booking.guest_email, subject, guestHtml, bookingId);
  }

  const ownerRows = infoRow("Guest", guestName)
    + infoRow("Email", escapeHtml(booking.guest_email))
    + infoRow("Phone", escapeHtml(booking.guest_phone))
    + infoRow("Dates", dates)
    + infoRow("Guests", String(booking.guests_count || ""))
    + infoRow("Dog", booking.has_dog ? "Yes" : "No")
    + infoRow("Address", escapeHtml([booking.address_line1, booking.address_line2, booking.city, booking.postcode, booking.country].filter(Boolean).join(", ")))
    + (booking.discount_amount > 0 ? infoRow("Discount code", `${escapeHtml(booking.discount_code)} (${money(booking.discount_amount)} off)`) : "")
    + infoRow("Payment just made", `${money(paidAmount)} (${paymentKind})`)
    + infoRow("Stripe payment ID", escapeHtml(paymentIntentId))
    + infoRow("Total paid so far", money(newAmountPaid))
    + infoRow("Total cost", money(booking.total_amount), true)
    + (booking.message ? infoRow("Message", escapeHtml(booking.message)) : "");
  const ownerHtml = emailShell(
    heading(purpose === "initial" ? "New confirmed booking" : "Balance paid") +
    para(`Booking reference <strong>${escapeHtml(ref)}</strong>`) +
    (guestEmailOk ? "" : para(`<strong>The guest's confirmation email could not be sent.</strong> Please contact them directly.`)) +
    infoBox(ownerRows)
  );
  await sendEmail(OWNER_EMAILS, purpose === "initial" ? `New confirmed booking ${ref}` : `Balance paid for ${ref}`, ownerHtml, bookingId);

  return json({ received: true });
});
