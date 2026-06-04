import { afterAll, describe, expect, it } from "vitest";
import { getAnon, getSql, shutdown } from "./helpers";

// Behavior-level guard for issue #327: every public-schema function with
// no legitimate anon caller must have EXECUTE revoked from anon. Functions
// with no legitimate authenticated caller must also have EXECUTE revoked
// from authenticated.
//
// Why ACL inspection via has_function_privilege() instead of
// `SET LOCAL ROLE anon; SELECT fn()`: the local Supabase Postgres 17.6
// Docker image segfaults on any permission-denied function call from
// anon. Reproducible with a trivial non-SECURITY-DEFINER function. Same
// exemption documented in pg-cron-health.test.ts. The supabase-js anon
// .rpc() check covers the actual HTTP boundary anon hits in production —
// but only for the two functions that PostgREST registers as RPCs.
// Trigger functions are not safe to call from anon over HTTP for the
// same Postgres-17.6 segfault reason; ACL inspection is the load-bearing
// assertion for them.

const SKIP = !process.env.INTEGRATION;

interface Fn {
  name: string;
  args: string;
  // Roles that should NOT have EXECUTE after this migration.
  denyRoles: ("anon" | "authenticated")[];
  // Roles that SHOULD retain EXECUTE.
  allowRoles: ("anon" | "authenticated" | "service_role")[];
  // PostgREST RPC name (slug) to probe via supabase-js as anon. Null for
  // trigger functions that are unsafe to call from anon over HTTP.
  rpcSlug: string | null;
}

const fns: Fn[] = [
  {
    name: "increment_transfer_attempt",
    args: "uuid, int",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: "increment_transfer_attempt",
  },
  {
    name: "devices_prevent_unrevoke",
    args: "",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: null,
  },
  {
    name: "update_updated_at",
    args: "",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: null,
  },
  {
    name: "get_highlight_feed",
    args: "text, jsonb, int, text",
    denyRoles: ["anon"],
    allowRoles: ["authenticated", "service_role"],
    rpcSlug: "get_highlight_feed",
  },
  {
    name: "get_library_with_highlights",
    args: "",
    denyRoles: ["anon"],
    allowRoles: ["authenticated", "service_role"],
    rpcSlug: "get_library_with_highlights",
  },
  {
    name: "ensure_realtime",
    args: "regclass",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: null,
  },
  // Catalog refit RPCs (2026-05-27). All service-role only — no
  // PostgREST-exposed authenticated callers. _field_replay_due is the
  // internal TTL helper consumed by select_replay_candidates; the rest
  // are surface entry points (replay cron + admin route).
  {
    name: "_field_replay_due",
    args: "timestamptz, text",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: null,
  },
  {
    name: "select_replay_candidates",
    args: "integer",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: "select_replay_candidates",
  },
  {
    name: "promote_ta_to_isbn",
    args: "text, text",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: "promote_ta_to_isbn",
  },
  {
    name: "requeue_catalog_resolve",
    args: "uuid, text[]",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: "requeue_catalog_resolve",
  },
  {
    name: "admin_apply_action",
    args: "uuid, uuid, text, jsonb",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: "admin_apply_action",
  },
  {
    name: "profiles_prevent_is_admin_self_update",
    args: "",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: null,
  },
  // catalog-fill-rate cron aggregate (2026-05-27 PR4). Service-role only;
  // admin sparkline reads catalog_fill_rate_history via RLS, not this RPC.
  {
    name: "compute_catalog_fill_rate",
    args: "",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: "compute_catalog_fill_rate",
  },
  // Kobo import highlight upsert (2026-06-04 #497). Service-role only — the
  // import route uses the service-role client; no anon/authenticated caller.
  {
    name: "upsert_kobo_highlights",
    args: "uuid, jsonb",
    denyRoles: ["anon", "authenticated"],
    allowRoles: ["service_role"],
    rpcSlug: "upsert_kobo_highlights",
  },
];

describe.skipIf(SKIP)("public function grants (issue #327)", () => {
  const sql = getSql();

  afterAll(async () => {
    await shutdown();
  });

  for (const fn of fns) {
    const sig = `public.${fn.name}(${fn.args})`;

    describe(sig, () => {
      for (const role of fn.denyRoles) {
        it(`denies EXECUTE to ${role}`, async () => {
          const [row] = await sql<{ has: boolean }[]>`
            SELECT has_function_privilege(
              ${role},
              ${sig},
              'EXECUTE'
            ) AS has
          `;
          expect(row.has).toBe(false);
        });
      }

      for (const role of fn.allowRoles) {
        it(`retains EXECUTE for ${role}`, async () => {
          const [row] = await sql<{ has: boolean }[]>`
            SELECT has_function_privilege(
              ${role},
              ${sig},
              'EXECUTE'
            ) AS has
          `;
          expect(row.has).toBe(true);
        });
      }

      if (fn.rpcSlug && fn.denyRoles.includes("anon")) {
        it("PostgREST denies anon at the HTTP boundary", async () => {
          const { data, error } = await getAnon().rpc(fn.rpcSlug as never);
          expect(data).toBeNull();
          expect(error).not.toBeNull();
        });
      }
    });
  }
});
