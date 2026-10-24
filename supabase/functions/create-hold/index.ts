import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Creates a 10-minute temporary hold once a visitor progresses past browsing
// into "Book Now". Validates dates against the owner-configured minimum
// notice period (site_settings.min_advance_nights) and the maximum stay
// length server-side — never trusts the browser's own calendar-greying
// alone. Also enforces each season's minimum stay, and limits how many holds
// one visitor (and everyone together) can have, so a script can't make the
// cottage look fully booked.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HOLD_MINUTES = 10;
const MAX_STAY_NIGHTS = 28;
const DEFAULT_MIN_NIGHTS = 2;
// Per visitor: this many holds in this many seconds.
const HOLDS_PER_VISITOR = 8;
const HOLD_LIMIT_WINDOW_SECONDS = 15 * 60;
// Everyone together: this many unfinished holds at once.
const MAX_LIVE_HOLDS = 15;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isValidDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
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
    const { checkin, checkout, guests_count } = await req.json();

    if (!isValidDate(checkin) || !isValidDate(checkout) || checkout <= checkin) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid dates" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const nightsRequested = Math.round((new Date(checkout + "T00:00:00").getTime() - new Date(checkin + "T00:00:00").getTime()) / 86400000);
    if (nightsRequested > MAX_STAY_NIGHTS) {
      return new Response(JSON.stringify({ ok: false, error: `The longest single stay is ${MAX_STAY_NIGHTS} nights` }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const busy = JSON.stringify({ ok: false, error: "We're getting a lot of booking requests right now. Please try again in a few minutes." });
    if (!(await allowRequest(supabase, "create-hold", req, HOLD_LIMIT_WINDOW_SECONDS, HOLDS_PER_VISITOR))) {
      return new Response(busy, { status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    const { count: liveHolds } = await supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("source", "direct")
      .eq("status", "pending")
      .is("guest_email", null)
      .gt("hold_expires_at", new Date().toISOString());
    if ((liveHolds ?? 0) >= MAX_LIVE_HOLDS) {
      return new Response(busy, { status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // The minimum stay is set per season in Admin → Rates, by check-in date.
    const { data: season } = await supabase.from("rates").select("min_nights").lte("date_from", checkin).gte("date_to", checkin).limit(1).maybeSingle();
    const minNights = season?.min_nights ?? DEFAULT_MIN_NIGHTS;
    if (nightsRequested < minNights) {
      return new Response(JSON.stringify({ ok: false, error: `Minimum stay for these dates is ${minNights} nights` }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

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
