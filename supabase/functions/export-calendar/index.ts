import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// .ics feed of direct (non-OTA) confirmed bookings, including owner
// closures. Paste this function's URL into Airbnb's and Booking.com's
// "import an external calendar" settings so both real bookings and manual
// closures block those platforms too.
//
// The platforms only need to know which dates are taken, so no guest names
// go in the feed. Once the CALENDAR_FEED_KEY secret is set, the feed also
// needs ?key=<that value> on the URL, so a stranger can't read it. Until
// then any request works, which lets the owners update the URL on Airbnb
// and Booking.com first without the feed ever going dark.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CALENDAR_FEED_KEY = Deno.env.get("CALENDAR_FEED_KEY");

function fmtDate(d: string): string {
  return d.replace(/-/g, "");
}

Deno.serve(async (req: Request) => {
  if (CALENDAR_FEED_KEY && new URL(req.url).searchParams.get("key") !== CALENDAR_FEED_KEY) {
    return new Response("Not found", { status: 404 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from("bookings")
    .select("id, checkin, checkout, is_blocked")
    .eq("source", "direct")
    .eq("status", "confirmed");

  if (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }

  const now = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cringley Cottage//Direct Bookings//EN",
    "CALSCALE:GREGORIAN",
  ];

  for (const b of data || []) {
    const summary = b.is_blocked ? "Not available" : "Booked";
    lines.push(
      "BEGIN:VEVENT",
      `UID:direct-${b.id}@cringleycottage.com`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${fmtDate(b.checkin)}`,
      `DTEND;VALUE=DATE:${fmtDate(b.checkout)}`,
      `SUMMARY:${summary}`,
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n"), {
    headers: { "Content-Type": "text/calendar; charset=utf-8" },
  });
});
