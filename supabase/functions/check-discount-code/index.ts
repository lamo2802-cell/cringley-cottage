import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Public: checks whether a discount code is valid right now (active, not
// expired, under its usage cap) and returns the % off — nothing else about
// the code is exposed. The actual booking flow re-validates this exact same
// way server-side before applying it; this endpoint only drives the UI preview.
// Every kind of "no" gets the same message, and each visitor gets a limited
// number of tries, so codes can't be found by guessing.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRIES_PER_VISITOR = 10;
const TRY_WINDOW_SECONDS = 60 * 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
  try {
    const { code } = await req.json();
    if (!code || typeof code !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Enter a code" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    if (!(await allowRequest(supabase, "check-discount-code", req, TRY_WINDOW_SECONDS, TRIES_PER_VISITOR))) {
      return new Response(JSON.stringify({ ok: false, error: "Too many tries. Please wait a while and try again." }), { status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    const { data: row } = await supabase
      .from("discount_codes")
      .select("percent_off, active, max_uses, times_used, expires_at")
      .eq("code", code.trim().toUpperCase())
      .maybeSingle();

    const usable = row && row.active
      && !(row.expires_at && row.expires_at < new Date().toISOString().slice(0, 10))
      && !(row.max_uses !== null && row.times_used >= row.max_uses);
    if (!usable) {
      return new Response(JSON.stringify({ ok: false, error: "That code isn't valid" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: true, percent_off: row.percent_off }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
