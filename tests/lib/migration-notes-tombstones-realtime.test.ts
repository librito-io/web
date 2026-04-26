import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const MIGRATION = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "supabase",
    "migrations",
    "20260426000001_notes_tombstones_and_realtime.sql",
  ),
  "utf8",
);

describe("notes_tombstones_and_realtime migration (WS-RT)", () => {
  it("adds notes.deleted_at column", () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE public\.notes[\s\S]+ADD COLUMN deleted_at timestamptz/,
    );
  });

  it("creates idx_notes_deleted_at partial index", () => {
    expect(MIGRATION).toMatch(
      /CREATE INDEX idx_notes_deleted_at[\s\S]+ON public\.notes \(user_id, deleted_at\)[\s\S]+WHERE deleted_at IS NOT NULL/,
    );
  });

  it("sets REPLICA IDENTITY FULL on notes and book_transfers", () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE public\.notes REPLICA IDENTITY FULL/,
    );
    expect(MIGRATION).toMatch(
      /ALTER TABLE public\.book_transfers REPLICA IDENTITY FULL/,
    );
  });

  it("adds notes and book_transfers to supabase_realtime publication", () => {
    expect(MIGRATION).toMatch(
      /ALTER PUBLICATION supabase_realtime ADD TABLE public\.notes/,
    );
    expect(MIGRATION).toMatch(
      /ALTER PUBLICATION supabase_realtime ADD TABLE public\.book_transfers/,
    );
  });

  it("does NOT add highlights to publication (deliberately omitted per spec §7.3)", () => {
    expect(MIGRATION).not.toMatch(
      /ALTER PUBLICATION supabase_realtime ADD TABLE public\.highlights/,
    );
  });
});
