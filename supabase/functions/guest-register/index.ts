import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Backs guest-register.html, the private page linked from the booking
// confirmation email (stripe-webhook) and, if it's still missing, the
// check-in day email (send-guest-messages). It records what the
// Immigration (Hotel Records) Order 1972 asks for:
//   - every guest aged 16+: full name and nationality
//   - anyone who isn't British, Irish or a Commonwealth citizen (British
//     Nationality Act 1981, Schedule 3) also: passport/ID number, where it
//     was issued, and their next destination
//
// The link is the booking id plus an HMAC of it (same idea as unsubscribe),
// so both emails can make the same link without storing anything:
//   guest-register.html?t=<booking id>.<first 32 hex of HMAC("guest-register:" + id)>
//
//   { action: "get", token }            → the stay, the country list and
//                                         anything already saved
//   { action: "save", token, guests }   → replaces the register for the stay
//
// Saved ID numbers are never sent back in full: the page shows the last 4
// characters, and leaving the box blank keeps the number already saved.
// Guests can change their details until their checkout day. Rows are
// deleted 12 months after checkout by a daily database job.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Nationalities offered on the form. exempt = British, Irish, or a country
// in Schedule 3 of the British Nationality Act 1981 (Commonwealth citizens),
// as amended up to S.I. 2023/1219 (Eswatini, Gabon, Togo). Those guests only
// give their name and nationality.
const EXEMPT = new Set([
  "British", "Irish",
  "Antigua and Barbuda", "Australia", "Bahamas", "Bangladesh", "Barbados", "Belize", "Botswana", "Brunei",
  "Cameroon", "Canada", "Cyprus", "Dominica", "Eswatini", "Fiji", "Gabon", "Gambia", "Ghana", "Grenada",
  "Guyana", "India", "Jamaica", "Kenya", "Kiribati", "Lesotho", "Malawi", "Malaysia", "Maldives", "Malta",
  "Mauritius", "Mozambique", "Namibia", "Nauru", "New Zealand", "Nigeria", "Pakistan", "Papua New Guinea",
  "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "Seychelles",
  "Sierra Leone", "Singapore", "Solomon Islands", "South Africa", "Sri Lanka", "Tanzania", "Togo", "Tonga",
  "Trinidad and Tobago", "Tuvalu", "Uganda", "Vanuatu", "Zambia", "Zimbabwe",
]);
const OTHER = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Argentina", "Armenia", "Austria", "Azerbaijan",
  "Bahrain", "Belarus", "Belgium", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Brazil", "Bulgaria",
  "Burkina Faso", "Burundi", "Cambodia", "Cape Verde", "Central African Republic", "Chad", "Chile", "China",
  "Colombia", "Comoros", "Congo", "Congo (Democratic Republic)", "Costa Rica", "Côte d'Ivoire", "Croatia", "Cuba",
  "Czech Republic", "Denmark", "Djibouti", "Dominican Republic", "East Timor", "Ecuador", "Egypt", "El Salvador",
  "Equatorial Guinea", "Eritrea", "Estonia", "Ethiopia", "Finland", "France", "Georgia", "Germany", "Greece",
  "Guatemala", "Guinea", "Guinea-Bissau", "Haiti", "Honduras", "Hong Kong", "Hungary", "Iceland", "Indonesia",
  "Iran", "Iraq", "Israel", "Italy", "Japan", "Jordan", "Kazakhstan", "Kosovo", "Kuwait", "Kyrgyzstan", "Laos",
  "Latvia", "Lebanon", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Macao", "Madagascar",
  "Mali", "Marshall Islands", "Mauritania", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro",
  "Morocco", "Myanmar", "Nepal", "Netherlands", "Nicaragua", "Niger", "North Korea", "North Macedonia", "Norway",
  "Oman", "Palau", "Palestine", "Panama", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar",
  "Romania", "Russia", "San Marino", "São Tomé and Príncipe", "Saudi Arabia", "Senegal", "Serbia", "Slovakia",
  "Slovenia", "Somalia", "South Korea", "South Sudan", "Spain", "Sudan", "Suriname", "Sweden", "Switzerland",
  "Syria", "Taiwan", "Tajikistan", "Thailand", "Tunisia", "Turkey", "Turkmenistan", "Ukraine",
  "United Arab Emirates", "United States", "Uruguay", "Uzbekistan", "Vatican City", "Venezuela", "Vietnam",
  "Yemen", "Stateless or other",
];
const NATIONALITIES = [
  { name: "British", exempt: true },
  { name: "Irish", exempt: true },
  ...[...[...EXEMPT].filter(n => n !== "British" && n !== "Irish"), ...OTHER]
    .sort((a, b) => a.localeCompare(b, "en"))
    .map(name => ({ name, exempt: EXEMPT.has(name) })),
];
const KNOWN = new Set(NATIONALITIES.map(n => n.name));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

async function hmacHex(message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SERVICE_ROLE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function bookingIdFromToken(token: unknown): Promise<string | null> {
  if (typeof token !== "string" || token.length > 120) return null;
  const [id, sig] = token.split(".");
  if (!id || !sig || !UUID_RE.test(id)) return null;
  const expected = (await hmacHex(`guest-register:${id}`)).slice(0, 32);
  return sameString(sig, expected) ? id : null;
}

// Same as guest-review: limits requests per visitor by a keyed hash of
// their IP address, and lets the request through if it can't check.
async function allowRequest(supabase: any, fn: string, req: Request, windowSeconds: number, max: number): Promise<boolean> {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "";
  if (!ip) return true;
  const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(SERVICE_ROLE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(ip)));
  const key = `${fn}:${Array.from(sig.slice(0, 12)).map(b => b.toString(16).padStart(2, "0")).join("")}`;
  const { data, error } = await supabase.rpc("hit_rate_limit", { p_key: key, p_window_seconds: windowSeconds, p_max: max });
  return error ? true : data !== false;
}

function ukToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}
function clean(v: unknown, max: number): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max + 1);
}
function idHint(n: string | null): string {
  if (!n) return "";
  const s = n.replace(/\s+/g, "");
  return s.length <= 4 ? "" : s.slice(-4);
}

const INVALID = "This link isn't valid. Please use the link in the email we sent you, or just reply to that email.";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    if (!(await allowRequest(supabase, "guest-register", req, 600, 40))) {
      return json({ ok: false, error: "Too many attempts. Please wait a few minutes and try again." }, 429);
    }

    const body = await req.json().catch(() => ({}));
    const bookingId = await bookingIdFromToken(body.token);
    if (!bookingId) return json({ ok: false, error: INVALID }, 404);

    const { data: booking } = await supabase
      .from("bookings")
      .select("id, booking_ref, source, status, is_blocked, guest_first_name, guest_last_name, checkin, checkout, guests_count, children_count, guest_register_saved_at")
      .eq("id", bookingId)
      .maybeSingle();
    if (!booking || booking.source !== "direct" || booking.is_blocked) return json({ ok: false, error: INVALID }, 404);
    if (booking.status === "cancelled") return json({ ok: false, error: "This booking has been cancelled, so there's nothing to fill in." }, 410);

    const totalGuests = Math.max(1, Number(booking.guests_count) || 1);
    const adults = Math.max(1, totalGuests - Math.max(0, Number(booking.children_count) || 0));
    const editable = booking.checkout >= ukToday();

    const { data: rows } = await supabase
      .from("guest_register")
      .select("position, full_name, nationality, id_required, id_document_number, id_document_issued_at, next_destination")
      .eq("booking_id", bookingId)
      .order("position");
    const saved = rows || [];

    if (body.action === "get") {
      return json({
        ok: true,
        editable,
        stay: {
          booking_ref: booking.booking_ref || "",
          first_name: booking.guest_first_name || "",
          last_name: booking.guest_last_name || "",
          checkin: booking.checkin,
          checkout: booking.checkout,
          adults,
          total_guests: totalGuests,
        },
        saved_at: booking.guest_register_saved_at,
        nationalities: NATIONALITIES,
        guests: saved.map(r => ({
          full_name: r.full_name,
          nationality: r.nationality,
          id_document_issued_at: r.id_document_issued_at || "",
          next_destination: r.next_destination || "",
          id_number_ends: idHint(r.id_document_number),
        })),
      });
    }

    if (body.action !== "save") return json({ ok: false, error: "Unknown request" }, 400);
    if (!editable) return json({ ok: false, error: "Your stay has ended, so these details can't be changed here. If something's wrong, just reply to any of our emails." }, 410);

    const input = Array.isArray(body.guests) ? body.guests : [];
    if (input.length < adults || input.length > totalGuests) {
      return json({ ok: false, error: adults === totalGuests
        ? `Please fill in details for all ${adults} guest${adults === 1 ? "" : "s"}.`
        : `Please fill in details for every adult (${adults}) and any children aged 16 or 17, up to ${totalGuests} guests in all.` }, 400);
    }

    const guests = [];
    for (let i = 0; i < input.length; i++) {
      const g = input[i] || {};
      const who = `Guest ${i + 1}`;
      const fullName = clean(g.full_name, 100);
      const nationality = clean(g.nationality, 60);
      if (fullName.length < 2 || fullName.length > 100) return json({ ok: false, error: `${who}: please enter their full name.` }, 400);
      if (!KNOWN.has(nationality)) return json({ ok: false, error: `${who}: please choose their nationality from the list.` }, 400);
      const idRequired = !EXEMPT.has(nationality);
      let idNumber = "", issuedAt = "", nextDest = "";
      if (idRequired) {
        idNumber = String(g.id_document_number ?? "").replace(/\s+/g, "").toUpperCase();
        issuedAt = clean(g.id_document_issued_at, 60);
        nextDest = clean(g.next_destination, 200);
        // Blank means "keep the number already saved" for the same person.
        if (!idNumber) {
          const prev = saved[i];
          if (prev && prev.id_document_number && prev.full_name === fullName) idNumber = prev.id_document_number;
        }
        if (!/^[A-Z0-9-]{4,30}$/.test(idNumber)) return json({ ok: false, error: `${who}: please enter their passport or ID card number (letters and numbers only).` }, 400);
        if (issuedAt.length < 2 || issuedAt.length > 60) return json({ ok: false, error: `${who}: please say which country (or office) issued their passport or ID card.` }, 400);
        if (nextDest.length < 2 || nextDest.length > 200) return json({ ok: false, error: `${who}: please say where they're going after Cringley Cottage.` }, 400);
      }
      guests.push({
        full_name: fullName,
        nationality,
        id_required: idRequired,
        id_document_number: idNumber,
        id_document_issued_at: issuedAt,
        next_destination: nextDest,
      });
    }

    const { error } = await supabase.rpc("save_guest_register", { p_booking_id: bookingId, p_guests: guests });
    if (error) return json({ ok: false, error: "Sorry, something went wrong saving your details. Please try again in a minute." }, 500);

    return json({ ok: true, saved_at: new Date().toISOString() });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
