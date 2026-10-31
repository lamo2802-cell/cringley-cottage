import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Edits a direct booking's guest details, dates, or cancels it. Owner-only
// (verified server-side against the caller's JWT, same pattern as account
// creation, and the session must have passed 2FA). Only ever touches
// source='direct' bookings — Airbnb/Booking.com rows are synced from iCal
// and are read-only here.
//
// If the dates change, price fields (total_amount, deposit_amount,
// payment_type, amount_due, discount_amount, deal_amount, and balance_due_date if one was
// already set) are recomputed from the current rates/settings — but nothing
// is charged or refunded via Stripe automatically. The admin UI surfaces
// that plainly so the owner can collect or refund the difference themselves.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const DEFAULT_RATE = 120;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isValidDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// True when the session has passed the authenticator-code step (aal2), not
// just the password. Only read after getUser() has accepted the token.
function passedTwoFactor(token: string): boolean {
  try {
    return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aal === "aal2";
  } catch {
    return false;
  }
}

async function loadRates(supabase: any) {
  const { data } = await supabase.from("rates").select("date_from, date_to, nightly_rate").order("date_from");
  return (data || []).map((r: any) => ({ from: r.date_from, to: r.date_to, rate: r.nightly_rate }));
}
async function loadSettings(supabase: any) {
  const { data } = await supabase.from("site_settings").select("deposit_percent, full_payment_window_days, week_discount_percent, dog_surcharge_enabled, dog_surcharge_amount").eq("id", 1).maybeSingle();
  return {
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
function stayNights(checkin: string, checkout: string): string[] {
  const out: string[] = [];
  const start = new Date(checkin + "T00:00:00");
  const end = new Date(checkout + "T00:00:00");
  const nights = Math.round((end.getTime() - start.getTime()) / 86400000);
  for (let i = 0; i < nights; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function dealSaving(nights: string[], rates: { from: string; to: string; rate: number }[], deal: { percent_off: number; stay_from: string; stay_to: string } | null): number {
  if (!deal) return 0;
  let saving = 0;
  for (const n of nights) {
    if (n >= deal.stay_from && n <= deal.stay_to) saving += Math.round(rateFor(n, rates) * Number(deal.percent_off)) / 100;
  }
  return Math.round(saving * 100) / 100;
}
// Same order as create-booking: nightly rates, less the booking's deal (a
// copy kept on the booking, so it still applies to any of its new nights
// that fall in the deal's dates), less the 7-night discount, less the code,
// plus the dog fee.
function computePricing(
  checkin: string, checkout: string,
  rates: { from: string; to: string; rate: number }[],
  settings: { depositRate: number; fullPaymentWindowDays: number; weekDiscount: number; dogSurchargeEnabled: boolean; dogSurchargeAmount: number },
  discountPercent: number,
  hasDog: boolean,
  deal: { percent_off: number; stay_from: string; stay_to: string } | null = null
) {
  const start = new Date(checkin + "T00:00:00");
  const nightList = stayNights(checkin, checkout);
  const nights = nightList.length;
  let total = 0;
  for (const n of nightList) total += rateFor(n, rates);
  const dealAmount = dealSaving(nightList, rates, deal);
  const afterDeal = Math.round((total - dealAmount) * 100) / 100;
  const weekDisc = nights >= 7 ? Math.round(afterDeal * settings.weekDiscount) : 0;
  const afterWeekDiscount = afterDeal - weekDisc;
  const discountAmount = discountPercent > 0 ? Math.round(afterWeekDiscount * (discountPercent / 100) * 100) / 100 : 0;
  // The dog surcharge is a flat fee, added after nightly-rate discounts (it isn't itself discounted).
  const dogSurcharge = (hasDog && settings.dogSurchargeEnabled) ? Number(settings.dogSurchargeAmount) || 0 : 0;
  const finalTotal = Math.max(0, Math.round((afterWeekDiscount - discountAmount) * 100) / 100) + dogSurcharge;
  const deposit = Math.round(finalTotal * settings.depositRate);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysUntilCheckin = Math.round((start.getTime() - today.getTime()) / 86400000);
  const paymentType = daysUntilCheckin < settings.fullPaymentWindowDays ? "full" : "deposit";
  const amountDue = paymentType === "full" ? finalTotal : deposit;
  return { totalAmount: finalTotal, depositAmount: deposit, paymentType, amountDue, discountAmount, dogSurcharge, dealAmount };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const callerToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!callerToken) {
      return new Response(JSON.stringify({ ok: false, error: "Not signed in" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${callerToken}` } } });
    const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !callerData?.user || callerData.user.app_metadata?.role !== "owner" || !passedTwoFactor(callerToken)) {
      return new Response(JSON.stringify({ ok: false, error: "Only an owner account can edit bookings" }), { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const {
      booking_id, first_name, last_name, email, phone,
      address_line1, address_line2, city, postcode, country,
      has_dog, message, checkin, checkout, cancel,
    } = body;

    if (!booking_id) {
      return new Response(JSON.stringify({ ok: false, error: "booking_id required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: booking, error: loadErr } = await supabase.from("bookings").select("*").eq("id", booking_id).maybeSingle();
    if (loadErr || !booking) {
      return new Response(JSON.stringify({ ok: false, error: "Booking not found" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    if (booking.source !== "direct") {
      return new Response(JSON.stringify({ ok: false, error: "Only direct bookings can be edited here — Airbnb/Booking.com bookings are synced automatically and update on their own platforms." }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const updates: Record<string, unknown> = {};
    if (typeof first_name === "string") updates.guest_first_name = first_name;
    if (typeof last_name === "string") updates.guest_last_name = last_name;
    if (typeof email === "string") updates.guest_email = email;
    if (typeof phone === "string") updates.guest_phone = phone;
    if (typeof address_line1 === "string") updates.address_line1 = address_line1;
    if (typeof address_line2 === "string") updates.address_line2 = address_line2;
    if (typeof city === "string") updates.city = city;
    if (typeof postcode === "string") updates.postcode = postcode;
    if (typeof country === "string") updates.country = country;
    if (typeof has_dog === "boolean") updates.has_dog = has_dog;
    if (typeof message === "string") updates.message = message;

    if (cancel === true) {
      updates.status = "cancelled";
    }

    let pricingResult: Record<string, unknown> | null = null;
    // Dates and the has_dog flag both feed pricing (has_dog can carry a pet
    // surcharge), so a change to either one triggers a reprice — a plain
    // guest-detail edit (name, email, etc.) never does.
    if (checkin || checkout || typeof has_dog === "boolean") {
      const finalCheckin = isValidDate(checkin) ? checkin : booking.checkin;
      const finalCheckout = isValidDate(checkout) ? checkout : booking.checkout;
      const finalHasDog = typeof has_dog === "boolean" ? has_dog : !!booking.has_dog;
      if (!isValidDate(finalCheckin) || !isValidDate(finalCheckout) || finalCheckout <= finalCheckin) {
        return new Response(JSON.stringify({ ok: false, error: "Invalid dates" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
      const datesChanged = finalCheckin !== booking.checkin || finalCheckout !== booking.checkout;
      const dogChanged = finalHasDog !== !!booking.has_dog;

      if (datesChanged) {
        const { data: clashes, error: clashErr } = await supabase
          .from("bookings").select("id, hold_expires_at")
          .neq("status", "cancelled").neq("id", booking_id)
          .lt("checkin", finalCheckout).gt("checkout", finalCheckin);
        if (clashErr) return new Response(JSON.stringify({ ok: false, error: clashErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        const now = Date.now();
        const realClash = (clashes || []).some((c: any) => !c.hold_expires_at || new Date(c.hold_expires_at).getTime() > now);
        if (realClash) return new Response(JSON.stringify({ ok: false, error: "Those dates clash with another booking" }), { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }

      if (datesChanged || dogChanged) {
        const rates = await loadRates(supabase);
        const settings = await loadSettings(supabase);
        const pricing = computePricing(finalCheckin, finalCheckout, rates, settings, booking.discount_percent || 0, finalHasDog, booking.deal || null);

        updates.checkin = finalCheckin;
        updates.checkout = finalCheckout;
        updates.total_amount = pricing.totalAmount;
        updates.deposit_amount = pricing.depositAmount;
        updates.payment_type = pricing.paymentType;
        updates.amount_due = pricing.amountDue;
        updates.discount_amount = pricing.discountAmount;
        updates.deal_amount = pricing.dealAmount;
        if (booking.balance_due_date) {
          const d = new Date(finalCheckin + "T00:00:00");
          d.setDate(d.getDate() - settings.fullPaymentWindowDays);
          updates.balance_due_date = d.toISOString().slice(0, 10);
        }
        pricingResult = {
          total_amount: pricing.totalAmount, amount_paid: booking.amount_paid || 0,
          outstanding: Math.max(0, Math.round((pricing.totalAmount - (booking.amount_paid || 0)) * 100) / 100),
        };
      }
    }

    if (Object.keys(updates).length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "Nothing to update" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { error: updateErr } = await supabase.from("bookings").update(updates).eq("id", booking_id);
    if (updateErr) return new Response(JSON.stringify({ ok: false, error: updateErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

    return new Response(JSON.stringify({ ok: true, pricing: pricingResult }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
