import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/public";
import { sendWelcomeEmail } from "$lib/server/email";

// Don't trust the request Host header for outbound email links — pull from
// runtime env so a misconfigured proxy can't inject phishing links.
// Use $env/dynamic/public (not static/public) so an unset PUBLIC_SITE_URL
// doesn't fail the build; static/public requires the export to exist at
// build time, which Vercel preview/prod won't have until the env var is
// configured.
const SITE_URL = env.PUBLIC_SITE_URL || "https://librito.io";

export const GET: RequestHandler = async ({ url, locals: { supabase } }) => {
  const code = url.searchParams.get("code");
  if (!code) redirect(303, "/auth/login");

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) redirect(303, "/auth/login?error=link_expired");

  // Check if this is a fresh email confirmation (within last 60s)
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user?.email_confirmed_at && user.email) {
    const confirmedAt = new Date(user.email_confirmed_at).getTime();
    const now = Date.now();
    if (now - confirmedAt < 60_000) {
      // Fire and forget — don't block the redirect
      sendWelcomeEmail(user.email, SITE_URL).catch(() => {});
    }
  }

  redirect(303, "/app");
};
