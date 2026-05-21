import { afterAll, describe, expect, it } from "vitest";
import { getSql, shutdown } from "./helpers";

// Verifies tables intended for Supabase Realtime are members of the
// `supabase_realtime` publication AND have REPLICA IDENTITY FULL (required
// for change-data-capture of soft-deletes via UPDATE).
//
// String-match unit tests catch typos in the migration SQL. This catches
// semantic drift: a future migration could `ALTER PUBLICATION ... DROP TABLE`
// or `REPLICA IDENTITY DEFAULT` and unit tests would still pass.

const SKIP = !process.env.INTEGRATION;

const REPLICATED_TABLES = ["notes", "book_transfers"] as const;

describe.skipIf(SKIP)("supabase_realtime publication membership", () => {
  const sql = getSql();

  afterAll(async () => {
    await shutdown();
  });

  it("contains notes and book_transfers", async () => {
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename
        FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND tablename IN ${sql(REPLICATED_TABLES)}
       ORDER BY tablename
    `;
    expect(rows.map((r) => r.tablename)).toEqual([...REPLICATED_TABLES].sort());
  });

  it("does NOT contain highlights (deliberately excluded per spec §7.3)", async () => {
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename
        FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND tablename = 'highlights'
    `;
    expect(rows).toEqual([]);
  });

  it("exposes public.ensure_realtime(regclass) helper", async () => {
    const rows = await sql<
      { prorettype: string; proargtypes_text: string; provolatile: string }[]
    >`
      SELECT pg_catalog.format_type(p.prorettype, NULL) AS prorettype,
             pg_catalog.pg_get_function_identity_arguments(p.oid) AS proargtypes_text,
             p.provolatile::text AS provolatile
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'ensure_realtime'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].prorettype).toBe("void");
    expect(rows[0].proargtypes_text).toBe("p_table regclass");
  });

  it("is idempotent when called on an already-published table", async () => {
    // notes is already in supabase_realtime via 20260426000001. Calling the
    // helper must be a no-op and must NOT error (whether from a duplicate
    // ALTER PUBLICATION or otherwise).
    await sql`SELECT public.ensure_realtime('public.notes'::regclass)`;
    const [row] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count
        FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'notes'
    `;
    expect(row.count).toBe("1");
  });

  it("adds a not-yet-published table to the publication", async () => {
    // Round-trip: create a throwaway table, helper adds it, verify
    // membership, drop. Dropping the table cascades the publication
    // binding so global state is restored.
    const tableName = `it_ensure_realtime_${Date.now()}`;
    try {
      await sql.unsafe(
        `CREATE TABLE public.${tableName} (id bigint primary key)`,
      );
      await sql`SELECT public.ensure_realtime(${`public.${tableName}`}::regclass)`;
      const [row] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
          FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime'
           AND schemaname = 'public'
           AND tablename = ${tableName}
      `;
      expect(row.count).toBe("1");
      // Second call must also be a no-op against the table we just added.
      await sql`SELECT public.ensure_realtime(${`public.${tableName}`}::regclass)`;
    } finally {
      await sql.unsafe(`DROP TABLE IF EXISTS public.${tableName}`);
    }
  });

  it("sets REPLICA IDENTITY FULL on notes and book_transfers", async () => {
    // pg_class.relreplident: 'd'=default, 'n'=nothing, 'f'=full, 'i'=index.
    // FULL is required for three reasons (see #106 close + migration
    // 20260521000003 COMMENT ON TABLE book_transfers):
    //   1. RLS eval on DELETE needs user_id in the WAL old-image.
    //   2. Firmware subscriber filter on device_id (nullable column) needs
    //      device_id present in UPDATE payloads — status flips don't mutate
    //      device_id, so without FULL the filter has nothing to evaluate.
    //   3. USING INDEX requires UNIQUE + NOT NULL columns — device_id is
    //      nullable, so no narrower replica identity is viable.
    const rows = await sql<{ relname: string; relreplident: string }[]>`
      SELECT relname, relreplident::text AS relreplident
        FROM pg_class
       WHERE relname IN ${sql(REPLICATED_TABLES)}
         AND relnamespace = 'public'::regnamespace
       ORDER BY relname
    `;
    expect(rows).toEqual([
      { relname: "book_transfers", relreplident: "f" },
      { relname: "notes", relreplident: "f" },
    ]);
  });
});
