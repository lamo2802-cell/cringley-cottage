import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Backs review.html, the private page linked from the review request email
// (sent by send-guest-messages the day after checkout). The link carries a
// random code; only its SHA-256 hash is stored in review_invites.
//
//   { action: "get", token }     → who the stay was for, and the review if
//                                   one was already sent
//   { action: "submit", token, rating, review_text, display_name,
//     private_note, confirm_genuine, confirm_adult }
//                                → saves the review once, emails the owners
//
// A new review is "pending" for 3 days so the owners can read it, then the
// public site shows it by itself (see the reviews read policy) unless they
// hold it back for a reason the reviews policy allows.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = "Cringley Cottage <hello@cringleycottage.com>";
const SITE_BASE_URL = "https://www.cringleycottage.com/";
const OWNER_EMAILS = ["lamo2802@gmail.com", "rpeacey987@gmail.com"];
const CHECK_WINDOW_DAYS = 3;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
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
  <tr><td style="padding:36px 40px 32px;">${bodyHtml}</td></tr>
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
function quoteBox(label: string, text: string): string {
  return `<p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;letter-spacing:0.5px;text-transform:uppercase;color:#7a6f60;margin:18px 0 6px;">${label}</p>
  <div style="font-family:Georgia,serif;font-size:15px;line-height:1.6;color:#232120;background:#f3f0e8;border-left:3px solid #5e7a52;padding:12px 16px;white-space:pre-wrap;">${escapeHtml(text)}</div>`;
}
function button(text: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px;"><tr><td style="background:#5e7a52;border-radius:3px;">
    <a href="${url}" style="display:inline-block;padding:13px 28px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;letter-spacing:0.5px;text-transform:uppercase;color:#ffffff;text-decoration:none;">${text}</a>
  </td></tr></table>`;
}

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
    function_name: "guest-review", recipient: [to].flat().join(", "), subject, ok, error, booking_id: bookingId ?? null,
  });
  return ok;
}

// Same as create-booking: one request from one visitor, recorded against a
// keyed hash of their IP address. Lets the request through if the limit
// can't be checked.
async function allowRequest(supabase: any, fn: string, req: Request, windowSeconds: number, max: number): Promise<boolean> {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "";
  if (!ip) return true;
  const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(SERVICE_ROLE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(ip)));
  const key = `${fn}:${Array.from(sig.slice(0, 12)).map(b => b.toString(16).padStart(2, "0")).join("")}`;
  const { data, error } = await supabase.rpc("hit_rate_limit", { p_key: key, p_window_seconds: windowSeconds, p_max: max });
  return error ? true : data !== false;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(digest).map(b => b.toString(16).padStart(2, "0")).join("");
}

const INVALID = "This review link isn't valid. Please use the link in the email we sent you, or just reply to that email.";
const EXPIRED = "This review link has expired. If you'd still like to tell us about your stay, just reply to the email we sent you.";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    if (!(await allowRequest(supabase, "guest-review", req, 600, 30))) {
      return json({ ok: false, error: "Too many attempts. Please wait a few minutes and try again." }, 429);
    }

    const body = await req.json().catch(() => ({}));
    const token = String(body.token || "").trim();
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(token)) return json({ ok: false, error: INVALID }, 404);

    const { data: invite } = await supabase
      .from("review_invites")
      .select("booking_id, expires_at, used_at")
      .eq("token_hash", await sha256Hex(token))
      .maybeSingle();
    if (!invite) return json({ ok: false, error: INVALID }, 404);

    const { data: booking } = await supabase
      .from("bookings")
      .select("id, booking_ref, guest_first_name, guest_last_name, guest_email, checkin, checkout")
      .eq("id", invite.booking_id)
      .maybeSingle();
    if (!booking) return json({ ok: false, error: INVALID }, 404);

    const { data: existing } = await supabase
      .from("reviews")
      .select("rating, review_text, guest_name, submitted_at")
      .eq("booking_id", booking.id)
      .maybeSingle();

    const stay = {
      first_name: booking.guest_first_name || "",
      last_initial: (booking.guest_last_name || "").trim().charAt(0).toUpperCase(),
      checkin: booking.checkin,
      checkout: booking.checkout,
    };

    if (body.action === "get") {
      if (existing) return json({ ok: true, stay, submitted: true, review: existing });
      if (invite.used_at || new Date(invite.expires_at) < new Date()) return json({ ok: false, error: EXPIRED }, 410);
      return json({ ok: true, stay, submitted: false });
    }

    if (body.action !== "submit") return json({ ok: false, error: "Unknown request" }, 400);
    if (existing) return json({ ok: false, error: "You've already sent a review for this stay. Thank you!", submitted: true, review: existing }, 409);

    const rating = Number(body.rating);
    const reviewText = String(body.review_text || "").trim();
    const displayName = String(body.display_name || "").trim().replace(/\s+/g, " ");
    const privateNote = String(body.private_note || "").trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json({ ok: false, error: "Please choose a star rating from 1 to 5." }, 400);
    if (reviewText.length < 20 || reviewText.length > 2000) return json({ ok: false, error: "Your review needs to be between 20 and 2,000 characters." }, 400);
    if (displayName.length < 1 || displayName.length > 40) return json({ ok: false, error: "Please enter the name to show with your review (up to 40 characters)." }, 400);
    if (privateNote.length > 2000) return json({ ok: false, error: "The note to the hosts can be up to 2,000 characters." }, 400);
    if (body.confirm_genuine !== true || body.confirm_adult !== true) return json({ ok: false, error: "Please tick both boxes to confirm." }, 400);

    // Use up the link in one statement, so two submits at once can't both
    // get through. The unique booking_id on reviews backs this up.
    const { data: claimed } = await supabase
      .from("review_invites")
      .update({ used_at: new Date().toISOString() })
      .eq("booking_id", booking.id).is("used_at", null).gt("expires_at", new Date().toISOString())
      .select("booking_id");
    if (!claimed || claimed.length === 0) return json({ ok: false, error: EXPIRED }, 410);

    const now = new Date();
    const publishAt = new Date(now.getTime() + CHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const { data: review, error: insertError } = await supabase
      .from("reviews")
      .insert({
        booking_id: booking.id,
        guest_name: displayName,
        source: "direct",
        rating,
        rating_max: 5,
        review_text: reviewText,
        review_date: now.toISOString().slice(0, 10),
        featured: true,
        status: "pending",
        publish_at: publishAt.toISOString(),
        submitted_at: now.toISOString(),
      })
      .select("id")
      .single();
    if (insertError || !review) {
      // Give the link back so the guest can try again.
      await supabase.from("review_invites").update({ used_at: null }).eq("booking_id", booking.id);
      return json({ ok: false, error: "Sorry, something went wrong saving your review. Please try again in a minute." }, 500);
    }
    if (privateNote) {
      await supabase.from("review_private_notes").insert({ review_id: review.id, note: privateNote });
    }

    const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
    await sendEmail(OWNER_EMAILS, `New guest review: ${rating} star${rating === 1 ? "" : "s"}, ${booking.booking_ref || "direct booking"}`, emailShell(
      heading("A guest has left a review") +
      infoBox(
        infoRow("Booking reference", escapeHtml(booking.booking_ref) || "—", true) +
        infoRow("Guest", `${escapeHtml(booking.guest_first_name)} ${escapeHtml(booking.guest_last_name)}`) +
        infoRow("Stay", `${fmtDate(booking.checkin)} – ${fmtDate(booking.checkout)}`) +
        infoRow("Rating", `<span style="color:#5e7a52;">${stars}</span> ${rating}/5`) +
        infoRow("Shown as", escapeHtml(displayName))
      ) +
      quoteBox("Public review", reviewText) +
      (privateNote ? quoteBox("Private note to you (never published)", privateNote) : para("<em>No private note.</em>")) +
      para(`It goes live on the website on <strong>${publishAt.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long" })}</strong>. You can only hold it back for a reason in the reviews policy (fake, abusive or unlawful, identifies another guest or staff, a duplicate, or about another business), not because it's critical.`) +
      button("Open reviews in admin", `${SITE_BASE_URL}admin.html#reviews`)
    ), booking.id);

    return json({ ok: true, submitted: true, review: { rating, review_text: reviewText, guest_name: displayName, submitted_at: now.toISOString() } });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
