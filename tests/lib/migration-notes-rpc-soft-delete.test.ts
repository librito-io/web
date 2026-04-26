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
    "20260426000002_filter_deleted_notes_in_rpcs.sql",
  ),
  "utf8",
);

describe("filter_deleted_notes_in_rpcs migration (WS-RT)", () => {
  it("redefines get_library_with_highlights with notes.deleted_at filter", () => {
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION get_library_with_highlights\(\)/,
    );
    expect(MIGRATION).toMatch(
      /LEFT JOIN notes n[\s\S]+ON n\.highlight_id = h\.id AND n\.deleted_at IS NULL/,
    );
  });

  it("redefines get_highlight_feed with notes.deleted_at filter", () => {
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION get_highlight_feed\(/,
    );
    expect(MIGRATION).toMatch(
      /LEFT JOIN notes n[\s\S]+ON n\.highlight_id = h\.id AND n\.deleted_at IS NULL/,
    );
  });

  it("re-grants EXECUTE to authenticated for both functions", () => {
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION get_library_with_highlights\(\) TO authenticated/,
    );
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION get_highlight_feed\(text, jsonb, int, text\) TO authenticated/,
    );
  });
});
