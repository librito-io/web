import { describe, it, expect } from "vitest";
import { relativeTime } from "../../src/lib/time/relativeTime";

const now = new Date("2026-04-14T12:00:00Z").getTime();
const strings = {
  justNow: "just now",
  minutes: "{n}m ago",
  hours: "{n}h ago",
  yesterday: "Yesterday",
};

describe("relativeTime", () => {
  it("returns the 'just now' bucket for < 60s", () => {
    expect(relativeTime(now - 30_000, { now, strings })).toBe("just now");
  });

  it("returns minutes for < 1h", () => {
    expect(relativeTime(now - 3 * 60_000, { now, strings })).toBe("3m ago");
  });

  it("returns hours for < 24h", () => {
    expect(relativeTime(now - 5 * 3_600_000, { now, strings })).toBe("5h ago");
  });

  it("returns 'Yesterday' for 24-48h", () => {
    expect(relativeTime(now - 30 * 3_600_000, { now, strings })).toBe(
      "Yesterday",
    );
  });

  it("returns a locale date beyond 48h", () => {
    const out = relativeTime(now - 7 * 24 * 3_600_000, { now, strings });
    expect(out).toMatch(/\d/); // locale-specific — just assert it contains digits
    expect(out).not.toBe("Yesterday");
  });

  it("accepts ISO strings", () => {
    expect(relativeTime("2026-04-14T11:59:30Z", { now, strings })).toBe(
      "just now",
    );
  });

  it("returns empty string for null/undefined input", () => {
    expect(relativeTime(null, { now, strings })).toBe("");
  });
});
