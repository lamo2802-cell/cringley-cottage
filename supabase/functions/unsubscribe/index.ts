import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Turns off offer emails for one guest. Reached two ways:
//   - the "Unsubscribe" link in an offer email, which opens
//     unsubscribe.html on the site and that page posts here with the token
//   - one-click unsubscribe from Gmail/Apple Mail etc., which post straight
//     to the List-Unsubscribe URL (?t=...) with "List-Unsubscribe=One-Click"
//
// The token is the guest's email plus an HMAC of it (made in
// send-marketing-offer with the same key), so nobody can unsubscribe
// someone else by guessing. It only ever sets marketing_consent to false,
// on every booking under that email.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
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

// Returns the email the token is for, or null if it isn't one we made.
async function emailFromToken(token: unknown): Promise<string | null> {
  if (typeof token !== "string" || token.length > 600) return null;
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) return null;
  let email: string;
  try { email = b64urlDecode(encoded).trim().toLowerCase(); } catch { return null; }
  if (!email.includes("@")) return null;
  const expected = (await hmacHex(`unsubscribe:${email}`)).slice(0, 32);
  return sameString(sig, expected) ? email : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  // GET does nothing on purpose: mail scanners open links to check them,
  // and that must never unsubscribe anyone.
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const url = new URL(req.url);
    let token: unknown = url.searchParams.get("t");
    if (!token) {
      const type = req.headers.get("content-type") || "";
      if (type.includes("application/json")) {
        token = (await req.json().catch(() => ({})))?.t;
      }
    }

    const email = await emailFromToken(token);
    if (!email) return json({ ok: false, error: "That unsubscribe link isn't valid. Reply to any of our emails and we'll remove you by hand." }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: rows, error } = await supabase
      .from("bookings").select("id, guest_email").eq("marketing_consent", true).not("guest_email", "is", null);
    if (error) return json({ ok: false, error: "Something went wrong. Please try again." }, 500);

    const ids = (rows || []).filter(r => (r.guest_email || "").trim().toLowerCase() === email).map(r => r.id);
    if (ids.length > 0) {
      const { error: updErr } = await supabase.from("bookings").update({ marketing_consent: false }).in("id", ids);
      if (updErr) return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
    }
    // Same answer whether or not they were still subscribed.
    return json({ ok: true });
  } catch {
    return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
});
