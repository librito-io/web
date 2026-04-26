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
    "20260425000003_harden_transfer_attempt_rpc.sql",
  ),
  "utf8",
);

describe("harden_transfer_attempt_rpc migration", () => {
  it("drops the prior single-arg signature", () => {
    expect(MIGRATION).toMatch(
      /DROP FUNCTION IF EXISTS public\.increment_transfer_attempt\(uuid\)/,
    );
  });

  it("redefines with parameterized cap defaulted to 10", () => {
    expect(MIGRATION).toMatch(
      /p_transfer_id uuid,[\s\S]*p_max_attempts int DEFAULT 10/,
    );
  });

  it("pins search_path", () => {
    expect(MIGRATION).toMatch(/SET search_path = public, pg_temp/);
  });

  it("revokes EXECUTE from PUBLIC", () => {
    expect(MIGRATION).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.increment_transfer_attempt\(uuid, int\) FROM PUBLIC/,
    );
  });

  it("grants EXECUTE to service_role", () => {
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.increment_transfer_attempt\(uuid, int\) TO service_role/,
    );
  });

  it("uses p_max_attempts in cap-hit branch (no hardcoded 10 in CASE)", () => {
    expect(MIGRATION).toMatch(
      /attempt_count \+ 1 >= p_max_attempts THEN 'failed'/,
    );
  });

  it("interpolates p_max_attempts into the curated last_error string", () => {
    expect(MIGRATION).toMatch(/\|\| p_max_attempts \|\|/);
  });
});
