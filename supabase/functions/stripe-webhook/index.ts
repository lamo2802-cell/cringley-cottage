import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Stripe webhook — the authoritative source for "did this actually get paid".
// Handles both the initial (deposit/full) payment and later balance payments.
// Sends the guest a branded confirmation email and Mark/Ruth an owner
// notification, both via Resend. If a discount code was used, increments its
// usage count here — only on a real completed payment, not an abandoned hold.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = "Cringley Cottage <hello@cringleycottage.com>";
const OWNER_EMAILS = ["lamo2802@gmail.com", "rpeacey987@gmail.com"];
const SITE_BASE_URL = "https://www.cringleycottage.com/";

async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(sigHeader.split(",").map(p => p.split("=")) as [string, string][]);
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, "0")).join("");
  if (computed.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function nextBookingRef(supabase: any): Promise<string> {
  const { data } = await supabase.rpc("nextval_booking_ref");
  const n = data as number;
  const year = new Date().getFullYear();
  return `CC-${year}-${String(n).padStart(4, "0")}`;
}

async function getFullPaymentWindowDays(supabase: any): Promise<number> {
  const { data } = await supabase.from("site_settings").select("full_payment_window_days").eq("id", 1).maybeSingle();
  return data?.full_payment_window_days ?? 14;
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

async function sendEmail(to: string | string[], subject: string, html: string) {
  if (!RESEND_API_KEY) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
  } catch { /* email is best-effort — never blocks booking confirmation */ }
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

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object;
    const bookingId = session?.metadata?.booking_id;
    const purpose = session?.metadata?.purpose === "balance" ? "balance" : "initial";
    const paymentIntentId = session.payment_intent || session.id;

    if (bookingId && session.payment_status === "paid") {
      const { data: existing } = await supabase
        .from("booking_payments")
        .select("id")
        .eq("stripe_payment_intent_id", paymentIntentId)
        .maybeSingle();

      if (!existing) {
        const { data: booking } = await supabase.from("bookings").select("*").eq("id", bookingId).maybeSingle();
        if (booking) {
          const paidAmount = (session.amount_total || 0) / 100;

          await supabase.from("booking_payments").insert({
            booking_id: bookingId,
            stripe_payment_intent_id: paymentIntentId,
            stripe_checkout_session_id: session.id,
            amount: paidAmount,
            purpose,
          });

          const newAmountPaid = Math.round(((booking.amount_paid || 0) + paidAmount) * 100) / 100;
          const updates: Record<string, unknown> = { amount_paid: newAmountPaid };

          if (purpose === "initial") {
            updates.status = "confirmed";
            updates.deposit_paid = true;
            updates.stripe_payment_intent_id = paymentIntentId;
            // Payment has genuinely landed — this booking must block these
            // dates permanently, not just until its checkout-window hold
            // (set by create-booking) happens to expire. Null it out here,
            // same as the fully-discounted no-Stripe path already does.
            updates.hold_expires_at = null;
            if (!booking.booking_ref) updates.booking_ref = await nextBookingRef(supabase);
            if (booking.payment_type === "deposit") {
              const windowDays = await getFullPaymentWindowDays(supabase);
              const checkin = new Date(booking.checkin + "T00:00:00");
              checkin.setDate(checkin.getDate() - windowDays);
              updates.balance_due_date = checkin.toISOString().slice(0, 10);
            }
            // A discount code was applied at booking time but payment still went
            // through Stripe (partial discount) — usage only counts once payment
            // actually completes, not when the hold was merely created.
            if (booking.discount_code) {
              const { data: codeRow } = await supabase.from("discount_codes").select("id, times_used").eq("code", booking.discount_code).maybeSingle();
              if (codeRow) await supabase.from("discount_codes").update({ times_used: codeRow.times_used + 1 }).eq("id", codeRow.id);
            }
          } else {
            if (newAmountPaid >= (booking.total_amount || 0) - 0.01) updates.balance_due_date = null;
          }

          await supabase.from("bookings").update(updates).eq("id", bookingId);

          const ref = (updates.booking_ref as string) || booking.booking_ref;
          const paymentKind = purpose === "balance" ? "Balance" : (booking.payment_type === "full" ? "Full payment" : "Deposit");
          if (ref) await tagStripePayment(paymentIntentId, ref, `${paymentKind} — Cringley Cottage ${ref}, ${booking.checkin} to ${booking.checkout}`);
          const outstanding = Math.max(0, Math.round(((booking.total_amount || 0) - newAmountPaid) * 100) / 100);
          const manageUrl = `${SITE_BASE_URL}pay-balance.html`;
          const guestInfoUrl = `${SITE_BASE_URL}guest-info.html`;

          if (booking.guest_email) {
            let guestHtml: string;
            let subject: string;
            if (purpose === "initial") {
              subject = `Booking Confirmed — ${ref}`;
              let rows = infoRow("Booking reference", escapeHtml(ref), true)
                + infoRow("Dates", `${fmtDate(booking.checkin)} &rarr; ${fmtDate(booking.checkout)}`)
                + (booking.discount_amount > 0 ? infoRow("Discount applied", `${money(booking.discount_amount)} (${escapeHtml(booking.discount_code)})`) : "")
                + infoRow("Total cost", money(booking.total_amount))
                + infoRow("Paid today", money(paidAmount));
              if (outstanding > 0) rows += infoRow("Balance due", `${money(outstanding)} by ${fmtDate((updates.balance_due_date as string) || booking.balance_due_date)}`, true);
              guestHtml = emailShell(
                heading("Booking confirmed") +
                para(`Dear ${escapeHtml(booking.guest_first_name) || "there"},`) +
                para("Thank you — your booking at Cringley Cottage is confirmed!") +
                infoBox(rows) +
                (outstanding > 0
                  ? para(`You can pay the remaining balance any time before then at <a href="${manageUrl}" style="color:#5e7a52;">${manageUrl}</a> using your booking reference and email.`)
                  : para("Your stay is paid in full — nothing more to do!")) +
                para(`We look forward to welcoming you to Cringley Cottage! Check-in is from <strong>3pm</strong>.`) +
                button("View guest information", guestInfoUrl)
              );
            } else {
              subject = `Balance Paid — ${ref}`;
              guestHtml = emailShell(
                heading("Balance received") +
                para(`Dear ${escapeHtml(booking.guest_first_name) || "there"},`) +
                para(`Thank you — we've received your balance payment of <strong>${money(paidAmount)}</strong>. Your booking is now paid in full.`) +
                infoBox(infoRow("Booking reference", escapeHtml(ref), true) + infoRow("Status", "Paid in full", true)) +
                para(`We look forward to welcoming you to Cringley Cottage! Check-in is from <strong>3pm</strong>.`) +
                button("View guest information", guestInfoUrl)
              );
            }
            await sendEmail(booking.guest_email, subject, guestHtml);
          }

          const ownerRows = infoRow("Guest", `${escapeHtml(booking.guest_first_name)} ${escapeHtml(booking.guest_last_name)}`)
            + infoRow("Email", escapeHtml(booking.guest_email))
            + infoRow("Phone", escapeHtml(booking.guest_phone))
            + infoRow("Dates", `${fmtDate(booking.checkin)} &rarr; ${fmtDate(booking.checkout)}`)
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
            infoBox(ownerRows)
          );
          await sendEmail(OWNER_EMAILS, purpose === "initial" ? `New confirmed booking ${ref}` : `Balance paid for ${ref}`, ownerHtml);
        }
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
