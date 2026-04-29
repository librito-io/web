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
    "20260429000004_rewrite_library_rpc_and_harden_feed_cursor.sql",
  ),
  "utf8",
);

describe("rewrite_library_rpc_and_harden_feed_cursor migration (PR 5)", () => {
  describe("P1: get_library_with_highlights cached auth.uid()", () => {
    it("drops then recreates the function (language change SQL → plpgsql)", () => {
      expect(MIGRATION).toMatch(
        /DROP FUNCTION IF EXISTS public\.get_library_with_highlights\(\)/,
      );
      expect(MIGRATION).toMatch(
        /CREATE OR REPLACE FUNCTION public\.get_library_with_highlights\(\)[\s\S]+LANGUAGE plpgsql/,
      );
    });

    it("declares v_uid uuid := auth.uid() once and references v_uid (not bare auth.uid()) in the body", () => {
      // Each function caches auth.uid() once via `v_uid uuid := auth.uid()`.
      // Strip line comments before counting so prose mentions don't pollute.
      const sqlOnly = MIGRATION.replace(/--[^\n]*/g, "");
      const declareMatches =
        sqlOnly.match(/v_uid\s+uuid\s*:=\s*auth\.uid\(\)/g) ?? [];
      expect(declareMatches.length).toBe(2);

      // Outside the two DECLAREs, no bare auth.uid() remains in either body.
      const strippedBodies = sqlOnly.replace(
        /v_uid\s+uuid\s*:=\s*auth\.uid\(\)/g,
        "",
      );
      expect(strippedBodies).not.toMatch(/auth\.uid\(\)/);
    });

    it("preserves SECURITY INVOKER + search_path = public", () => {
      expect(MIGRATION).toMatch(
        /CREATE OR REPLACE FUNCTION public\.get_library_with_highlights\(\)[\s\S]+SECURITY INVOKER[\s\S]+SET search_path = public/,
      );
    });

    it("preserves GRANT EXECUTE TO authenticated", () => {
      expect(MIGRATION).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.get_library_with_highlights\(\) TO authenticated/,
      );
    });
  });

  describe("P2: get_library_with_highlights LATERAL JOIN", () => {
    it("uses LEFT JOIN LATERAL for highlight aggregation", () => {
      expect(MIGRATION).toMatch(/LEFT JOIN LATERAL\s*\([\s\S]+jsonb_agg/);
    });

    it("preserves the deleted_at filter on notes inside the lateral", () => {
      expect(MIGRATION).toMatch(
        /LEFT JOIN notes n[\s\S]+ON n\.highlight_id = h\.id[\s\S]+AND n\.deleted_at IS NULL/,
      );
    });

    it("preserves the deleted_at filter on highlights", () => {
      expect(MIGRATION).toMatch(/h\.deleted_at IS NULL/);
    });
  });

  describe("L1: get_highlight_feed NULL title/author cursor", () => {
    it("wraps book_title in COALESCE in the title-sort cursor comparison", () => {
      expect(MIGRATION).toMatch(
        /WHEN 'title' THEN[\s\S]+\(COALESCE\(book_title, ''\), chapter_index, start_word, highlight_id\)\s*>[\s\S]+COALESCE\(p_cursor->>'t', ''\)/,
      );
    });

    it("wraps book_author + book_title in COALESCE in the author-sort cursor comparison", () => {
      expect(MIGRATION).toMatch(
        /WHEN 'author' THEN[\s\S]+\(COALESCE\(book_author, ''\), COALESCE\(book_title, ''\), chapter_index, start_word, highlight_id\)\s*>[\s\S]+COALESCE\(p_cursor->>'a', ''\)[\s\S]+COALESCE\(p_cursor->>'t', ''\)/,
      );
    });

    it("wraps book_title in COALESCE in the title-sort ORDER BY", () => {
      expect(MIGRATION).toMatch(
        /CASE WHEN p_sort = 'title'\s+THEN COALESCE\(book_title, ''\)\s+END ASC/,
      );
    });

    it("wraps book_author in COALESCE in the author-sort ORDER BY", () => {
      expect(MIGRATION).toMatch(
        /CASE WHEN p_sort = 'author'\s+THEN COALESCE\(book_author, ''\) END ASC/,
      );
    });

    it("wraps n.book_title in COALESCE when building the title-sort cursor", () => {
      expect(MIGRATION).toMatch(
        /WHEN 'title' THEN\s+jsonb_build_object\('t', COALESCE\(n\.book_title, ''\)/,
      );
    });

    it("wraps n.book_author + n.book_title in COALESCE when building the author-sort cursor", () => {
      expect(MIGRATION).toMatch(
        /WHEN 'author' THEN\s+jsonb_build_object\('a', COALESCE\(n\.book_author, ''\)[\s\S]+'t', COALESCE\(n\.book_title, ''\)/,
      );
    });

    it("preserves get_highlight_feed signature + GRANT", () => {
      expect(MIGRATION).toMatch(
        /CREATE OR REPLACE FUNCTION public\.get_highlight_feed\(\s+p_sort\s+text,\s+p_cursor\s+jsonb,\s+p_limit\s+int,\s+p_book_hash\s+text/,
      );
      expect(MIGRATION).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.get_highlight_feed\(text, jsonb, int, text\) TO authenticated/,
      );
    });
  });
});
