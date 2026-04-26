import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

const NOTES_MIGRATION = readFileSync(
  join(MIGRATIONS_DIR, "20260426000001_notes_tombstones_and_realtime.sql"),
  "utf8",
);

const TRANSFERS_MIGRATION = readFileSync(
  join(MIGRATIONS_DIR, "20260426000003_enable_realtime_book_transfers.sql"),
  "utf8",
);

describe("notes_tombstones_and_realtime migration (WS-RT)", () => {
  it("adds notes.deleted_at column with IF NOT EXISTS guard", () => {
    expect(NOTES_MIGRATION).toMatch(
      /ALTER TABLE public\.notes[\s\S]+ADD COLUMN IF NOT EXISTS deleted_at timestamptz/,
    );
  });

  it("creates idx_notes_deleted_at partial index with IF NOT EXISTS guard", () => {
    expect(NOTES_MIGRATION).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_notes_deleted_at[\s\S]+ON public\.notes \(user_id, deleted_at\)[\s\S]+WHERE deleted_at IS NOT NULL/,
    );
  });

  it("sets REPLICA IDENTITY FULL on notes", () => {
    expect(NOTES_MIGRATION).toMatch(
      /ALTER TABLE public\.notes REPLICA IDENTITY FULL/,
    );
  });

  it("guards ALTER PUBLICATION ADD TABLE for notes against re-runs", () => {
    expect(NOTES_MIGRATION).toMatch(
      /pg_publication_tables[\s\S]+tablename = 'notes'[\s\S]+ALTER PUBLICATION supabase_realtime ADD TABLE public\.notes/,
    );
  });

  it("does NOT add highlights to publication (deliberately omitted per spec §7.3)", () => {
    expect(NOTES_MIGRATION).not.toMatch(
      /ALTER PUBLICATION supabase_realtime ADD TABLE public\.highlights/,
    );
  });

  it("schedules a 30-day hard-delete sweep for trashed notes", () => {
    expect(NOTES_MIGRATION).toMatch(
      /cron\.schedule\([\s\S]+'empty-trashed-notes'[\s\S]+DELETE FROM public\.notes[\s\S]+deleted_at < now\(\) - interval '30 days'/,
    );
  });

  it("unschedules the GC job before re-scheduling so re-runs are idempotent", () => {
    expect(NOTES_MIGRATION).toMatch(
      /cron\.unschedule\(jobid\)[\s\S]+jobname = 'empty-trashed-notes'/,
    );
  });
});

describe("enable_realtime_book_transfers migration (WS-C scope)", () => {
  it("sets REPLICA IDENTITY FULL on book_transfers", () => {
    expect(TRANSFERS_MIGRATION).toMatch(
      /ALTER TABLE public\.book_transfers REPLICA IDENTITY FULL/,
    );
  });

  it("guards ALTER PUBLICATION ADD TABLE for book_transfers against re-runs", () => {
    expect(TRANSFERS_MIGRATION).toMatch(
      /pg_publication_tables[\s\S]+tablename = 'book_transfers'[\s\S]+ALTER PUBLICATION supabase_realtime ADD TABLE public\.book_transfers/,
    );
  });
});
