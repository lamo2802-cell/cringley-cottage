import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Sends a one-off marketing/offer email to every guest who has opted in
// (marketing_consent = true on a confirmed, non-blocked direct booking with
// an email on file). Owner-only — verified server-side against the current
// database state, never trusting a client-supplied claim.
//
// Privacy: each email is sent individually (one Resend call per recipient,
// "to" always a single address) so recipients never see each other's
// contact details — no shared "to"/"cc" list.
//
// dry_run: true returns the recipient count only, with nothing sent — the
// admin UI uses this to show a confirmation ("this will go to N people")
// before the real send.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = "Cringley Cottage <hello@cringleycottage.com>";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function emailShell(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;background:#e9e3d6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9e3d6;padding:32px 16px;"><tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;">
  <tr><td style="background:#232120;padding:28px 32px;text-align:center;">
    <div style="display:inline-block;border:1px solid rgba(255,255,255,0.35);border-radius:2px;padding:10px 22px;">
      <span style="font-family:Georgia,'Times New Roman',serif;font-size:19px;letter-spacing:3px;color:#f3ede3;text-transform:uppercase;">Cringley Cottage</span>
    </div>
  </td></tr>
  <tr><td style="padding:36px 40px 8px;">${bodyHtml}</td></tr>
  <tr><td style="padding:28px 40px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #e5ddd0;padding-top:20px;">
      <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:13px;color:#7a6f60;">Cringley Cottage &middot; Askrigg &middot; Yorkshire Dales &middot; <a href="https://www.cringleycottage.com/" style="color:#5e7a52;text-decoration:underline;">www.cringleycottage.com</a></p>
      <p style="margin:0;font-family:Georgia,serif;font-size:12px;color:#a39a89;">You're receiving this because you opted in when booking with us. Reply "unsubscribe" any time and we'll remove you.</p>
    </td></tr></table>
  </td></tr>
  </table></td></tr></table></body></html>`;
}
function heading(text: string): string {
  return `<h1 style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#232120;margin:0 0 14px;">${text}</h1>`;
}
function para(text: string): string {
  return `<p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.6;color:#4a453d;margin:0 0 14px;">${text}</p>`;
}
function escapeHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function freeTextToHtml(text: string): string {
  const blocks = (text || "").split(/\n\s*\n/);
  return blocks.map(block => {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every(l => l.startsWith("- "))) {
      const items = lines.map(l => `<li style="margin:0 0 6px;">${escapeHtml(l.slice(2))}</li>`).join("");
      return `<ul style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.6;color:#4a453d;margin:0 0 14px;padding-left:22px;">${items}</ul>`;
    }
    return para(lines.map(escapeHtml).join("<br>"));
  }).join("");
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
  } catch { /* best-effort */ }
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
    if (callerErr || !callerData?.user || callerData.user.app_metadata?.role !== "owner") {
      return new Response(JSON.stringify({ ok: false, error: "Only an owner account can send offers" }), { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const { subject, body, dry_run } = await req.json();
    if (!subject || typeof subject !== "string" || !body || typeof body !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Subject and body are both required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: rows, error: qErr } = await supabase
      .from("bookings")
      .select("guest_first_name, guest_email")
      .eq("marketing_consent", true).eq("status", "confirmed").eq("is_blocked", false)
      .not("guest_email", "is", null);
    if (qErr) return new Response(JSON.stringify({ ok: false, error: qErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

    // De-dupe by email — a guest may have booked more than once.
    const byEmail = new Map<string, { first_name: string; email: string }>();
    for (const r of rows || []) {
      if (!r.guest_email) continue;
      byEmail.set(r.guest_email.toLowerCase(), { first_name: r.guest_first_name || "there", email: r.guest_email });
    }
    const recipients = Array.from(byEmail.values());

    if (dry_run) {
      return new Response(JSON.stringify({ ok: true, recipient_count: recipients.length }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // Send one at a time, one recipient per email — never a shared to/cc list,
    // so no recipient ever sees another's contact details.
    let sent = 0;
    for (const r of recipients) {
      const html = emailShell(
        heading(subject) +
        para(`Dear ${escapeHtml(r.first_name)},`) +
        freeTextToHtml(body)
      );
      await sendEmail(r.email, subject, html);
      sent++;
    }

    await supabase.from("marketing_sends").insert({
      subject, body, recipient_count: sent, sent_by: callerData.user.id,
    });

    return new Response(JSON.stringify({ ok: true, sent }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
