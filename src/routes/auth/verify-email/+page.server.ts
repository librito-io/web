import { fail, redirect } from "@sveltejs/kit";
import type { Actions } from "./$types";
import { env } from "$env/dynamic/public";
import { sendWelcomeEmail } from "$lib/server/email";

const SITE_URL = env.PUBLIC_SITE_URL || "https://librito.io";

export const actions: Actions = {
  default: async ({ request, locals: { supabase } }) => {
    const form = await request.formData();
    const email = form.get("email");
    const token = form.get("token");

    if (
      typeof email !== "string" ||
      typeof token !== "string" ||
      !email ||
      !token
    ) {
      return fail(400, { message: "Enter the 6-digit code from your email." });
    }

    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: "signup",
    });

    if (error || !data.user) {
      return fail(400, {
        message: error?.message ?? "That code is invalid or expired.",
      });
    }

    // verifyOtp(type:'signup') success means a brand-new confirmed user — always
    // a fresh signup, so fire the welcome email unconditionally (no 60s heuristic
    // needed here, unlike the OAuth callback). Best-effort; never block redirect.
    sendWelcomeEmail(data.user.email!, SITE_URL).catch(() => {});

    // Session cookies are written by the server client during verifyOtp, so the
    // /app load sees an authenticated session. (Later: onboarding gate intercepts.)
    redirect(303, "/app");
  },
};
