import { Resend } from "resend";
// @ts-ignore — Vite ?raw import, not recognized by tsc
import welcomeHtml from "../../../supabase/templates/welcome.html?raw";

let resend: Resend | null = null;

function getClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  if (!resend) resend = new Resend(apiKey);
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
    if (!client) {
      console.log("RESEND_API_KEY not set — skipping welcome email");
      return;
    }

    const html = (welcomeHtml as string).replace(
      /\{\{APP_URL\}\}/g,
      `${siteUrl}/app`,
    );

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
