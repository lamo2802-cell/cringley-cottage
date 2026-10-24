import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Deletes an account (staff or owner). Owner-only, verified server-side,
// and the session must have passed 2FA.
// Two safety checks: can't delete yourself, and can't delete the last
// remaining owner account (would lock everyone out of admin permanently).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
    if (callerErr || !callerData?.user || callerData.user.app_metadata?.role !== "owner" || !passedTwoFactor(callerToken)) {
      return new Response(JSON.stringify({ ok: false, error: "Owner only" }), { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ ok: false, error: "user_id required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    if (user_id === callerData.user.id) {
      return new Response(JSON.stringify({ ok: false, error: "You can't delete your own account while signed in as it" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: target } = await adminClient.auth.admin.getUserById(user_id);

    if (target?.user?.app_metadata?.role === "owner") {
      const { data: all } = await adminClient.auth.admin.listUsers({ perPage: 200 });
      const ownerCount = (all?.users || []).filter(u => u.app_metadata?.role === "owner").length;
      if (ownerCount <= 1) {
        return new Response(JSON.stringify({ ok: false, error: "Can't delete the last remaining owner account" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
    }

    const { error } = await adminClient.auth.admin.deleteUser(user_id);
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
