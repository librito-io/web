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
    "20260429000001_tighten_browser_rls_book_transfers_notes.sql",
  ),
  "utf8",
);

describe("tighten_browser_rls migration (audit PR 2: S1/S2/S5)", () => {
  it("S1: drops the browser INSERT policy on book_transfers", () => {
    expect(MIGRATION).toMatch(
      /DROP POLICY IF EXISTS "Users can create own transfers"[\s\S]+ON public\.book_transfers/,
    );
  });

  it("S2: tightens storage upload to require an EXISTS match against a pending transfer row", () => {
    expect(MIGRATION).toMatch(
      /ALTER POLICY "Users can upload book transfers" ON storage\.objects[\s\S]+EXISTS \([\s\S]+FROM public\.book_transfers t[\s\S]+t\.id::text = \(storage\.foldername\(name\)\)\[2\][\s\S]+t\.user_id = \(SELECT auth\.uid\(\)\)[\s\S]+t\.status = 'pending'/,
    );
  });

  it("S2: keeps the user_id folder check wrapped in (SELECT auth.uid()) per advisor pattern", () => {
    expect(MIGRATION).toMatch(
      /\(storage\.foldername\(name\)\)\[1\] = \(SELECT auth\.uid\(\)\)::text/,
    );
  });

  it("S5: drops the browser DELETE policy on notes", () => {
    expect(MIGRATION).toMatch(
      /DROP POLICY IF EXISTS "Users can delete own notes" ON public\.notes/,
    );
  });

  it("S5: documents the soft-delete contract on the notes table", () => {
    expect(MIGRATION).toMatch(
      /COMMENT ON TABLE public\.notes IS[\s\S]+Soft-delete via deleted_at[\s\S]+Do NOT add an RLS DELETE policy back/,
    );
  });

  it("S1: documents the no-browser-write invariant on book_transfers", () => {
    expect(MIGRATION).toMatch(
      /COMMENT ON TABLE public\.book_transfers IS[\s\S]+all mutations go through API routes using service_role/,
    );
  });
});
