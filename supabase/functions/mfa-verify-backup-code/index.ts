import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Redeems a one-time backup code in place of a TOTP code, for an account
// that has 2FA enabled but has lost its authenticator device. The caller
// must already hold a valid session from password login (their identity
// is taken from that token, never from client-supplied input).
//
// A backup code can't raise the session to aal2 (only Supabase's own
// authenticator check can), so instead it removes the lost authenticator
// and the remaining codes. The account is then a password-only account,
// and admin.html makes the owner set up 2FA on their new device before it
// shows anything else.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
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
    const userId = callerData.user.id;

    const { code } = await req.json();
    if (!code || typeof code !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Code required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    const normalized = code.trim().toUpperCase();
    const hash = await sha256Hex(normalized);

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: match } = await adminClient
      .from("mfa_backup_codes")
      .select("id")
      .eq("user_id", userId)
      .eq("code_hash", hash)
      .is("used_at", null)
      .maybeSingle();

    if (!match) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid or already-used backup code" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // Spend the code first, and only if nobody else just did, so the same
    // code can't be used twice at once.
    const { data: spent } = await adminClient
      .from("mfa_backup_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("id", match.id)
      .is("used_at", null)
      .select("id");
    if (!spent || spent.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid or already-used backup code" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { data: factorList, error: listErr } = await adminClient.auth.admin.mfa.listFactors({ userId });
    if (listErr) {
      return new Response(JSON.stringify({ ok: false, error: listErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    for (const f of factorList?.factors || []) {
      const { error: delErr } = await adminClient.auth.admin.mfa.deleteFactor({ id: f.id, userId });
      if (delErr) {
        return new Response(JSON.stringify({ ok: false, error: delErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
    }
    await adminClient.from("mfa_backup_codes").delete().eq("user_id", userId);

    return new Response(JSON.stringify({ ok: true, reenroll: true }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
