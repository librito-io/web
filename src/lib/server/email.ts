import { Resend } from "resend";
import { RESEND_API_KEY } from "$env/static/private";
import welcomeHtml from "../../../supabase/templates/welcome.html?raw";

// One-shot warning at module load when RESEND_API_KEY is absent. The
// per-signup log-and-skip pattern this replaces produced spurious noise
// on self-host installs that intentionally ran without Resend; operators
// reading their startup log get one clear signal here instead.
if (!RESEND_API_KEY) {
  console.warn(
    "email.resend_unconfigured: RESEND_API_KEY not set — welcome emails will be silently skipped. " +
      "Set RESEND_API_KEY in env to enable.",
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

export async function sendWelcomeEmail(
  email: string,
  siteUrl: string,
): Promise<void> {
  try {
    const client = getClient();
    if (!client) return;

    const html = welcomeHtml.replace(/\{\{APP_URL\}\}/g, `${siteUrl}/app`);

    await client.emails.send({
      from: "Librito <noreply@librito.io>",
      to: email,
      subject: "Welcome to Librito",
      html,
    });
  } catch (err) {
    console.error("Failed to send welcome email:", err);
  }
}
