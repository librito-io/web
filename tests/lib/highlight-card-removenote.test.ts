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

describe("HighlightCard.removeNote (WS-RT idempotency guard)", () => {
  it("uses UPDATE deleted_at, not DELETE", () => {
    // Sole DELETE on notes was removed in WS-RT Task 7. Hard-DELETE would
    // skip Realtime tombstones (no row to UPDATE → no event), break sync.
    expect(SOURCE).not.toMatch(/\.from\(["']notes["']\)\s*\.delete\(/);
    expect(SOURCE).toMatch(
      /removeNote[\s\S]+\.from\(["']notes["']\)[\s\S]+\.update\(\s*\{\s*deleted_at:/,
    );
  });

  it("guards re-clicks with .is('deleted_at', null) so trashed rows are no-op", () => {
    // Without this predicate, re-clicking Remove on an already-trashed note
    // would bump updated_at and re-emit a duplicate Realtime UPDATE.
    expect(SOURCE).toMatch(
      /removeNote[\s\S]+\.update\([\s\S]+\.eq\(["']highlight_id["'][\s\S]+\.eq\(["']user_id["'][\s\S]+\.is\(["']deleted_at["'],\s*null\s*\)/,
    );
  });
});
