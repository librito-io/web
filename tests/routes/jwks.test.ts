import { describe, it, expect, vi } from "vitest";

const TEST_JWK_STR =
  '{"kty":"EC","x":"wBDwlgqhn52S8f6atVgDsORf-Q0Vrt7OzTVFBopqOmk","y":"qWSlUix55SIjeW2-npqtLfkikO2tiW94jMm03bzKCTw","crv":"P-256","kid":"test-kid-fixture","use":"sig","alg":"ES256"}';

vi.mock("$env/static/private", () => ({
  LIBRITO_JWT_PUBLIC_KEY_JWK: TEST_JWK_STR,
}));

const { GET } = await import("../../src/routes/.well-known/jwks.json/+server");

function buildEvent() {
  return {
    request: new Request("http://x/.well-known/jwks.json", { method: "GET" }),
  } as unknown as Parameters<typeof GET>[0];
}

describe("GET /.well-known/jwks.json", () => {
  it("200 returns { keys: [<jwk>] } shape with correct headers", async () => {
    const res = await GET(buildEvent());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toMatch(/public, max-age=3600/);

    const body = (await res.json()) as { keys: Array<Record<string, string>> };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys).toHaveLength(1);

    const [jwk] = body.keys;
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(jwk.alg).toBe("ES256");
    expect(jwk.use).toBe("sig");
    expect(jwk.kid).toBe("test-kid-fixture");
    // Must NOT expose private-component fields.
    expect(jwk.d).toBeUndefined();
  });
});

describe("GET /.well-known/jwks.json — misconfiguration", () => {
  it("500 server_error when LIBRITO_JWT_PUBLIC_KEY_JWK is not valid JSON", async () => {
    vi.resetModules();
    vi.doMock("$env/static/private", () => ({
      LIBRITO_JWT_PUBLIC_KEY_JWK: "not-json{",
    }));
    const mod = await import("../../src/routes/.well-known/jwks.json/+server");
    const res = await mod.GET(buildEvent());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("server_error");
    vi.doUnmock("$env/static/private");
  });
});
