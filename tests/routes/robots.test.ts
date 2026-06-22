import { describe, it, expect, vi, beforeEach } from "vitest";

// /robots.txt gates crawling on PUBLIC_LAUNCHED. The handler reads
// env.PUBLIC_LAUNCHED at call time, so a single mutable mock object lets us
// flip launch state between cases without re-importing the module.
const publicEnv: Record<string, string> = {};
vi.mock("$env/dynamic/public", () => ({ env: publicEnv }));

const { GET } = await import("../../src/routes/robots.txt/+server");

function call() {
  return GET({} as unknown as Parameters<typeof GET>[0]);
}

describe("GET /robots.txt", () => {
  beforeEach(() => {
    for (const k of Object.keys(publicEnv)) delete publicEnv[k];
  });

  it("disallows all crawling pre-launch (PUBLIC_LAUNCHED unset)", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /");
  });

  it("allows crawling once launched (PUBLIC_LAUNCHED=true)", async () => {
    publicEnv.PUBLIC_LAUNCHED = "true";
    const res = await call();
    const body = await res.text();
    expect(body).toContain("Allow: /");
    expect(body).not.toContain("Disallow:");
  });
});
