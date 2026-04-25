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
    "20260425000002_transfer_attempt_increment_rpc.sql",
  ),
  "utf8",
);

describe("transfer_attempt_increment_rpc migration", () => {
  it("defines public.increment_transfer_attempt(uuid)", () => {
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION public\.increment_transfer_attempt\(p_transfer_id uuid\)/,
    );
  });

  it("returns (attempt_count int, status text)", () => {
    expect(MIGRATION).toMatch(
      /RETURNS TABLE\(attempt_count int, status text\)/,
    );
  });

  it("increments attempt_count by 1 in the UPDATE", () => {
    expect(MIGRATION).toMatch(/attempt_count = attempt_count \+ 1/);
  });

  it("flips status to 'failed' at the 10-attempt cap via CASE", () => {
    expect(MIGRATION).toMatch(
      /status = CASE WHEN attempt_count \+ 1 >= 10 THEN 'failed' ELSE status END/,
    );
  });

  it("writes the exact curated cap-hit last_error string", () => {
    expect(MIGRATION).toMatch(
      /'Couldn''t deliver to your device after 10 attempts\.'/,
    );
  });

  it("guards by id and status='pending' so non-pending rows are not double-counted", () => {
    expect(MIGRATION).toMatch(
      /WHERE id = p_transfer_id AND status = 'pending'/,
    );
  });
});
