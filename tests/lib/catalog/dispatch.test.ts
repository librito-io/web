import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockSupabase } from "../../helpers";

const resolveIsbnSpy = vi.fn(async () => ({
  cached: false,
  rateLimited: false,
  row: {},
}));
const resolveTitleAuthorSpy = vi.fn(async () => ({
  cached: false,
  rateLimited: false,
  row: {},
}));
vi.mock("$lib/server/catalog/fetcher", () => ({
  resolveIsbn: resolveIsbnSpy,
  resolveTitleAuthor: resolveTitleAuthorSpy,
}));

const { dispatchResolve, parseWorkPayload } =
  await import("$lib/server/catalog/dispatch");

beforeEach(() => {
  resolveIsbnSpy.mockClear();
  resolveTitleAuthorSpy.mockClear();
});

describe("dispatchResolve", () => {
  it("isbn work → resolveIsbn with ctx + fields threaded", async () => {
    const admin = createMockSupabase();
    const deps = { rateLimiters: {} as any, mutex: undefined };
    await dispatchResolve(admin as any, deps as any, "user-1", {
      kind: "isbn",
      isbn: "9780000000000",
      ctx: { title: "T", author: "A" },
      fields: ["cover"],
    });
    expect(resolveIsbnSpy).toHaveBeenCalledWith(
      admin,
      "9780000000000",
      deps,
      { title: "T", author: "A" },
      ["cover"],
    );
    expect(resolveTitleAuthorSpy).not.toHaveBeenCalled();
  });

  it("ta work → resolveTitleAuthor with fields threaded", async () => {
    const admin = createMockSupabase();
    const deps = { rateLimiters: {} as any, mutex: undefined };
    await dispatchResolve(admin as any, deps as any, "user-1", {
      kind: "ta",
      title: "T",
      author: "A",
      fields: ["publisher"],
    });
    expect(resolveTitleAuthorSpy).toHaveBeenCalledWith(admin, "T", "A", deps, [
      "publisher",
    ]);
    expect(resolveIsbnSpy).not.toHaveBeenCalled();
  });
});

describe("parseWorkPayload", () => {
  it("valid ISBN payload parses", () => {
    const body = JSON.stringify({
      userId: "user-1",
      item: { kind: "isbn", isbn: "9780000000000" },
    });
    const r = parseWorkPayload(body);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.userId).toBe("user-1");
      expect(r.value.item).toEqual({ kind: "isbn", isbn: "9780000000000" });
    }
  });

  it("valid ISBN payload with ctx + fields parses", () => {
    const body = JSON.stringify({
      userId: "user-1",
      item: {
        kind: "isbn",
        isbn: "9780000000000",
        ctx: { title: "T", author: "A" },
        fields: ["cover", "description"],
      },
    });
    const r = parseWorkPayload(body);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.item.kind === "isbn") {
      expect(r.value.item.ctx).toEqual({ title: "T", author: "A" });
      expect(r.value.item.fields).toEqual(["cover", "description"]);
    }
  });

  it("valid TA payload parses", () => {
    const body = JSON.stringify({
      userId: "u",
      item: { kind: "ta", title: "T", author: "A" },
    });
    const r = parseWorkPayload(body);
    expect(r.ok).toBe(true);
  });

  it("non-JSON body rejected", () => {
    const r = parseWorkPayload("not json");
    expect(r.ok).toBe(false);
  });

  it("missing userId rejected", () => {
    const r = parseWorkPayload(
      JSON.stringify({ item: { kind: "isbn", isbn: "9780000000000" } }),
    );
    expect(r.ok).toBe(false);
  });

  it("missing item rejected", () => {
    const r = parseWorkPayload(JSON.stringify({ userId: "u" }));
    expect(r.ok).toBe(false);
  });

  it("unknown item.kind rejected", () => {
    const r = parseWorkPayload(
      JSON.stringify({ userId: "u", item: { kind: "garbage", isbn: "x" } }),
    );
    expect(r.ok).toBe(false);
  });

  it("ISBN payload without isbn string rejected", () => {
    const r = parseWorkPayload(
      JSON.stringify({ userId: "u", item: { kind: "isbn" } }),
    );
    expect(r.ok).toBe(false);
  });

  it("TA payload without title or author rejected", () => {
    const r1 = parseWorkPayload(
      JSON.stringify({ userId: "u", item: { kind: "ta", title: "T" } }),
    );
    expect(r1.ok).toBe(false);
    const r2 = parseWorkPayload(
      JSON.stringify({ userId: "u", item: { kind: "ta", author: "A" } }),
    );
    expect(r2.ok).toBe(false);
  });

  it("unexpected fields entries rejected", () => {
    const r = parseWorkPayload(
      JSON.stringify({
        userId: "u",
        item: { kind: "isbn", isbn: "9780000000000", fields: ["bogus"] },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("ISBN payload with non-object ctx rejected", () => {
    const r = parseWorkPayload(
      JSON.stringify({
        userId: "u",
        item: { kind: "isbn", isbn: "9780000000000", ctx: "not-an-object" },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("whitespace-only isbn/title/author rejected", () => {
    expect(
      parseWorkPayload(
        JSON.stringify({ userId: "u", item: { kind: "isbn", isbn: "   " } }),
      ).ok,
    ).toBe(false);
    expect(
      parseWorkPayload(
        JSON.stringify({
          userId: "u",
          item: { kind: "ta", title: " ", author: "A" },
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseWorkPayload(
        JSON.stringify({
          userId: "u",
          item: { kind: "ta", title: "T", author: "\t" },
        }),
      ).ok,
    ).toBe(false);
  });
});
