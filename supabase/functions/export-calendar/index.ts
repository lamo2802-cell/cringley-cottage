import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Public .ics feed of direct (non-OTA) confirmed bookings, including owner
// closures. Paste this function's URL into Airbnb's and Booking.com's
// "import an external calendar" settings so both real bookings and manual
// closures block those platforms too.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function fmtDate(d: string): string {
  return d.replace(/-/g, "");
}

// RFC 5545 §3.3.11 TEXT escaping — guest names are free text, and without
// this a backslash, comma, semicolon or embedded newline in a name could
// corrupt the feed or inject bogus extra fields/events into it.
function icsEscape(s: string): string {
  return (s || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from("bookings")
    .select("id, checkin, checkout, guest_first_name, guest_last_name, is_blocked")
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
    let summary: string;
    if (b.is_blocked) {
      summary = "Not available";
    } else if (b.guest_first_name) {
      summary = `Booked - ${icsEscape(b.guest_first_name)} ${icsEscape(b.guest_last_name ?? "")}`.trim();
    } else {
      summary = "Booked (direct)";
    }
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
