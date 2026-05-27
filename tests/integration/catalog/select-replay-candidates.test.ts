import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getAdmin, shutdown } from "../helpers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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

      const due = (rows ?? []).find((r) => r.isbn === "9780000000010");
      expect(due?.replay_fields).toContain("description");

      // Row at 30min has every field parked and no field is TTL-up, so it
      // doesn't surface at all.
      const notDue = (rows ?? []).find((r) => r.isbn === "9780000000011");
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
      const due = (rows ?? []).find((r) => r.isbn === "9780000000020");
      expect(due?.replay_fields).toContain("description");

      const notDue = (rows ?? []).find((r) => r.isbn === "9780000000021");
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
      const found = (rows ?? []).find((r) => r.isbn === "9780000000030");
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
      const row = (rows ?? []).find((r) => r.isbn === "9780000000040");
      expect(row?.replay_fields).toEqual(
        expect.arrayContaining(["description", "subjects"]),
      );
      expect(row?.replay_fields).not.toContain("publisher");
    });

    it("respects p_limit and orders by last_attempted_at ASC (oldest first)", async () => {
      const now = Date.now();
      const seedRows = Array.from({ length: 5 }).map((_, i) =>
        rowWithAllFieldsParked({
          isbn: `978000000005${i}`,
          description: null,
          description_attempted_at: new Date(
            now - (10 - i) * DAY,
          ).toISOString(),
          description_fail_reason: "provider_empty_field",
          last_attempted_at: new Date(now - (10 - i) * DAY).toISOString(),
        }),
      );
      await admin.from("book_catalog").insert(seedRows);

      // description_fail_reason = provider_empty_field has 30d TTL —
      // every seeded row is 6-10 days old, so none would qualify on
      // description alone. But the cover branch's parked rate_limited
      // (5min ago) keeps each row OUT. Switch one field to a 91-day-old
      // provider_no_data so the rows surface.
      // Actually simpler: re-seed with the cover field tripped instead.
      await admin.from("book_catalog").delete().like("isbn", "97800000000%");
      const olderSeed = Array.from({ length: 5 }).map((_, i) =>
        rowWithAllFieldsParked({
          isbn: `978000000005${i}`,
          storage_path: null,
          cover_attempted_at: new Date(now - (10 - i) * DAY).toISOString(),
          cover_fail_reason: "provider_no_data",
          last_attempted_at: new Date(now - (10 - i) * DAY).toISOString(),
        }),
      );
      // cover predicate ladder for provider_no_data is 90d — 6-10d not due.
      // Use provider_empty_field with 30d ladder, but rows still under 30d.
      // Simplest path: use provider_disabled (24h ladder).
      olderSeed.forEach((row) => {
        row.cover_fail_reason = "provider_disabled";
      });
      await admin.from("book_catalog").insert(olderSeed);

      const { data: picked } = await admin.rpc("select_replay_candidates", {
        p_limit: 3,
      });
      expect(picked).toHaveLength(3);
      // Oldest last_attempted_at first → ...50 (10d old) before ...54 (6d).
      expect(picked![0].isbn).toBe("9780000000050");
      expect(picked![1].isbn).toBe("9780000000051");
      expect(picked![2].isbn).toBe("9780000000052");
    });
  },
);
