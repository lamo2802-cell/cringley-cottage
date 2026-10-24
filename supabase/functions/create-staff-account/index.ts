import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Creates an account (staff or another owner) with a given role. Only
// callable by an authenticated owner whose session has passed 2FA —
// verified server-side against the current database state, never trusting
// a client-supplied claim.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_ROLES = ["staff", "owner"];

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
    if (!callerToken) {
      return new Response(JSON.stringify({ ok: false, error: "Not signed in" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${callerToken}` } } });
    const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !callerData?.user || callerData.user.app_metadata?.role !== "owner" || !passedTwoFactor(callerToken)) {
      return new Response(JSON.stringify({ ok: false, error: "Only an owner account can create new accounts" }), { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { email, password, role, display_name } = await req.json();
    if (!email || !password || !role) {
      return new Response(JSON.stringify({ ok: false, error: "Email, password, and role are all required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid role" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }
    if (password.length < 8) {
      return new Response(JSON.stringify({ ok: false, error: "Password must be at least 8 characters" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role },
      user_metadata: { display_name: display_name || null },
    });

    if (createErr) {
      return new Response(JSON.stringify({ ok: false, error: createErr.message }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: true, user_id: created.user?.id, email: created.user?.email }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
