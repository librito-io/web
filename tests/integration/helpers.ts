import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";

// Resolve local Supabase connection info at module init. Works both locally
// and in CI (where `supabase start` has already run) by shelling out to the
// CLI rather than baking in dev keys — fresh CI boots get fresh JWTs.
//
// execFileSync (not execSync) keeps the call shell-free; the argv is a
// fixed literal so there is no injection surface, but the discipline holds
// for future edits.
function loadSupabaseEnv(): {
  dbUrl: string;
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
      "Integration tests require a running local Supabase. Run `supabase start` first.\n" +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  const parsed = new Map<string, string>();
  for (const line of out.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)="(.+)"$/);
    if (match) parsed.set(match[1], match[2]);
  }

  const dbUrl = parsed.get("DB_URL");
  const apiUrl = parsed.get("API_URL");
  const serviceRoleKey = parsed.get("SERVICE_ROLE_KEY");
  const anonKey = parsed.get("ANON_KEY");
  if (!dbUrl || !apiUrl || !serviceRoleKey || !anonKey) {
    throw new Error(
      "supabase status did not return DB_URL / API_URL / SERVICE_ROLE_KEY / ANON_KEY",
    );
  }
  return { dbUrl, apiUrl, serviceRoleKey, anonKey };
}

let cachedEnv: ReturnType<typeof loadSupabaseEnv> | null = null;
function env() {
  if (!cachedEnv) cachedEnv = loadSupabaseEnv();
  return cachedEnv;
}

let cachedSql: ReturnType<typeof postgres> | null = null;
export function getSql() {
  if (!cachedSql) {
    cachedSql = postgres(env().dbUrl, {
      // Disable prepared-statement cache so a mid-suite `supabase db reset`
      // never leaves us holding a reference to a dropped statement plan.
      prepare: false,
      max: 4,
    });
  }
  return cachedSql;
}

let cachedAdmin: SupabaseClient | null = null;
export function getAdmin(): SupabaseClient {
  if (!cachedAdmin) {
    const { apiUrl, serviceRoleKey } = env();
    cachedAdmin = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cachedAdmin;
}

let cachedAnon: SupabaseClient | null = null;
export function getAnon(): SupabaseClient {
  if (!cachedAnon) {
    const { apiUrl, anonKey } = env();
    cachedAnon = createClient(apiUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cachedAnon;
}

export async function shutdown() {
  if (cachedSql) {
    await cachedSql.end({ timeout: 5 });
    cachedSql = null;
  }
}

export interface TestUser {
  id: string;
  email: string;
}

export async function createTestUser(label: string): Promise<TestUser> {
  const email = `it-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@librito.test`;
  const { data, error } = await getAdmin().auth.admin.createUser({
    email,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(
      `createTestUser failed: ${error?.message ?? "no user returned"}`,
    );
  }
  return { id: data.user.id, email };
}

export async function deleteTestUser(id: string): Promise<void> {
  // Cascading FKs (books → highlights → notes) clean up child rows.
  const { error } = await getAdmin().auth.admin.deleteUser(id);
  if (error) {
    throw new Error(`deleteTestUser failed: ${error.message}`);
  }
}
