import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../helpers";
import type { CoverVariant } from "../../src/lib/server/catalog/types";

vi.mock("$env/static/public", () => ({
  PUBLIC_SUPABASE_URL: "https://supabase.example.co",
}));
vi.mock("$env/dynamic/private", () => ({
  env: {
    get COVER_STORAGE_BACKEND() {
      return process.env.COVER_STORAGE_BACKEND;
    },
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_IMAGES_API_TOKEN: "tok",
  },
}));
vi.mock("$env/dynamic/public", () => ({
  env: { PUBLIC_CLOUDFLARE_IMAGES_HASH: "hashabc" },
}));

beforeEach(() => {
  delete process.env.COVER_STORAGE_BACKEND;
  vi.resetModules();
});

describe("coverUrl", () => {
  it("builds Supabase Storage public object URL (no transform — Free tier safe)", async () => {
    const { coverUrl } = await import("../../src/lib/server/cover-storage");
    const url = coverUrl("u/abc.jpg", "supabase", "medium");
    expect(url).toBe(
      "https://supabase.example.co/storage/v1/object/public/cover-cache/u/abc.jpg",
    );
  });

  it("builds Cloudflare Images delivery URL", async () => {
    const { coverUrl } = await import("../../src/lib/server/cover-storage");
    const url = coverUrl("img-id-123", "cloudflare-images", "thumbnail");
    expect(url).toBe("https://imagedelivery.net/hashabc/img-id-123/thumbnail");
  });
});

describe("uploadCover (supabase backend)", () => {
  it("uploads to cover-cache and returns sha-derived path", async () => {
    process.env.COVER_STORAGE_BACKEND = "supabase";
    const { uploadCover } = await import("../../src/lib/server/cover-storage");
    const supabase = createMockSupabase();
    supabase.storage.from = () =>
      ({
        upload: vi.fn(async () => ({ data: {}, error: null })),
      }) as unknown as ReturnType<(typeof supabase.storage)["from"]>;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    const r = await uploadCover(bytes, "image/jpeg", {
      supabase: supabase as never,
    });
    expect(r.backend).toBe("supabase");
    expect(r.storage_path).toMatch(/^[a-f0-9]{2}\/[a-f0-9]{62}\.jpg$/);
    expect(r.image_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("uploadCover (cloudflare-images backend)", () => {
  it("POSTs the bytes to /v1 and returns the CF image id", async () => {
    process.env.COVER_STORAGE_BACKEND = "cloudflare-images";
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { id: "cf-id-7" } }), {
          status: 200,
        }),
    );
    const { uploadCover } = await import("../../src/lib/server/cover-storage");
    const r = await uploadCover(
      new Uint8Array([0xff, 0xd8, 0xff]),
      "image/jpeg",
      { fetchFn },
    );
    expect(r.backend).toBe("cloudflare-images");
    expect(r.storage_path).toBe("cf-id-7");
    expect(fetchFn).toHaveBeenCalled();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/images/v1",
    );
    expect(init.method).toBe("POST");
  });
});

describe("resolveVariant", () => {
  it("returns requested when source width unknown (null)", async () => {
    const { resolveVariant } =
      await import("../../src/lib/server/cover-storage");
    expect(resolveVariant("xlarge", null)).toBe("xlarge");
  });

  it("returns xlarge when source >= 1200", async () => {
    const { resolveVariant } =
      await import("../../src/lib/server/cover-storage");
    expect(resolveVariant("xlarge", 1500)).toBe("xlarge");
    expect(resolveVariant("xlarge", 1200)).toBe("xlarge");
  });

  it("downgrades xlarge to large when source 600-1199", async () => {
    const { resolveVariant } =
      await import("../../src/lib/server/cover-storage");
    expect(resolveVariant("xlarge", 800)).toBe("large");
    expect(resolveVariant("xlarge", 1199)).toBe("large");
    expect(resolveVariant("xlarge", 600)).toBe("large");
  });

  it("downgrades xlarge to medium when source 300-599", async () => {
    const { resolveVariant } =
      await import("../../src/lib/server/cover-storage");
    expect(resolveVariant("xlarge", 400)).toBe("medium");
    expect(resolveVariant("xlarge", 599)).toBe("medium");
    expect(resolveVariant("xlarge", 300)).toBe("medium");
  });

  it("downgrades xlarge to thumbnail when source 240-299", async () => {
    const { resolveVariant } =
      await import("../../src/lib/server/cover-storage");
    expect(resolveVariant("xlarge", 250)).toBe("thumbnail");
    expect(resolveVariant("xlarge", 240)).toBe("thumbnail");
  });

  it("falls all the way back to thumbnail when source < all thresholds", async () => {
    const { resolveVariant } =
      await import("../../src/lib/server/cover-storage");
    expect(resolveVariant("xlarge", 100)).toBe("thumbnail");
  });

  it("never returns a variant requiring more than source", async () => {
    const { resolveVariant } =
      await import("../../src/lib/server/cover-storage");
    expect(resolveVariant("large", 500)).toBe("medium");
    expect(resolveVariant("medium", 250)).toBe("thumbnail");
  });

  it("does not upgrade when requested variant is small", async () => {
    const { resolveVariant } =
      await import("../../src/lib/server/cover-storage");
    expect(resolveVariant("thumbnail", 5000)).toBe("thumbnail");
    expect(resolveVariant("medium", 2000)).toBe("medium");
  });
});

describe("coverUrl with cover_max_width", () => {
  it("constructs xlarge URL when source >= 1200", async () => {
    process.env.COVER_STORAGE_BACKEND = "cloudflare-images";
    const { coverUrl } = await import("../../src/lib/server/cover-storage");
    const url = coverUrl(
      "ab/cd",
      "cloudflare-images",
      "xlarge",
      1500,
    );
    expect(url).toBe("https://imagedelivery.net/hashabc/ab/cd/xlarge");
  });

  it("downgrades to large URL when source < 1200", async () => {
    process.env.COVER_STORAGE_BACKEND = "cloudflare-images";
    const { coverUrl } = await import("../../src/lib/server/cover-storage");
    const url = coverUrl(
      "ab/cd",
      "cloudflare-images",
      "xlarge",
      800,
    );
    expect(url).toBe("https://imagedelivery.net/hashabc/ab/cd/large");
  });

  it("trusts caller (uses requested variant) when cover_max_width unknown", async () => {
    process.env.COVER_STORAGE_BACKEND = "cloudflare-images";
    const { coverUrl } = await import("../../src/lib/server/cover-storage");
    const url = coverUrl(
      "ab/cd",
      "cloudflare-images",
      "xlarge",
      null,
    );
    expect(url).toBe("https://imagedelivery.net/hashabc/ab/cd/xlarge");
  });

  it("supabase backend ignores variant entirely (full-size only)", async () => {
    const { coverUrl } = await import("../../src/lib/server/cover-storage");
    const url = coverUrl(
      "ab/cd.jpg",
      "supabase",
      "xlarge",
      800,
    );
    expect(url).toBe(
      "https://supabase.example.co/storage/v1/object/public/cover-cache/ab/cd.jpg",
    );
  });
});
