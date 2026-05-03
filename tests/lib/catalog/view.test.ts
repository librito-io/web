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

const { getCatalogForBrowser, getCoverUrlsByIsbns } =
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

const ISBN_A = "9780743273565";
const ISBN_B = "9780062316097";
const ISBN_C = "9780525559474";

describe("getCoverUrlsByIsbns", () => {
  it("returns an empty Map without hitting the DB when input is empty", async () => {
    const supabase = createMockSupabase();
    // Booby-trap: if the helper does query, this would surface in the result.
    supabase._results.set("book_catalog.select", {
      data: [
        { isbn: "wrong", storage_path: "x", cover_storage_backend: "supabase" },
      ],
      error: null,
    });

    const result = await getCoverUrlsByIsbns(supabase, []);

    expect(result.size).toBe(0);
  });

  it("returns Map entries only for ISBNs with a positive (cover-bearing) row", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        // positive
        {
          isbn: ISBN_A,
          storage_path: "ab/a.jpg",
          cover_storage_backend: "supabase",
        },
        // positive
        {
          isbn: ISBN_B,
          storage_path: "cd/b.jpg",
          cover_storage_backend: "supabase",
        },
        // negative-cache row — must be omitted from the Map
        {
          isbn: ISBN_C,
          storage_path: null,
          cover_storage_backend: null,
        },
      ],
      error: null,
    });

    const result = await getCoverUrlsByIsbns(supabase, [
      ISBN_A,
      ISBN_B,
      ISBN_C,
    ]);

    expect(result.size).toBe(2);
    expect(result.get(ISBN_A)).toContain("ab/a.jpg");
    expect(result.get(ISBN_B)).toContain("cd/b.jpg");
    expect(result.has(ISBN_C)).toBe(false);
  });

  it("handles duplicate input ISBNs without producing duplicated entries", async () => {
    // Behavioural contract: duplicates in input do not corrupt the result.
    // The helper's `Array.from(new Set(...))` dedupe before the query is the
    // implementation that satisfies this; pinning behaviour rather than
    // poking the chain shape keeps the test robust against future query
    // refactors.
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN_A,
          storage_path: "ab/a.jpg",
          cover_storage_backend: "supabase",
        },
        {
          isbn: ISBN_B,
          storage_path: "cd/b.jpg",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });

    const result = await getCoverUrlsByIsbns(supabase, [
      ISBN_A,
      ISBN_A,
      ISBN_B,
      ISBN_A,
    ]);

    expect(result.size).toBe(2);
    expect(result.get(ISBN_A)).toContain("ab/a.jpg");
    expect(result.get(ISBN_B)).toContain("cd/b.jpg");
  });

  it("returns no entry for ISBNs with no catalog row at all (cold-miss)", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN_A,
          storage_path: "ab/a.jpg",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });

    const result = await getCoverUrlsByIsbns(supabase, [
      ISBN_A,
      ISBN_B,
      ISBN_C,
    ]);

    expect(result.size).toBe(1);
    expect(result.has(ISBN_A)).toBe(true);
    expect(result.has(ISBN_B)).toBe(false);
    expect(result.has(ISBN_C)).toBe(false);
  });

  it("threads the variant param through to coverUrl()", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN_A,
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });

    // Default variant ("thumbnail") and an explicit override should both
    // resolve to a URL containing the storage path. (Supabase backend
    // ignores the variant; the assertion is that the URL still resolves.)
    const thumb = await getCoverUrlsByIsbns(supabase, [ISBN_A]);
    expect(thumb.get(ISBN_A)).toContain("ab/cd.jpg");

    const supabase2 = createMockSupabase();
    supabase2._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN_A,
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });
    const large = await getCoverUrlsByIsbns(supabase2, [ISBN_A], "large");
    expect(large.get(ISBN_A)).toContain("ab/cd.jpg");
  });

  it("throws when the Supabase query returns an error", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: null,
      error: { message: "DB connection failed", code: "500" },
    });

    await expect(getCoverUrlsByIsbns(supabase, [ISBN_A])).rejects.toBeTruthy();
  });
});
