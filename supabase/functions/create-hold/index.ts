import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Creates a 10-minute temporary hold once a visitor progresses past browsing
// into "Book Now". Validates dates against the owner-configured minimum
// notice period (site_settings.min_advance_nights) and the maximum stay
// length server-side — never trusts the browser's own calendar-greying
// alone.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HOLD_MINUTES = 10;
const MAX_STAY_NIGHTS = 28;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isValidDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  try {
    const { checkin, checkout, guests_count } = await req.json();

    if (!isValidDate(checkin) || !isValidDate(checkout) || checkout <= checkin) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid dates" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const nightsRequested = Math.round((new Date(checkout + "T00:00:00").getTime() - new Date(checkin + "T00:00:00").getTime()) / 86400000);
    if (nightsRequested > MAX_STAY_NIGHTS) {
      return new Response(JSON.stringify({ ok: false, error: `The longest single stay is ${MAX_STAY_NIGHTS} nights` }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: settings } = await supabase.from("site_settings").select("min_advance_nights").eq("id", 1).maybeSingle();
    const minAdvance = settings?.min_advance_nights ?? 2;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + minAdvance);
    if (new Date(checkin + "T00:00:00") < cutoff) {
      return new Response(JSON.stringify({ ok: false, error: `Bookings need at least ${minAdvance} night${minAdvance === 1 ? '' : 's'} notice` }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const nowIso = new Date().toISOString();
    // Holds that have run out but that the 10-minute cleanup job hasn't
    // reached yet: cancel them now, or the database's no-overlap rule would
    // still count them and turn this visitor away.
    await supabase
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("status", "pending")
      .lt("hold_expires_at", nowIso)
      .lt("checkin", checkout)
      .gt("checkout", checkin);

    const { data: clashes, error: clashErr } = await supabase
      .from("bookings")
      .select("id, hold_expires_at")
      .neq("status", "cancelled")
      .lt("checkin", checkout)
      .gt("checkout", checkin);

    if (clashErr) {
      return new Response(JSON.stringify({ ok: false, error: clashErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const now = Date.now();
    const realClash = (clashes || []).some(c => !c.hold_expires_at || new Date(c.hold_expires_at).getTime() > now);
    if (realClash) {
      return new Response(JSON.stringify({ ok: false, error: "Those dates are no longer available" }), { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const expiresAt = new Date(now + HOLD_MINUTES * 60 * 1000).toISOString();

    const { data: inserted, error: insertErr } = await supabase
      .from("bookings")
      .insert({
        checkin, checkout,
        source: "direct",
        status: "pending",
        guests_count: guests_count ?? null,
        hold_expires_at: expiresAt,
      })
      .select("id")
      .single();

    // 23P01 is the no-overlap rule: someone else grabbed the dates in the
    // moment between the check above and this insert.
    if (insertErr?.code === "23P01") {
      return new Response(JSON.stringify({ ok: false, error: "Those dates are no longer available" }), { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    if (insertErr) {
      return new Response(JSON.stringify({ ok: false, error: insertErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: true, hold_id: inserted.id, expires_at: expiresAt }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
