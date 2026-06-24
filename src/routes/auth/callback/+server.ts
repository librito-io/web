import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/public";
import { sendWelcomeEmail } from "$lib/server/email";
import { resolveReturnTo } from "$lib/auth/return-to";

// Outbound email links: pull origin from runtime env, never the request Host.
const SITE_URL = env.PUBLIC_SITE_URL || "https://librito.io";

// Map GoTrue provider-error values to friendly ?error= reasons the login page
// renders. The signups-disabled literal is the one most likely to drift across
// gotrue versions — confirm empirically (plan Task 10 / spec verification #3).
function friendlyError(error: string, description: string | null): string {
  if (error === "access_denied") return "cancelled";
  if (
    /signup|sign-?ups?\s+not\s+allowed/i.test(description ?? "") ||
    error === "signup_disabled"
  ) {
    return "signup_disabled";
  }
  return "oauth_failed";
}

export const GET: RequestHandler = async ({ url, locals: { supabase } }) => {
  // Provider-error branch (user cancel, signups disabled) comes back as
  // ?error=...&error_description=... rather than ?code=...
  const providerError = url.searchParams.get("error");
  if (providerError) {
    const reason = friendlyError(
      providerError,
      url.searchParams.get("error_description"),
    );
    redirect(303, `/auth/login?error=${reason}`);
  }

  const code = url.searchParams.get("code");
  if (!code) redirect(303, "/auth/login");

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) redirect(303, "/auth/login?error=link_expired");

  // Welcome email for fresh OAuth users only (email signups now welcome via the
  // verify-email action). 60s window: new OAuth users have email_confirmed_at ≈
  // now; returning users have an old timestamp.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user?.email_confirmed_at && user.email) {
    const confirmedAt = new Date(user.email_confirmed_at).getTime();
    if (Date.now() - confirmedAt < 60_000) {
      sendWelcomeEmail(user.email, SITE_URL).catch(() => {});
    }
  }

  // Validate the user-controllable return_to against the /app-only allow-list.
  redirect(303, resolveReturnTo(url.searchParams.get("return_to")));
};
