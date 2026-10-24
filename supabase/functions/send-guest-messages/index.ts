import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Runs every ~15 minutes (pg_cron). Sends a check-in-day email (with the
// owner's editable access instructions — key safe code etc.) at the
// admin-configured UK time, and a check-out-eve reminder email (turn off
// lights/radiators, secure windows, return key) at another admin-configured
// UK time, the day before checkout. Each is sent exactly once per booking
// (checkin_email_sent_at / checkout_email_sent_at guard against repeats).
// Only ever emails direct bookings with a guest email on file — Airbnb and
// Booking.com bookings arrive via iCal with no guest contact info, so they
// are naturally excluded.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SYNC_SECRET = Deno.env.get("SYNC_SECRET");
const FROM_EMAIL = "Cringley Cottage <hello@cringleycottage.com>";
const SITE_BASE_URL = "https://www.cringleycottage.com/";

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
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
function escapeHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// Renders the owner's plain-text admin copy as paragraphs/bullets, preserving
// blank-line breaks and turning "- " lines into a simple bullet list.
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

function ukNow(): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  let hour = parts.hour === "24" ? "00" : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
    const { date: todayUK, time: nowUK } = ukNow();
    const tomorrowUK = addDays(todayUK, 1);

    const { data: settings } = await supabase
      .from("site_settings")
      .select("checkin_email_time, checkout_email_time, checkin_email_text, checkout_email_text")
      .eq("id", 1)
      .maybeSingle();

    const checkinTime = (settings?.checkin_email_time || "08:00:00").slice(0, 5);
    const checkoutTime = (settings?.checkout_email_time || "10:00:00").slice(0, 5);
    const checkinText = settings?.checkin_email_text || "";
    const checkoutText = settings?.checkout_email_text || "";

    let checkinSent = 0, checkoutSent = 0;

    if (nowUK >= checkinTime) {
      const { data: arriving } = await supabase
        .from("bookings")
        .select("id, booking_ref, guest_first_name, guest_email, checkin, checkout")
        .eq("source", "direct").eq("is_blocked", false).eq("status", "confirmed")
        .eq("checkin", todayUK).is("checkin_email_sent_at", null)
        .not("guest_email", "is", null);

      for (const b of arriving || []) {
        const html = emailShell(
          heading("You're checking in today!") +
          para(`Dear ${escapeHtml(b.guest_first_name) || "there"},`) +
          infoBox(
            infoRow("Booking reference", b.booking_ref || "—", true) +
            infoRow("Check-in", fmtDate(b.checkin))
          ) +
          freeTextToHtml(checkinText) +
          button("View guest information", `${SITE_BASE_URL}guest-info.html`)
        );
        await sendEmail(b.guest_email, `Check-in Today — Cringley Cottage`, html);
        await supabase.from("bookings").update({ checkin_email_sent_at: new Date().toISOString() }).eq("id", b.id);
        checkinSent++;
      }
    }

    if (nowUK >= checkoutTime) {
      const { data: leaving } = await supabase
        .from("bookings")
        .select("id, booking_ref, guest_first_name, guest_email, checkin, checkout")
        .eq("source", "direct").eq("is_blocked", false).eq("status", "confirmed")
        .eq("checkout", tomorrowUK).is("checkout_email_sent_at", null)
        .not("guest_email", "is", null);

      for (const b of leaving || []) {
        const html = emailShell(
          heading("Checking out tomorrow") +
          para(`Dear ${escapeHtml(b.guest_first_name) || "there"},`) +
          infoBox(
            infoRow("Booking reference", b.booking_ref || "—", true) +
            infoRow("Check-out", fmtDate(b.checkout))
          ) +
          freeTextToHtml(checkoutText)
        );
        await sendEmail(b.guest_email, `Checking Out Tomorrow — Cringley Cottage`, html);
        await supabase.from("bookings").update({ checkout_email_sent_at: new Date().toISOString() }).eq("id", b.id);
        checkoutSent++;
      }
    }

    return new Response(JSON.stringify({ ok: true, checkinSent, checkoutSent, todayUK, nowUK }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
