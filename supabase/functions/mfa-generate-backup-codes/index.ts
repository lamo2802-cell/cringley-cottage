import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Lets a signed-in account generate a fresh set of one-time backup codes
// for itself, to use if its authenticator device is ever lost. Generating
// a new set immediately invalidates any codes generated previously. The
// session must have passed 2FA, or a stolen password alone could mint codes
// and use one to get past the authenticator step.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const CODE_COUNT = 8;

function randomCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    if (i === 3) out += "-";
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
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
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const callerToken = authHeader.replace(/^Bearer\s+/i, "");
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${callerToken}` } } });
    const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !callerData?.user) {
      return new Response(JSON.stringify({ ok: false, error: "Not signed in" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    if (!passedTwoFactor(callerToken)) {
      return new Response(JSON.stringify({ ok: false, error: "Enter your authenticator code first" }), { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    const userId = callerData.user.id;

    const codes = Array.from({ length: CODE_COUNT }, randomCode);
    const hashes = await Promise.all(codes.map(sha256Hex));

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    await adminClient.from("mfa_backup_codes").delete().eq("user_id", userId);
    const { error: insertErr } = await adminClient.from("mfa_backup_codes").insert(hashes.map(h => ({ user_id: userId, code_hash: h })));
    if (insertErr) {
      return new Response(JSON.stringify({ ok: false, error: insertErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: true, codes }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
