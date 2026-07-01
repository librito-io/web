import type { RequestHandler } from "./$types";
import { createAdminClient } from "$lib/server/supabase";
import { newsletterLimiter, enforceRateLimit } from "$lib/server/ratelimit";
import {
  processNewsletterSignup,
  normalizeEmail,
  isValidEmail,
} from "$lib/server/newsletter";
import { sendNewsletterWelcome } from "$lib/server/email";
import { jsonError, jsonSuccess } from "$lib/server/errors";
import { logger } from "$lib/server/log";

// Public newsletter signup from the site footer. No Bearer auth (auth is
// per-route in this app; this is a browser-facing endpoint). Defense: honeypot
// + fail-CLOSED per-IP limiter. Email is stored via the service-role admin
// client (the table denies anon/authenticated at the RLS boundary).
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  let body: { email?: unknown; locale?: unknown; company?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request", "Body must be JSON");
  }

  // Honeypot: a real user never sees/fills `company`. Bots do. Return success
  // without doing any work so the bot cannot distinguish a drop from a save.
  if (typeof body.company === "string" && body.company.trim() !== "") {
    return jsonSuccess({ subscribed: true });
  }

  if (typeof body.email !== "string") {
    return jsonError(400, "invalid_email", "A valid email is required");
  }
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) {
    return jsonError(400, "invalid_email", "A valid email is required");
  }

  const limited = await enforceRateLimit(
    newsletterLimiter,
    getClientAddress(),
    "Too many signups. Please try again later.",
  );
  if (limited) return limited;

  const locale =
    typeof body.locale === "string" ? body.locale.slice(0, 8) : null;

  try {
    const supabase = createAdminClient();
    const { fresh } = await processNewsletterSignup(supabase, email, locale);
    if (fresh) {
      // Fire-and-forget; a mail hiccup must not fail the signup.
      sendNewsletterWelcome(email).catch(() => {});
    }
    return jsonSuccess({ subscribed: true });
  } catch (err) {
    logger().error(
      {
        event: "newsletter.signup_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "newsletter.signup_failed",
    );
    return jsonError(500, "signup_failed", "Could not save your signup");
  }
};
