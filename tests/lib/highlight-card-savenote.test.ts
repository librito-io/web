import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "src",
    "lib",
    "components",
    "HighlightCard.svelte",
  ),
  "utf8",
);

describe("HighlightCard.saveNote (WS-RT resurrection guard)", () => {
  it("upsert clears deleted_at so trashed → save resurrects the row", () => {
    // Without deleted_at: null, the upsert UPDATE on a tombstoned row
    // overwrites text but leaves deleted_at non-null, so RPCs + sync
    // (which filter deleted_at IS NULL) hide the resurrected note.
    expect(SOURCE).toMatch(
      /saveNote[\s\S]+?\.upsert\(\s*\{[\s\S]+?deleted_at:\s*null[\s\S]+?onConflict:\s*["']highlight_id["']/,
    );
  });
});
