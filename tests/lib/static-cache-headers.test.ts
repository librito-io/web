import { describe, it, expect } from "vitest";
import { config } from "../../vercel";

// Guards the wordmark-flash cache fix. /librito.svg (the hero + header logos)
// must be served with a long, non-revalidating Cache-Control so a reload paints
// it from cache instead of the `max-age=0, must-revalidate` conditional GET that
// makes Safari re-decode and flash the logo on every refresh. If this header
// rule is dropped or weakened, the Safari reload flash returns.
describe("static asset cache headers (vercel.ts)", () => {
  const rule = (config.headers ?? []).find((h) => h.source === "/librito.svg");

  it("defines a Cache-Control rule for /librito.svg", () => {
    expect(rule).toBeDefined();
  });

  it("serves it long-lived and without must-revalidate", () => {
    const cc = rule?.headers.find(
      (h) => h.key.toLowerCase() === "cache-control",
    )?.value;
    expect(cc).toBeDefined();
    expect(cc).not.toMatch(/must-revalidate/);
    expect(cc).not.toMatch(/max-age=0\b/);
    const maxAge = Number(cc?.match(/max-age=(\d+)/)?.[1] ?? "0");
    // A day is plenty to cover any realistic reload cadence; we set a year.
    expect(maxAge).toBeGreaterThanOrEqual(86400);
  });
});
