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

const { dispatchResolve } = await import("$lib/server/catalog/dispatch");

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
