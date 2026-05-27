import { describe, it, expect, afterAll } from "vitest";
import { getSql, shutdown } from "../helpers";

const NEW_RPCS = [
  "public.admin_apply_action(uuid,uuid,text,jsonb)",
  "public.promote_ta_to_isbn(text,text)",
  "public.requeue_catalog_resolve(uuid,text[])",
  "public.select_replay_candidates(int)",
  "public._field_replay_due(timestamptz,text)",
];

describe.skipIf(!process.env.INTEGRATION)(
  "catalog refit rpc EXECUTE grants",
  () => {
    afterAll(async () => {
      await shutdown();
    });

    it("anon cannot EXECUTE any new rpc", async () => {
      const sql = getSql();
      for (const fn of NEW_RPCS) {
        const [{ has_privilege }] = await sql<{ has_privilege: boolean }[]>`
          SELECT has_function_privilege('anon', ${fn}, 'EXECUTE') AS has_privilege
        `;
        expect(has_privilege, `anon ${fn}`).toBe(false);
      }
    });

    it("authenticated cannot EXECUTE any new rpc", async () => {
      const sql = getSql();
      for (const fn of NEW_RPCS) {
        const [{ has_privilege }] = await sql<{ has_privilege: boolean }[]>`
          SELECT has_function_privilege('authenticated', ${fn}, 'EXECUTE') AS has_privilege
        `;
        expect(has_privilege, `authenticated ${fn}`).toBe(false);
      }
    });

    it("service_role can EXECUTE every new rpc", async () => {
      const sql = getSql();
      for (const fn of NEW_RPCS) {
        const [{ has_privilege }] = await sql<{ has_privilege: boolean }[]>`
          SELECT has_function_privilege('service_role', ${fn}, 'EXECUTE') AS has_privilege
        `;
        expect(has_privilege, `service_role ${fn}`).toBe(true);
      }
    });
  },
);
