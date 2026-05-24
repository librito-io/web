import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jwtVerify, importJWK } from "jose";
import {
  mintRealtimeToken,
  checkKidInJwks,
  REALTIME_TOKEN_TTL_SECONDS,
  type JwksKidCache,
} from "$lib/server/realtime";
import { __setTestDestination, __resetTestDestination } from "$lib/server/log";
import { DEV_STANDBY_JWK, DEV_KID } from "../fixtures/dev-jwk";

// Spy on importJWK while delegating to the real implementation. The
// realtime module imports `importJWK` from "jose" at module load, so the
// mock must be in place before that import resolves — vi.mock is hoisted
// above ESM imports automatically.
vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    importJWK: vi.fn(actual.importJWK),
  };
});

const SUPABASE_URL = "https://test-proj.supabase.co";

describe("mintRealtimeToken", () => {
  it("returns expiresIn of exactly 3600 seconds (1 h)", async () => {
    const { expiresIn } = await mintRealtimeToken({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      privateJwk: DEV_STANDBY_JWK,
      supabaseUrl: SUPABASE_URL,
    });
    expect(expiresIn).toBe(3600);
    expect(REALTIME_TOKEN_TTL_SECONDS).toBe(3600);
  });

  it("signs an ES256 JWT with kid header from JWK + role/sub/aud/exp/iat/device_id claims", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const deviceId = "22222222-2222-2222-2222-222222222222";
    const before = Math.floor(Date.now() / 1000);
    const { token } = await mintRealtimeToken({
      userId,
      deviceId,
      privateJwk: DEV_STANDBY_JWK,
      supabaseUrl: SUPABASE_URL,
    });
    const after = Math.floor(Date.now() / 1000);

    // Verify with the public side of the same key
    const { d, key_ops, ...publicJwk } = DEV_STANDBY_JWK;
    const publicKey = await importJWK(publicJwk, "ES256");

    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      audience: "authenticated",
    });

    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.typ).toBe("JWT");
    expect(protectedHeader.kid).toBe(DEV_KID);
    expect(payload.iss).toBe(`${SUPABASE_URL}/auth/v1`);
    expect(payload.sub).toBe(userId);
    expect(payload.role).toBe("authenticated");
    expect(payload.aud).toBe("authenticated");
    expect(payload.device_id).toBe(deviceId);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.iat as number).toBeGreaterThanOrEqual(before);
    expect(payload.iat as number).toBeLessThanOrEqual(after);
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
  });

  it("throws when privateJwk is missing the `d` private component", async () => {
    const { d, ...publicOnly } = DEV_STANDBY_JWK;
    await expect(
      mintRealtimeToken({
        userId: "11111111-1111-1111-1111-111111111111",
        deviceId: "22222222-2222-2222-2222-222222222222",
        privateJwk: publicOnly as typeof DEV_STANDBY_JWK,
        supabaseUrl: SUPABASE_URL,
      }),
    ).rejects.toThrow(/private component|d field|missing/i);
  });

  it("caches importJWK result by kid across mints with the same key", async () => {
    const importJwkSpy = vi.mocked(importJWK);
    importJwkSpy.mockClear();

    // Two mints with the same kid — second must reuse the cached CryptoKey.
    // (The module-scope cache may already be warm from earlier tests in
    // this file, in which case the count is 0 — that is also acceptable
    // evidence the cache is working. The regression we're guarding
    // against is "called once per mint", which would show as ≥2 here.)
    const opts = {
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      privateJwk: DEV_STANDBY_JWK,
      supabaseUrl: SUPABASE_URL,
    };
    await mintRealtimeToken(opts);
    await mintRealtimeToken(opts);

    expect(importJwkSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("rejects verification with a different keypair", async () => {
    const { token } = await mintRealtimeToken({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      privateJwk: DEV_STANDBY_JWK,
      supabaseUrl: SUPABASE_URL,
    });
    const { generateKeyPair, exportJWK } = await import("jose");
    const otherKp = await generateKeyPair("ES256", { extractable: true });
    const otherJwk = await exportJWK(otherKp.publicKey);
    const otherKey = await importJWK(otherJwk, "ES256");
    await expect(
      jwtVerify(token, otherKey, { audience: "authenticated" }),
    ).rejects.toThrow();
  });
});

describe("checkKidInJwks", () => {
  let writes: Record<string, unknown>[];
  let cache: JwksKidCache;

  beforeEach(() => {
    cache = { confirmed: null };
    writes = [];
    __setTestDestination((line) => {
      writes.push(JSON.parse(line));
    });
  });

  afterEach(() => {
    __resetTestDestination();
    vi.unstubAllGlobals();
  });

  it("ignores malformed body where keys is a non-array (logs kid_not_in_jwks, does not throw)", async () => {
    const kid = "kid-malformed-keys-not-array";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: "not-an-array" }), {
            status: 200,
          }),
      ),
    );

    await expect(
      checkKidInJwks(kid, SUPABASE_URL, cache),
    ).resolves.toBeUndefined();

    const kidNotInJwks = writes.find(
      (w) => w.event === "realtime.kid_not_in_jwks",
    );
    expect(kidNotInJwks).toBeDefined();
    expect(kidNotInJwks).toMatchObject({ kid, knownKids: [] });
    expect(cache.confirmed).toBeNull();
  });

  it("ignores malformed body where keys array has non-object elements", async () => {
    const kid = "kid-malformed-keys-mixed";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: ["string", 42, null] }), {
            status: 200,
          }),
      ),
    );

    await expect(
      checkKidInJwks(kid, SUPABASE_URL, cache),
    ).resolves.toBeUndefined();
    expect(
      writes.find((w) => w.event === "realtime.kid_not_in_jwks"),
    ).toMatchObject({ kid, knownKids: [] });
  });

  it("ignores body that is not an object", async () => {
    const kid = "kid-body-is-string";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify("not an object"), { status: 200 }),
      ),
    );

    await expect(
      checkKidInJwks(kid, SUPABASE_URL, cache),
    ).resolves.toBeUndefined();
    expect(
      writes.find((w) => w.event === "realtime.kid_not_in_jwks"),
    ).toBeDefined();
  });

  it("logs jwks_fetch_non_ok on non-200 response", async () => {
    const kid = "kid-fetch-non-ok";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Service Unavailable", { status: 503 })),
    );

    await checkKidInJwks(kid, SUPABASE_URL, cache);
    expect(
      writes.find((w) => w.event === "realtime.jwks_fetch_non_ok"),
    ).toMatchObject({ kid, status: 503 });
  });

  it("returns silently when our kid appears in a valid JWKS response", async () => {
    const kid = "kid-valid-match";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              keys: [{ kid: "other-kid" }, { kid }],
            }),
            { status: 200 },
          ),
      ),
    );

    await checkKidInJwks(kid, SUPABASE_URL, cache);
    expect(
      writes.find((w) => w.event === "realtime.kid_not_in_jwks"),
    ).toBeUndefined();
    expect(cache.confirmed).toBe(kid);
  });

  it("short-circuits on subsequent calls when cache already holds the kid", async () => {
    const kid = "kid-short-circuit";
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [{ kid }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await checkKidInJwks(kid, SUPABASE_URL, cache);
    await checkKidInJwks(kid, SUPABASE_URL, cache);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("mintRealtimeToken — JWKS-check contract", () => {
  // Guards the user-visible invariant: JWKS confirmation is fire-and-forget,
  // so a degraded JWKS endpoint (garbage body, non-200, network throw) can
  // never break mint. If a future refactor accidentally changes
  // `void checkKidInJwks(...)` to `await checkKidInJwks(...)` or otherwise
  // ties the mint return value to JWKS health, this test fails.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("succeeds even when the JWKS endpoint returns a non-JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<html>maintenance</html>", { status: 200 }),
      ),
    );

    const { token, expiresIn } = await mintRealtimeToken({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      privateJwk: DEV_STANDBY_JWK,
      supabaseUrl: SUPABASE_URL,
    });

    expect(token).toBeTruthy();
    expect(expiresIn).toBe(REALTIME_TOKEN_TTL_SECONDS);
  });

  it("succeeds even when the JWKS body is structurally garbage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: "not-an-array" }), {
            status: 200,
          }),
      ),
    );

    const { token } = await mintRealtimeToken({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      privateJwk: DEV_STANDBY_JWK,
      supabaseUrl: SUPABASE_URL,
    });

    expect(token).toBeTruthy();
  });

  it("succeeds even when the JWKS endpoint is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const { token } = await mintRealtimeToken({
      userId: "11111111-1111-1111-1111-111111111111",
      deviceId: "22222222-2222-2222-2222-222222222222",
      privateJwk: DEV_STANDBY_JWK,
      supabaseUrl: SUPABASE_URL,
    });

    expect(token).toBeTruthy();
  });
});
