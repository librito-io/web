import { Resend } from "resend";
import { readFileSync } from "fs";
import { resolve } from "path";

let resend: Resend | null = null;

function getClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  if (!resend) resend = new Resend(apiKey);
  return resend;
}

/** Exposed for testing only */
export const _getResendClient = getClient;

let welcomeTemplate: string | null = null;

function getWelcomeTemplate(): string {
  if (!welcomeTemplate) {
    const templatePath = resolve("supabase/templates/welcome.html");
    welcomeTemplate = readFileSync(templatePath, "utf-8");
  }
  return welcomeTemplate;
}

export async function sendWelcomeEmail(
  email: string,
  siteUrl: string,
): Promise<void> {
  const client = getClient();
  if (!client) {
    console.log("RESEND_API_KEY not set — skipping welcome email");
    return;
  }

  const html = getWelcomeTemplate().replace(
    /\{\{APP_URL\}\}/g,
    `${siteUrl}/app`,
  );

  try {
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
