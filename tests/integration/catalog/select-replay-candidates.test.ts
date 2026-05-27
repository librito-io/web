import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getAdmin, shutdown } from "../helpers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// The shared integration getAdmin() returns an un-typed supabase-js
// client (no Database generic), so RPC return shape doesn't flow into
// .find() callbacks. Mirror the generated select_replay_candidates row
// here so the test assertions are self-checked rather than implicit-any.
interface ReplayCandidate {
  id: string;
  isbn: string | null;
  normalized_title_author: string | null;
  title: string | null;
  author: string | null;
  replay_fields: string[];
}

/**
 * Seed a row with every per-field attempted_at populated to a fresh
 * timestamp + fail_reason rate_limited. That parks all six fields'
 * predicates at FALSE so individual field-state cases can be tested in
 * isolation — without this, the OR clauses in select_replay_candidates
 * pick up rows via whichever field still has NULL attempted_at.
 */
function rowWithAllFieldsParked(overrides: Record<string, unknown>) {
  const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  return {
    cover_attempted_at: recent,
    cover_fail_reason: "rate_limited",
    description_attempted_at: recent,
    description_fail_reason: "rate_limited",
    publisher_attempted_at: recent,
    publisher_fail_reason: "rate_limited",
    published_date_attempted_at: recent,
    published_date_fail_reason: "rate_limited",
    subjects_attempted_at: recent,
    subjects_fail_reason: "rate_limited",
    page_count_attempted_at: recent,
    page_count_fail_reason: "rate_limited",
    ...overrides,
  };
}

describe.skipIf(!process.env.INTEGRATION)(
  "select_replay_candidates RPC",
  () => {
    let admin: ReturnType<typeof getAdmin>;

    beforeEach(async () => {
      admin = getAdmin();
      await admin.from("book_catalog").delete().not("id", "is", null);
    });

    afterAll(async () => {
      await shutdown();
    });

    it("rate_limited older than 1h is replay-due; fresh rate_limited is not", async () => {
      const now = Date.now();
      await admin.from("book_catalog").insert([
        rowWithAllFieldsParked({
          isbn: "9780000000010",
          description: null,
          description_attempted_at: new Date(now - 2 * HOUR).toISOString(),
          description_fail_reason: "rate_limited",
        }),
        rowWithAllFieldsParked({
          isbn: "9780000000011",
          description: null,
          description_attempted_at: new Date(
            now - 30 * 60 * 1000,
          ).toISOString(),
          description_fail_reason: "rate_limited",
        }),
      ]);

      const { data: rows, error } = await admin.rpc(
        "select_replay_candidates",
        { p_limit: 100 },
      );
      expect(error).toBeNull();

      const due = (rows as ReplayCandidate[] | null)?.find(
        (r) => r.isbn === "9780000000010",
      );
      expect(due?.replay_fields).toContain("description");

      // Row at 30min has every field parked and no field is TTL-up, so it
      // doesn't surface at all.
      const notDue = (rows as ReplayCandidate[] | null)?.find(
        (r) => r.isbn === "9780000000011",
      );
      expect(notDue).toBeUndefined();
    });

    it("provider_no_data older than 90d is replay-due; 50d-old is not", async () => {
      const now = Date.now();
      await admin.from("book_catalog").insert([
        rowWithAllFieldsParked({
          isbn: "9780000000020",
          description: null,
          description_attempted_at: new Date(now - 100 * DAY).toISOString(),
          description_fail_reason: "provider_no_data",
        }),
        rowWithAllFieldsParked({
          isbn: "9780000000021",
          description: null,
          description_attempted_at: new Date(now - 50 * DAY).toISOString(),
          description_fail_reason: "provider_no_data",
        }),
      ]);

      const { data: rows } = await admin.rpc("select_replay_candidates", {
        p_limit: 100,
      });
      const due = (rows as ReplayCandidate[] | null)?.find(
        (r) => r.isbn === "9780000000020",
      );
      expect(due?.replay_fields).toContain("description");

      const notDue = (rows as ReplayCandidate[] | null)?.find(
        (r) => r.isbn === "9780000000021",
      );
      expect(notDue).toBeUndefined();
    });

    it("never-attempted field is immediately replay-due", async () => {
      // attempted_at IS NULL → predicate returns TRUE for that field.
      // Park the other five fields so only description trips the OR.
      await admin.from("book_catalog").insert(
        rowWithAllFieldsParked({
          isbn: "9780000000030",
          description: null,
          description_attempted_at: null,
          description_fail_reason: null,
        }),
      );
      const { data: rows } = await admin.rpc("select_replay_candidates", {
        p_limit: 100,
      });
      const found = (rows as ReplayCandidate[] | null)?.find(
        (r) => r.isbn === "9780000000030",
      );
      expect(found?.replay_fields).toEqual(["description"]);
    });

    it("replay_fields enumerates exactly the fields with TTL up", async () => {
      const now = Date.now();
      await admin.from("book_catalog").insert(
        rowWithAllFieldsParked({
          isbn: "9780000000040",
          description: null,
          description_attempted_at: new Date(now - 2 * HOUR).toISOString(),
          description_fail_reason: "rate_limited",
          publisher: "Already populated",
          publisher_attempted_at: new Date(now - 2 * HOUR).toISOString(),
          subjects: null,
          subjects_attempted_at: new Date(now - 91 * DAY).toISOString(),
          subjects_fail_reason: "provider_no_data",
        }),
      );

      const { data: rows } = await admin.rpc("select_replay_candidates", {
        p_limit: 100,
      });
      const row = (rows as ReplayCandidate[] | null)?.find(
        (r) => r.isbn === "9780000000040",
      );
      expect(row?.replay_fields).toEqual(
        expect.arrayContaining(["description", "subjects"]),
      );
      expect(row?.replay_fields).not.toContain("publisher");
    });

    it("respects p_limit and orders by last_attempted_at ASC (oldest first)", async () => {
      const now = Date.now();
      // Five cover-null rows aged 6-10 days with cover_fail_reason =
      // provider_disabled (24h TTL → due). All five surface; ORDER BY
      // last_attempted_at ASC puts the 10-day-old row first.
      const rows = Array.from({ length: 5 }).map((_, i) =>
        rowWithAllFieldsParked({
          isbn: `978000000005${i}`,
          storage_path: null,
          cover_attempted_at: new Date(now - (10 - i) * DAY).toISOString(),
          cover_fail_reason: "provider_disabled",
          last_attempted_at: new Date(now - (10 - i) * DAY).toISOString(),
        }),
      );
      await admin.from("book_catalog").insert(rows);

      const { data: picked } = await admin.rpc("select_replay_candidates", {
        p_limit: 3,
      });
      expect(picked).toHaveLength(3);
      expect(picked![0].isbn).toBe("9780000000050");
      expect(picked![1].isbn).toBe("9780000000051");
      expect(picked![2].isbn).toBe("9780000000052");
    });
  },
);
