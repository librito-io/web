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
