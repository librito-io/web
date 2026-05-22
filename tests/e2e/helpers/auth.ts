import type { Page } from "@playwright/test";
import { getAdmin } from "./supabase";

export interface E2EUser {
  id: string;
  email: string;
  password: string;
}

// Create a fresh confirmed user via the admin API. Each test gets its own
// user so flows like rename/unpair don't collide on shared state. Caller is
// responsible for `cleanupUser(user.id)` in `test.afterEach`.
export async function createE2EUser(label: string): Promise<E2EUser> {
  const email = `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@librito.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await getAdmin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(
      `createE2EUser failed: ${error?.message ?? "no user returned"}`,
    );
  }
  return { id: data.user.id, email, password };
}

export async function cleanupUser(id: string): Promise<void> {
  // Cascading FKs (devices, books → highlights → notes) clean up child rows.
  const { error } = await getAdmin().auth.admin.deleteUser(id);
  if (error) throw new Error(`cleanupUser failed: ${error.message}`);
}

// Drive the login form UI so the session cookie lands the same way it would
// for a real user (signInWithPassword + @supabase/ssr cookie persistence in
// hooks.server.ts). Cheaper alternatives (injecting cookies via
// `context.addCookies`) skip the cookie-write codepath we actually care
// about exercising.
export async function login(page: Page, user: E2EUser): Promise<void> {
  await page.goto("/auth/login");
  // Svelte 5 SSR ships the form without the onsubmit handler; a click
  // racing hydration silently no-ops and waitForURL hangs to 30s. Wait
  // for hydration to settle before driving the form.
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/app"));
}
