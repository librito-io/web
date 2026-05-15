import { Resend } from "resend";
import { RESEND_API_KEY } from "$env/static/private";
import welcomeHtml from "../../../supabase/templates/welcome.html?raw";
import { logger } from "$lib/server/log";

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
