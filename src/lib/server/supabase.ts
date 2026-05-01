import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PUBLIC_SUPABASE_URL } from "$env/static/public";
import { SUPABASE_SERVICE_ROLE_KEY } from "$env/static/private";

// Module-scope lazy singleton. Service-role client is stateless across
// requests (`persistSession: false`, no auth state), so memoising it
// avoids per-request `SupabaseClient` allocation churn under load.
// Mirrors the pattern in `email.ts`. See audit issue P2.
let adminClient: SupabaseClient | null = null;

export function createAdminClient(): SupabaseClient {
  if (!adminClient) {
    adminClient = createClient(PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return adminClient;
}
