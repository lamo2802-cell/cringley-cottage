import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Runs daily (pg_cron). Emails a branded balance-due reminder to any
// confirmed booking with an unpaid balance due within REMINDER_WINDOW_DAYS,
// exactly once per booking (balance_reminder_sent_at guards against repeats),
// then emails the owners a list of any balances already overdue.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SYNC_SECRET = Deno.env.get("SYNC_SECRET");
const REMINDER_WINDOW_DAYS = 7;
const FROM_EMAIL = "Cringley Cottage <hello@cringleycottage.com>";
const SITE_BASE_URL = "https://www.cringleycottage.com/";
const OWNER_EMAILS = ["lamo2802@gmail.com", "rpeacey987@gmail.com"];

function money(n: number): string { return "£" + Number(n).toFixed(2).replace(/\.00$/, ""); }
function fmtDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
// Guest-supplied first name reaches this file from the booking record — escape
// it before it goes into the HTML email, same as every other guest-facing send.
function escapeHtml(s: unknown): string {
  return (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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
      <p style="margin:0;font-family:Georgia,serif;font-size:12px;color:#a39a89;">Questions? Just reply to this email &mdash; we read every message.</p>
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
function infoRow(label: string, value: string, bold = false): string {
  const weight = bold ? "600" : "400";
  const color = bold ? "#5e7a52" : "#232120";
  return `<tr>
    <td style="padding:6px 0;border-top:1px solid #e5ddd0;color:#7a6f60;font-size:13px;font-family:'Helvetica Neue',Arial,sans-serif;">${label}</td>
    <td style="padding:6px 0;border-top:1px solid #e5ddd0;text-align:right;font-weight:${weight};color:${color};font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;">${value}</td>
  </tr>`;
}
function infoBox(rows: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f0e8;border-radius:4px;margin:4px 0 18px;">
    <tr><td style="padding:18px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
  </table>`;
}
function button(text: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px;"><tr><td style="background:#5e7a52;border-radius:3px;">
    <a href="${url}" style="display:inline-block;padding:13px 28px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;letter-spacing:0.5px;text-transform:uppercase;color:#ffffff;text-decoration:none;">${text}</a>
  </td></tr></table>`;
}

// Email failures used to vanish silently. Each send is now recorded in
// email_log (admin shows the failures), and the result is returned so the
// caller can react. Never throws.
const emailLogDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
async function sendEmail(to: string | string[], subject: string, html: string, bookingId?: string): Promise<boolean> {
  let ok = false;
  let error: string | null = null;
  if (!RESEND_API_KEY) {
    error = "RESEND_API_KEY not set";
  } else {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
      });
      ok = res.ok;
      if (!ok) error = `Resend ${res.status}: ${(await res.text()).slice(0, 500)}`;
    } catch (e) {
      error = String(e);
    }
  }
  await emailLogDb.from("email_log").insert({
    function_name: "send-balance-reminders", recipient: [to].flat().join(", "), subject, ok, error, booking_id: bookingId ?? null,
  });
  return ok;
}

Deno.serve(async (req: Request) => {
  if (SYNC_SECRET) {
    const provided = req.headers.get("x-sync-secret");
    if (provided !== SYNC_SECRET) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const windowEnd = new Date();
    windowEnd.setDate(windowEnd.getDate() + REMINDER_WINDOW_DAYS);
    const windowEndStr = windowEnd.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    const { data: due, error } = await supabase
      .from("bookings")
      .select("*")
      .eq("status", "confirmed")
      .not("balance_due_date", "is", null)
      .lte("balance_due_date", windowEndStr)
      .gte("balance_due_date", today)
      .is("balance_reminder_sent_at", null);

    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    let sent = 0;
    for (const booking of due || []) {
      const outstanding = Math.max(0, Math.round(((booking.total_amount || 0) - (booking.amount_paid || 0)) * 100) / 100);
      if (outstanding <= 0 || !booking.guest_email) continue;

      const manageUrl = `${SITE_BASE_URL}pay-balance.html`;
      const html = emailShell(
        heading("Balance due soon") +
        para(`Dear ${escapeHtml(booking.guest_first_name) || "there"},`) +
        para("Just a friendly reminder — the balance for your upcoming stay at Cringley Cottage is due soon.") +
        infoBox(
          infoRow("Booking reference", booking.booking_ref, true) +
          infoRow("Dates", `${fmtDate(booking.checkin)} &rarr; ${fmtDate(booking.checkout)}`) +
          infoRow("Balance due", `${money(outstanding)} by ${fmtDate(booking.balance_due_date)}`, true)
        ) +
        para("You can pay any time before then using your booking reference and email.") +
        para("We look forward to welcoming you!") +
        button("Pay your balance", manageUrl)
      );

      await sendEmail(booking.guest_email, `Balance Due Soon — ${booking.booking_ref}`, html, booking.id);
      await supabase.from("bookings").update({ balance_reminder_sent_at: new Date().toISOString() }).eq("id", booking.id);
      sent++;
    }

    // Daily nudge to the owners for any balance that's past its due date and
    // still unpaid, while the stay is still to come. Nothing is cancelled
    // automatically; that stays the owners' call.
    const { data: overdue, error: overdueErr } = await supabase
      .from("bookings")
      .select("id, booking_ref, guest_first_name, guest_last_name, guest_email, guest_phone, checkin, balance_due_date, total_amount, amount_paid")
      .eq("status", "confirmed")
      .not("balance_due_date", "is", null)
      .lt("balance_due_date", today)
      .gte("checkin", today)
      .order("checkin");
    if (overdueErr) {
      return new Response(JSON.stringify({ ok: false, sent, error: overdueErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    const overdueRows = (overdue || [])
      .map(b => ({ ...b, outstanding: Math.max(0, Math.round(((b.total_amount || 0) - (b.amount_paid || 0)) * 100) / 100) }))
      .filter(b => b.outstanding > 0);
    if (overdueRows.length > 0) {
      const rows = overdueRows.map(b => infoRow(
        `${escapeHtml(b.booking_ref)} · ${escapeHtml(b.guest_first_name)} ${escapeHtml(b.guest_last_name)}<br><span style="font-size:12px;">${escapeHtml(b.guest_email)} · ${escapeHtml(b.guest_phone)}</span>`,
        `${money(b.outstanding)}<br><span style="font-size:12px;font-weight:400;">due ${fmtDate(b.balance_due_date)}, arrives ${fmtDate(b.checkin)}</span>`,
        true,
      )).join("");
      await sendEmail(OWNER_EMAILS, `Overdue balance${overdueRows.length === 1 ? "" : "s"}: ${overdueRows.length} booking${overdueRows.length === 1 ? "" : "s"}`, emailShell(
        heading("Balances overdue") +
        para("These bookings are past their balance due date and still unpaid. The key-safe code won't be sent until they're paid in full.") +
        infoBox(rows)
      ));
    }

    return new Response(JSON.stringify({ ok: true, sent, overdue: overdueRows.length }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
