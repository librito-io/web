import { describe, it, expect } from "vitest";
import { relativeTime } from "../../src/lib/time/relativeTime";

const now = new Date("2026-04-14T12:00:00Z").getTime();
const strings = {
  justNow: "Just now",
  minuteAgo: "1 minute ago",
  minutesAgo: "{n} minutes ago",
  hourAgo: "1 hour ago",
  hoursAgo: "{n} hours ago",
  dayAgo: "1 day ago",
  daysAgo: "{n} days ago",
  weekAgo: "1 week ago",
};

describe("relativeTime", () => {
  it("returns 'Just now' for < 1 minute", () => {
    expect(relativeTime(now - 30_000, { now, strings })).toBe("Just now");
  });

  it("returns '1 minute ago' singular at exactly 1 minute", () => {
    expect(relativeTime(now - 60_000, { now, strings })).toBe("1 minute ago");
  });

  it("returns '{n} minutes ago' plural between 2 and 59 minutes", () => {
    expect(relativeTime(now - 3 * 60_000, { now, strings })).toBe(
      "3 minutes ago",
    );
    expect(relativeTime(now - 59 * 60_000, { now, strings })).toBe(
      "59 minutes ago",
    );
  });

  it("returns '1 hour ago' singular at exactly 1 hour", () => {
    expect(relativeTime(now - 3_600_000, { now, strings })).toBe("1 hour ago");
  });

  it("returns '{n} hours ago' plural between 2 and 23 hours", () => {
    expect(relativeTime(now - 5 * 3_600_000, { now, strings })).toBe(
      "5 hours ago",
    );
    expect(relativeTime(now - 23 * 3_600_000, { now, strings })).toBe(
      "23 hours ago",
    );
  });

  it("returns '1 day ago' singular at exactly 24h", () => {
    expect(relativeTime(now - 24 * 3_600_000, { now, strings })).toBe(
      "1 day ago",
    );
  });

  it("returns '{n} days ago' between 2 and 6 days", () => {
    expect(relativeTime(now - 2 * 24 * 3_600_000, { now, strings })).toBe(
      "2 days ago",
    );
    expect(relativeTime(now - 6 * 24 * 3_600_000, { now, strings })).toBe(
      "6 days ago",
    );
  });

  it("returns '1 week ago' between 7 and 13 days", () => {
    expect(relativeTime(now - 7 * 24 * 3_600_000, { now, strings })).toBe(
      "1 week ago",
    );
    expect(relativeTime(now - 13 * 24 * 3_600_000, { now, strings })).toBe(
      "1 week ago",
    );
  });

  it("returns 'Month Day' format for same-year dates 14+ days ago", () => {
    expect(
      relativeTime("2026-03-15T12:00:00Z", { now, strings, locale: "en-US" }),
    ).toBe("March 15");
  });

  it("returns 'Month Day, Year' format for past-year dates", () => {
    expect(
      relativeTime("2025-12-15T12:00:00Z", { now, strings, locale: "en-US" }),
    ).toBe("December 15, 2025");
  });

  it("accepts ISO strings", () => {
    expect(relativeTime("2026-04-14T11:59:30Z", { now, strings })).toBe(
      "Just now",
    );
  });

  it("returns empty string for null/undefined input", () => {
    expect(relativeTime(null, { now, strings })).toBe("");
  });
});
