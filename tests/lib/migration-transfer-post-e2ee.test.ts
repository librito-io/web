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
    "20260423000001_transfer_post_e2ee.sql",
  ),
  "utf8",
);

describe("transfer_post_e2ee migration", () => {
  it("aborts if pending_upload rows remain", () => {
    expect(MIGRATION).toMatch(/Drain window incomplete/);
    expect(MIGRATION).toMatch(/pending_upload/);
    expect(MIGRATION).toMatch(/RAISE EXCEPTION/);
  });

  it("adds the four WS-D/scrub columns", () => {
    expect(MIGRATION).toMatch(
      /ADD COLUMN attempt_count int NOT NULL DEFAULT 0/,
    );
    expect(MIGRATION).toMatch(/ADD COLUMN last_error text/);
    expect(MIGRATION).toMatch(/ADD COLUMN last_attempt_at timestamptz/);
    expect(MIGRATION).toMatch(/ADD COLUMN scrubbed_at timestamptz/);
  });

  it("relaxes filename / sha256 / storage_path nullability", () => {
    expect(MIGRATION).toMatch(/ALTER COLUMN sha256 DROP NOT NULL/);
    expect(MIGRATION).toMatch(/ALTER COLUMN filename DROP NOT NULL/);
    expect(MIGRATION).toMatch(/ALTER COLUMN storage_path DROP NOT NULL/);
  });

  it("normalises empty-sha legacy rows to scrubbed state", () => {
    expect(MIGRATION).toMatch(
      /UPDATE book_transfers[\s\S]+sha256 = NULL[\s\S]+WHERE sha256 = ''/,
    );
  });

  it("tightens valid_transfer_status (no pending_upload, adds failed)", () => {
    expect(MIGRATION).toMatch(/DROP CONSTRAINT valid_transfer_status/);
    expect(MIGRATION).toMatch(
      /CHECK \(status IN \('pending', 'downloaded', 'expired', 'failed'\)\)/,
    );
  });

  it("reworks valid_sha256 to allow NULL for scrubbed rows", () => {
    expect(MIGRATION).toMatch(/DROP CONSTRAINT valid_sha256/);
    expect(MIGRATION).toMatch(
      /sha256 ~ '\^\[0-9a-f\]\{64\}\$'[\s\S]+scrubbed_at IS NOT NULL AND sha256 IS NULL/,
    );
  });

  it("creates the dedup partial unique index", () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX idx_transfers_dedup_pending[\s\S]+\(user_id, sha256\)[\s\S]+status = 'pending' AND sha256 IS NOT NULL/,
    );
  });

  it("creates the scrubbed_at partial index", () => {
    expect(MIGRATION).toMatch(
      /CREATE INDEX idx_transfers_scrubbed[\s\S]+\(scrubbed_at\)[\s\S]+scrubbed_at IS NOT NULL/,
    );
  });

  it("drops expire-abandoned-uploads and reinstalls hourly expire/scrub jobs", () => {
    expect(MIGRATION).toMatch(
      /cron\.unschedule[\s\S]+expire-abandoned-uploads/,
    );
    expect(MIGRATION).toMatch(/cron\.unschedule[\s\S]+expire-stale-transfers/);
    expect(MIGRATION).toMatch(
      /cron\.schedule\([\s\S]+expire-stale-transfers[\s\S]+'0 \* \* \* \*'/,
    );
    expect(MIGRATION).toMatch(
      /cron\.schedule\([\s\S]+scrub-retired-transfers[\s\S]+'0 \* \* \* \*'/,
    );
    expect(MIGRATION).toMatch(/uploaded_at < now\(\) - interval '48 hours'/);
    expect(MIGRATION).toMatch(/downloaded_at < now\(\) - interval '24 hours'/);
    expect(MIGRATION).toMatch(/uploaded_at < now\(\) - interval '49 hours'/);
  });
});
