import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  getSql,
  shutdown,
  type TestUser,
} from "./helpers";

// Behavior guard for the Live Highlight Feed broadcast triggers
// (migration 20260621000001). realtime.send is FAIL-SILENT (its INSERT into
// realtime.messages is wrapped in EXCEPTION WHEN OTHERS THEN RAISE WARNING),
// so a swallowed/guard-suppressed send is otherwise indistinguishable from a
// delivered one — these tests assert a row ACTUALLY lands in realtime.messages
// for the topic. Runs as superuser via postgres-js (BYPASSRLS), mirroring the
// service_role writers in production.

const SKIP = !process.env.INTEGRATION;

describe.skipIf(SKIP)("highlight broadcast triggers (live feed)", () => {
  const sql = getSql();
  let user: TestUser;
  let bookId: string;

  // realtime.messages is daily RANGE-partitioned on inserted_at; a missing
  // current-day partition silently drops every send. Managed Supabase
  // maintains partitions; the test harness must ensure today's exists.
  async function ensureTodayPartition(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const tomorrow = new Date(Date.now() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const part = `messages_${today.replace(/-/g, "_")}`;
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS realtime.${part} ` +
        `PARTITION OF realtime.messages ` +
        `FOR VALUES FROM ('${today}') TO ('${tomorrow}')`,
    );
  }

  async function topicCount(): Promise<number> {
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n
        FROM realtime.messages
       WHERE topic = ${"user:" + user.id}
         AND event = 'highlight_change'
    `;
    return Number(row.n);
  }

  beforeAll(async () => {
    await ensureTodayPartition();
    user = await createTestUser("hl-broadcast");
    const [book] = await sql<{ id: string }[]>`
      INSERT INTO public.books (user_id, book_hash, title, author, isbn)
      VALUES (${user.id}, ${"feed1234"}, ${"Feed Book"}, ${"Author"}, ${"9780000000077"})
      RETURNING id
    `;
    bookId = book.id;
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
    await shutdown();
  });

  it("emits exactly one broadcast for a single-statement multi-row INSERT", async () => {
    const before = await topicCount();
    await sql`
      INSERT INTO public.highlights
        (book_id, user_id, source, chapter_index, start_word, end_word, text)
      VALUES
        (${bookId}, ${user.id}, 'papers3', 0, 0, 5, ${"row a"}),
        (${bookId}, ${user.id}, 'papers3', 0, 6, 9, ${"row b"})
    `;
    expect(await topicCount()).toBe(before + 1);
    const [msg] = await sql<{ op: string }[]>`
      SELECT payload->>'op' AS op
        FROM realtime.messages
       WHERE topic = ${"user:" + user.id} AND event = 'highlight_change'
       ORDER BY inserted_at DESC LIMIT 1
    `;
    expect(msg.op).toBe("insert");
  });

  it("emits zero insert broadcasts on a no-op ON CONFLICT re-send", async () => {
    // Mirrors processSync's upsert (onConflict book_id,chapter_index,start_word,end_word).
    // Conflict-updated rows route to the UPDATE path and are excluded from the
    // AFTER INSERT transition table; deleted_at is unchanged so the UPDATE
    // guard suppresses too. Net delta = 0.
    const before = await topicCount();
    await sql`
      INSERT INTO public.highlights
        (book_id, user_id, source, chapter_index, start_word, end_word, text)
      VALUES (${bookId}, ${user.id}, 'papers3', 0, 0, 5, ${"row a v2"})
      ON CONFLICT (book_id, chapter_index, start_word, end_word) WHERE source = 'papers3'
      DO UPDATE SET text = EXCLUDED.text
    `;
    expect(await topicCount()).toBe(before);
  });

  it("emits one update broadcast on a deleted_at transition (trash)", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO public.highlights
        (book_id, user_id, source, chapter_index, start_word, end_word, text)
      VALUES (${bookId}, ${user.id}, 'papers3', 1, 0, 4, ${"to trash"})
      RETURNING id
    `;
    const before = await topicCount();
    await sql`UPDATE public.highlights SET deleted_at = now() WHERE id = ${row.id}`;
    expect(await topicCount()).toBe(before + 1);
    const [msg] = await sql<{ op: string; deleted_at: string | null }[]>`
      SELECT payload->>'op' AS op, payload->>'deleted_at' AS deleted_at
        FROM realtime.messages
       WHERE topic = ${"user:" + user.id} AND event = 'highlight_change'
       ORDER BY inserted_at DESC LIMIT 1
    `;
    expect(msg.op).toBe("update");
    expect(msg.deleted_at).not.toBeNull();
  });

  it("emits one update broadcast on a deleted_at -> NULL transition (restore)", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO public.highlights
        (book_id, user_id, source, chapter_index, start_word, end_word, text, deleted_at)
      VALUES (${bookId}, ${user.id}, 'papers3', 2, 0, 4, ${"to restore"}, now())
      RETURNING id
    `;
    const before = await topicCount();
    await sql`UPDATE public.highlights SET deleted_at = NULL WHERE id = ${row.id}`;
    expect(await topicCount()).toBe(before + 1);
    const [msg] = await sql<{ deleted_at: string | null }[]>`
      SELECT payload->>'deleted_at' AS deleted_at
        FROM realtime.messages
       WHERE topic = ${"user:" + user.id} AND event = 'highlight_change'
       ORDER BY inserted_at DESC LIMIT 1
    `;
    expect(msg.deleted_at).toBeNull();
  });

  it("emits zero broadcasts on a non-deleted_at UPDATE (guard suppresses)", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO public.highlights
        (book_id, user_id, source, chapter_index, start_word, end_word, text)
      VALUES (${bookId}, ${user.id}, 'papers3', 3, 0, 4, ${"edit me"})
      RETURNING id
    `;
    const before = await topicCount();
    await sql`UPDATE public.highlights SET text = ${"edited"} WHERE id = ${row.id}`;
    expect(await topicCount()).toBe(before);
  });

  it("creates the realtime.messages SELECT policy scoped to the per-user topic", async () => {
    const rows = await sql<
      { polname: string; using_expr: string; cmd: string }[]
    >`
      SELECT polname,
             pg_get_expr(polqual, polrelid) AS using_expr,
             polcmd::text AS cmd
        FROM pg_policy
       WHERE polrelid = 'realtime.messages'::regclass
         AND polname = 'authenticated read own highlight topic'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].cmd).toBe("r"); // SELECT
    expect(rows[0].using_expr).toContain("topic()");
    expect(rows[0].using_expr).toContain("uid()");
  });
});
