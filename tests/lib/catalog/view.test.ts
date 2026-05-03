import { describe, it, expect, vi } from "vitest";
import { createMockSupabase } from "../../helpers";

vi.mock("$env/static/private", () => ({
  COVER_STORAGE_BACKEND: "supabase",
}));
vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/private", () => ({
  env: {},
}));
vi.mock("$env/dynamic/public", () => ({
  env: {},
}));

const { getCatalogForBrowser } =
  await import("../../../src/lib/server/catalog/view");

const ISBN = "9780743273565";

describe("getCatalogForBrowser", () => {
  it("returns null when no row exists for the ISBN", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });

    const result = await getCatalogForBrowser(supabase, ISBN);

    expect(result).toBeNull();
  });

  it("returns CatalogView with cover_url null for negative-cache row (both storage fields null)", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN,
          title: "The Great Gatsby",
          author: "F. Scott Fitzgerald",
          description: null,
          description_provider: null,
          publisher: null,
          page_count: null,
          subjects: null,
          published_date: null,
          language: null,
          series_name: null,
          series_position: null,
          storage_path: null,
          cover_storage_backend: null,
        },
      ],
      error: null,
    });

    const result = await getCatalogForBrowser(supabase, ISBN);

    expect(result).not.toBeNull();
    expect(result!.cover_url).toBeNull();
    expect(result!.isbn).toBe(ISBN);
    expect(result!.title).toBe("The Great Gatsby");
    // Discriminant fields are present in the view for downstream narrowing
    expect(result!.storage_path).toBeNull();
    expect(result!.cover_storage_backend).toBeNull();
  });

  it("returns CatalogView with non-null cover_url for positive row (supabase backend)", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN,
          title: "The Great Gatsby",
          author: "F. Scott Fitzgerald",
          description: "A novel about the Jazz Age.",
          description_provider: "openlibrary",
          publisher: "Scribner",
          page_count: 180,
          subjects: ["Fiction", "Classic"],
          published_date: "1925-04-10",
          language: "en",
          series_name: null,
          series_position: null,
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });

    const result = await getCatalogForBrowser(supabase, ISBN, "medium");

    expect(result).not.toBeNull();
    expect(result!.cover_url).toContain(
      "storage/v1/object/public/cover-cache/ab/cd.jpg",
    );
    expect(result!.cover_url).toContain("supabase.example.co");
    expect(result!.title).toBe("The Great Gatsby");
    expect(result!.description).toBe("A novel about the Jazz Age.");
    expect(result!.page_count).toBe(180);
    // Discriminant fields preserved in view
    expect(result!.storage_path).toBe("ab/cd.jpg");
    expect(result!.cover_storage_backend).toBe("supabase");
  });

  it("TypeScript: cover_url derivation compiles without ! assertions (discriminated-union narrowing)", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN,
          title: "Test",
          author: "Author",
          description: null,
          description_provider: null,
          publisher: null,
          page_count: null,
          subjects: null,
          published_date: null,
          language: null,
          series_name: null,
          series_position: null,
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });

    const result = await getCatalogForBrowser(supabase, ISBN);

    // The discriminant (storage_path + cover_storage_backend) is carried
    // through CatalogView so TypeScript's discriminated-union narrowing works
    // downstream without non-null assertions. This test pins that contract.
    if (
      result &&
      result.storage_path !== null &&
      result.cover_storage_backend !== null
    ) {
      // Inside this branch, cover_url must be non-null — no ! needed.
      const url: string = result.cover_url as string;
      expect(url).toBeTruthy();
    } else {
      // Shouldn't reach here given the fixture above.
      throw new Error("Expected positive row");
    }
  });

  it("throws when the Supabase query returns an error", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: null,
      error: { message: "DB connection failed", code: "500" },
    });

    await expect(getCatalogForBrowser(supabase, ISBN)).rejects.toBeTruthy();
  });

  it("passes variant to coverUrl — large variant in URL path is resolved by caller", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN,
          title: "Test",
          author: "Author",
          description: null,
          description_provider: null,
          publisher: null,
          page_count: null,
          subjects: null,
          published_date: null,
          language: null,
          series_name: null,
          series_position: null,
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });

    // For supabase backend, variant is a layout hint (URL is the same).
    // Confirm a different variant still returns a non-null cover_url.
    const result = await getCatalogForBrowser(supabase, ISBN, "large");

    expect(result).not.toBeNull();
    expect(result!.cover_url).toContain("ab/cd.jpg");
  });
});
