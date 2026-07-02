import { Resend } from "resend";
import { env as privateEnv } from "$env/dynamic/private";
import welcomeHtml from "../../../supabase/templates/welcome.html?raw";
import { logger } from "$lib/server/log";
import type { ContactReason } from "$lib/server/contact";

// Read at module load (still serverless-cold-start scope), via
// $env/dynamic/private so the value resolves at runtime rather than being
// baked at build time. RESEND_API_KEY is a candidate for Vercel's
// `Sensitive` env type — Sensitive vars are redacted to an empty string by
// `vercel pull` and would otherwise inline as `""` in the prebuilt deploy
// flow (.github/workflows/production-deploy.yml). See CLAUDE.md
// "Vercel Sensitive env vars require $env/dynamic/private".
const RESEND_API_KEY = privateEnv.RESEND_API_KEY;

// One warn at module load; per-call would spam self-host logs.
if (!RESEND_API_KEY) {
  logger().warn(
    {
      event: "email.resend_unconfigured",
      detail:
        "RESEND_API_KEY not set — welcome emails will be silently skipped. Set RESEND_API_KEY in env to enable.",
    },
    "email.resend_unconfigured",
  );
}

let resend: Resend | null = null;

function getClient(): Resend | null {
  if (!RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(RESEND_API_KEY);
  return resend;
}

/** Exposed for testing only */
export const _getResendClient = getClient;

function safeSiteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("scheme");
    }
    return parsed.origin;
  } catch {
    // Malformed siteUrl (invalid URL / non-http(s) scheme) → safe canonical default.
    return "https://librito.io";
  }
}

export async function sendWelcomeEmail(
  email: string,
  siteUrl: string,
): Promise<void> {
  try {
    const client = getClient();
    if (!client) return;

    const html = welcomeHtml.replace(
      /\{\{APP_URL\}\}/g,
      `${safeSiteUrl(siteUrl)}/app`,
    );

    await client.emails.send({
      from: "Librito <noreply@librito.io>",
      to: email,
      subject: "Welcome to Librito",
      html,
    });
  } catch (err) {
    logger().error(
      {
        event: "email.send_welcome_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "email.send_welcome_failed",
    );
  }
}

// Minimal HTML escaper for user-supplied text dropped into an email body.
// The submitter's message is untrusted; escape before interpolating into HTML.
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Reason drives the subject tag (deterministic inbox routing without an LLM)
// and a human-readable body line. Values are the closed set from
// ContactReason; email.ts owns the presentation mapping.
const REASON_META: Record<ContactReason, { tag: string; label: string }> = {
  bug: { tag: "[Bug]", label: "Bug report" },
  feature: { tag: "[Feature]", label: "Feature request" },
  other: { tag: "[General]", label: "Something else" },
};

export async function sendContactEmail(
  name: string,
  fromEmail: string,
  message: string,
  reason: ContactReason,
): Promise<boolean> {
  try {
    const client = getClient();
    if (!client) return false;

    const meta = REASON_META[reason];
    const safeMsg = escapeHtml(message).replace(/\n/g, "<br>");
    // Name lands in the HTML body only (escaped). replyTo stays the bare
    // address — a display name spliced into the header is a header-injection
    // vector. reason is a closed enum, so its tag/label are trusted literals.
    const html =
      `<p><strong>From:</strong> ${escapeHtml(name)} (${escapeHtml(fromEmail)})</p>` +
      `<p><strong>Reason:</strong> ${meta.label}</p>` +
      `<p>${safeMsg}</p>`;

    await client.emails.send({
      from: "Librito <noreply@librito.io>",
      to: "support@librito.io",
      replyTo: fromEmail,
      subject: `${meta.tag} New Librito support message`,
      html,
    });
    return true;
  } catch (err) {
    logger().error(
      {
        event: "email.send_contact_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "email.send_contact_failed",
    );
    return false;
  }
}

export async function sendNewsletterWelcome(email: string): Promise<void> {
  try {
    const client = getClient();
    if (!client) return;

    await client.emails.send({
      from: "Librito <noreply@librito.io>",
      to: email,
      subject: "Thanks for signing up",
      html:
        "<p>Thanks for signing up to the Librito newsletter.</p>" +
        "<p>We'll keep you posted as we get closer to launch.</p>",
    });
  } catch (err) {
    logger().error(
      {
        event: "email.send_newsletter_welcome_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "email.send_newsletter_welcome_failed",
    );
  }
}
