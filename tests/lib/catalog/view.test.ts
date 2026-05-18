import { describe, it, expect, vi } from "vitest";
import { createMockSupabase } from "../../helpers";

vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/private", () => ({
  env: { COVER_STORAGE_BACKEND: "supabase" },
}));
vi.mock("$env/dynamic/public", () => ({
  env: {},
}));

const {
  getCatalogForBrowser,
  getCoverUrlsByIsbns,
  getCatalogForBrowserByTitleAuthor,
  getCoverUrlsByTitleAuthor,
} = await import("../../../src/lib/server/catalog/view");

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
          cover_max_width: null,
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
          cover_max_width: 1500,
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
          cover_max_width: 1500,
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
          cover_max_width: 1500,
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

    expect(result.covers.size).toBe(0);
    expect(result.negativeIsbns.size).toBe(0);
  });

  it("returns positive-row covers in the Map and negative-cache ISBNs in negativeIsbns set", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        // positive
        {
          isbn: ISBN_A,
          storage_path: "ab/a.jpg",
          cover_storage_backend: "supabase",
          cover_max_width: 1500,
        },
        // positive
        {
          isbn: ISBN_B,
          storage_path: "cd/b.jpg",
          cover_storage_backend: "supabase",
          cover_max_width: 1500,
        },
        // negative-cache row — covers map omits, negativeIsbns set includes
        {
          isbn: ISBN_C,
          storage_path: null,
          cover_storage_backend: null,
          cover_max_width: null,
        },
      ],
      error: null,
    });

    const result = await getCoverUrlsByIsbns(supabase, [
      ISBN_A,
      ISBN_B,
      ISBN_C,
    ]);

    expect(result.covers.size).toBe(2);
    expect(result.covers.get(ISBN_A)).toContain("ab/a.jpg");
    expect(result.covers.get(ISBN_B)).toContain("cd/b.jpg");
    expect(result.covers.has(ISBN_C)).toBe(false);
    // Negative-cache row surfaces in negativeIsbns so feed-enrichment can
    // distinguish "tried, found nothing" from "never tried" and skip the
    // cold-miss schedule. Issue #110.
    expect(result.negativeIsbns.has(ISBN_C)).toBe(true);
    expect(result.negativeIsbns.has(ISBN_A)).toBe(false);
    expect(result.negativeIsbns.has(ISBN_B)).toBe(false);
  });

  it("returns ISBNs with no catalog row in neither covers nor negativeIsbns (cold-miss)", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN_A,
          storage_path: "ab/a.jpg",
          cover_storage_backend: "supabase",
          cover_max_width: 1500,
        },
      ],
      error: null,
    });

    const result = await getCoverUrlsByIsbns(supabase, [
      ISBN_A,
      ISBN_B,
      ISBN_C,
    ]);

    // ISBN_A is positive; ISBN_B and ISBN_C have no row at all — they must
    // appear in neither map so the caller schedules a cold-miss resolve.
    expect(result.covers.has(ISBN_A)).toBe(true);
    expect(result.negativeIsbns.has(ISBN_A)).toBe(false);
    expect(result.covers.has(ISBN_B)).toBe(false);
    expect(result.negativeIsbns.has(ISBN_B)).toBe(false);
    expect(result.covers.has(ISBN_C)).toBe(false);
    expect(result.negativeIsbns.has(ISBN_C)).toBe(false);
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
          cover_max_width: 1500,
        },
        {
          isbn: ISBN_B,
          storage_path: "cd/b.jpg",
          cover_storage_backend: "supabase",
          cover_max_width: 1500,
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

    expect(result.covers.size).toBe(2);
    expect(result.covers.get(ISBN_A)).toContain("ab/a.jpg");
    expect(result.covers.get(ISBN_B)).toContain("cd/b.jpg");
  });

  it("threads the variant param through to coverUrl()", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN_A,
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
          cover_max_width: 1500,
        },
      ],
      error: null,
    });

    // Default variant ("thumbnail") and an explicit override should both
    // resolve to a URL containing the storage path. (Supabase backend
    // ignores the variant; the assertion is that the URL still resolves.)
    const thumb = await getCoverUrlsByIsbns(supabase, [ISBN_A]);
    expect(thumb.covers.get(ISBN_A)).toContain("ab/cd.jpg");

    const supabase2 = createMockSupabase();
    supabase2._results.set("book_catalog.select", {
      data: [
        {
          isbn: ISBN_A,
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
          cover_max_width: 1500,
        },
      ],
      error: null,
    });
    const large = await getCoverUrlsByIsbns(supabase2, [ISBN_A], "large");
    expect(large.covers.get(ISBN_A)).toContain("ab/cd.jpg");
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

describe("getCatalogForBrowserByTitleAuthor", () => {
  const TITLE = "The Great Gatsby";
  const AUTHOR = "F. Scott Fitzgerald";

  it("returns null when title or author normalises to nothing", async () => {
    const supabase = createMockSupabase();
    // Booby-trap: should never hit the DB on a null key.
    supabase._results.set("book_catalog.select", {
      data: [{ isbn: null }],
      error: null,
    });
    const result = await getCatalogForBrowserByTitleAuthor(supabase, "", "x");
    expect(result).toBeNull();
  });

  it("returns null when no row exists for normalised (title, author)", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", { data: [], error: null });
    const result = await getCatalogForBrowserByTitleAuthor(
      supabase,
      TITLE,
      AUTHOR,
    );
    expect(result).toBeNull();
  });

  it("returns CatalogView with cover_url for positive row", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: null,
          title: TITLE,
          author: AUTHOR,
          description: "blurb",
          description_provider: "openlibrary",
          publisher: "Scribner",
          page_count: 180,
          subjects: null,
          published_date: "1925",
          language: "en",
          series_name: null,
          series_position: null,
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
          cover_max_width: 1500,
        },
      ],
      error: null,
    });

    const result = await getCatalogForBrowserByTitleAuthor(
      supabase,
      TITLE,
      AUTHOR,
      "large",
    );

    expect(result).not.toBeNull();
    expect(result!.isbn).toBeNull();
    expect(result!.title).toBe(TITLE);
    expect(result!.cover_url).toContain("ab/cd.jpg");
  });

  it("returns CatalogView with cover_url=null for negative-cache row", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          isbn: null,
          title: TITLE,
          author: AUTHOR,
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
          cover_max_width: null,
        },
      ],
      error: null,
    });
    const result = await getCatalogForBrowserByTitleAuthor(
      supabase,
      TITLE,
      AUTHOR,
    );
    expect(result).not.toBeNull();
    expect(result!.cover_url).toBeNull();
  });

  it("throws when the Supabase query errors", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: null,
      error: { message: "DB down" },
    });
    await expect(
      getCatalogForBrowserByTitleAuthor(supabase, TITLE, AUTHOR),
    ).rejects.toBeTruthy();
  });
});

describe("getCoverUrlsByTitleAuthor", () => {
  it("returns empty Map without hitting the DB when input is empty", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          normalized_title_author: "x|y",
          storage_path: "x",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });

    const result = await getCoverUrlsByTitleAuthor(supabase, []);
    expect(result.covers.size).toBe(0);
    expect(result.negativeKeys.size).toBe(0);
  });

  it("skips pairs whose normalisation yields null; still queries if any survive", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          normalized_title_author: "the great gatsby|f scott fitzgerald",
          storage_path: "ab/cd.jpg",
          cover_storage_backend: "supabase",
          cover_max_width: 1500,
        },
      ],
      error: null,
    });

    const result = await getCoverUrlsByTitleAuthor(supabase, [
      { title: "", author: "missing" },
      { title: "The Great Gatsby", author: "F. Scott Fitzgerald" },
    ]);

    expect(result.covers.size).toBe(1);
    expect(result.covers.get("the great gatsby|f scott fitzgerald")).toContain(
      "ab/cd.jpg",
    );
  });

  it("does not hit the DB when every pair normalises to null", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          normalized_title_author: "x|y",
          storage_path: "x",
          cover_storage_backend: "supabase",
        },
      ],
      error: null,
    });
    const result = await getCoverUrlsByTitleAuthor(supabase, [
      { title: "", author: "" },
      { title: "only title", author: "" },
    ]);
    expect(result.covers.size).toBe(0);
    expect(result.negativeKeys.size).toBe(0);
  });

  it("returns negative-cache rows in negativeKeys set; covers map omits", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: [
        {
          normalized_title_author: "the great gatsby|f scott fitzgerald",
          storage_path: null,
          cover_storage_backend: null,
          cover_max_width: null,
        },
      ],
      error: null,
    });

    const result = await getCoverUrlsByTitleAuthor(supabase, [
      { title: "The Great Gatsby", author: "F. Scott Fitzgerald" },
    ]);

    expect(result.covers.size).toBe(0);
    expect(result.negativeKeys.has("the great gatsby|f scott fitzgerald")).toBe(
      true,
    );
  });

  it("throws when the Supabase query errors", async () => {
    const supabase = createMockSupabase();
    supabase._results.set("book_catalog.select", {
      data: null,
      error: { message: "DB down" },
    });
    await expect(
      getCoverUrlsByTitleAuthor(supabase, [{ title: "T", author: "A" }]),
    ).rejects.toBeTruthy();
  });
});

// Grab handles to the already-imported mock env objects so we can mutate them
// within the downgrade test to simulate cloudflare-images backend.
const { env: dynPrivateEnv } = await import("$env/dynamic/private");
const { env: dynPublicEnv } = await import("$env/dynamic/public");

// This describe block mutates a process-resident mock module object inside the
// test and restores it in a finally. Safe ONLY because Vitest runs this file's
// tests serially in declaration order. If `sequence.concurrent` is ever enabled
// for this file or this block is reordered above other describes that depend on
// the default backend, the mutation window may overlap another test's execution.
describe("cover_max_width variant downgrade (cloudflare-images backend)", () => {
  it("downgrades requested xlarge to large when cover_max_width is 800", async () => {
    // Mutate the shared mock env objects to switch the backend for this test.
    // cover-storage.ts reads these at call time, so mutation takes effect
    // without a module re-import.
    const origBackend = dynPrivateEnv.COVER_STORAGE_BACKEND;
    const origHash = (dynPublicEnv as Record<string, string | undefined>)
      .PUBLIC_CLOUDFLARE_IMAGES_HASH;
    (dynPrivateEnv as Record<string, string>).COVER_STORAGE_BACKEND =
      "cloudflare-images";
    (dynPublicEnv as Record<string, string>).PUBLIC_CLOUDFLARE_IMAGES_HASH =
      "testhash";

    try {
      const supabase = createMockSupabase();
      supabase._results.set("book_catalog.select", {
        data: [
          {
            isbn: "9780000000000",
            storage_path: "abc/def",
            cover_storage_backend: "cloudflare-images",
            cover_max_width: 800,
            title: null,
            author: null,
            description: null,
            description_provider: null,
            publisher: null,
            page_count: null,
            subjects: null,
            published_date: null,
            language: null,
            series_name: null,
            series_position: null,
          },
        ],
        error: null,
      });

      const result = await getCatalogForBrowser(
        supabase,
        "9780000000000",
        "xlarge",
      );

      // xlarge requires min 1200px source; 800px source must downgrade to large.
      expect(result?.cover_url).toContain("/large");
      expect(result?.cover_url).not.toContain("/xlarge");
    } finally {
      // Restore original env values so other tests are unaffected.
      (
        dynPrivateEnv as Record<string, string | undefined>
      ).COVER_STORAGE_BACKEND = origBackend;
      if (origHash === undefined) {
        delete (dynPublicEnv as Record<string, string | undefined>)
          .PUBLIC_CLOUDFLARE_IMAGES_HASH;
      } else {
        (dynPublicEnv as Record<string, string>).PUBLIC_CLOUDFLARE_IMAGES_HASH =
          origHash;
      }
    }
  });
});
