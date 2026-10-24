import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Finalizes a booking. Independently computes the amount due from `rates`
// and `site_settings` (never trusts the client), and if a discount code is
// supplied, re-validates and applies it server-side too. If the discount
// brings the amount due to £0, the booking is confirmed immediately — no
// Stripe session is created at all — and the same confirmation emails the
// webhook would normally send are sent directly from here.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const DEFAULT_RATE = 120;
// Once the guest submits their details, the hold is renewed for long enough
// to open the Stripe page. create-checkout-session then extends it to
// outlast that page (which expires after 31 minutes). The cleanup cron
// reclaims it if they never pay; stripe-webhook nulls this out for real once
// payment actually succeeds, so a genuinely confirmed booking can never expire.
const CHECKOUT_HOLD_MINUTES = 10;
const FROM_EMAIL = "Cringley Cottage <hello@cringleycottage.com>";
const OWNER_EMAILS = ["lamo2802@gmail.com", "rpeacey987@gmail.com"];
const SITE_BASE_URL = "https://www.cringleycottage.com/";
const MAX_STAY_NIGHTS = 28;
const DEFAULT_MIN_NIGHTS = 2;
// Per visitor: this many booking submissions in this many seconds.
const BOOKINGS_PER_VISITOR = 8;
const BOOKING_LIMIT_WINDOW_SECONDS = 15 * 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isValidDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function loadRates(supabase: any) {
  const { data } = await supabase.from("rates").select("date_from, date_to, nightly_rate").order("date_from");
  return (data || []).map((r: any) => ({ from: r.date_from, to: r.date_to, rate: r.nightly_rate }));
}

async function loadSettings(supabase: any) {
  const { data } = await supabase.from("site_settings").select("min_advance_nights, deposit_percent, full_payment_window_days, week_discount_percent, dog_surcharge_enabled, dog_surcharge_amount").eq("id", 1).maybeSingle();
  return {
    minAdvanceNights: data?.min_advance_nights ?? 2,
    depositRate: (data?.deposit_percent ?? 25) / 100,
    fullPaymentWindowDays: data?.full_payment_window_days ?? 14,
    weekDiscount: (data?.week_discount_percent ?? 10) / 100,
    dogSurchargeEnabled: data?.dog_surcharge_enabled ?? false,
    dogSurchargeAmount: data?.dog_surcharge_amount ?? 0,
  };
}

function rateFor(dateISO: string, rates: { from: string; to: string; rate: number }[]) {
  const found = rates.find(r => dateISO >= r.from && dateISO <= r.to);
  return found ? found.rate : DEFAULT_RATE;
}

async function validateDiscountCode(supabase: any, code: string) {
  const { data: row } = await supabase
    .from("discount_codes")
    .select("id, code, percent_off, active, max_uses, times_used, expires_at")
    .eq("code", code.trim().toUpperCase())
    .maybeSingle();
  if (!row || !row.active) return null;
  if (row.expires_at && row.expires_at < new Date().toISOString().slice(0, 10)) return null;
  if (row.max_uses !== null && row.times_used >= row.max_uses) return null;
  return row;
}

function computePricing(
  checkin: string, checkout: string,
  rates: { from: string; to: string; rate: number }[],
  settings: { depositRate: number; fullPaymentWindowDays: number; weekDiscount: number; dogSurchargeEnabled: boolean; dogSurchargeAmount: number },
  discountPercent: number,
  hasDog: boolean
) {
  const start = new Date(checkin + "T00:00:00");
  const end = new Date(checkout + "T00:00:00");
  const nights = Math.round((end.getTime() - start.getTime()) / 86400000);
  let total = 0;
  for (let i = 0; i < nights; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    total += rateFor(d.toISOString().slice(0, 10), rates);
  }
  const weekDisc = nights >= 7 ? Math.round(total * settings.weekDiscount) : 0;
  const afterWeekDiscount = total - weekDisc;
  const discountAmount = discountPercent > 0 ? Math.round(afterWeekDiscount * (discountPercent / 100) * 100) / 100 : 0;
  // The dog surcharge is a flat fee, added after nightly-rate discounts (it isn't itself discounted).
  const dogSurcharge = (hasDog && settings.dogSurchargeEnabled) ? Number(settings.dogSurchargeAmount) || 0 : 0;
  const finalTotal = Math.max(0, Math.round((afterWeekDiscount - discountAmount) * 100) / 100) + dogSurcharge;
  const deposit = Math.round(finalTotal * settings.depositRate);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysUntilCheckin = Math.round((start.getTime() - today.getTime()) / 86400000);
  const paymentType = daysUntilCheckin < settings.fullPaymentWindowDays ? "full" : "deposit";
  const amountDue = paymentType === "full" ? finalTotal : deposit;

  return { totalAmount: finalTotal, depositAmount: deposit, paymentType, amountDue, discountAmount, dogSurcharge };
}

function guestBreakdown(adults: number, children: number): string {
  const parts = [`${adults} adult${adults === 1 ? "" : "s"}`];
  if (children > 0) parts.push(`${children} child${children === 1 ? "" : "ren"}`);
  return parts.join(", ");
}
function money(n: number) { return "£" + Number(n).toFixed(2).replace(/\.00$/, ""); }
function fmtDate(d: string) { return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }); }
// Throws rather than returning "CC-YYYY-null" if the sequence call fails;
// the caller's catch turns that into a 500 before anything is confirmed.
async function nextBookingRef(supabase: any) {
  const { data, error } = await supabase.rpc("nextval_booking_ref");
  const n = Number(data);
  if (error || data === null || data === undefined || !Number.isFinite(n) || n <= 0) {
    throw new Error(`Couldn't assign a booking reference: ${error?.message ?? "no value returned"}`);
  }
  const year = new Date().getFullYear();
  return `CC-${year}-${String(n).padStart(4, "0")}`;
}
// Guest-supplied fields (name, phone, discount code echoed back) reach this
// file straight from the public booking form — escape them before they go
// into an HTML email, whether that email goes to the guest or to the
// owner's own inbox (the owner-notification path is the more sensitive one).
function escapeHtml(s: unknown): string {
  return (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function emailShell(bodyHtml: string) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#e9e3d6;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9e3d6;padding:32px 16px;"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;"><tr><td style="background:#232120;padding:28px 32px;text-align:center;"><div style="display:inline-block;border:1px solid rgba(255,255,255,0.35);border-radius:2px;padding:10px 22px;"><span style="font-family:Georgia,'Times New Roman',serif;font-size:19px;letter-spacing:3px;color:#f3ede3;text-transform:uppercase;">Cringley Cottage</span></div></td></tr><tr><td style="padding:36px 40px 8px;">${bodyHtml}</td></tr><tr><td style="padding:28px 40px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #e5ddd0;padding-top:20px;"><p style="margin:0 0 4px;font-family:Georgia,serif;font-size:13px;color:#7a6f60;">Cringley Cottage &middot; Askrigg &middot; Yorkshire Dales &middot; <a href="https://www.cringleycottage.com/" style="color:#5e7a52;text-decoration:underline;">www.cringleycottage.com</a></p><p style="margin:0;font-family:Georgia,serif;font-size:12px;color:#a39a89;">Questions? Just reply to this email &mdash; we read every message.</p></td></tr></table></td></tr></table></td></tr></table></body></html>`;
}
function heading(t: string) { return `<h1 style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#232120;margin:0 0 14px;">${t}</h1>`; }
function para(t: string) { return `<p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.6;color:#4a453d;margin:0 0 14px;">${t}</p>`; }
function infoRow(l: string, v: string, bold = false) {
  const w = bold ? "600" : "400", c = bold ? "#5e7a52" : "#232120";
  return `<tr><td style="padding:6px 0;border-top:1px solid #e5ddd0;color:#7a6f60;font-size:13px;font-family:'Helvetica Neue',Arial,sans-serif;">${l}</td><td style="padding:6px 0;border-top:1px solid #e5ddd0;text-align:right;font-weight:${w};color:${c};font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;">${v}</td></tr>`;
}
function infoBox(rows: string) { return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f0e8;border-radius:4px;margin:4px 0 18px;"><tr><td style="padding:18px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr></table>`; }
function button(t: string, u: string) { return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px;"><tr><td style="background:#5e7a52;border-radius:3px;"><a href="${u}" style="display:inline-block;padding:13px 28px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;letter-spacing:0.5px;text-transform:uppercase;color:#ffffff;text-decoration:none;">${t}</a></td></tr></table>`; }
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
    function_name: "create-booking", recipient: [to].flat().join(", "), subject, ok, error, booking_id: bookingId ?? null,
  });
  return ok;
}

// One request from one visitor, recorded against a keyed hash of their IP
// address so the address itself is never stored. Lets the request through if
// the limit can't be checked, so a hiccup never blocks a real guest.
async function allowRequest(supabase: any, fn: string, req: Request, windowSeconds: number, max: number): Promise<boolean> {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "";
  if (!ip) return true;
  const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(SERVICE_ROLE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(ip)));
  const key = `${fn}:${Array.from(sig.slice(0, 12)).map(b => b.toString(16).padStart(2, "0")).join("")}`;
  const { data, error } = await supabase.rpc("hit_rate_limit", { p_key: key, p_window_seconds: windowSeconds, p_max: max });
  return error ? true : data !== false;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  try {
    const body = await req.json();
    const {
      hold_id, checkin, checkout,
      first_name, last_name, email, phone,
      address_line1, address_line2, city, postcode, country,
      has_dog, adults, children, message, discount_code, marketing_consent, terms_accepted,
    } = body;

    // The guest must actively accept the Terms (non-refundable deposit,
    // cancellation rules) before paying; when they did is stored below.
    if (terms_accepted !== true) {
      return new Response(JSON.stringify({ ok: false, error: "Please tick the box to accept the Terms & Conditions." }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    if (!email || typeof email !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Email required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    if (!first_name || !last_name) {
      return new Response(JSON.stringify({ ok: false, error: "Name required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // The booking form collects headcounts (adults/children) rather than
    // each guest's name — max occupancy is enforced here, server-side,
    // never trusting whatever the form's own picker limits allowed.
    const adultsCount = Math.max(1, parseInt(adults, 10) || 1);
    const childrenCount = Math.max(0, parseInt(children, 10) || 0);
    const MAX_OCCUPANCY = 4;
    if (adultsCount + childrenCount > MAX_OCCUPANCY) {
      return new Response(JSON.stringify({ ok: false, error: `Maximum occupancy is ${MAX_OCCUPANCY} guests` }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    if (!(await allowRequest(supabase, "create-booking", req, BOOKING_LIMIT_WINDOW_SECONDS, BOOKINGS_PER_VISITOR))) {
      return new Response(JSON.stringify({ ok: false, error: "Too many attempts. Please wait a few minutes and try again." }), { status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    const settings = await loadSettings(supabase);
    let bookingId: string;
    let finalCheckin: string, finalCheckout: string;

    if (hold_id) {
      const { data: hold } = await supabase.from("bookings").select("id, status, hold_expires_at, source, checkin, checkout").eq("id", hold_id).maybeSingle();
      const stillLive = hold && hold.source === "direct" && hold.status === "pending" && hold.hold_expires_at && new Date(hold.hold_expires_at).getTime() > Date.now();
      if (!stillLive) {
        return new Response(JSON.stringify({ ok: false, error: "Your held dates have expired. Please select dates again." }), { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      bookingId = hold.id; finalCheckin = hold.checkin; finalCheckout = hold.checkout;
    } else {
      if (!isValidDate(checkin) || !isValidDate(checkout) || checkout <= checkin) {
        return new Response(JSON.stringify({ ok: false, error: "Invalid or missing dates" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      const nightsRequested = Math.round((new Date(checkout + "T00:00:00").getTime() - new Date(checkin + "T00:00:00").getTime()) / 86400000);
      if (nightsRequested > MAX_STAY_NIGHTS) {
        return new Response(JSON.stringify({ ok: false, error: `The longest single stay is ${MAX_STAY_NIGHTS} nights` }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      const { data: season } = await supabase.from("rates").select("min_nights").lte("date_from", checkin).gte("date_to", checkin).limit(1).maybeSingle();
      const minNights = season?.min_nights ?? DEFAULT_MIN_NIGHTS;
      if (nightsRequested < minNights) {
        return new Response(JSON.stringify({ ok: false, error: `Minimum stay for these dates is ${minNights} nights` }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + settings.minAdvanceNights);
      if (new Date(checkin + "T00:00:00") < cutoff) {
        return new Response(JSON.stringify({ ok: false, error: `Bookings need at least ${settings.minAdvanceNights} night${settings.minAdvanceNights === 1 ? '' : 's'} notice` }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      // Clear run-out holds the cleanup job hasn't reached yet, or the
      // database's no-overlap rule would still count them.
      await supabase.from("bookings").update({ status: "cancelled" }).eq("status", "pending").lt("hold_expires_at", new Date().toISOString()).lt("checkin", checkout).gt("checkout", checkin);
      const { data: clashes, error: clashErr } = await supabase.from("bookings").select("id, hold_expires_at").neq("status", "cancelled").lt("checkin", checkout).gt("checkout", checkin);
      if (clashErr) return new Response(JSON.stringify({ ok: false, error: clashErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      const now = Date.now();
      const realClash = (clashes || []).some(c => !c.hold_expires_at || new Date(c.hold_expires_at).getTime() > now);
      if (realClash) return new Response(JSON.stringify({ ok: false, error: "Those dates are no longer available" }), { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      const { data: inserted, error: insertErr } = await supabase.from("bookings").insert({ checkin, checkout, source: "direct", status: "pending" }).select("id").single();
      // 23P01: the no-overlap rule caught someone grabbing the dates in between.
      if (insertErr?.code === "23P01") return new Response(JSON.stringify({ ok: false, error: "Those dates are no longer available" }), { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      if (insertErr) return new Response(JSON.stringify({ ok: false, error: insertErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      bookingId = inserted.id; finalCheckin = checkin; finalCheckout = checkout;
    }

    // ─── Discount code ──────────────────────────────────────────────────────────────────────────────────────────────
    let discountRow: any = null;
    if (discount_code && typeof discount_code === "string") {
      discountRow = await validateDiscountCode(supabase, discount_code);
      if (!discountRow) {
        return new Response(JSON.stringify({ ok: false, error: "That discount code is no longer valid" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
    }

    const rates = await loadRates(supabase);
    const pricing = computePricing(finalCheckin, finalCheckout, rates, settings, discountRow?.percent_off || 0, !!has_dog);
    const guestsCount = adultsCount + childrenCount;
    const fullyDiscounted = pricing.amountDue <= 0;

    const baseUpdates: Record<string, unknown> = {
      guest_first_name: first_name, guest_last_name: last_name,
      guest_email: email, guest_phone: phone ?? null,
      address_line1: address_line1 ?? null, address_line2: address_line2 ?? null,
      city: city ?? null, postcode: postcode ?? null, country: country || "United Kingdom",
      has_dog: !!has_dog, guests_count: guestsCount, children_count: childrenCount, message: message ?? null,
      total_amount: pricing.totalAmount, deposit_amount: pricing.depositAmount,
      payment_type: pricing.paymentType, amount_due: pricing.amountDue,
      // Confirmed (fully-discounted, no-Stripe) bookings are permanently
      // blocked (null); everything else gets a renewed checkout-window
      // expiry so an abandoned Stripe checkout gets reclaimed automatically
      // instead of blocking these dates forever.
      hold_expires_at: fullyDiscounted ? null : new Date(Date.now() + CHECKOUT_HOLD_MINUTES * 60 * 1000).toISOString(),
      discount_code: discountRow ? discountRow.code ?? discount_code.trim().toUpperCase() : null,
      discount_percent: discountRow ? discountRow.percent_off : null,
      discount_amount: pricing.discountAmount,
      marketing_consent: !!marketing_consent,
      marketing_consent_at: marketing_consent ? new Date().toISOString() : null,
      terms_accepted_at: new Date().toISOString(),
    };

    if (fullyDiscounted) {
      // Skip Stripe entirely — confirm right now. The reference is assigned
      // before the code's use is claimed, so a failure there can't use it up.
      // The claim is one step, so two guests can't both take its last use.
      const bookingRef = await nextBookingRef(supabase);
      if (discountRow) {
        const { data: claimed } = await supabase.rpc("claim_discount_use", { p_code: discountRow.code });
        if (claimed !== true) {
          return new Response(JSON.stringify({ ok: false, error: "That discount code is no longer valid" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
      }
      baseUpdates.status = "confirmed";
      baseUpdates.deposit_paid = true;
      baseUpdates.amount_paid = pricing.totalAmount; // 0, but keeps amount_paid === total_amount invariant
      baseUpdates.booking_ref = bookingRef;

      const { error: updateErr } = await supabase.from("bookings").update(baseUpdates).eq("id", bookingId);
      if (updateErr) return new Response(JSON.stringify({ ok: false, error: updateErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

      const guestInfoUrl = `${SITE_BASE_URL}guest-info.html`;
      await sendEmail(email, `Booking Confirmed — ${bookingRef}`, emailShell(
        heading("Booking confirmed") +
        para(`Dear ${escapeHtml(first_name)},`) +
        para("Thank you — your booking at Cringley Cottage is confirmed, with a 100% discount applied. Nothing further to pay!") +
        infoBox(
          infoRow("Booking reference", bookingRef, true) +
          infoRow("Dates", `${fmtDate(finalCheckin)} &rarr; ${fmtDate(finalCheckout)}`) +
          infoRow("Discount code", escapeHtml(baseUpdates.discount_code as string), true)
        ) +
        infoBox(
          infoRow("Check-in", "From 3pm") +
          infoRow("Check-out", "By 10am") +
          infoRow("Address", "Cringley Cottage, Silver Street,<br>Askrigg, Leyburn DL8 3HS") +
          infoRow("Parking", "On-street in the village, or Parkins Garth car park at the village entrance")
        ) +
        para(`Your booking is made under our <a href="${SITE_BASE_URL}terms.html" style="color:#5e7a52;">booking terms</a>. We'll email your key-safe code on the morning you arrive.`) +
        para("We look forward to welcoming you to Cringley Cottage!") +
        button("View guest information", guestInfoUrl)
      ));
      await sendEmail(OWNER_EMAILS, `New confirmed booking ${bookingRef} (100% discount)`, emailShell(
        heading("New confirmed booking — 100% discount") +
        para(`Booking reference <strong>${bookingRef}</strong>`) +
        infoBox(
          infoRow("Guest", `${escapeHtml(first_name)} ${escapeHtml(last_name)}`) +
          infoRow("Email", escapeHtml(email)) +
          infoRow("Phone", escapeHtml(phone) || "") +
          infoRow("Dates", `${fmtDate(finalCheckin)} &rarr; ${fmtDate(finalCheckout)}`) +
          infoRow("Guests", guestBreakdown(adultsCount, childrenCount)) +
          infoRow("Dog", has_dog ? "Yes" : "No") +
          (pricing.dogSurcharge > 0 ? infoRow("Pet surcharge", money(pricing.dogSurcharge)) : "") +
          infoRow("Discount code", `${escapeHtml(baseUpdates.discount_code)} (${discountRow?.percent_off}% off)`, true) +
          infoRow("Amount paid", "£0 — fully discounted", true)
        )
      ));

      return new Response(JSON.stringify({ ok: true, booking_id: bookingId, booking_ref: bookingRef, skip_payment: true }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { error: updateErr } = await supabase.from("bookings").update(baseUpdates).eq("id", bookingId);
    if (updateErr) return new Response(JSON.stringify({ ok: false, error: updateErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

    return new Response(JSON.stringify({
      ok: true, booking_id: bookingId, skip_payment: false,
      payment_type: pricing.paymentType, amount_due: pricing.amountDue, total_amount: pricing.totalAmount,
    }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
