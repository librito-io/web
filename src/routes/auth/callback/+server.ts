import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals: { supabase } }) => {
  const code = url.searchParams.get("code");
  if (!code) redirect(303, "/auth/login");

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) redirect(303, "/auth/login?error=link_expired");

  redirect(303, "/app");
};
