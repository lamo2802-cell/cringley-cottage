import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Records a fire-safety checklist submission from staff-checklist.html.
// Inserts via the service role (mirroring the same rules the RLS policies
// on fire_checks already enforce: an owner can submit for anyone, staff can
// only submit as themselves), and — the reason this exists as an edge
// function rather than a plain REST insert — sends the owners an email
// whenever the changeover staff leave a non-empty "changeover_comments"
// note (e.g. "running low on bin bags"). Nothing noted, no email; this is
// deliberately not tied to the fire-safety pass/fail items, which the owner
// already reviews in admin.html at their own pace.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = "Cringley Cottage <hello@cringleycottage.com>";
const OWNER_EMAILS = ["lamo2802@gmail.com", "rpeacey987@gmail.com"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TYPE_LABELS: Record<string, string> = {
  change_of_occupancy: "Change of occupancy", daily: "Daily", weekly: "Weekly", monthly: "Monthly", six_monthly: "Six-monthly",
};

// Staff-entered free text — escape before it goes into an HTML email to the owners.
function escapeHtml(s: unknown): string {
  return (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
function emailShell(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#e9e3d6;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9e3d6;padding:32px 16px;"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;"><tr><td style="background:#232120;padding:28px 32px;text-align:center;"><div style="display:inline-block;border:1px solid rgba(255,255,255,0.35);border-radius:2px;padding:10px 22px;"><span style="font-family:Georgia,'Times New Roman',serif;font-size:19px;letter-spacing:3px;color:#f3ede3;text-transform:uppercase;">Cringley Cottage</span></div></td></tr><tr><td style="padding:36px 40px 8px;">${bodyHtml}</td></tr><tr><td style="padding:28px 40px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #e5ddd0;padding-top:20px;"><p style="margin:0;font-family:Georgia,serif;font-size:12px;color:#a39a89;">Sent because a changeover comment was left on a fire safety checklist submission.</p></td></tr></table></td></tr></table></td></tr></table></body></html>`;
}
function heading(t: string) { return `<h1 style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#232120;margin:0 0 14px;">${t}</h1>`; }
function para(t: string) { return `<p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.6;color:#4a453d;margin:0 0 14px;">${t}</p>`; }
function infoRow(l: string, v: string, bold = false) {
  const w = bold ? "600" : "400", c = bold ? "#5e7a52" : "#232120";
  return `<tr><td style="padding:6px 0;border-top:1px solid #e5ddd0;color:#7a6f60;font-size:13px;font-family:'Helvetica Neue',Arial,sans-serif;">${l}</td><td style="padding:6px 0;border-top:1px solid #e5ddd0;text-align:right;font-weight:${w};color:${c};font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;">${v}</td></tr>`;
}
function infoBox(rows: string) { return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f0e8;border-radius:4px;margin:4px 0 18px;"><tr><td style="padding:18px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr></table>`; }
async function sendEmail(to: string | string[], subject: string, html: string) {
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
    const callerRole = callerData?.user?.app_metadata?.role;
    if (callerErr || !callerData?.user || (callerRole !== "owner" && callerRole !== "staff")) {
      return new Response(JSON.stringify({ ok: false, error: "Only signed-in staff or owner accounts can submit a checklist" }), { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const { check_date, check_type, inspected_by, items, actions, notes, changeover_comments } = body;

    if (!check_date || !check_type || !inspected_by || !Array.isArray(items)) {
      return new Response(JSON.stringify({ ok: false, error: "Missing required fields" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // Mirrors the staff_insert_fire_checks RLS policy: staff can only ever
    // submit as themselves, regardless of what the client sends.
    const inspectedByUserId = callerRole === "staff" ? callerData.user.id : (body.inspected_by_user_id ?? callerData.user.id);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const trimmedComments = typeof changeover_comments === "string" ? changeover_comments.trim() : "";

    const { data: inserted, error: insertErr } = await supabase
      .from("fire_checks")
      .insert({
        check_date, check_type, inspected_by,
        inspected_by_user_id: inspectedByUserId,
        items,
        actions: Array.isArray(actions) ? actions : [],
        notes: notes || null,
        changeover_comments: trimmedComments || null,
      })
      .select("id")
      .single();

    if (insertErr) {
      return new Response(JSON.stringify({ ok: false, error: insertErr.message }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // Nothing noted, no email — only a non-empty comment triggers this.
    if (trimmedComments) {
      const html = emailShell(
        heading("Changeover comment") +
        para(`A note was left on a fire safety checklist submission.`) +
        infoBox(
          infoRow("Date", fmtDate(check_date), true) +
          infoRow("Check type", escapeHtml(TYPE_LABELS[check_type] || check_type)) +
          infoRow("Submitted by", escapeHtml(inspected_by))
        ) +
        para(`<strong>Comment:</strong><br>${escapeHtml(trimmedComments).replace(/\n/g, "<br>")}`)
      );
      await sendEmail(OWNER_EMAILS, `Changeover comment — ${TYPE_LABELS[check_type] || check_type} (${check_date})`, html);
    }

    return new Response(JSON.stringify({ ok: true, id: inserted.id }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
