import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Mirrors tests/integration/helpers.ts: shell out to the Supabase CLI for
// API URL + keys so fresh CI boots get fresh JWTs without hardcoded dev
// secrets. Kept separate from the integration helpers because the e2e suite
// has no `postgres-js` dependency and runs against the running dev server,
// not a direct DB connection.
function loadSupabaseEnv(): {
  apiUrl: string;
  serviceRoleKey: string;
  anonKey: string;
} {
  let out: string;
  try {
    out = execFileSync("supabase", ["status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      "e2e tests require a running local Supabase. Run `supabase start` first.\n" +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  const parsed = new Map<string, string>();
  for (const line of out.split("\n")) {
    // Quote chars are optional; value may be empty. Accept both shapes so a
    // future Supabase CLI format tweak (or an empty FOO="") parses cleanly
    // rather than silently dropping the line and surfacing as a missing-key
    // error downstream.
    const match = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (match) parsed.set(match[1], match[2]);
  }

  const apiUrl = parsed.get("API_URL");
  const serviceRoleKey = parsed.get("SERVICE_ROLE_KEY");
  const anonKey = parsed.get("ANON_KEY");
  if (!apiUrl || !serviceRoleKey || !anonKey) {
    throw new Error(
      "supabase status did not return API_URL / SERVICE_ROLE_KEY / ANON_KEY",
    );
  }
  return { apiUrl, serviceRoleKey, anonKey };
}

let cachedEnv: ReturnType<typeof loadSupabaseEnv> | null = null;
function supabaseEnv(): ReturnType<typeof loadSupabaseEnv> {
  if (!cachedEnv) cachedEnv = loadSupabaseEnv();
  return cachedEnv;
}

let cachedAdmin: SupabaseClient | null = null;
export function getAdmin(): SupabaseClient {
  if (!cachedAdmin) {
    const { apiUrl, serviceRoleKey } = supabaseEnv();
    cachedAdmin = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cachedAdmin;
}
