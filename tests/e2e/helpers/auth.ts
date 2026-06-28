import type { Page } from "@playwright/test";
import { getAdmin } from "./supabase";
import { awaitHydration } from "./hydrate";

export interface E2EUser {
  id: string;
  email: string;
  password: string;
}

export interface CreateE2EUserOpts {
  /**
   * When true, the helper sets `profiles.is_admin = true` after creating
   * the user — single place to mutate so future hardening (e.g., audit-row
   * write on grant) lands here instead of being inlined across every admin
   * spec. The profile row is created by the `handle_new_user` trigger on
   * auth.users INSERT, so the UPDATE always finds the row.
   */
  isAdmin?: boolean;
}

// Create a fresh confirmed user via the admin API. Each test gets its own
// user so flows like rename/unpair don't collide on shared state. Caller is
// responsible for `cleanupUser(user.id)` in `test.afterEach`.
export async function createE2EUser(
  label: string,
  opts: CreateE2EUserOpts = {},
): Promise<E2EUser> {
  const email = `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@librito.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const admin = getAdmin();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(
      `createE2EUser failed: ${error?.message ?? "no user returned"}`,
    );
  }
  if (opts.isAdmin) {
    const { error: grantErr } = await admin
      .from("profiles")
      .update({ is_admin: true })
      .eq("id", data.user.id);
    if (grantErr) {
      throw new Error(`createE2EUser isAdmin grant: ${grantErr.message}`);
    }
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
  await awaitHydration(page);
  await page.getByLabel("Username or email").fill(user.email);
  // exact: true so the match is the password input only — the reveal-toggle
  // button's aria-label ("Show password") is also a getByLabel candidate.
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: /log in/i }).click();

  // Race URL transition against the inline form error. On a real auth failure
  // (wrong password, locked account) the redesigned login page renders
  // `<p class="auth-error" role="alert">{error}</p>` and never navigates —
  // without this race the helper hangs to `waitForURL`'s 30s default and fails
  // with a generic timeout, hiding the actual auth-error text. Issue #363.
  // (Pre-redesign this matched `p[style*="color: red"]`; the login OAuth/card
  // redesign moved errors to `.auth-error` — keep this locator in sync with
  // login/+page.svelte's error markup.)
  const errorLocator = page.locator("p.auth-error").first();
  const navigation = page
    .waitForURL((url) => url.pathname.startsWith("/app"))
    .then(() => "navigated" as const);
  const failure = errorLocator
    .waitFor({ state: "visible" })
    .then(() => "failed" as const);

  const outcome = await Promise.race([navigation, failure]);
  if (outcome === "failed") {
    const message = (await errorLocator.textContent())?.trim() ?? "";
    throw new Error(`login failed: ${message}`);
  }
}
