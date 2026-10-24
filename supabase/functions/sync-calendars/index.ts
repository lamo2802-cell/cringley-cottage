import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Pulls every owner-managed iCal feed (Airbnb, Booking.com, or anything else
// added in admin.html) into the bookings table. Triggered on schedule
// (x-sync-secret, set by pg_cron) or manually from the admin page (a valid
// owner JWT in Authorization, from a session that has passed 2FA).
//
// Airbnb (and some other platforms) reissue a fresh UID for a placeholder
// "not available" block each time it re-derives one — the same conceptual
// block re-appears under a new UID rather than updating in place. Upserting
// alone can't catch that: it just accumulates a new row per day and leaves
// the previous days' rows behind as stale phantom blocks that never clear,
// silently over-blocking real availability. So after upserting whatever the
// feed currently contains, this also deletes any synced-but-not-manually-
// touched booking for that source whose external_uid is no longer present in
// this fetch — the feed is authoritative for its own source_tag.
//
// Each feed's last result is stored on its ical_sources row. When a feed
// fails FAILURES_BEFORE_ALERT runs in a row the owners get one email, and
// another only after it has worked again and then failed again.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SYNC_SECRET = Deno.env.get("SYNC_SECRET");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = "Cringley Cottage <hello@cringleycottage.com>";
const OWNER_EMAILS = ["lamo2802@gmail.com", "rpeacey987@gmail.com"];
const FAILURES_BEFORE_ALERT = 2;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ICalEvent { uid: string; start: string; end: string; }

function parseICal(text: string): ICalEvent[] {
  const events: ICalEvent[] = [];
  const lines = text.split(/\r?\n/);
  let inEvent = false, uid = "", dtstart = "", dtend = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "BEGIN:VEVENT") { inEvent = true; uid = ""; dtstart = ""; dtend = ""; }
    else if (line === "END:VEVENT") {
      if (inEvent && dtstart && dtend) events.push({ uid, start: dtstart, end: dtend });
      inEvent = false;
    } else if (inEvent) {
      if (line.startsWith("UID:")) uid = line.slice(4).trim();
      else if (line.startsWith("DTSTART")) dtstart = (line.split(":").pop() || "").replace(/T.*/, "").trim();
      else if (line.startsWith("DTEND")) dtend = (line.split(":").pop() || "").replace(/T.*/, "").trim();
    }
  }
  return events;
}

function toISODate(s: string): string {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function escapeHtml(s: unknown): string {
  return (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Logged to email_log like every other booking email. Never throws.
async function alertOwners(supabase: any, subject: string, html: string) {
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
  await supabase.from("email_log").insert({ function_name: "sync-calendars", recipient: OWNER_EMAILS.join(", "), subject, ok, error });
}

// Syncs one feed. Returns the result to show in admin, or throws with the
// reason it failed.
async function syncSource(supabase: any, src: any): Promise<string | number> {
  const res = await fetch(src.url);
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  // A login page or error page instead of a calendar would otherwise look
  // like an empty calendar, and the prune below would wipe every block.
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("the feed didn't return a calendar");
  const events = parseICal(text);

  const rows = events
    .filter(ev => ev.start && ev.end)
    .map(ev => ({
      checkin: toISODate(ev.start),
      checkout: toISODate(ev.end),
      source: src.source_tag,
      status: "confirmed",
      external_uid: ev.uid || `${src.source_tag}-${ev.start}-${ev.end}`,
    }));

  if (rows.length > 0) {
    const { error } = await supabase.from("bookings").upsert(rows, { onConflict: "source,external_uid" });
    if (error) throw new Error(`upsert error: ${error.message}`);
  }

  // Prune stale rows: anything previously synced for this source whose
  // external_uid isn't in today's feed no longer represents a real
  // block (the feed is authoritative). Only ever touches rows that
  // still have an external_uid — a guest's own direct booking or a
  // cancelled/finalized row is never synced-managed, so it's never a
  // candidate here regardless of source.
  const currentUids = rows.map(r => r.external_uid);
  let staleQuery = supabase
    .from("bookings")
    .delete()
    .eq("source", src.source_tag)
    .not("external_uid", "is", null);
  staleQuery = currentUids.length > 0
    ? staleQuery.not("external_uid", "in", `(${currentUids.map(u => `"${u.replace(/"/g, '\\"')}"`).join(",")})`)
    : staleQuery;
  const { error: pruneErr, count } = await staleQuery.select("id", { count: "exact", head: true });
  if (pruneErr) throw new Error(`${rows.length} synced (prune error: ${pruneErr.message})`);

  return count ? `${rows.length} synced, ${count} stale removed` : rows.length;
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  // Auth: either the cron shared secret, or a signed-in owner
  const provided = req.headers.get("x-sync-secret");
  let authorized = !!SYNC_SECRET && provided === SYNC_SECRET;

  if (!authorized) {
    const authHeader = req.headers.get("Authorization") || "";
    const callerToken = authHeader.replace(/^Bearer\s+/i, "");
    if (callerToken) {
      const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${callerToken}` } } });
      const { data: callerData } = await callerClient.auth.getUser();
      authorized = callerData?.user?.app_metadata?.role === "owner" && passedTwoFactor(callerToken);
    }
  }
  if (!authorized) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: sources, error: sourcesErr } = await supabase
      .from("ical_sources")
      .select("id, label, url, source_tag, consecutive_failures, failure_alert_sent_at");
    if (sourcesErr) {
      return new Response(JSON.stringify({ ok: false, error: sourcesErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const results: Record<string, number | string> = {};

    for (const src of sources || []) {
      try {
        results[src.label] = await syncSource(supabase, src);
        await supabase.from("ical_sources").update({
          last_synced_at: new Date().toISOString(), last_error: null, consecutive_failures: 0, failure_alert_sent_at: null,
        }).eq("id", src.id);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        results[src.label] = `error: ${reason}`;
        const failures = (src.consecutive_failures || 0) + 1;
        const updates: Record<string, unknown> = { last_error: reason, consecutive_failures: failures };
        if (failures >= FAILURES_BEFORE_ALERT && !src.failure_alert_sent_at) {
          await alertOwners(supabase, `Calendar sync failing: ${src.label}`,
            `<p>The <strong>${escapeHtml(src.label)}</strong> calendar hasn't synced for the last ${failures} attempts, so bookings made there may not be blocking dates on the website.</p>
             <p>Last error: ${escapeHtml(reason)}</p>
             <p>Please check the feed URL in Admin → Calendar Sync, and keep an eye out for clashes until it's working again. You'll get another email only if it starts failing again after it recovers.</p>`);
          updates.failure_alert_sent_at = new Date().toISOString();
        }
        await supabase.from("ical_sources").update(updates).eq("id", src.id);
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
